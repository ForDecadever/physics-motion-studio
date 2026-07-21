import { create } from 'zustand'

import type { EntityId, Vec2 } from '../scene/model/types'
import type { RuntimeBodyState, SimulationStatus } from '../physics/worker/messages'

interface SimulationState {
  status: SimulationStatus
  simulationTime: number
  fixedTimeStep: number
  playbackRate: number
  runtimeBodies: Record<EntityId, RuntimeBodyState>
  runtimeTrajectories: Record<EntityId, Vec2[]>
  warnings: string[]
  errorMessage: string | null
  beginInitialization: () => void
  setReady: (fixedTimeStep: number) => void
  setRuntimeState: (
    status: Exclude<SimulationStatus, 'initializing' | 'error'>,
    simulationTime: number,
    playbackRate: number,
  ) => void
  setFrame: (simulationTime: number, bodies: RuntimeBodyState[]) => void
  addWarning: (message: string) => void
  setError: (message: string) => void
}

export const useSimulationStore = create<SimulationState>((set) => ({
  status: 'initializing',
  simulationTime: 0,
  fixedTimeStep: 1 / 120,
  playbackRate: 1,
  runtimeBodies: {},
  runtimeTrajectories: {},
  warnings: [],
  errorMessage: null,
  beginInitialization: () =>
    set({
      status: 'initializing',
      simulationTime: 0,
      runtimeBodies: {},
      runtimeTrajectories: {},
      warnings: [],
      errorMessage: null,
    }),
  setReady: (fixedTimeStep) => set({ status: 'ready', fixedTimeStep }),
  setRuntimeState: (status, simulationTime, playbackRate) =>
    set({ status, simulationTime, playbackRate }),
  setFrame: (simulationTime, bodies) =>
    set((state) => {
      const previousTrajectories =
        simulationTime === 0 || simulationTime < state.simulationTime
          ? {}
          : state.runtimeTrajectories
      const runtimeTrajectories = Object.fromEntries(
        bodies.map((body) => {
          const previous = previousTrajectories[body.entityId] ?? []
          const last = previous.at(-1)
          const next =
            last && last.x === body.position.x && last.y === body.position.y
              ? previous
              : [...previous, { ...body.position }].slice(-1800)
          return [body.entityId, next]
        }),
      )
      return {
        simulationTime,
        runtimeBodies: Object.fromEntries(bodies.map((body) => [body.entityId, body])),
        runtimeTrajectories,
      }
    }),
  addWarning: (message) => set((state) => ({ warnings: [...state.warnings, message].slice(-5) })),
  setError: (errorMessage) => set({ status: 'error', errorMessage }),
}))

export function isSimulationRuntimeLocked(
  state: Pick<SimulationState, 'status' | 'simulationTime'>,
): boolean {
  return state.status === 'playing' || state.simulationTime > 0
}
