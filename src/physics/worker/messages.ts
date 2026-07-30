import type { EntityId, SceneDocument, Vec2 } from '../../scene/model/types'

export type MainToPhysicsMessage =
  | { type: 'initialize'; scene: SceneDocument }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'step' }
  | { type: 'reset' }
  | { type: 'setPlaybackRate'; rate: number }
  | { type: 'setRecordedBodyIds'; entityIds: EntityId[] }
  | { type: 'clearGifHistory' }
  | { type: 'requestGifHistory'; requestId: number }

export interface RuntimeBodyState {
  entityId: EntityId
  position: Vec2
  angleRad: number
  linearVelocity: Vec2
  angularVelocityRad: number
  netForce: Vec2
  acceleration: Vec2
  translationalKineticEnergyJ: number
  rotationalKineticEnergyJ: number
  kineticEnergyJ: number
}

export interface RuntimeSample {
  simulationTime: number
  bodies: RuntimeBodyState[]
}

export type GifHistoryStatus =
  | {
      kind: 'ready'
      bodyCount: number
      maxBodies: number
      sampleCount: number
      startTime: number
      endTime: number
    }
  | {
      kind: 'blocked'
      reason: 'body-limit'
      bodyCount: number
      maxBodies: number
    }

export interface GifHistorySnapshot {
  requestId: number
  status: GifHistoryStatus
  sampleRate: number
  bodyIds: EntityId[]
  times: Float32Array
  values: Float32Array
}

export type SimulationStatus = 'initializing' | 'ready' | 'playing' | 'paused' | 'error'

export type PhysicsToMainMessage =
  | { type: 'ready'; fixedTimeStep: number }
  | {
      type: 'state'
      status: Exclude<SimulationStatus, 'initializing' | 'error'>
      simulationTime: number
      playbackRate: number
    }
  | {
      type: 'frame'
      simulationTime: number
      bodies: RuntimeBodyState[]
      samples: RuntimeSample[]
    }
  | { type: 'gifHistoryStatus'; status: GifHistoryStatus }
  | { type: 'gifHistorySnapshot'; snapshot: GifHistorySnapshot }
  | { type: 'warning'; message: string; entityId?: EntityId }
  | { type: 'fatalError'; message: string }
