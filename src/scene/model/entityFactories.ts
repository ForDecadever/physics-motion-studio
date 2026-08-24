import type {
  BezierPathNode,
  BodyEntity,
  ConnectorEndpoint,
  ConnectorEntity,
  FieldEntity,
  ForceEntity,
  GroundEndpointRef,
  GroundEntity,
  GroundJointEntity,
  MeasurementEntity,
  ParticleSourceEntity,
  ParticleSourceShape,
  Vec2,
} from './types'
import { centerBezierPathNodes } from './bodyPath'
import { getEntityCreationDefaults } from './creationDefaults'

type ConnectorEndpointInput = string | ConnectorEndpoint

function connectorEndpoint(input: ConnectorEndpointInput): ConnectorEndpoint {
  return typeof input === 'string'
    ? { type: 'body', bodyId: input, localAnchor: { x: 0, y: 0 } }
    : input
}

function connectorPhysics(collisionEnabled = false) {
  return {
    collisionEnabled,
    radiusM: 0.05,
    massKg: 0,
    material: { friction: 0, restitution: 0 },
  }
}

function baseEntity(_legacyLayerId: string, name: string) {
  return {
    id: crypto.randomUUID(),
    name,
    visible: true,
    locked: false,
    simulationEnabled: true,
  }
}

export function createLineGround(
  layerId: string,
  start: Vec2,
  end: Vec2,
  index: number,
): GroundEntity {
  const defaults = getEntityCreationDefaults().ground
  return {
    ...baseEntity(layerId, `直线地面 ${index}`),
    kind: 'ground',
    geometry: { type: 'line', start, end },
    material: { friction: defaults.friction, restitution: defaults.restitution },
    conveyor: {
      enabled: defaults.conveyorEnabled,
      direction: defaults.conveyorDirection,
      speedMps: defaults.conveyorSpeedMps,
    },
    collisionSide: 'both',
    normalFlipped: false,
  }
}

export function createArcGround(
  layerId: string,
  center: Vec2,
  radius: number,
  startRad: number,
  endRad: number,
  index: number,
): GroundEntity {
  const defaults = getEntityCreationDefaults().ground
  return {
    ...baseEntity(layerId, `圆弧地面 ${index}`),
    kind: 'ground',
    geometry: { type: 'arc', center, radius, startRad, endRad },
    material: { friction: defaults.friction, restitution: defaults.restitution },
    conveyor: {
      enabled: defaults.conveyorEnabled,
      direction: defaults.conveyorDirection,
      speedMps: defaults.conveyorSpeedMps,
    },
    collisionSide: 'both',
    normalFlipped: false,
  }
}

export function createBezierGround(
  layerId: string,
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  index: number,
): GroundEntity {
  const defaults = getEntityCreationDefaults().ground
  return {
    ...baseEntity(layerId, `贝塞尔地面 ${index}`),
    kind: 'ground',
    geometry: { type: 'cubicBezier', p0, p1, p2, p3 },
    material: { friction: defaults.friction, restitution: defaults.restitution },
    conveyor: {
      enabled: defaults.conveyorEnabled,
      direction: defaults.conveyorDirection,
      speedMps: defaults.conveyorSpeedMps,
    },
    collisionSide: 'both',
    normalFlipped: false,
  }
}

export function createGroundJoint(
  layerId: string,
  a: GroundEndpointRef,
  b: GroundEndpointRef,
  index: number,
): GroundJointEntity {
  return {
    ...baseEntity(layerId, `地面连接点 ${index}`),
    kind: 'groundJoint',
    a,
    b,
    transition: { mode: 'auto', directionFlipped: false },
  }
}

export function createBall(
  layerId: string,
  position: Vec2,
  radius: number,
  index: number,
): BodyEntity {
  const defaults = getEntityCreationDefaults().body
  return {
    ...baseEntity(layerId, `小球 ${index}`),
    kind: 'body',
    preset: 'ball',
    color: defaults.ballColor,
    shape: { type: 'circle', radius, collisionEnabled: defaults.ballCollisionEnabled },
    transform: { position, angleRad: 0 },
    massKg: defaults.massKg,
    chargeC: 0,
    material: { friction: defaults.friction, restitution: defaults.restitution },
    initialVelocity: { x: 0, y: 0 },
    initialAngularVelocityRad: 0,
    rotationEnabled: true,
    continuousCollisionDetection: false,
  }
}

export function createBlock(
  layerId: string,
  position: Vec2,
  width: number,
  height: number,
  index: number,
): BodyEntity {
  const defaults = getEntityCreationDefaults().body
  return {
    ...baseEntity(layerId, `物块 ${index}`),
    kind: 'body',
    preset: 'block',
    color: defaults.blockColor,
    shape: { type: 'box', width, height },
    transform: { position, angleRad: 0 },
    massKg: defaults.massKg,
    chargeC: 0,
    material: { friction: defaults.friction, restitution: defaults.restitution },
    initialVelocity: { x: 0, y: 0 },
    initialAngularVelocityRad: 0,
    rotationEnabled: true,
    continuousCollisionDetection: false,
  }
}

export function createBezierBlock(
  layerId: string,
  worldNodes: BezierPathNode[],
  index: number,
): BodyEntity | null {
  const defaults = getEntityCreationDefaults().body
  const centered = centerBezierPathNodes(worldNodes)
  if (!centered.analysis.valid) return null
  return {
    ...baseEntity(layerId, `钢笔物块 ${index}`),
    kind: 'body',
    preset: 'block',
    color: defaults.blockColor,
    shape: { type: 'bezierPath', nodes: centered.nodes },
    transform: { position: centered.center, angleRad: 0 },
    massKg: defaults.massKg,
    chargeC: 0,
    material: { friction: defaults.friction, restitution: defaults.restitution },
    initialVelocity: { x: 0, y: 0 },
    initialAngularVelocityRad: 0,
    rotationEnabled: true,
    continuousCollisionDetection: false,
  }
}

export function createGravityField(
  layerId: string,
  center: Vec2,
  width: number,
  height: number,
  index: number,
): FieldEntity {
  const magnitude = getEntityCreationDefaults().field.gravityMps2
  return {
    ...baseEntity(layerId, `重力场 ${index}`),
    kind: 'field',
    region: { type: 'rectangle', center, width, height, angleRad: 0 },
    field: { type: 'uniformGravity', acceleration: { x: 0, y: -magnitude } },
  }
}

export function createElectricField(
  layerId: string,
  center: Vec2,
  width: number,
  height: number,
  index: number,
): FieldEntity {
  const magnitude = getEntityCreationDefaults().field.electricNPerC
  return {
    ...baseEntity(layerId, `电场 ${index}`),
    kind: 'field',
    region: { type: 'rectangle', center, width, height, angleRad: 0 },
    field: { type: 'uniformElectric', strength: { x: magnitude, y: 0 } },
  }
}

export function createMagneticField(
  layerId: string,
  center: Vec2,
  width: number,
  height: number,
  index: number,
): FieldEntity {
  const magnitude = getEntityCreationDefaults().field.magneticTesla
  return {
    ...baseEntity(layerId, `磁场 ${index}`),
    kind: 'field',
    region: { type: 'rectangle', center, width, height, angleRad: 0 },
    field: { type: 'uniformMagnetic', bzTesla: magnitude },
  }
}

export function createParticleSource(
  layerId: string,
  shape: ParticleSourceShape,
  index: number,
): ParticleSourceEntity {
  const defaults = getEntityCreationDefaults().particleSource
  return {
    ...baseEntity(layerId, `粒子源 ${index}`),
    kind: 'particleSource',
    shape,
    directionRad: 0,
    spreadRad: 0,
    densityPerDegree: 3,
    flipEmission: false,
    continuousEmission: {
      enabled: false,
      simultaneous: false,
      intervalSeconds: 1,
      lifetimeSeconds: 60,
    },
    speedMps: defaults.speedMps,
    chargeC: defaults.chargeC,
    massKg: defaults.massKg,
    coulombEnabled: true,
  }
}

export function createForce(
  layerId: string,
  bodyId: string,
  localAnchor: Vec2,
  index: number,
): ForceEntity {
  const defaults = getEntityCreationDefaults().force
  return {
    ...baseEntity(layerId, `力 ${index}`),
    kind: 'force',
    bodyId,
    localAnchor,
    magnitudeN: defaults.magnitudeN,
    directionRad: defaults.directionRad,
  }
}

export function createMarkerMeasurement(
  layerId: string,
  points: Vec2[],
  index: number,
  color = '#ffd166',
  lineWidthM = 0.04,
): MeasurementEntity {
  return {
    ...baseEntity(layerId, `记号 ${index}`),
    kind: 'measurement',
    simulationEnabled: false,
    measurement: { type: 'marker', points, color, lineWidthM },
  }
}

export function createRulerMeasurement(
  layerId: string,
  a: Vec2,
  b: Vec2,
  index: number,
): MeasurementEntity {
  return {
    ...baseEntity(layerId, `直尺 ${index}`),
    kind: 'measurement',
    simulationEnabled: false,
    measurement: { type: 'ruler', a, b },
  }
}

export function createProtractorMeasurement(
  layerId: string,
  a: Vec2,
  vertex: Vec2,
  b: Vec2,
  index: number,
): MeasurementEntity {
  return {
    ...baseEntity(layerId, `量角器 ${index}`),
    kind: 'measurement',
    simulationEnabled: false,
    measurement: { type: 'protractor', a, vertex, b },
  }
}

export function createRope(
  layerId: string,
  firstEndpoint: ConnectorEndpointInput,
  secondEndpoint: ConnectorEndpointInput,
  length: number,
  index: number,
): ConnectorEntity {
  return {
    ...baseEntity(layerId, `绳 ${index}`),
    kind: 'connector',
    a: connectorEndpoint(firstEndpoint),
    b: connectorEndpoint(secondEndpoint),
    connector: { type: 'rope', maxLength: length },
    ...connectorPhysics(),
  }
}

export function createRod(
  layerId: string,
  firstEndpoint: ConnectorEndpointInput,
  secondEndpoint: ConnectorEndpointInput,
  length: number,
  index: number,
): ConnectorEntity {
  return {
    ...baseEntity(layerId, `杆 ${index}`),
    kind: 'connector',
    a: connectorEndpoint(firstEndpoint),
    b: connectorEndpoint(secondEndpoint),
    connector: { type: 'rod', length, endpointRotation: { a: 'free', b: 'free' } },
    ...connectorPhysics(),
  }
}

export function createSpring(
  layerId: string,
  firstEndpoint: ConnectorEndpointInput,
  secondEndpoint: ConnectorEndpointInput,
  restLength: number,
  index: number,
): ConnectorEntity {
  return {
    ...baseEntity(layerId, `弹簧 ${index}`),
    kind: 'connector',
    a: connectorEndpoint(firstEndpoint),
    b: connectorEndpoint(secondEndpoint),
    connector: { type: 'spring', restLength, stiffness: 20, damping: 0 },
    ...connectorPhysics(false),
  }
}
