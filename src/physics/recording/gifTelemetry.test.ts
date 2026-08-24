import { describe, expect, it } from 'vitest'

import type {
  RuntimeBodyState,
  RuntimeConnectorState,
  RuntimeParticleSourceState,
} from '../worker/messages'
import {
  GIF_BODY_CHANNEL_COUNT,
  GIF_RECORDING_MAX_BODIES,
  GIF_RECORDING_MAX_CONNECTOR_POINTS,
  GifTelemetryBuffer,
} from './gifTelemetry'

function runtimeBody(entityId: string, value: number): RuntimeBodyState {
  return {
    entityId,
    position: { x: value, y: value + 1 },
    angleRad: value + 2,
    linearVelocity: { x: value + 3, y: value + 4 },
    angularVelocityRad: 0,
    netForce: { x: value + 5, y: value + 6 },
    acceleration: { x: 0, y: 0 },
    translationalKineticEnergyJ: 0,
    rotationalKineticEnergyJ: 0,
    kineticEnergyJ: 0,
  }
}

function runtimeConnector(entityId: string, value: number): RuntimeConnectorState {
  return {
    entityId,
    points: [
      { x: value, y: value + 1 },
      { x: value + 2, y: value + 3 },
    ],
  }
}

function runtimeParticles(
  count: number,
  frame: number,
  continuousEmission = false,
): RuntimeParticleSourceState {
  return {
    entityId: 'source',
    continuousEmission,
    ions: Array.from({ length: count }, (_, index) => ({
      id: index,
      t: count <= 1 ? 0.5 : index / (count - 1),
      bornAt: continuousEmission ? index : 0,
      continuous: continuousEmission,
      position: { x: frame + index / 10, y: index / 20 },
    })),
  }
}

describe('GifTelemetryBuffer', () => {
  it('stores compact chronological body samples', () => {
    const buffer = new GifTelemetryBuffer(['a', 'b'])
    buffer.append(0, [runtimeBody('a', 1), runtimeBody('b', 10)])
    buffer.append(1 / 30, [runtimeBody('a', 2), runtimeBody('b', 20)])

    const snapshot = buffer.snapshot(4)
    expect(snapshot.requestId).toBe(4)
    expect(snapshot.status).toMatchObject({ kind: 'ready', sampleCount: 2 })
    expect([...snapshot.times]).toEqual([0, expect.closeTo(1 / 30)])
    expect(snapshot.values).toHaveLength(2 * 2 * GIF_BODY_CHANNEL_COUNT)
    expect([...snapshot.values.slice(0, 7)]).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect([...snapshot.values.slice(21, 28)]).toEqual([20, 21, 22, 23, 24, 25, 26])
  })

  it('marks a missing body as a discontinuity', () => {
    const buffer = new GifTelemetryBuffer(['a', 'b'])
    buffer.append(0, [runtimeBody('a', 1)])

    const snapshot = buffer.snapshot(1)
    expect(Number.isNaN(snapshot.values[GIF_BODY_CHANNEL_COUNT])).toBe(true)
  })

  it('stores the fixed connector node layout with each chronological sample', () => {
    const initial = runtimeConnector('spring', 0)
    const buffer = new GifTelemetryBuffer([], [initial])
    buffer.append(0, [], [runtimeConnector('spring', 1)])
    buffer.append(1 / 30, [], [runtimeConnector('spring', 5)])

    const snapshot = buffer.snapshot(8)
    expect(snapshot.connectorIds).toEqual(['spring'])
    expect([...snapshot.connectorPointOffsets]).toEqual([0, 2])
    expect([...snapshot.connectorValues]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('keeps only the newest 300 seconds in chronological order', () => {
    const buffer = new GifTelemetryBuffer([])
    for (let index = 0; index <= buffer.capacity; index += 1) {
      buffer.append(index / 30, [])
    }

    const snapshot = buffer.snapshot(2)
    expect(snapshot.times).toHaveLength(buffer.capacity)
    expect(snapshot.times[0]).toBeCloseTo(1 / 30)
    expect(snapshot.times.at(-1)).toBeCloseTo(buffer.capacity / 30)
    expect(buffer.length).toBe(buffer.capacity)

    buffer.append((buffer.capacity + 1) / 30, [])
    expect(buffer.length).toBe(buffer.capacity)
  })

  it('blocks recording instead of silently dropping bodies above the limit', () => {
    const ids = Array.from({ length: GIF_RECORDING_MAX_BODIES + 1 }, (_, index) => `b-${index}`)
    const buffer = new GifTelemetryBuffer(ids)
    expect(buffer.append(0, [])).toBe(false)
    expect(buffer.getStatus()).toEqual({
      kind: 'blocked',
      reason: 'body-limit',
      bodyCount: GIF_RECORDING_MAX_BODIES + 1,
      maxBodies: GIF_RECORDING_MAX_BODIES,
    })
  })

  it('blocks recording instead of allocating an unsafe connector history', () => {
    const connector = {
      entityId: 'rope',
      points: Array.from({ length: GIF_RECORDING_MAX_CONNECTOR_POINTS + 1 }, () => ({
        x: 0,
        y: 0,
      })),
    }
    const buffer = new GifTelemetryBuffer([], [connector])
    expect(buffer.append(0, [], [connector])).toBe(false)
    expect(buffer.getStatus()).toEqual({
      kind: 'blocked',
      reason: 'connector-point-limit',
      pointCount: GIF_RECORDING_MAX_CONNECTOR_POINTS + 1,
      maxPoints: GIF_RECORDING_MAX_CONNECTOR_POINTS,
    })
  })

  it('clears old samples and can immediately start a new history', () => {
    const buffer = new GifTelemetryBuffer(['a'])
    buffer.append(0, [runtimeBody('a', 1)])
    buffer.append(1 / 30, [runtimeBody('a', 2)])

    buffer.clear()
    expect(buffer.getStatus()).toMatchObject({ kind: 'ready', sampleCount: 0 })

    buffer.append(5, [runtimeBody('a', 3)])
    const snapshot = buffer.snapshot(3)
    expect([...snapshot.times]).toEqual([5])
    expect(snapshot.values[0]).toBe(3)
  })

  it.each([1080, 3600])('records %i static particles without a particle-count limit', (count) => {
    const source = runtimeParticles(count, 0)
    const buffer = new GifTelemetryBuffer([], [], [source])

    expect(buffer.append(0, [], [], [source])).toBe(true)
    const snapshot = buffer.snapshot(count)

    expect(snapshot.status.kind).toBe('ready')
    expect(snapshot.particleSourceIds).toEqual(['source'])
    expect([...snapshot.particleFrameOffsets]).toEqual([0, count])
    expect(snapshot.particleIonIds).toHaveLength(count)
    expect(snapshot.particleValues).toHaveLength(count * 2)
  })

  it('stores variable particle births and expirations with stable ids', () => {
    const initial = runtimeParticles(1, 0, true)
    const second = runtimeParticles(2, 1, true)
    second.ions[0]!.id = 0
    second.ions[1]!.id = 1
    const third = runtimeParticles(1, 2, true)
    third.ions[0]!.id = 1
    const buffer = new GifTelemetryBuffer([], [], [initial])

    buffer.append(0, [], [], [initial])
    buffer.append(1, [], [], [second])
    buffer.append(2, [], [], [third])
    const snapshot = buffer.snapshot(9)

    expect([...snapshot.particleFrameOffsets]).toEqual([0, 1, 3, 4])
    expect([...snapshot.particleIonIds]).toEqual([0, 0, 1, 1])
    expect([...snapshot.particleIonBornTimes]).toEqual([0, 0, 1, 0])
    expect([...snapshot.particleIonContinuous]).toEqual([1, 1, 1, 1])
  })

  it('evicts the oldest samples when the public telemetry budget is reached', () => {
    const source = runtimeParticles(100, 0, true)
    const buffer = new GifTelemetryBuffer([], [], [source], 45_000)
    for (let frame = 0; frame < 10; frame += 1) {
      buffer.append(frame, [], [], [runtimeParticles(100, frame, true)])
    }

    const status = buffer.getStatus()
    expect(status).toMatchObject({ kind: 'ready', historyTruncated: true, endTime: 9 })
    if (status.kind === 'ready') {
      expect(status.startTime).toBeGreaterThan(0)
      expect(status.allocatedBytes).toBeLessThanOrEqual(status.telemetryBudgetBytes)
    }
  })
})
