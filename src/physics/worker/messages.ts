import type { EntityId, SceneDocument, Vec2 } from '../../scene/model/types'

export type MainToPhysicsMessage =
  | { type: 'initialize'; scene: SceneDocument }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'step' }
  | { type: 'reset' }
  | { type: 'setPlaybackRate'; rate: number }

export interface RuntimeBodyState {
  entityId: EntityId
  position: Vec2
  angleRad: number
  linearVelocity: Vec2
  angularVelocityRad: number
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
  | { type: 'frame'; simulationTime: number; bodies: RuntimeBodyState[] }
  | { type: 'warning'; message: string; entityId?: EntityId }
  | { type: 'fatalError'; message: string }
