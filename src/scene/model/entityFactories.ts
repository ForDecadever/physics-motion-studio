import type {
  BezierPathNode,
  BodyEntity,
  ConnectorEndpoint,
  ConnectorEntity,
  FieldEntity,
  GroundEndpointRef,
  GroundEntity,
  GroundJointEntity,
  ParticleSourceEntity,
  ParticleSourceShape,
  Vec2,
} from './types'
import { centerBezierPathNodes } from './bodyPath'

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
  return {
    ...baseEntity(layerId, `直线地面 ${index}`),
    kind: 'ground',
    geometry: { type: 'line', start, end },
    material: { friction: 0, restitution: 0 },
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
  return {
    ...baseEntity(layerId, `圆弧地面 ${index}`),
    kind: 'ground',
    geometry: { type: 'arc', center, radius, startRad, endRad },
    material: { friction: 0, restitution: 0 },
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
  return {
    ...baseEntity(layerId, `贝塞尔地面 ${index}`),
    kind: 'ground',
    geometry: { type: 'cubicBezier', p0, p1, p2, p3 },
    material: { friction: 0, restitution: 0 },
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
  return {
    ...baseEntity(layerId, `小球 ${index}`),
    kind: 'body',
    preset: 'ball',
    shape: { type: 'circle', radius, collisionEnabled: true },
    transform: { position, angleRad: 0 },
    massKg: 1,
    chargeC: 0,
    material: { friction: 0, restitution: 0 },
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
  return {
    ...baseEntity(layerId, `物块 ${index}`),
    kind: 'body',
    preset: 'block',
    shape: { type: 'box', width, height },
    transform: { position, angleRad: 0 },
    massKg: 1,
    chargeC: 0,
    material: { friction: 0, restitution: 0 },
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
  const centered = centerBezierPathNodes(worldNodes)
  if (!centered.analysis.valid) return null
  return {
    ...baseEntity(layerId, `钢笔物块 ${index}`),
    kind: 'body',
    preset: 'block',
    shape: { type: 'bezierPath', nodes: centered.nodes },
    transform: { position: centered.center, angleRad: 0 },
    massKg: 1,
    chargeC: 0,
    material: { friction: 0, restitution: 0 },
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
  return {
    ...baseEntity(layerId, `重力场 ${index}`),
    kind: 'field',
    region: { type: 'rectangle', center, width, height, angleRad: 0 },
    field: { type: 'uniformGravity', acceleration: { x: 0, y: -9.80665 } },
  }
}

export function createElectricField(
  layerId: string,
  center: Vec2,
  width: number,
  height: number,
  index: number,
): FieldEntity {
  return {
    ...baseEntity(layerId, `电场 ${index}`),
    kind: 'field',
    region: { type: 'rectangle', center, width, height, angleRad: 0 },
    field: { type: 'uniformElectric', strength: { x: 1e6, y: 0 } },
  }
}

export function createMagneticField(
  layerId: string,
  center: Vec2,
  width: number,
  height: number,
  index: number,
): FieldEntity {
  return {
    ...baseEntity(layerId, `磁场 ${index}`),
    kind: 'field',
    region: { type: 'rectangle', center, width, height, angleRad: 0 },
    field: { type: 'uniformMagnetic', bzTesla: 1 },
  }
}

export function createParticleSource(
  layerId: string,
  shape: ParticleSourceShape,
  index: number,
): ParticleSourceEntity {
  return {
    ...baseEntity(layerId, `粒子源 ${index}`),
    kind: 'particleSource',
    shape,
    directionRad: 0,
    flipEmission: false,
    speedMps: 1,
    chargeC: 0,
    massKg: 1,
    coulombEnabled: true,
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
