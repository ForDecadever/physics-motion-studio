export const CURRENT_SCHEMA_VERSION = 7 as const
export const CURRENT_APP_VERSION = '1.2.0'

export type EntityId = string
export type LayerId = string
export type ChartId = string
export type ChartSeriesId = string

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

export interface BezierPathNode {
  anchor: Vec2
  inHandle: Vec2
  outHandle: Vec2
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
  collisionSide: 'both'
  normalFlipped: false
}

export type GroundEndpointKey = 'start' | 'end'

export interface GroundEndpointRef {
  groundId: EntityId
  endpoint: GroundEndpointKey
}

export type GroundJointTransition =
  | { mode: 'auto'; directionFlipped: boolean }
  | { mode: 'manual'; lengthM: number; directionFlipped: boolean }

export interface GroundJointEntity extends BaseEntity {
  kind: 'groundJoint'
  a: GroundEndpointRef
  b: GroundEndpointRef
  transition: GroundJointTransition
}

export type BodyShape =
  | { type: 'circle'; radius: number; collisionEnabled: boolean }
  | { type: 'box'; width: number; height: number }

export interface BodyEntity extends BaseEntity {
  kind: 'body'
  preset: 'ball' | 'block'
  shape: BodyShape
  transform: Transform2D
  massKg: number
  chargeC: number
  material: Material2D
  initialVelocity: Vec2
  initialAngularVelocityRad: number
  rotationEnabled: boolean
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
  | {
      type: 'circle'
      center: Vec2
      radius: number
      startRad: number
      sweepRad: number
    }
  | { type: 'polygon'; points: Vec2[] }
  | { type: 'bezierPath'; nodes: BezierPathNode[] }

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

export type SceneEntity =
  GroundEntity | GroundJointEntity | BodyEntity | FieldEntity | ConnectorEntity

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
  recordingSampleRate: number
  recordingDurationSeconds: number
}

export type ChartMetricId =
  | 'positionX'
  | 'positionY'
  | 'velocityX'
  | 'velocityY'
  | 'speed'
  | 'acceleration'
  | 'angle'
  | 'angularVelocity'
  | 'netForce'
  | 'kineticEnergy'
  | 'translationalKineticEnergy'
  | 'rotationalKineticEnergy'

export type ChartAxisMetricId = 'time' | ChartMetricId

export type ChartAxisDefinition =
  { type: 'metric'; metricId: ChartAxisMetricId } | { type: 'expression'; expression: string }

export interface ChartObjectBinding {
  alias: string
  entityId: EntityId
}

export type ChartLineStyle = 'solid' | 'dashed' | 'dotted'

export interface ChartSeriesDefinition {
  id: ChartSeriesId
  entityId: EntityId
  visible: boolean
  color: string
  lineStyle: ChartLineStyle
  lineWidth: number
}

export interface ChartDefinition {
  id: ChartId
  name: string
  xAxis: ChartAxisDefinition
  yAxis: ChartAxisDefinition
  bindings: ChartObjectBinding[]
  series: ChartSeriesDefinition[]
}

export interface SceneDocument {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION
  appVersion: string
  metadata: SceneMetadata
  settings: SceneSettings
  layers: Layer[]
  entities: SceneEntity[]
  charts: ChartDefinition[]
}
