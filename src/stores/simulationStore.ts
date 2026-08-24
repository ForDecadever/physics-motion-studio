import { create } from 'zustand'

import type { EntityId } from '../scene/model/types'
import type {
  GifHistoryStatus,
  RuntimeBodyState,
  RuntimeConnectorState,
  RuntimeParticleSourceState,
  SimulationStatus,
} from '../physics/worker/messages'
import {
  RuntimeTrajectoryHistory,
  type ReadonlyTrajectory,
  type RuntimeParticleTrajectory,
} from '../physics/trajectory/runtimeTrajectoryHistory'

const runtimeTrajectoryHistory = new RuntimeTrajectoryHistory()

interface SimulationState {
  status: SimulationStatus
  simulationTime: number
  fixedTimeStep: number
  playbackRate: number
  runtimeBodies: Record<EntityId, RuntimeBodyState>
  runtimeConnectors: Record<EntityId, RuntimeConnectorState>
  runtimeTrajectories: Record<EntityId, ReadonlyTrajectory>
  runtimeParticleTrajectories: RuntimeParticleTrajectory[]
  runtimeParticleSources: RuntimeParticleSourceState[]
  gifHistoryStatus: GifHistoryStatus
  warnings: string[]
  errorMessage: string | null
  beginInitialization: () => void
  setReady: (fixedTimeStep: number) => void
  setRuntimeState: (
    status: Exclude<SimulationStatus, 'initializing' | 'error'>,
    simulationTime: number,
    playbackRate: number,
  ) => void
  setFrame: (
    simulationTime: number,
    bodies: RuntimeBodyState[],
    connectors?: RuntimeConnectorState[],
    particleSources?: RuntimeParticleSourceState[],
  ) => void
  setGifHistoryStatus: (status: GifHistoryStatus) => void
  addWarning: (message: string) => void
  setError: (message: string) => void
}

export const useSimulationStore = create<SimulationState>((set) => ({
  status: 'initializing',
  simulationTime: 0,
  fixedTimeStep: 1 / 120,
  playbackRate: 1,
  runtimeBodies: {},
  runtimeConnectors: {},
  runtimeTrajectories: {},
  runtimeParticleTrajectories: [],
  runtimeParticleSources: [],
  gifHistoryStatus: {
    kind: 'ready',
    bodyCount: 0,
    maxBodies: 200,
    sampleCount: 0,
    startTime: 0,
    endTime: 0,
    telemetryBudgetBytes: 512 * 1024 * 1024,
    allocatedBytes: 0,
    historyTruncated: false,
  },
  warnings: [],
  errorMessage: null,
  beginInitialization: () => {
    runtimeTrajectoryHistory.clear()
    set({
      status: 'initializing',
      simulationTime: 0,
      runtimeBodies: {},
      runtimeConnectors: {},
      runtimeTrajectories: {},
      runtimeParticleTrajectories: [],
      runtimeParticleSources: [],
      gifHistoryStatus: {
        kind: 'ready',
        bodyCount: 0,
        maxBodies: 200,
        sampleCount: 0,
        startTime: 0,
        endTime: 0,
        telemetryBudgetBytes: 512 * 1024 * 1024,
        allocatedBytes: 0,
        historyTruncated: false,
      },
      warnings: [],
      errorMessage: null,
    })
  },
  setReady: (fixedTimeStep) => set({ status: 'ready', fixedTimeStep }),
  setRuntimeState: (status, simulationTime, playbackRate) =>
    set({ status, simulationTime, playbackRate }),
  setFrame: (simulationTime, bodies, connectors = [], particleSources = []) =>
    set(() => {
      const histories = runtimeTrajectoryHistory.append(simulationTime, bodies, particleSources)
      return {
        simulationTime,
        runtimeBodies: Object.fromEntries(bodies.map((body) => [body.entityId, body])),
        runtimeConnectors: Object.fromEntries(
          connectors.map((connector) => [connector.entityId, connector]),
        ),
        runtimeTrajectories: histories.bodies,
        runtimeParticleTrajectories: histories.particles,
        runtimeParticleSources: particleSources,
      }
    }),
  setGifHistoryStatus: (gifHistoryStatus) => set({ gifHistoryStatus }),
  addWarning: (message) =>
    set((state) => ({
      warnings: [...state.warnings.filter((warning) => warning !== message), message].slice(-5),
    })),
  setError: (errorMessage) => set({ status: 'error', errorMessage }),
}))

export function getRuntimeTrajectoryHistoryDiagnostics(): {
  allocatedBytes: number
  pointCount: number
  pointCapacity: number
  particlePointCapacity: number
} {
  return {
    allocatedBytes: runtimeTrajectoryHistory.allocatedBytes,
    pointCount: runtimeTrajectoryHistory.pointCount,
    pointCapacity: runtimeTrajectoryHistory.pointCapacity,
    particlePointCapacity: runtimeTrajectoryHistory.particlePointCapacity,
  }
}

export function isSimulationRuntimeLocked(
  state: Pick<SimulationState, 'status' | 'simulationTime'>,
): boolean {
  return state.status === 'playing' || state.simulationTime > 0
}
