export const CURRENT_SCHEMA_VERSION = 22 as const
export const CURRENT_APP_VERSION = '1.6.2'

export type EntityId = string
export type ChartId = string
export type ChartSeriesId = string

export interface Vec2 {
  x: number
  y: number
}

export interface ScalarExpressionDefinition {
  expression: string
  fallbackValue: number
}

export interface GlobalVariableDefinition {
  name: string
  expression: string
  value: number
}

export type EntityNumericProperty =
  | 'transform.position.x'
  | 'transform.position.y'
  | 'transform.angleDegrees'
  | 'groundJoint.transition.lengthM'
  | 'body.shape.radius'
  | 'body.shape.width'
  | 'body.shape.height'
  | 'body.massKg'
  | 'body.chargeC'
  | 'body.material.friction'
  | 'body.material.restitution'
  | 'body.initialVelocity.x'
  | 'body.initialVelocity.y'
  | 'body.initialAngularVelocityRad'
  | 'ground.geometry.radius'
  | 'ground.geometry.startDegrees'
  | 'ground.geometry.endDegrees'
  | `ground.geometry.${'p0' | 'p1' | 'p2' | 'p3'}.${'x' | 'y'}`
  | 'ground.material.friction'
  | 'ground.material.restitution'
  | 'ground.conveyor.speedMps'
  | 'field.region.width'
  | 'field.region.height'
  | 'field.region.radius'
  | 'field.region.startDegrees'
  | 'field.region.sweepDegrees'
  | 'field.gravity.x'
  | 'field.gravity.y'
  | 'force.localAnchor.x'
  | 'force.localAnchor.y'
  | 'measurement.marker.lineWidthM'
  | 'particleSource.directionDegrees'
  | 'particleSource.spreadDegrees'
  | 'particleSource.densityPerDegree'
  | 'particleSource.continuous.intervalSeconds'
  | 'particleSource.continuous.lifetimeSeconds'
  | 'particleSource.speedMps'
  | 'particleSource.chargeC'
  | 'particleSource.massKg'
  | 'connector.length'
  | 'connector.stiffness'
  | 'connector.damping'
  | 'connector.radiusM'
  | 'connector.massKg'
  | 'connector.material.friction'
  | 'connector.material.restitution'
  | `connector.endpoint.${'a' | 'b'}.${'localAnchor' | 'position'}.${'x' | 'y'}`
  | `connector.endpoint.${'a' | 'b'}.pathPercent`

export type BooleanNumericProperty =
  | 'boolean.totalMassKg'
  | 'boolean.totalChargeC'
  | 'boolean.friction'
  | 'boolean.restitution'
  | 'boolean.transform.position.x'
  | 'boolean.transform.position.y'
  | 'boolean.transform.angleDegrees'
  | 'boolean.initialVelocity.x'
  | 'boolean.initialVelocity.y'
  | 'boolean.initialAngularVelocityRad'
  | 'boolean.field.gravity.x'
  | 'boolean.field.gravity.y'

export type SceneNumericProperty =
  | 'settings.gridStep'
  | 'settings.snapStep'
  | 'settings.recordingSampleRate'
  | 'settings.recordingDurationSeconds'

export type PropertyExpressionTarget =
  | { type: 'entity'; entityId: EntityId; property: EntityNumericProperty }
  | { type: 'boolean'; nodeId: string; property: BooleanNumericProperty }
  | { type: 'scene'; property: SceneNumericProperty }

export interface PropertyExpressionBinding {
  id: string
  target: PropertyExpressionTarget
  expression: string
  fallbackValue: number
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
  collapsedHandles?: {
    inOffset: Vec2
    outOffset: Vec2
  }
}

export type BooleanOperation = 'union' | 'intersection' | 'difference'

export interface EntityTreeItem {
  kind: 'entity'
  entityId: EntityId
}

export type BooleanMassDistribution = { mode: 'source' } | { mode: 'uniform'; totalMassKg: number }

export type BooleanChargeDistribution =
  { mode: 'source' } | { mode: 'uniform'; totalChargeC: number }

export type BooleanScalarDistribution = { mode: 'source' } | { mode: 'uniform'; value: number }

export type BooleanFieldDistribution =
  { mode: 'source' } | { mode: 'uniform'; field: FieldDefinition }

export type BooleanInitialVelocity = { mode: 'source' } | { mode: 'override'; value: Vec2 }

export type BooleanInitialAngularVelocity =
  { mode: 'source' } | { mode: 'override'; valueRadPerSecond: number }

export interface BooleanNode {
  kind: 'boolean'
  id: string
  name: string
  visible: boolean
  locked: boolean
  operation: BooleanOperation
  resultId: EntityId
  operands: SceneTreeItem[]
  simulationEnabled: boolean
  rotationEnabled: boolean
  continuousCollisionDetection: boolean
  massDistribution: BooleanMassDistribution
  chargeDistribution: BooleanChargeDistribution
  fieldDistribution: BooleanFieldDistribution
  frictionDistribution: BooleanScalarDistribution
  restitutionDistribution: BooleanScalarDistribution
  initialVelocity: BooleanInitialVelocity
  initialAngularVelocity: BooleanInitialAngularVelocity
}

export type SceneTreeItem = EntityTreeItem | BooleanNode

export interface BaseEntity {
  id: EntityId
  name: string
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

export interface GroundConveyor {
  enabled: boolean
  direction: 'forward' | 'reverse'
  speedMps: number
}

export interface GroundEntity extends BaseEntity {
  kind: 'ground'
  geometry: GroundGeometry
  material: Material2D
  conveyor: GroundConveyor
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
  | { type: 'bezierPath'; nodes: BezierPathNode[] }

export interface BodyEntity extends BaseEntity {
  kind: 'body'
  preset: 'ball' | 'block'
  color: string
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
  | {
      type: 'uniformGravity'
      acceleration: Vec2
      magnitudeExpression?: ScalarExpressionDefinition
    }
  | {
      type: 'uniformElectric'
      strength: Vec2
      componentExpressions?: {
        x?: ScalarExpressionDefinition
        y?: ScalarExpressionDefinition
      }
    }
  | {
      type: 'uniformMagnetic'
      bzTesla: number
      magnitudeExpression?: ScalarExpressionDefinition
    }

export interface FieldEntity extends BaseEntity {
  kind: 'field'
  region: FieldRegion
  field: FieldDefinition
}

export interface BodyConnectorEndpoint {
  type: 'body'
  bodyId: EntityId
  localAnchor: Vec2
}

export interface GroundConnectorEndpoint {
  type: 'ground'
  groundId: EntityId
  pathRatio: number
}

export interface GroundJointConnectorEndpoint {
  type: 'groundJoint'
  groundJointId: EntityId
  pathRatio: number
}

export interface WorldConnectorEndpoint {
  type: 'world'
  position: Vec2
}

export interface FreeConnectorEndpoint {
  type: 'free'
  position: Vec2
}

export type ConnectorEndpoint =
  | BodyConnectorEndpoint
  | GroundConnectorEndpoint
  | GroundJointConnectorEndpoint
  | WorldConnectorEndpoint
  | FreeConnectorEndpoint

export type RodEndpointRotation = 'free' | 'fixed'

export type ConnectorDefinition =
  | { type: 'rope'; maxLength: number }
  | {
      type: 'rod'
      length: number
      endpointRotation: { a: RodEndpointRotation; b: RodEndpointRotation }
    }
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
  collisionEnabled: boolean
  radiusM: number
  massKg: number
  material: Material2D
}

export type ParticleSourceShape =
  { type: 'point'; position: Vec2 } | { type: 'line'; start: Vec2; end: Vec2 }

export interface ParticleSourceEntity extends BaseEntity {
  kind: 'particleSource'
  shape: ParticleSourceShape
  directionRad: number
  spreadRad: number
  densityPerDegree: number
  flipEmission: boolean
  continuousEmission: {
    enabled: boolean
    simultaneous: boolean
    intervalSeconds: number
    lifetimeSeconds: number
  }
  speedMps: number
  chargeC: number
  massKg: number
  coulombEnabled: boolean
}

export interface ForceEntity extends BaseEntity {
  kind: 'force'
  bodyId: EntityId
  localAnchor: Vec2
  magnitudeN: number
  directionRad: number
  magnitudeExpression?: ScalarExpressionDefinition
  directionDegreesExpression?: ScalarExpressionDefinition
}

export type MeasurementDefinition =
  | { type: 'marker'; points: Vec2[]; color: string; lineWidthM: number }
  | { type: 'ruler'; a: Vec2; b: Vec2 }
  | { type: 'protractor'; a: Vec2; vertex: Vec2; b: Vec2 }

export interface MeasurementEntity extends BaseEntity {
  kind: 'measurement'
  measurement: MeasurementDefinition
}

export type SceneEntity =
  | GroundEntity
  | GroundJointEntity
  | BodyEntity
  | FieldEntity
  | ConnectorEntity
  | ParticleSourceEntity
  | ForceEntity
  | MeasurementEntity

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
  globalVariables: GlobalVariableDefinition[]
  propertyExpressions: PropertyExpressionBinding[]
  rootItems: SceneTreeItem[]
  entities: SceneEntity[]
  charts: ChartDefinition[]
}
