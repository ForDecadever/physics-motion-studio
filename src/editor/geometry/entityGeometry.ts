import type {
  BodyEntity,
  ConnectorEndpoint,
  EntityId,
  FieldEntity,
  GroundEntity,
  SceneEntity,
  Vec2,
} from '../../scene/model/types'

export interface EditableTransform {
  position: Vec2
  angleRad: number
}

export interface EntityBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y }
}

export function subtract(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y }
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function rotateVector(vector: Vec2, angleRad: number): Vec2 {
  const cosine = Math.cos(angleRad)
  const sine = Math.sin(angleRad)
  return {
    x: vector.x * cosine - vector.y * sine,
    y: vector.x * sine + vector.y * cosine,
  }
}

export function rotatePoint(point: Vec2, pivot: Vec2, angleRad: number): Vec2 {
  return add(pivot, rotateVector(subtract(point, pivot), angleRad))
}

function average(points: Vec2[]): Vec2 {
  const total = points.reduce((sum, point) => add(sum, point), { x: 0, y: 0 })
  return { x: total.x / points.length, y: total.y / points.length }
}

export function getEntityTransform(entity: SceneEntity): EditableTransform | null {
  if (entity.kind === 'body') return entity.transform

  if (entity.kind === 'ground') {
    const geometry = entity.geometry
    if (geometry.type === 'line') {
      return {
        position: average([geometry.start, geometry.end]),
        angleRad: Math.atan2(geometry.end.y - geometry.start.y, geometry.end.x - geometry.start.x),
      }
    }
    if (geometry.type === 'arc') {
      return { position: geometry.center, angleRad: geometry.startRad }
    }
    return {
      position: average([geometry.p0, geometry.p1, geometry.p2, geometry.p3]),
      angleRad: Math.atan2(geometry.p3.y - geometry.p0.y, geometry.p3.x - geometry.p0.x),
    }
  }

  if (entity.kind === 'field') {
    const region = entity.region
    if (region.type === 'infinite') return null
    if (region.type === 'polygon') {
      return { position: average(region.points), angleRad: 0 }
    }
    return {
      position: region.center,
      angleRad: region.type === 'rectangle' ? region.angleRad : 0,
    }
  }

  return null
}

function moveAndRotatePoint(
  point: Vec2,
  before: EditableTransform,
  after: EditableTransform,
): Vec2 {
  const relative = subtract(point, before.position)
  return add(after.position, rotateVector(relative, after.angleRad - before.angleRad))
}

function transformGround(
  entity: GroundEntity,
  before: EditableTransform,
  after: EditableTransform,
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

function transformField(
  entity: FieldEntity,
  before: EditableTransform,
  after: EditableTransform,
): FieldEntity {
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

  return {
    ...entity,
    region: {
      ...region,
      center: after.position,
      ...(region.type === 'rectangle' ? { angleRad: after.angleRad } : {}),
    },
  }
}

export function withEntityTransform(
  entity: SceneEntity,
  transform: EditableTransform,
): SceneEntity {
  const before = getEntityTransform(entity)
  if (!before) return entity

  if (entity.kind === 'body') {
    return { ...entity, transform }
  }
  if (entity.kind === 'ground') {
    return transformGround(entity, before, transform)
  }
  if (entity.kind === 'field') {
    return transformField(entity, before, transform)
  }
  return entity
}

function bodyCorners(entity: BodyEntity): Vec2[] {
  const { position, angleRad } = entity.transform
  if (entity.shape.type === 'box') {
    const halfWidth = entity.shape.width / 2
    const halfHeight = entity.shape.height / 2
    return [
      { x: -halfWidth, y: -halfHeight },
      { x: halfWidth, y: -halfHeight },
      { x: halfWidth, y: halfHeight },
      { x: -halfWidth, y: halfHeight },
    ].map((corner) => add(position, rotateVector(corner, angleRad)))
  }

  const radius = entity.shape.type === 'circle' ? entity.shape.radius : entity.shape.collisionRadius
  return [
    { x: position.x - radius, y: position.y - radius },
    { x: position.x + radius, y: position.y + radius },
  ]
}

export function sampleBezier(entity: GroundEntity, segments = 32): Vec2[] {
  if (entity.geometry.type !== 'cubicBezier') return []
  const { p0, p1, p2, p3 } = entity.geometry
  const points: Vec2[] = []

  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments
    const inverse = 1 - t
    points.push({
      x:
        inverse ** 3 * p0.x +
        3 * inverse ** 2 * t * p1.x +
        3 * inverse * t ** 2 * p2.x +
        t ** 3 * p3.x,
      y:
        inverse ** 3 * p0.y +
        3 * inverse ** 2 * t * p1.y +
        3 * inverse * t ** 2 * p2.y +
        t ** 3 * p3.y,
    })
  }

  return points
}

function pointsForBounds(entity: SceneEntity): Vec2[] {
  if (entity.kind === 'body') return bodyCorners(entity)
  if (entity.kind === 'ground') {
    const geometry = entity.geometry
    if (geometry.type === 'line') return [geometry.start, geometry.end]
    if (geometry.type === 'cubicBezier') return sampleBezier(entity)
    return [
      { x: geometry.center.x - geometry.radius, y: geometry.center.y - geometry.radius },
      { x: geometry.center.x + geometry.radius, y: geometry.center.y + geometry.radius },
    ]
  }
  if (entity.kind === 'field') {
    const region = entity.region
    if (region.type === 'infinite') return []
    if (region.type === 'polygon') return region.points
    if (region.type === 'circle') {
      return [
        { x: region.center.x - region.radius, y: region.center.y - region.radius },
        { x: region.center.x + region.radius, y: region.center.y + region.radius },
      ]
    }
    const halfWidth = region.width / 2
    const halfHeight = region.height / 2
    return [
      { x: -halfWidth, y: -halfHeight },
      { x: halfWidth, y: -halfHeight },
      { x: halfWidth, y: halfHeight },
      { x: -halfWidth, y: halfHeight },
    ].map((corner) => add(region.center, rotateVector(corner, region.angleRad)))
  }
  return []
}

export function getEntityBounds(entity: SceneEntity): EntityBounds | null {
  const points = pointsForBounds(entity)
  if (points.length === 0) return null
  const xValues = points.map((point) => point.x)
  const yValues = points.map((point) => point.y)
  return {
    minX: Math.min(...xValues),
    minY: Math.min(...yValues),
    maxX: Math.max(...xValues),
    maxY: Math.max(...yValues),
  }
}

export function resolveConnectorEndpoint(
  entities: SceneEntity[],
  endpoint: ConnectorEndpoint,
): Vec2 | null {
  const body = entities.find(
    (entity): entity is BodyEntity => entity.id === endpoint.bodyId && entity.kind === 'body',
  )
  if (!body) return null
  return add(body.transform.position, rotateVector(endpoint.localAnchor, body.transform.angleRad))
}

export function getEntityById(
  entities: SceneEntity[],
  entityId: EntityId,
): SceneEntity | undefined {
  return entities.find((entity) => entity.id === entityId)
}
