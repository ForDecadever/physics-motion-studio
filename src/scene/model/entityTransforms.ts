import type {
  FieldEntity,
  GroundEntity,
  ParticleSourceEntity,
  SceneEntity,
  Transform2D,
  Vec2,
} from './types'

function add(first: Vec2, second: Vec2): Vec2 {
  return { x: first.x + second.x, y: first.y + second.y }
}

function subtract(first: Vec2, second: Vec2): Vec2 {
  return { x: first.x - second.x, y: first.y - second.y }
}

function rotate(vector: Vec2, angleRad: number): Vec2 {
  const cosine = Math.cos(angleRad)
  const sine = Math.sin(angleRad)
  return {
    x: vector.x * cosine - vector.y * sine,
    y: vector.x * sine + vector.y * cosine,
  }
}

function average(points: readonly Vec2[]): Vec2 {
  const total = points.reduce((sum, point) => add(sum, point), { x: 0, y: 0 })
  return { x: total.x / points.length, y: total.y / points.length }
}

export function sceneEntityTransform(entity: SceneEntity): Transform2D | null {
  if (entity.kind === 'body') return entity.transform
  if (entity.kind === 'ground') {
    const geometry = entity.geometry
    if (geometry.type === 'line') {
      return {
        position: average([geometry.start, geometry.end]),
        angleRad: Math.atan2(geometry.end.y - geometry.start.y, geometry.end.x - geometry.start.x),
      }
    }
    if (geometry.type === 'arc') return { position: geometry.center, angleRad: geometry.startRad }
    return {
      position: average([geometry.p0, geometry.p1, geometry.p2, geometry.p3]),
      angleRad: Math.atan2(geometry.p3.y - geometry.p0.y, geometry.p3.x - geometry.p0.x),
    }
  }
  if (entity.kind === 'field') {
    const region = entity.region
    if (region.type === 'infinite') return null
    if (region.type === 'polygon' || region.type === 'bezierPath') {
      const points =
        region.type === 'polygon' ? region.points : region.nodes.map((node) => node.anchor)
      return points.length > 0 ? { position: average(points), angleRad: 0 } : null
    }
    return {
      position: region.center,
      angleRad:
        region.type === 'rectangle'
          ? region.angleRad
          : region.type === 'circle'
            ? region.startRad
            : 0,
    }
  }
  if (entity.kind === 'particleSource') {
    if (entity.shape.type === 'point') {
      return { position: entity.shape.position, angleRad: entity.directionRad }
    }
    const { start, end } = entity.shape
    return {
      position: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
      angleRad: Math.atan2(end.y - start.y, end.x - start.x),
    }
  }
  return null
}

function moveAndRotatePoint(point: Vec2, before: Transform2D, after: Transform2D): Vec2 {
  return add(
    after.position,
    rotate(subtract(point, before.position), after.angleRad - before.angleRad),
  )
}

function transformGround(
  entity: GroundEntity,
  before: Transform2D,
  after: Transform2D,
): GroundEntity {
  const geometry = entity.geometry
  const angleDelta = after.angleRad - before.angleRad
  if (geometry.type === 'line') {
    return {
      ...entity,
      geometry: {
        ...geometry,
        start: moveAndRotatePoint(geometry.start, before, after),
        end: moveAndRotatePoint(geometry.end, before, after),
      },
    }
  }
  if (geometry.type === 'arc') {
    return {
      ...entity,
      geometry: {
        ...geometry,
        center: after.position,
        startRad: geometry.startRad + angleDelta,
        endRad: geometry.endRad + angleDelta,
      },
    }
  }
  return {
    ...entity,
    geometry: {
      ...geometry,
      p0: moveAndRotatePoint(geometry.p0, before, after),
      p1: moveAndRotatePoint(geometry.p1, before, after),
      p2: moveAndRotatePoint(geometry.p2, before, after),
      p3: moveAndRotatePoint(geometry.p3, before, after),
    },
  }
}

function transformField(entity: FieldEntity, before: Transform2D, after: Transform2D): FieldEntity {
  const region = entity.region
  if (region.type === 'infinite') return entity
  if (region.type === 'polygon') {
    return {
      ...entity,
      region: {
        ...region,
        points: region.points.map((point) => moveAndRotatePoint(point, before, after)),
      },
    }
  }
  if (region.type === 'bezierPath') {
    return {
      ...entity,
      region: {
        ...region,
        nodes: region.nodes.map((node) => ({
          ...node,
          anchor: moveAndRotatePoint(node.anchor, before, after),
          inHandle: moveAndRotatePoint(node.inHandle, before, after),
          outHandle: moveAndRotatePoint(node.outHandle, before, after),
        })),
      },
    }
  }
  return {
    ...entity,
    region: {
      ...region,
      center: after.position,
      ...(region.type === 'rectangle'
        ? { angleRad: after.angleRad }
        : region.type === 'circle'
          ? { startRad: after.angleRad }
          : {}),
    },
  }
}

function transformParticleSource(
  entity: ParticleSourceEntity,
  before: Transform2D,
  after: Transform2D,
): ParticleSourceEntity {
  const angleDelta = after.angleRad - before.angleRad
  if (entity.shape.type === 'point') {
    return {
      ...entity,
      shape: { type: 'point', position: after.position },
      directionRad: entity.directionRad + angleDelta,
    }
  }
  return {
    ...entity,
    shape: {
      type: 'line',
      start: moveAndRotatePoint(entity.shape.start, before, after),
      end: moveAndRotatePoint(entity.shape.end, before, after),
    },
  }
}

export function withSceneEntityTransform(entity: SceneEntity, transform: Transform2D): SceneEntity {
  const before = sceneEntityTransform(entity)
  if (!before) return entity
  if (entity.kind === 'body') return { ...entity, transform }
  if (entity.kind === 'ground') return transformGround(entity, before, transform)
  if (entity.kind === 'field') return transformField(entity, before, transform)
  if (entity.kind === 'particleSource') return transformParticleSource(entity, before, transform)
  return entity
}
