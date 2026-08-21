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

export interface RuntimeConnectorState {
  entityId: EntityId
  points: Vec2[]
}

export interface RuntimeIonState {
  t: number
  position: Vec2
}

export interface RuntimeParticleSourceState {
  entityId: EntityId
  ions: RuntimeIonState[]
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
  | {
      kind: 'blocked'
      reason: 'connector-point-limit'
      pointCount: number
      maxPoints: number
    }
  | {
      kind: 'blocked'
      reason: 'particle-ion-limit'
      ionCount: number
      maxIons: number
    }

export interface GifHistorySnapshot {
  requestId: number
  status: GifHistoryStatus
  sampleRate: number
  bodyIds: EntityId[]
  times: Float32Array
  values: Float32Array
  connectorIds: EntityId[]
  connectorPointOffsets: Uint32Array
  connectorValues: Float32Array
  particleIonCount: number
  particleIonTs: Float32Array
  particleValues: Float32Array
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
      connectors: RuntimeConnectorState[]
      particleSources: RuntimeParticleSourceState[]
      samples: RuntimeSample[]
    }
  | { type: 'gifHistoryStatus'; status: GifHistoryStatus }
  | { type: 'gifHistorySnapshot'; snapshot: GifHistorySnapshot }
  | { type: 'warning'; message: string; entityId?: EntityId }
  | { type: 'fatalError'; message: string }
