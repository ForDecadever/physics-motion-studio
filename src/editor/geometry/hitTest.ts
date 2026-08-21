import type {
  BodyEntity,
  EntityId,
  GroundEndpointRef,
  GroundEntity,
  SceneDocument,
  SceneEntity,
  Vec2,
} from '../../scene/model/types'
import {
  pointInBooleanGeometry,
  resolveBooleanScene,
  transformBooleanBodyGeometry,
  type ResolvedBooleanResult,
} from '../../scene/model/booleanGeometry'
import { angleWithinSweep } from '../../physics/core/fieldRegions'
import type { RuntimeBodyState, RuntimeConnectorState } from '../../physics/worker/messages'
import { sampleClosedBezierPath } from '../../scene/model/bezierPath'
import { sampleAdaptiveClosedBezierPath } from '../../scene/model/bodyPath'
import { findBooleanNode } from '../../scene/model/booleanLayerGraph'
import { resolveGroundEndpoint, resolveGroundJoint } from '../../scene/model/groundEndpoints'
import {
  buildGroundPathNetwork,
  type GroundPath,
  type GroundPathNetwork,
} from '../../scene/model/groundPath'
import { snapPoint } from '../camera/viewport'
import {
  add,
  distance,
  getEntityBounds,
  resolveConnectorEndpoint,
  rotateVector,
  sampleBezier,
  subtract,
} from './entityGeometry'

export interface GridSnapStep {
  step: number
}

export function snappedGroundPathRatio(
  path: Pick<GroundPath, 'length' | 'closestPoint'>,
  point: Vec2,
  gridSnap: GridSnapStep | null,
): number {
  const snappedPoint = gridSnap ? snapPoint(point, gridSnap.step) : point
  return path.length > 0 ? path.closestPoint(snappedPoint).s / path.length : 0
}

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
  if (entity.shape.type === 'bezierPath') {
    return pointInPolygon(local, sampleAdaptiveClosedBezierPath(entity.shape.nodes))
  }
  return Math.hypot(local.x, local.y) <= entity.shape.radius
}

export interface GroundEndpointHit {
  ground: GroundEntity
  reference: GroundEndpointRef
  position: Vec2
}

export function findNearestGroundEndpoint(
  entities: readonly SceneEntity[],
  point: Vec2,
  tolerance: number,
  excludedGroundIds: ReadonlySet<EntityId> = new Set(),
  endpointIsEligible: (reference: GroundEndpointRef) => boolean = () => true,
): GroundEndpointHit | null {
  let nearest: GroundEndpointHit | null = null
  let nearestDistance = tolerance + Number.EPSILON

  for (let index = entities.length - 1; index >= 0; index -= 1) {
    const ground = entities[index]
    if (
      !ground ||
      ground.kind !== 'ground' ||
      ground.locked ||
      !ground.visible ||
      excludedGroundIds.has(ground.id)
    ) {
      continue
    }
    for (const endpoint of ['start', 'end'] as const) {
      const reference = { groundId: ground.id, endpoint }
      if (!endpointIsEligible(reference)) continue
      const resolved = resolveGroundEndpoint(entities, reference)
      if (!resolved) continue
      const candidateDistance = distance(point, resolved.position)
      if (candidateDistance < nearestDistance) {
        nearestDistance = candidateDistance
        nearest = { ground, reference, position: resolved.position }
      }
    }
  }

  return nearest
}

export function findNearestUnoccupiedGroundEndpoint(
  entities: readonly SceneEntity[],
  point: Vec2,
  tolerance: number,
): GroundEndpointHit | null {
  return findNearestGroundEndpoint(entities, point, tolerance, new Set(), (reference) =>
    entities.every(
      (entity) =>
        entity.kind !== 'groundJoint' ||
        !(
          (entity.a.groundId === reference.groundId && entity.a.endpoint === reference.endpoint) ||
          (entity.b.groundId === reference.groundId && entity.b.endpoint === reference.endpoint)
        ),
    ),
  )
}

export function hitTestEntity(
  entity: SceneEntity,
  allEntities: SceneEntity[],
  point: Vec2,
  tolerance: number,
  groundPathNetwork?: GroundPathNetwork,
  runtimeConnectors: Record<EntityId, RuntimeConnectorState> = {},
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
    if (region.type === 'circle') {
      const offset = subtract(point, region.center)
      return (
        distance(point, region.center) <= region.radius &&
        angleWithinSweep(Math.atan2(offset.y, offset.x), region.startRad, region.sweepRad)
      )
    }
    if (region.type === 'polygon') return pointInPolygon(point, region.points)
    if (region.type === 'bezierPath') {
      return pointInPolygon(point, sampleClosedBezierPath(region.nodes))
    }
    const local = rotateVector(subtract(point, region.center), -region.angleRad)
    return Math.abs(local.x) <= region.width / 2 && Math.abs(local.y) <= region.height / 2
  }
  if (entity.kind === 'particleSource') {
    if (entity.shape.type === 'point') {
      return distance(point, entity.shape.position) <= tolerance
    }
    return distanceToSegment(point, entity.shape.start, entity.shape.end) <= tolerance
  }

  if (entity.kind === 'groundJoint') {
    const transitionPath = (
      groundPathNetwork ?? buildGroundPathNetwork(allEntities)
    ).jointPaths.get(entity.id)?.path
    if ((transitionPath?.closestPoint(point).distance ?? Infinity) <= tolerance) return true
    const resolved = resolveGroundJoint(allEntities, entity)
    const positions = [resolved.a?.position, resolved.b?.position].filter(
      (position): position is Vec2 => Boolean(position),
    )
    if (positions.some((position) => distance(point, position) <= tolerance)) return true
    return Boolean(
      resolved.a &&
      resolved.b &&
      resolved.issue &&
      distanceToSegment(point, resolved.a.position, resolved.b.position) <= tolerance,
    )
  }

  const runtimePoints = runtimeConnectors[entity.id]?.points
  if (runtimePoints && runtimePoints.length >= 2) {
    return runtimePoints.some((next, index) => {
      const previous = runtimePoints[index - 1]
      return previous ? distanceToSegment(point, previous, next) <= tolerance : false
    })
  }
  const start = resolveConnectorEndpoint(allEntities, entity.a)
  const end = resolveConnectorEndpoint(allEntities, entity.b)
  return Boolean(start && end && distanceToSegment(point, start, end) <= tolerance)
}

export function findTopEntity(
  entities: SceneEntity[],
  point: Vec2,
  tolerance: number,
  runtimeConnectors: Record<EntityId, RuntimeConnectorState> = {},
): SceneEntity | null {
  const visualOrder: SceneEntity['kind'][] = [
    'body',
    'particleSource',
    'groundJoint',
    'connector',
    'ground',
    'field',
  ]
  const groundPathNetwork = entities.some((entity) => entity.kind === 'groundJoint')
    ? buildGroundPathNetwork(entities)
    : undefined
  for (const kind of visualOrder) {
    for (let index = entities.length - 1; index >= 0; index -= 1) {
      const entity = entities[index]
      if (
        entity?.kind === kind &&
        hitTestEntity(entity, entities, point, tolerance, groundPathNetwork, runtimeConnectors)
      ) {
        return entity
      }
    }
  }
  return null
}

export function findTopBooleanResult(
  scene: SceneDocument,
  point: Vec2,
  runtimeBodies: Record<EntityId, RuntimeBodyState> = {},
): ResolvedBooleanResult | null {
  const roots = resolveBooleanScene(scene).roots
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    const result = roots[index]!
    const node = findBooleanNode(scene.rootItems, result.nodeId)
    if (!node?.visible || node.locked) continue
    if (!result.valid) {
      if (result.sourceOutlines.some((outline) => pointInBooleanGeometry(point, outline))) {
        return result
      }
      continue
    }
    const geometry =
      result.kind === 'body'
        ? transformBooleanBodyGeometry(
            result,
            runtimeBodies[result.resultId]?.position,
            runtimeBodies[result.resultId]?.angleRad,
          )
        : result.geometry
    if (pointInBooleanGeometry(point, geometry)) return result
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
