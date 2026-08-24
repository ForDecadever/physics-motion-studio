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
  contactSources?: RuntimeContactSource[]
}

export interface RuntimeContactSource {
  sourceEntityId: EntityId
  sourceKind: 'ground' | 'body' | 'connector'
  direction: Vec2
}

export interface RuntimeConnectorState {
  entityId: EntityId
  points: Vec2[]
}

export interface RuntimeIonState {
  id: number
  t: number
  bornAt: number
  continuous: boolean
  position: Vec2
}

export interface RuntimeParticleSourceState {
  entityId: EntityId
  continuousEmission: boolean
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
      telemetryBudgetBytes: number
      allocatedBytes: number
      historyTruncated: boolean
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
  particleSourceIds: EntityId[]
  particleFrameOffsets: Uint32Array
  particleSourceIndexes: Uint32Array
  particleIonIds: Uint32Array
  particleIonTs: Float32Array
  particleIonBornTimes: Float32Array
  particleIonContinuous: Uint8Array
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
