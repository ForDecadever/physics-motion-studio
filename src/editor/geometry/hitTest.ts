import type { BodyEntity, SceneEntity, Vec2 } from '../../scene/model/types'
import {
  add,
  distance,
  getEntityBounds,
  resolveConnectorEndpoint,
  rotateVector,
  sampleBezier,
  subtract,
} from './entityGeometry'

function distanceToSegment(point: Vec2, start: Vec2, end: Vec2): number {
  const segment = subtract(end, start)
  const lengthSquared = segment.x ** 2 + segment.y ** 2
  if (lengthSquared === 0) return distance(point, start)
  const projection = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * segment.x + (point.y - start.y) * segment.y) / lengthSquared,
    ),
  )
  return distance(point, {
    x: start.x + projection * segment.x,
    y: start.y + projection * segment.y,
  })
}

function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false
  for (
    let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current++
  ) {
    const a = polygon[current]
    const b = polygon[previous]
    if (!a || !b) continue
    const crosses =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    if (crosses) inside = !inside
  }
  return inside
}

function hitBody(entity: BodyEntity, point: Vec2): boolean {
  const local = rotateVector(subtract(point, entity.transform.position), -entity.transform.angleRad)
  if (entity.shape.type === 'box') {
    return (
      Math.abs(local.x) <= entity.shape.width / 2 && Math.abs(local.y) <= entity.shape.height / 2
    )
  }
  const radius = entity.shape.type === 'circle' ? entity.shape.radius : entity.shape.collisionRadius
  return Math.hypot(local.x, local.y) <= radius
}

export function hitTestEntity(
  entity: SceneEntity,
  allEntities: SceneEntity[],
  point: Vec2,
  tolerance: number,
): boolean {
  if (!entity.visible || entity.locked) return false
  if (entity.kind === 'body') return hitBody(entity, point)

  if (entity.kind === 'ground') {
    const geometry = entity.geometry
    if (geometry.type === 'line') {
      return distanceToSegment(point, geometry.start, geometry.end) <= tolerance
    }
    const points =
      geometry.type === 'cubicBezier'
        ? sampleBezier(entity)
        : Array.from({ length: 33 }, (_, index) => {
            const angle = geometry.startRad + ((geometry.endRad - geometry.startRad) * index) / 32
            return add(geometry.center, {
              x: Math.cos(angle) * geometry.radius,
              y: Math.sin(angle) * geometry.radius,
            })
          })
    return points.some((next, index) => {
      const previous = points[index - 1]
      return previous ? distanceToSegment(point, previous, next) <= tolerance : false
    })
  }

  if (entity.kind === 'field') {
    const region = entity.region
    if (region.type === 'infinite') return false
    if (region.type === 'circle') return distance(point, region.center) <= region.radius
    if (region.type === 'polygon') return pointInPolygon(point, region.points)
    const local = rotateVector(subtract(point, region.center), -region.angleRad)
    return Math.abs(local.x) <= region.width / 2 && Math.abs(local.y) <= region.height / 2
  }

  const start = resolveConnectorEndpoint(allEntities, entity.a)
  const end = resolveConnectorEndpoint(allEntities, entity.b)
  return Boolean(start && end && distanceToSegment(point, start, end) <= tolerance)
}

export function findTopEntity(
  entities: SceneEntity[],
  point: Vec2,
  tolerance: number,
): SceneEntity | null {
  const visualOrder: SceneEntity['kind'][] = ['body', 'connector', 'ground', 'field']
  for (const kind of visualOrder) {
    for (let index = entities.length - 1; index >= 0; index -= 1) {
      const entity = entities[index]
      if (entity?.kind === kind && hitTestEntity(entity, entities, point, tolerance)) {
        return entity
      }
    }
  }
  return null
}

export function entitiesInsideBounds(
  entities: SceneEntity[],
  start: Vec2,
  end: Vec2,
): SceneEntity[] {
  const selection = {
    minX: Math.min(start.x, end.x),
    minY: Math.min(start.y, end.y),
    maxX: Math.max(start.x, end.x),
    maxY: Math.max(start.y, end.y),
  }

  return entities.filter((entity) => {
    if (entity.locked || !entity.visible || entity.kind === 'connector') return false
    const bounds = getEntityBounds(entity)
    return Boolean(
      bounds &&
      bounds.minX >= selection.minX &&
      bounds.maxX <= selection.maxX &&
      bounds.minY >= selection.minY &&
      bounds.maxY <= selection.maxY,
    )
  })
}
