import { describe, expect, it } from 'vitest'

import { ChartTelemetryBuffer } from '../../features/charts/chartTelemetry'
import { createEmptyScene } from '../../scene/model/createEmptyScene'
import {
  createBall,
  createGravityField,
  createLineGround,
  createMagneticField,
  createParticleSource,
  createSpring,
} from '../../scene/model/entityFactories'
import type { SceneDocument } from '../../scene/model/types'
import { GIF_RECORDING_SAMPLE_RATE, GifTelemetryBuffer } from '../recording/gifTelemetry'
import { RuntimeTrajectoryHistory } from '../trajectory/runtimeTrajectoryHistory'
import { SimulationWorld, type SimulationRuntimeDiagnostics } from '../core/SimulationWorld'
import type { GifHistoryStatus } from '../worker/messages'

const FRAME_STEP_INTERVAL = 2
const GIF_STEP_INTERVAL = 4
const TIMING_BATCH_STEPS = 20
const COMPARISON_WINDOW_SECONDS = 10

interface TimingStats {
  averageMs: number
  p99Ms: number
}

interface LongRunResult {
  durationSeconds: number
  fixedStepCount: number
  early: TimingStats
  tail: TimingStats
  averageRegression: number
  p99Regression: number
  historyAllocatedBytes: number
  historyPointCount: number
  historyPointCapacity: number
  chartAllocatedBytes: number
  gifAllocatedBytes: number
  gifSampleCount: number
  gifStatus: GifHistoryStatus
  diagnostics: SimulationRuntimeDiagnostics
  peakContactStateCount: number
  peakParticleCount: number
  finalParticleCount: number
}

function stats(samples: readonly number[]): TimingStats {
  const ordered = [...samples].sort((first, second) => first - second)
  const percentileIndex = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * 0.99) - 1),
  )
  return {
    averageMs: samples.reduce((sum, sample) => sum + sample, 0) / samples.length,
    p99Ms: ordered[percentileIndex]!,
  }
}

function contactStateCount(diagnostics: SimulationRuntimeDiagnostics): number {
  return (
    diagnostics.connectorBodyContactManifoldCount +
    diagnostics.persistentGroundContactCount +
    diagnostics.persistentBooleanCircleContactCount +
    diagnostics.releasedGroundContactPairCount +
    diagnostics.releasedBooleanCircleContactCount
  )
}

function runLongScenario(
  scene: SceneDocument,
  durationSeconds: number,
  earlyWindowStartSeconds = 0,
): LongRunResult {
  const world = new SimulationWorld(scene)
  const initialBodies = world.getBodyStates()
  const initialConnectors = world.getConnectorStates()
  const initialParticles = world.getParticleSourceStates()
  const history = new RuntimeTrajectoryHistory()
  const chart = new ChartTelemetryBuffer(
    scene.settings.recordingSampleRate * scene.settings.recordingDurationSeconds,
  )
  const gif = new GifTelemetryBuffer(
    initialBodies.map((body) => body.entityId),
    initialConnectors,
    initialParticles,
  )
  const fixedStepCount = Math.round(durationSeconds / world.fixedTimeStep)
  const comparisonSteps = Math.round(COMPARISON_WINDOW_SECONDS / world.fixedTimeStep)
  const earlyWindowStartStep = Math.round(earlyWindowStartSeconds / world.fixedTimeStep)
  const earlyWindowEndStep = earlyWindowStartStep + comparisonSteps
  const earlySamples: number[] = []
  const tailSamples: number[] = []
  let batchStartedAt = performance.now()
  let peakContactStateCount = 0
  let peakParticleCount = initialParticles.reduce((sum, source) => sum + source.ions.length, 0)

  try {
    for (let stepIndex = 0; stepIndex < fixedStepCount; stepIndex += 1) {
      world.step()
      if (stepIndex % FRAME_STEP_INTERVAL === 0) {
        const bodies = world.getBodyStates()
        const particles = world.getParticleSourceStates()
        peakParticleCount = Math.max(
          peakParticleCount,
          particles.reduce((sum, source) => sum + source.ions.length, 0),
        )
        history.append(world.simulationTime, bodies, particles)
        chart.append([{ simulationTime: world.simulationTime, bodies }])
      }
      if (stepIndex % GIF_STEP_INTERVAL === 0) {
        gif.append(
          world.simulationTime,
          world.getBodyStates(),
          world.getConnectorStates(),
          world.getParticleSourceStates(),
        )
      }

      if ((stepIndex + 1) % 120 === 0) {
        peakContactStateCount = Math.max(
          peakContactStateCount,
          contactStateCount(world.getRuntimeDiagnostics()),
        )
      }

      if ((stepIndex + 1) % TIMING_BATCH_STEPS === 0) {
        const durationPerStepMs = (performance.now() - batchStartedAt) / TIMING_BATCH_STEPS
        if (stepIndex + 1 > earlyWindowStartStep && stepIndex + 1 <= earlyWindowEndStep) {
          earlySamples.push(durationPerStepMs)
        }
        if (stepIndex + 1 > fixedStepCount - comparisonSteps) {
          tailSamples.push(durationPerStepMs)
        }
        batchStartedAt = performance.now()
      }
    }

    const early = stats(earlySamples)
    const tail = stats(tailSamples)
    return {
      durationSeconds,
      fixedStepCount,
      early,
      tail,
      averageRegression: tail.averageMs / early.averageMs - 1,
      p99Regression: tail.p99Ms / early.p99Ms - 1,
      historyAllocatedBytes: history.allocatedBytes,
      historyPointCount: history.pointCount,
      historyPointCapacity: history.pointCapacity,
      chartAllocatedBytes: chart.allocatedBytes,
      gifAllocatedBytes: gif.allocatedBytes,
      gifSampleCount: gif.length,
      gifStatus: gif.getStatus(),
      diagnostics: world.getRuntimeDiagnostics(),
      peakContactStateCount,
      peakParticleCount,
      finalParticleCount: world
        .getParticleSourceStates()
        .reduce((sum, source) => sum + source.ions.length, 0),
    }
  } finally {
    world.dispose()
  }
}

function ordinaryScene(): SceneDocument {
  const scene = createEmptyScene('1000 秒普通场景', new Date('2026-08-23T00:00:00.000Z'))
  scene.settings.pairwiseElectrostatics = false
  scene.entities = Array.from({ length: 20 }, (_, index) => {
    const ball = createBall('', { x: index * 3, y: index % 2 }, 0.25, index + 1)
    ball.initialVelocity = { x: 0.2, y: 0.01 * (index % 3) }
    return ball
  })
  return scene
}

function complexScene(): SceneDocument {
  const scene = createEmptyScene('100 秒复杂场景', new Date('2026-08-23T00:00:00.000Z'))
  scene.settings.pairwiseElectrostatics = false
  const bodies = Array.from({ length: 24 }, (_, index) => {
    const ball = createBall(
      '',
      { x: (index % 8) * 1.2 - 4.2, y: Math.floor(index / 8) * 1.2 + 2 },
      0.35,
      index + 1,
    )
    ball.initialVelocity = { x: index % 2 === 0 ? 0.4 : -0.4, y: 0 }
    return ball
  })
  const springs = Array.from({ length: 8 }, (_, index) => {
    const spring = createSpring('', bodies[index * 2]!.id, bodies[index * 2 + 1]!.id, 1, index + 1)
    if (spring.connector.type === 'spring') {
      spring.connector.stiffness = 80
      spring.connector.damping = 0.4
    }
    return spring
  })
  const gravity = createGravityField('', { x: 0, y: 15 }, 80, 40, 1)
  const magnetic = createMagneticField('', { x: 0, y: 10 }, 8, 8, 1)
  if (magnetic.field.type === 'uniformMagnetic') magnetic.field.bzTesla = 1
  const source = createParticleSource('', { type: 'point', position: { x: 0, y: 10 } }, 1)
  source.spreadRad = Math.PI * 2
  source.speedMps = 1
  source.massKg = 1
  source.chargeC = 1
  scene.entities = [
    createLineGround('', { x: -30, y: 0 }, { x: 30, y: 0 }, 1),
    gravity,
    magnetic,
    source,
    ...bodies,
    ...springs,
  ]
  return scene
}

function continuousParticleScene(): SceneDocument {
  const scene = createEmptyScene('1000 秒连续粒子场景', new Date('2026-08-23T00:00:00.000Z'))
  scene.entities = Array.from({ length: 16 }, (_, index) => {
    const source = createParticleSource(
      '',
      { type: 'point', position: { x: (index % 8) * 2, y: Math.floor(index / 8) * 2 } },
      index + 1,
    )
    source.spreadRad = Math.PI * 2
    source.speedMps = 1
    source.massKg = 1
    source.chargeC = 1
    source.continuousEmission = {
      enabled: true,
      simultaneous: false,
      intervalSeconds: 1,
      lifetimeSeconds: 60,
    }
    return source
  })
  return scene
}

function expectStable(result: LongRunResult): void {
  expect(result.early.averageMs).toBeGreaterThan(0)
  expect(result.early.p99Ms).toBeGreaterThan(0)
  expect(result.averageRegression).toBeLessThanOrEqual(0.2)
  expect(result.p99Regression).toBeLessThanOrEqual(0.2)
  expect(result.historyPointCount).toBeLessThanOrEqual(result.historyPointCapacity)
  expect(Number.isFinite(result.historyAllocatedBytes)).toBe(true)
  expect(Number.isFinite(result.chartAllocatedBytes)).toBe(true)
  expect(Number.isFinite(result.gifAllocatedBytes)).toBe(true)
  expect(result.diagnostics.warningCount).toBeLessThanOrEqual(64)
  expect(result.peakContactStateCount).toBeLessThanOrEqual(256)
}

describe('长时间运行性能', () => {
  it('1000 秒普通场景达到记录上限后保持稳定', () => {
    const result = runLongScenario(ordinaryScene(), 1000)
    console.info('LONG_RUN ordinary', JSON.stringify(result))
    expectStable(result)
    expect(result.gifSampleCount).toBe(300 * GIF_RECORDING_SAMPLE_RATE)
    expect(result.gifStatus.kind).toBe('ready')
  })

  it('100 秒复杂场景末段不随总时长退化', () => {
    const result = runLongScenario(complexScene(), 100)
    console.info('LONG_RUN complex', JSON.stringify(result))
    expectStable(result)
    expect(result.gifSampleCount).toBe(100 * GIF_RECORDING_SAMPLE_RATE)
    expect(result.gifStatus.kind).toBe('ready')
  })

  it('1000 秒连续粒子场景保持有限活动数量和稳定记录成本', () => {
    const result = runLongScenario(continuousParticleScene(), 1000, 70)
    console.info('LONG_RUN continuous-particles', JSON.stringify(result))
    expectStable(result)
    expect(result.peakParticleCount).toBeLessThanOrEqual(16 * 60)
    expect(result.finalParticleCount).toBe(16 * 60)
    expect(result.historyPointCount).toBe(0)
    expect(result.gifStatus.kind).toBe('ready')
  })
})
