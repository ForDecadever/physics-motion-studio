import type { BodyEntity, ConnectorEntity, FieldEntity, GroundEntity, LayerId, Vec2 } from './types'

function baseEntity(layerId: LayerId, name: string) {
  return {
    id: crypto.randomUUID(),
    name,
    layerId,
    visible: true,
    locked: false,
    simulationEnabled: true,
  }
}

export function createLineGround(
  layerId: LayerId,
  start: Vec2,
  end: Vec2,
  index: number,
): GroundEntity {
  return {
    ...baseEntity(layerId, `直线地面 ${index}`),
    kind: 'ground',
    geometry: { type: 'line', start, end },
    material: { friction: 0.5, restitution: 0.2 },
    collisionSide: 'normal',
    normalFlipped: false,
  }
}

export function createArcGround(
  layerId: LayerId,
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
    material: { friction: 0.5, restitution: 0.2 },
    collisionSide: 'normal',
    normalFlipped: false,
  }
}

export function createBezierGround(
  layerId: LayerId,
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
    material: { friction: 0.5, restitution: 0.2 },
    collisionSide: 'normal',
    normalFlipped: false,
  }
}

export function createBall(
  layerId: LayerId,
  position: Vec2,
  radius: number,
  index: number,
): BodyEntity {
  return {
    ...baseEntity(layerId, `小球 ${index}`),
    kind: 'body',
    preset: 'ball',
    shape: { type: 'circle', radius },
    transform: { position, angleRad: 0 },
    massKg: 1,
    chargeC: 0,
    material: { friction: 0.4, restitution: 0.5 },
    initialVelocity: { x: 0, y: 0 },
    initialAngularVelocityRad: 0,
    continuousCollisionDetection: false,
  }
}

export function createParticle(
  layerId: LayerId,
  position: Vec2,
  collisionRadius: number,
  index: number,
): BodyEntity {
  return {
    ...baseEntity(layerId, `质点 ${index}`),
    kind: 'body',
    preset: 'particle',
    shape: { type: 'particle', collisionRadius, collisionEnabled: false },
    transform: { position, angleRad: 0 },
    massKg: 1,
    chargeC: 0,
    material: { friction: 0, restitution: 0 },
    initialVelocity: { x: 0, y: 0 },
    initialAngularVelocityRad: 0,
    continuousCollisionDetection: false,
  }
}

export function createPointCharge(
  layerId: LayerId,
  position: Vec2,
  collisionRadius: number,
  index: number,
): BodyEntity {
  return {
    ...baseEntity(layerId, `点电荷 ${index}`),
    kind: 'body',
    preset: 'pointCharge',
    shape: { type: 'particle', collisionRadius, collisionEnabled: false },
    transform: { position, angleRad: 0 },
    massKg: 1,
    chargeC: 1e-6,
    material: { friction: 0, restitution: 0 },
    initialVelocity: { x: 0, y: 0 },
    initialAngularVelocityRad: 0,
    continuousCollisionDetection: false,
  }
}

export function createBlock(
  layerId: LayerId,
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
    material: { friction: 0.5, restitution: 0.2 },
    initialVelocity: { x: 0, y: 0 },
    initialAngularVelocityRad: 0,
    continuousCollisionDetection: false,
  }
}

export function createGravityField(
  layerId: LayerId,
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
  layerId: LayerId,
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
  layerId: LayerId,
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

export function createRope(
  layerId: LayerId,
  firstBodyId: string,
  secondBodyId: string,
  length: number,
  index: number,
): ConnectorEntity {
  return {
    ...baseEntity(layerId, `绳 ${index}`),
    kind: 'connector',
    a: { bodyId: firstBodyId, localAnchor: { x: 0, y: 0 } },
    b: { bodyId: secondBodyId, localAnchor: { x: 0, y: 0 } },
    connector: { type: 'rope', maxLength: length },
  }
}

export function createRod(
  layerId: LayerId,
  firstBodyId: string,
  secondBodyId: string,
  length: number,
  index: number,
): ConnectorEntity {
  return {
    ...baseEntity(layerId, `杆 ${index}`),
    kind: 'connector',
    a: { bodyId: firstBodyId, localAnchor: { x: 0, y: 0 } },
    b: { bodyId: secondBodyId, localAnchor: { x: 0, y: 0 } },
    connector: { type: 'rod', length, freeRotation: true },
  }
}

export function createSpring(
  layerId: LayerId,
  firstBodyId: string,
  secondBodyId: string,
  restLength: number,
  index: number,
): ConnectorEntity {
  return {
    ...baseEntity(layerId, `弹簧 ${index}`),
    kind: 'connector',
    a: { bodyId: firstBodyId, localAnchor: { x: 0, y: 0 } },
    b: { bodyId: secondBodyId, localAnchor: { x: 0, y: 0 } },
    connector: { type: 'spring', restLength, stiffness: 20, damping: 0.5 },
  }
}
