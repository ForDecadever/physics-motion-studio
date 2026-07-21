export const CURRENT_SCHEMA_VERSION = 1 as const

export type EntityId = string
export type LayerId = string

export interface Vec2 {
  x: number
  y: number
}

export interface Transform2D {
  position: Vec2
  angleRad: number
}

export interface Material2D {
  friction: number
  restitution: number
}

export interface Layer {
  id: LayerId
  name: string
  visible: boolean
  locked: boolean
}

export interface BaseEntity {
  id: EntityId
  name: string
  layerId: LayerId
  visible: boolean
  locked: boolean
  simulationEnabled: boolean
}

export type GroundGeometry =
  | { type: 'line'; start: Vec2; end: Vec2 }
  | {
      type: 'arc'
      center: Vec2
      radius: number
      startRad: number
      endRad: number
    }
  | {
      type: 'cubicBezier'
      p0: Vec2
      p1: Vec2
      p2: Vec2
      p3: Vec2
    }

export interface GroundEntity extends BaseEntity {
  kind: 'ground'
  geometry: GroundGeometry
  material: Material2D
  collisionSide: 'normal' | 'both'
  normalFlipped: boolean
}

export type BodyShape =
  | {
      type: 'particle'
      collisionRadius: number
      collisionEnabled: boolean
    }
  | { type: 'circle'; radius: number }
  | { type: 'box'; width: number; height: number }

export interface BodyEntity extends BaseEntity {
  kind: 'body'
  preset: 'particle' | 'ball' | 'block' | 'pointCharge'
  shape: BodyShape
  transform: Transform2D
  massKg: number
  chargeC: number
  material: Material2D
  initialVelocity: Vec2
  initialAngularVelocityRad: number
  continuousCollisionDetection: boolean
}

export type FieldRegion =
  | { type: 'infinite' }
  | {
      type: 'rectangle'
      center: Vec2
      width: number
      height: number
      angleRad: number
    }
  | { type: 'circle'; center: Vec2; radius: number }
  | { type: 'polygon'; points: Vec2[] }

export type FieldDefinition =
  | { type: 'uniformGravity'; acceleration: Vec2 }
  | { type: 'uniformElectric'; strength: Vec2 }
  | { type: 'uniformMagnetic'; bzTesla: number }

export interface FieldEntity extends BaseEntity {
  kind: 'field'
  region: FieldRegion
  field: FieldDefinition
}

export interface ConnectorEndpoint {
  bodyId: EntityId
  localAnchor: Vec2
}

export type ConnectorDefinition =
  | { type: 'rope'; maxLength: number }
  | { type: 'rod'; length: number; freeRotation: boolean }
  | {
      type: 'spring'
      restLength: number
      stiffness: number
      damping: number
    }

export interface ConnectorEntity extends BaseEntity {
  kind: 'connector'
  a: ConnectorEndpoint
  b: ConnectorEndpoint
  connector: ConnectorDefinition
}

export type SceneEntity = GroundEntity | BodyEntity | FieldEntity | ConnectorEntity

export interface SceneMetadata {
  name: string
  createdAt: string
  updatedAt: string
}

export interface SceneSettings {
  fixedTimeStep: number
  gridStep: number
  snapStep: number
  pairwiseElectrostatics: boolean
}

export interface SceneDocument {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION
  appVersion: string
  metadata: SceneMetadata
  settings: SceneSettings
  layers: Layer[]
  entities: SceneEntity[]
}
