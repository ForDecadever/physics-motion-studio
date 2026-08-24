import { ScalarExpressionError } from '../expressions/scalarExpression'
import { bodyLocalAnchorIsInside } from './bodyAnchors'
import { resolveBooleanScene } from './booleanGeometry'
import { findBooleanNode } from './booleanLayerGraph'
import { sceneEntityTransform, withSceneEntityTransform } from './entityTransforms'
import type {
  BooleanNode,
  BooleanNumericProperty,
  ConnectorEndpoint,
  EntityNumericProperty,
  PropertyExpressionBinding,
  PropertyExpressionTarget,
  SceneDocument,
  SceneEntity,
  SceneNumericProperty,
} from './types'

const ENTITY_EXACT_PROPERTIES = new Set<EntityNumericProperty>([
  'transform.position.x',
  'transform.position.y',
  'transform.angleDegrees',
  'groundJoint.transition.lengthM',
  'body.shape.radius',
  'body.shape.width',
  'body.shape.height',
  'body.massKg',
  'body.chargeC',
  'body.material.friction',
  'body.material.restitution',
  'body.initialVelocity.x',
  'body.initialVelocity.y',
  'body.initialAngularVelocityRad',
  'ground.geometry.radius',
  'ground.geometry.startDegrees',
  'ground.geometry.endDegrees',
  'ground.material.friction',
  'ground.material.restitution',
  'ground.conveyor.speedMps',
  'field.region.width',
  'field.region.height',
  'field.region.radius',
  'field.region.startDegrees',
  'field.region.sweepDegrees',
  'field.gravity.x',
  'field.gravity.y',
  'force.localAnchor.x',
  'force.localAnchor.y',
  'measurement.marker.lineWidthM',
  'particleSource.directionDegrees',
  'particleSource.spreadDegrees',
  'particleSource.densityPerDegree',
  'particleSource.continuous.intervalSeconds',
  'particleSource.continuous.lifetimeSeconds',
  'particleSource.speedMps',
  'particleSource.chargeC',
  'particleSource.massKg',
  'connector.length',
  'connector.stiffness',
  'connector.damping',
  'connector.radiusM',
  'connector.massKg',
  'connector.material.friction',
  'connector.material.restitution',
])

const BOOLEAN_PROPERTIES = new Set<BooleanNumericProperty>([
  'boolean.totalMassKg',
  'boolean.totalChargeC',
  'boolean.friction',
  'boolean.restitution',
  'boolean.transform.position.x',
  'boolean.transform.position.y',
  'boolean.transform.angleDegrees',
  'boolean.initialVelocity.x',
  'boolean.initialVelocity.y',
  'boolean.initialAngularVelocityRad',
  'boolean.field.gravity.x',
  'boolean.field.gravity.y',
])

const SCENE_PROPERTIES = new Set<SceneNumericProperty>([
  'settings.gridStep',
  'settings.snapStep',
  'settings.recordingSampleRate',
  'settings.recordingDurationSeconds',
])

const GROUND_POINT_PROPERTY = /^ground\.geometry\.(p[0-3])\.(x|y)$/
const CONNECTOR_ENDPOINT_PROPERTY =
  /^connector\.endpoint\.(a|b)\.(?:(localAnchor|position)\.(x|y)|pathPercent)$/

function degrees(radians: number): number {
  return (radians * 180) / Math.PI
}

function radians(valueDegrees: number): number {
  return (valueDegrees * Math.PI) / 180
}

function validRange(value: number, minimum: number, maximum = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ScalarExpressionError(`表达式结果必须在 ${minimum} 到 ${maximum} 之间。`)
  }
  return value
}

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new ScalarExpressionError('表达式结果必须是有限值。')
  return value
}

export function isEntityNumericProperty(value: string): value is EntityNumericProperty {
  return (
    ENTITY_EXACT_PROPERTIES.has(value as EntityNumericProperty) ||
    GROUND_POINT_PROPERTY.test(value) ||
    CONNECTOR_ENDPOINT_PROPERTY.test(value)
  )
}

export function isBooleanNumericProperty(value: string): value is BooleanNumericProperty {
  return BOOLEAN_PROPERTIES.has(value as BooleanNumericProperty)
}

export function isSceneNumericProperty(value: string): value is SceneNumericProperty {
  return SCENE_PROPERTIES.has(value as SceneNumericProperty)
}

export function isSupportedPropertyExpressionTarget(target: {
  type: string
  property: string
}): boolean {
  if (target.type === 'entity') return isEntityNumericProperty(target.property)
  if (target.type === 'boolean') return isBooleanNumericProperty(target.property)
  return target.type === 'scene' && isSceneNumericProperty(target.property)
}

function connectorEndpointValue(
  endpoint: ConnectorEndpoint,
  property: EntityNumericProperty,
): number | null {
  const match = CONNECTOR_ENDPOINT_PROPERTY.exec(property)
  if (!match) return null
  const pointKind = match[2]
  const axis = match[3] as 'x' | 'y' | undefined
  if (pointKind === 'localAnchor' && endpoint.type === 'body' && axis) {
    return endpoint.localAnchor[axis]
  }
  if (pointKind === 'position' && (endpoint.type === 'world' || endpoint.type === 'free') && axis) {
    return endpoint.position[axis]
  }
  if (!pointKind && (endpoint.type === 'ground' || endpoint.type === 'groundJoint')) {
    return endpoint.pathRatio * 100
  }
  return null
}

function withConnectorEndpointValue(
  endpoint: ConnectorEndpoint,
  property: EntityNumericProperty,
  value: number,
): ConnectorEndpoint | null {
  const match = CONNECTOR_ENDPOINT_PROPERTY.exec(property)
  if (!match) return null
  const pointKind = match[2]
  const axis = match[3] as 'x' | 'y' | undefined
  if (pointKind === 'localAnchor' && endpoint.type === 'body' && axis) {
    return { ...endpoint, localAnchor: { ...endpoint.localAnchor, [axis]: finite(value) } }
  }
  if (pointKind === 'position' && (endpoint.type === 'world' || endpoint.type === 'free') && axis) {
    return { ...endpoint, position: { ...endpoint.position, [axis]: finite(value) } }
  }
  if (!pointKind && (endpoint.type === 'ground' || endpoint.type === 'groundJoint')) {
    return { ...endpoint, pathRatio: validRange(value, 0, 100) / 100 }
  }
  return null
}

function entityNumericValue(entity: SceneEntity, property: EntityNumericProperty): number | null {
  const transform = sceneEntityTransform(entity)
  if (property === 'transform.position.x') return transform?.position.x ?? null
  if (property === 'transform.position.y') return transform?.position.y ?? null
  if (property === 'transform.angleDegrees') return transform ? degrees(transform.angleRad) : null
  if (property === 'groundJoint.transition.lengthM') {
    return entity.kind === 'groundJoint' && entity.transition.mode === 'manual'
      ? entity.transition.lengthM
      : null
  }
  if (property === 'body.shape.radius') {
    return entity.kind === 'body' && entity.shape.type === 'circle' ? entity.shape.radius : null
  }
  if (property === 'body.shape.width') {
    return entity.kind === 'body' && entity.shape.type === 'box' ? entity.shape.width : null
  }
  if (property === 'body.shape.height') {
    return entity.kind === 'body' && entity.shape.type === 'box' ? entity.shape.height : null
  }
  if (property === 'body.massKg') return entity.kind === 'body' ? entity.massKg : null
  if (property === 'body.chargeC') return entity.kind === 'body' ? entity.chargeC : null
  if (property === 'body.material.friction') {
    return entity.kind === 'body' ? entity.material.friction : null
  }
  if (property === 'body.material.restitution') {
    return entity.kind === 'body' ? entity.material.restitution : null
  }
  if (property === 'body.initialVelocity.x') {
    return entity.kind === 'body' ? entity.initialVelocity.x : null
  }
  if (property === 'body.initialVelocity.y') {
    return entity.kind === 'body' ? entity.initialVelocity.y : null
  }
  if (property === 'body.initialAngularVelocityRad') {
    return entity.kind === 'body' ? entity.initialAngularVelocityRad : null
  }
  if (property === 'ground.geometry.radius') {
    return entity.kind === 'ground' && entity.geometry.type === 'arc'
      ? entity.geometry.radius
      : null
  }
  if (property === 'ground.geometry.startDegrees') {
    return entity.kind === 'ground' && entity.geometry.type === 'arc'
      ? degrees(entity.geometry.startRad)
      : null
  }
  if (property === 'ground.geometry.endDegrees') {
    return entity.kind === 'ground' && entity.geometry.type === 'arc'
      ? degrees(entity.geometry.endRad)
      : null
  }
  const groundPoint = GROUND_POINT_PROPERTY.exec(property)
  if (groundPoint && entity.kind === 'ground' && entity.geometry.type === 'cubicBezier') {
    const point = entity.geometry[groundPoint[1] as 'p0' | 'p1' | 'p2' | 'p3']
    return point[groundPoint[2] as 'x' | 'y']
  }
  if (property === 'ground.material.friction') {
    return entity.kind === 'ground' ? entity.material.friction : null
  }
  if (property === 'ground.material.restitution') {
    return entity.kind === 'ground' ? entity.material.restitution : null
  }
  if (property === 'ground.conveyor.speedMps') {
    return entity.kind === 'ground' ? entity.conveyor.speedMps : null
  }
  if (property === 'field.region.width') {
    return entity.kind === 'field' && entity.region.type === 'rectangle'
      ? entity.region.width
      : null
  }
  if (property === 'field.region.height') {
    return entity.kind === 'field' && entity.region.type === 'rectangle'
      ? entity.region.height
      : null
  }
  if (property === 'field.region.radius') {
    return entity.kind === 'field' && entity.region.type === 'circle' ? entity.region.radius : null
  }
  if (property === 'field.region.startDegrees') {
    return entity.kind === 'field' && entity.region.type === 'circle'
      ? degrees(entity.region.startRad)
      : null
  }
  if (property === 'field.region.sweepDegrees') {
    return entity.kind === 'field' && entity.region.type === 'circle'
      ? degrees(entity.region.sweepRad)
      : null
  }
  if (property === 'field.gravity.x') {
    return entity.kind === 'field' && entity.field.type === 'uniformGravity'
      ? entity.field.acceleration.x
      : null
  }
  if (property === 'field.gravity.y') {
    return entity.kind === 'field' && entity.field.type === 'uniformGravity'
      ? entity.field.acceleration.y
      : null
  }
  if (property === 'force.localAnchor.x') {
    return entity.kind === 'force' ? entity.localAnchor.x : null
  }
  if (property === 'force.localAnchor.y') {
    return entity.kind === 'force' ? entity.localAnchor.y : null
  }
  if (property === 'measurement.marker.lineWidthM') {
    return entity.kind === 'measurement' && entity.measurement.type === 'marker'
      ? entity.measurement.lineWidthM
      : null
  }
  if (property === 'particleSource.directionDegrees') {
    return entity.kind === 'particleSource' ? degrees(entity.directionRad) : null
  }
  if (property === 'particleSource.spreadDegrees') {
    return entity.kind === 'particleSource' ? degrees(entity.spreadRad) : null
  }
  if (property === 'particleSource.densityPerDegree') {
    return entity.kind === 'particleSource' ? entity.densityPerDegree : null
  }
  if (property === 'particleSource.continuous.intervalSeconds') {
    return entity.kind === 'particleSource' ? entity.continuousEmission.intervalSeconds : null
  }
  if (property === 'particleSource.continuous.lifetimeSeconds') {
    return entity.kind === 'particleSource' ? entity.continuousEmission.lifetimeSeconds : null
  }
  if (property === 'particleSource.speedMps') {
    return entity.kind === 'particleSource' ? entity.speedMps : null
  }
  if (property === 'particleSource.chargeC') {
    return entity.kind === 'particleSource' ? entity.chargeC : null
  }
  if (property === 'particleSource.massKg') {
    return entity.kind === 'particleSource' ? entity.massKg : null
  }
  if (property === 'connector.length' && entity.kind === 'connector') {
    return entity.connector.type === 'rope'
      ? entity.connector.maxLength
      : entity.connector.type === 'rod'
        ? entity.connector.length
        : entity.connector.restLength
  }
  if (property === 'connector.stiffness') {
    return entity.kind === 'connector' && entity.connector.type === 'spring'
      ? entity.connector.stiffness
      : null
  }
  if (property === 'connector.damping') {
    return entity.kind === 'connector' && entity.connector.type === 'spring'
      ? entity.connector.damping
      : null
  }
  if (property === 'connector.radiusM') return entity.kind === 'connector' ? entity.radiusM : null
  if (property === 'connector.massKg') return entity.kind === 'connector' ? entity.massKg : null
  if (property === 'connector.material.friction') {
    return entity.kind === 'connector' ? entity.material.friction : null
  }
  if (property === 'connector.material.restitution') {
    return entity.kind === 'connector' ? entity.material.restitution : null
  }
  const endpointMatch = CONNECTOR_ENDPOINT_PROPERTY.exec(property)
  if (endpointMatch && entity.kind === 'connector') {
    return connectorEndpointValue(entity[endpointMatch[1] as 'a' | 'b'], property)
  }
  return null
}

function updateEntityNumericProperty(
  entity: SceneEntity,
  property: EntityNumericProperty,
  inputValue: number,
): SceneEntity | null {
  const value = finite(inputValue)
  const transform = sceneEntityTransform(entity)
  if (property === 'transform.position.x' && transform) {
    return withSceneEntityTransform(entity, {
      ...transform,
      position: { ...transform.position, x: value },
    })
  }
  if (property === 'transform.position.y' && transform) {
    return withSceneEntityTransform(entity, {
      ...transform,
      position: { ...transform.position, y: value },
    })
  }
  if (property === 'transform.angleDegrees' && transform) {
    return withSceneEntityTransform(entity, { ...transform, angleRad: radians(value) })
  }
  if (
    property === 'groundJoint.transition.lengthM' &&
    entity.kind === 'groundJoint' &&
    entity.transition.mode === 'manual'
  ) {
    return { ...entity, transition: { ...entity.transition, lengthM: validRange(value, 0) } }
  }
  if (
    property === 'body.shape.radius' &&
    entity.kind === 'body' &&
    entity.shape.type === 'circle'
  ) {
    return { ...entity, shape: { ...entity.shape, radius: validRange(value, 0.001) } }
  }
  if (property === 'body.shape.width' && entity.kind === 'body' && entity.shape.type === 'box') {
    return { ...entity, shape: { ...entity.shape, width: validRange(value, 0.001) } }
  }
  if (property === 'body.shape.height' && entity.kind === 'body' && entity.shape.type === 'box') {
    return { ...entity, shape: { ...entity.shape, height: validRange(value, 0.001) } }
  }
  if (property === 'body.massKg' && entity.kind === 'body') {
    return { ...entity, massKg: validRange(value, Number.EPSILON) }
  }
  if (property === 'body.chargeC' && entity.kind === 'body') return { ...entity, chargeC: value }
  if (property === 'body.material.friction' && entity.kind === 'body') {
    return { ...entity, material: { ...entity.material, friction: validRange(value, 0, 5) } }
  }
  if (property === 'body.material.restitution' && entity.kind === 'body') {
    return { ...entity, material: { ...entity.material, restitution: validRange(value, 0, 1) } }
  }
  if (property === 'body.initialVelocity.x' && entity.kind === 'body') {
    return { ...entity, initialVelocity: { ...entity.initialVelocity, x: value } }
  }
  if (property === 'body.initialVelocity.y' && entity.kind === 'body') {
    return { ...entity, initialVelocity: { ...entity.initialVelocity, y: value } }
  }
  if (property === 'body.initialAngularVelocityRad' && entity.kind === 'body') {
    return { ...entity, initialAngularVelocityRad: value }
  }
  if (
    property === 'ground.geometry.radius' &&
    entity.kind === 'ground' &&
    entity.geometry.type === 'arc'
  ) {
    return { ...entity, geometry: { ...entity.geometry, radius: validRange(value, 0.001) } }
  }
  if (
    property === 'ground.geometry.startDegrees' &&
    entity.kind === 'ground' &&
    entity.geometry.type === 'arc'
  ) {
    return { ...entity, geometry: { ...entity.geometry, startRad: radians(value) } }
  }
  if (
    property === 'ground.geometry.endDegrees' &&
    entity.kind === 'ground' &&
    entity.geometry.type === 'arc'
  ) {
    return { ...entity, geometry: { ...entity.geometry, endRad: radians(value) } }
  }
  const groundPoint = GROUND_POINT_PROPERTY.exec(property)
  if (groundPoint && entity.kind === 'ground' && entity.geometry.type === 'cubicBezier') {
    const pointKey = groundPoint[1] as 'p0' | 'p1' | 'p2' | 'p3'
    const axis = groundPoint[2] as 'x' | 'y'
    return {
      ...entity,
      geometry: {
        ...entity.geometry,
        [pointKey]: { ...entity.geometry[pointKey], [axis]: value },
      },
    }
  }
  if (property === 'ground.material.friction' && entity.kind === 'ground') {
    return { ...entity, material: { ...entity.material, friction: validRange(value, 0, 5) } }
  }
  if (property === 'ground.material.restitution' && entity.kind === 'ground') {
    return { ...entity, material: { ...entity.material, restitution: validRange(value, 0, 1) } }
  }
  if (property === 'ground.conveyor.speedMps' && entity.kind === 'ground') {
    return { ...entity, conveyor: { ...entity.conveyor, speedMps: validRange(value, 0) } }
  }
  if (
    property === 'field.region.width' &&
    entity.kind === 'field' &&
    entity.region.type === 'rectangle'
  ) {
    return { ...entity, region: { ...entity.region, width: validRange(value, 0.001) } }
  }
  if (
    property === 'field.region.height' &&
    entity.kind === 'field' &&
    entity.region.type === 'rectangle'
  ) {
    return { ...entity, region: { ...entity.region, height: validRange(value, 0.001) } }
  }
  if (
    property === 'field.region.radius' &&
    entity.kind === 'field' &&
    entity.region.type === 'circle'
  ) {
    return { ...entity, region: { ...entity.region, radius: validRange(value, 0.001) } }
  }
  if (
    property === 'field.region.startDegrees' &&
    entity.kind === 'field' &&
    entity.region.type === 'circle'
  ) {
    return { ...entity, region: { ...entity.region, startRad: radians(value) } }
  }
  if (
    property === 'field.region.sweepDegrees' &&
    entity.kind === 'field' &&
    entity.region.type === 'circle'
  ) {
    return {
      ...entity,
      region: { ...entity.region, sweepRad: radians(validRange(value, -360, 360)) },
    }
  }
  if (
    property === 'field.gravity.x' &&
    entity.kind === 'field' &&
    entity.field.type === 'uniformGravity'
  ) {
    return {
      ...entity,
      field: { ...entity.field, acceleration: { ...entity.field.acceleration, x: value } },
    }
  }
  if (
    property === 'field.gravity.y' &&
    entity.kind === 'field' &&
    entity.field.type === 'uniformGravity'
  ) {
    return {
      ...entity,
      field: { ...entity.field, acceleration: { ...entity.field.acceleration, y: value } },
    }
  }
  if (property === 'force.localAnchor.x' && entity.kind === 'force') {
    return { ...entity, localAnchor: { ...entity.localAnchor, x: value } }
  }
  if (property === 'force.localAnchor.y' && entity.kind === 'force') {
    return { ...entity, localAnchor: { ...entity.localAnchor, y: value } }
  }
  if (
    property === 'measurement.marker.lineWidthM' &&
    entity.kind === 'measurement' &&
    entity.measurement.type === 'marker'
  ) {
    return {
      ...entity,
      measurement: { ...entity.measurement, lineWidthM: validRange(value, 0.001, 1) },
    }
  }
  if (property === 'particleSource.directionDegrees' && entity.kind === 'particleSource') {
    return { ...entity, directionRad: radians(value) }
  }
  if (property === 'particleSource.spreadDegrees' && entity.kind === 'particleSource') {
    return { ...entity, spreadRad: radians(validRange(value, 0, 360)) }
  }
  if (property === 'particleSource.densityPerDegree' && entity.kind === 'particleSource') {
    return { ...entity, densityPerDegree: validRange(value, 0.01, 10) }
  }
  if (
    property === 'particleSource.continuous.intervalSeconds' &&
    entity.kind === 'particleSource'
  ) {
    return {
      ...entity,
      continuousEmission: {
        ...entity.continuousEmission,
        intervalSeconds: validRange(value, 1 / 120, 3600),
      },
    }
  }
  if (
    property === 'particleSource.continuous.lifetimeSeconds' &&
    entity.kind === 'particleSource'
  ) {
    return {
      ...entity,
      continuousEmission: {
        ...entity.continuousEmission,
        lifetimeSeconds: validRange(value, 1 / 120, 86400),
      },
    }
  }
  if (property === 'particleSource.speedMps' && entity.kind === 'particleSource') {
    return { ...entity, speedMps: validRange(value, 0) }
  }
  if (property === 'particleSource.chargeC' && entity.kind === 'particleSource') {
    return { ...entity, chargeC: value }
  }
  if (property === 'particleSource.massKg' && entity.kind === 'particleSource') {
    return { ...entity, massKg: validRange(value, Number.EPSILON) }
  }
  if (property === 'connector.length' && entity.kind === 'connector') {
    const length = validRange(value, 0.001)
    return {
      ...entity,
      connector:
        entity.connector.type === 'rope'
          ? { ...entity.connector, maxLength: length }
          : entity.connector.type === 'rod'
            ? { ...entity.connector, length }
            : { ...entity.connector, restLength: length },
    }
  }
  if (
    property === 'connector.stiffness' &&
    entity.kind === 'connector' &&
    entity.connector.type === 'spring'
  ) {
    return { ...entity, connector: { ...entity.connector, stiffness: validRange(value, 0) } }
  }
  if (
    property === 'connector.damping' &&
    entity.kind === 'connector' &&
    entity.connector.type === 'spring'
  ) {
    return { ...entity, connector: { ...entity.connector, damping: validRange(value, 0) } }
  }
  if (property === 'connector.radiusM' && entity.kind === 'connector') {
    return { ...entity, radiusM: validRange(value, 0.001) }
  }
  if (property === 'connector.massKg' && entity.kind === 'connector') {
    const minimum = entity.connector.type === 'rope' && entity.collisionEnabled ? 0.001 : 0
    return { ...entity, massKg: validRange(value, minimum) }
  }
  if (property === 'connector.material.friction' && entity.kind === 'connector') {
    return { ...entity, material: { ...entity.material, friction: validRange(value, 0, 5) } }
  }
  if (property === 'connector.material.restitution' && entity.kind === 'connector') {
    return { ...entity, material: { ...entity.material, restitution: validRange(value, 0, 1) } }
  }
  const endpointMatch = CONNECTOR_ENDPOINT_PROPERTY.exec(property)
  if (endpointMatch && entity.kind === 'connector') {
    const endpointKey = endpointMatch[1] as 'a' | 'b'
    const endpoint = withConnectorEndpointValue(entity[endpointKey], property, value)
    return endpoint ? { ...entity, [endpointKey]: endpoint } : null
  }
  return null
}

function booleanField(node: BooleanNode, scene: SceneDocument) {
  if (node.fieldDistribution.mode === 'uniform') return node.fieldDistribution.field
  const result = resolveBooleanScene(scene).byResultId.get(node.resultId)
  return result?.valid && result.kind === 'field' ? result.regions[0]?.field : undefined
}

function booleanNumericValue(
  scene: SceneDocument,
  node: BooleanNode,
  property: BooleanNumericProperty,
): number | null {
  const result = resolveBooleanScene(scene).byResultId.get(node.resultId)
  if (!result?.valid) return null
  if (property === 'boolean.totalMassKg') return result.kind === 'body' ? result.massKg : null
  if (property === 'boolean.totalChargeC') return result.kind === 'body' ? result.chargeC : null
  if (property === 'boolean.friction') {
    return result.kind === 'body' ? (result.materialRegions[0]?.material.friction ?? 0) : null
  }
  if (property === 'boolean.restitution') {
    return result.kind === 'body' ? (result.materialRegions[0]?.material.restitution ?? 0) : null
  }
  if (property === 'boolean.transform.position.x') {
    return result.kind === 'body' ? result.centerOfMass.x : null
  }
  if (property === 'boolean.transform.position.y') {
    return result.kind === 'body' ? result.centerOfMass.y : null
  }
  if (property === 'boolean.transform.angleDegrees') {
    return result.kind === 'body' ? degrees(result.angleRad) : null
  }
  if (property === 'boolean.initialVelocity.x') {
    return result.kind === 'body' ? result.initialVelocity.x : null
  }
  if (property === 'boolean.initialVelocity.y') {
    return result.kind === 'body' ? result.initialVelocity.y : null
  }
  if (property === 'boolean.initialAngularVelocityRad') {
    return result.kind === 'body' ? result.initialAngularVelocityRad : null
  }
  const field = booleanField(node, scene)
  if (property === 'boolean.field.gravity.x') {
    return field?.type === 'uniformGravity' ? field.acceleration.x : null
  }
  return field?.type === 'uniformGravity' ? field.acceleration.y : null
}

function updateBooleanNumericProperty(
  scene: SceneDocument,
  node: BooleanNode,
  property: BooleanNumericProperty,
  value: number,
): BooleanNode | null {
  if (property === 'boolean.totalMassKg') {
    return {
      ...node,
      massDistribution: { mode: 'uniform', totalMassKg: validRange(value, Number.EPSILON) },
    }
  }
  if (property === 'boolean.totalChargeC') {
    return { ...node, chargeDistribution: { mode: 'uniform', totalChargeC: finite(value) } }
  }
  if (property === 'boolean.friction') {
    return { ...node, frictionDistribution: { mode: 'uniform', value: validRange(value, 0, 5) } }
  }
  if (property === 'boolean.restitution') {
    return { ...node, restitutionDistribution: { mode: 'uniform', value: validRange(value, 0, 1) } }
  }
  const result = resolveBooleanScene(scene).byResultId.get(node.resultId)
  if (!result?.valid || result.kind !== 'body') {
    if (!property.startsWith('boolean.field.gravity.')) return null
  }
  if (property === 'boolean.initialVelocity.x' && result?.valid && result.kind === 'body') {
    return {
      ...node,
      initialVelocity: {
        mode: 'override',
        value: { x: finite(value), y: result.initialVelocity.y },
      },
    }
  }
  if (property === 'boolean.initialVelocity.y' && result?.valid && result.kind === 'body') {
    return {
      ...node,
      initialVelocity: {
        mode: 'override',
        value: { x: result.initialVelocity.x, y: finite(value) },
      },
    }
  }
  if (property === 'boolean.initialAngularVelocityRad') {
    return {
      ...node,
      initialAngularVelocity: { mode: 'override', valueRadPerSecond: finite(value) },
    }
  }
  const field = booleanField(node, scene)
  if (field?.type !== 'uniformGravity') return null
  return {
    ...node,
    fieldDistribution: {
      mode: 'uniform',
      field: {
        ...field,
        acceleration: {
          ...field.acceleration,
          [property.endsWith('.x') ? 'x' : 'y']: finite(value),
        },
      },
    },
  }
}

function replaceBooleanNode(
  items: SceneDocument['rootItems'],
  nodeId: string,
  update: (node: BooleanNode) => BooleanNode,
): { items: SceneDocument['rootItems']; replaced: boolean } {
  let replaced = false
  const itemsAfter = items.map((item) => {
    if (item.kind !== 'boolean') return item
    if (item.id === nodeId) {
      replaced = true
      return update(item)
    }
    const nested = replaceBooleanNode(item.operands, nodeId, update)
    if (!nested.replaced) return item
    replaced = true
    return { ...item, operands: nested.items }
  })
  return { items: itemsAfter, replaced }
}

export function readNumericPropertyTarget(
  scene: SceneDocument,
  target: PropertyExpressionTarget,
): number | null {
  if (target.type === 'entity') {
    const entity = scene.entities.find((candidate) => candidate.id === target.entityId)
    return entity ? entityNumericValue(entity, target.property) : null
  }
  if (target.type === 'boolean') {
    const node = findBooleanNode(scene.rootItems, target.nodeId)
    return node ? booleanNumericValue(scene, node, target.property) : null
  }
  return scene.settings[
    target.property.replace('settings.', '') as keyof SceneDocument['settings']
  ] as number | null
}

export function applyNumericPropertyTarget(
  scene: SceneDocument,
  target: PropertyExpressionTarget,
  value: number,
): SceneDocument {
  finite(value)
  if (target.type === 'entity') {
    let replaced = false
    const entities = scene.entities.map((entity) => {
      if (entity.id !== target.entityId) return entity
      const next = updateEntityNumericProperty(entity, target.property, value)
      if (!next) throw new ScalarExpressionError('这个属性表达式与目标实体类型不匹配。')
      const endpointMatch = CONNECTOR_ENDPOINT_PROPERTY.exec(target.property)
      if (next.kind === 'connector' && endpointMatch?.[2] === 'localAnchor') {
        const endpoint = next[endpointMatch[1] as 'a' | 'b']
        if (endpoint.type === 'body') {
          const body = scene.entities.find(
            (candidate) => candidate.kind === 'body' && candidate.id === endpoint.bodyId,
          )
          if (body?.kind === 'body' && !bodyLocalAnchorIsInside(body, endpoint.localAnchor)) {
            throw new ScalarExpressionError('连接器局部锚点的表达式结果必须位于目标物体内。')
          }
        }
      }
      replaced = true
      return next
    })
    if (!replaced) throw new ScalarExpressionError('属性表达式引用的实体不存在。')
    return { ...scene, entities }
  }
  if (target.type === 'boolean') {
    if (target.property.startsWith('boolean.transform.')) {
      const node = findBooleanNode(scene.rootItems, target.nodeId)
      const result = node ? resolveBooleanScene(scene).byResultId.get(node.resultId) : undefined
      if (!result?.valid || result.kind !== 'body') {
        throw new ScalarExpressionError('这个变换表达式与布尔结果类型不匹配。')
      }
      const position = {
        x:
          target.property === 'boolean.transform.position.x'
            ? finite(value)
            : result.centerOfMass.x,
        y:
          target.property === 'boolean.transform.position.y'
            ? finite(value)
            : result.centerOfMass.y,
      }
      const angleRad =
        target.property === 'boolean.transform.angleDegrees' ? radians(value) : result.angleRad
      const angleDelta = angleRad - result.angleRad
      const cosine = Math.cos(angleDelta)
      const sine = Math.sin(angleDelta)
      const sourceIds = new Set(result.sourceEntityIds)
      const entities = scene.entities.map((entity) => {
        if (!sourceIds.has(entity.id)) return entity
        const transform = sceneEntityTransform(entity)
        if (!transform) return entity
        const offsetX = transform.position.x - result.centerOfMass.x
        const offsetY = transform.position.y - result.centerOfMass.y
        return withSceneEntityTransform(entity, {
          position: {
            x: position.x + offsetX * cosine - offsetY * sine,
            y: position.y + offsetX * sine + offsetY * cosine,
          },
          angleRad: transform.angleRad + angleDelta,
        })
      })
      return { ...scene, entities }
    }
    const result = replaceBooleanNode(scene.rootItems, target.nodeId, (node) => {
      const next = updateBooleanNumericProperty(scene, node, target.property, value)
      if (!next) throw new ScalarExpressionError('这个属性表达式与布尔结果类型不匹配。')
      return next
    })
    if (!result.replaced) throw new ScalarExpressionError('属性表达式引用的布尔结果不存在。')
    return { ...scene, rootItems: result.items }
  }
  if (target.property === 'settings.gridStep') {
    return {
      ...scene,
      settings: { ...scene.settings, gridStep: validRange(value, Number.EPSILON) },
    }
  }
  if (target.property === 'settings.snapStep') {
    return {
      ...scene,
      settings: { ...scene.settings, snapStep: validRange(value, Number.EPSILON) },
    }
  }
  if (target.property === 'settings.recordingSampleRate') {
    const next = validRange(value, 1, 120)
    if (!Number.isInteger(next)) throw new ScalarExpressionError('记录频率必须是整数。')
    return { ...scene, settings: { ...scene.settings, recordingSampleRate: next } }
  }
  const next = validRange(value, 1, 3600)
  if (!Number.isInteger(next)) throw new ScalarExpressionError('记录时长必须是整数秒。')
  return { ...scene, settings: { ...scene.settings, recordingDurationSeconds: next } }
}

export function removeChangedNumericBindings(
  before: SceneDocument,
  after: SceneDocument,
  scope: (binding: PropertyExpressionBinding) => boolean,
): SceneDocument {
  const propertyExpressions = before.propertyExpressions.filter((binding) => {
    if (!scope(binding)) return true
    const beforeValue = readNumericPropertyTarget(before, binding.target)
    const afterValue = readNumericPropertyTarget(after, binding.target)
    return beforeValue !== null && afterValue !== null && Object.is(beforeValue, afterValue)
  })
  return propertyExpressions.length === after.propertyExpressions.length
    ? after
    : { ...after, propertyExpressions }
}
