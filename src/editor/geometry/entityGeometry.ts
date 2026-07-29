import type {
  BodyEntity,
  ConnectorEndpoint,
  EntityId,
  FieldEntity,
  GroundEntity,
  SceneEntity,
  Vec2,
} from '../../scene/model/types'
import { sampleClosedBezierPath } from '../../scene/model/bezierPath'

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

export type ScaleHandleId = 'min-min' | 'min-max' | 'max-min' | 'max-max'

export interface ScaleHandle {
  id: ScaleHandleId
  position: Vec2
  cursor: 'nwse-resize' | 'nesw-resize'
}

export interface ScaleHandleGeometry {
  bounds: EntityBounds
  center: Vec2
  handles: ScaleHandle[]
}

export interface ScaleEntitiesResult {
  factor: number
  replacements: SceneEntity[]
}

const MINIMUM_SCALABLE_SIZE_M = 0.001

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y }
}

export function subtract(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y }
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y
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
    if (region.type === 'polygon' || region.type === 'bezierPath') {
      const points =
        region.type === 'polygon' ? region.points : region.nodes.map((node) => node.anchor)
      return { position: average(points), angleRad: 0 }
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

  if (region.type === 'bezierPath') {
    return {
      ...entity,
      region: {
        ...region,
        nodes: region.nodes.map((node) => ({
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

  const radius = entity.shape.radius
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
    if (region.type === 'bezierPath') return sampleClosedBezierPath(region.nodes)
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

export function isScalableEntity(
  entity: SceneEntity,
): entity is BodyEntity | GroundEntity | FieldEntity {
  return entity.kind === 'body' || entity.kind === 'ground' || entity.kind === 'field'
    ? entity.kind !== 'field' || entity.region.type !== 'infinite'
    : false
}

export function getScalableSelectionBounds(
  entities: readonly SceneEntity[],
  selectedIds: readonly EntityId[],
): EntityBounds | null {
  const selected = new Set(selectedIds)
  const bounds = entities
    .filter(
      (entity) =>
        selected.has(entity.id) && entity.visible && !entity.locked && isScalableEntity(entity),
    )
    .map(getEntityBounds)
    .filter((candidate): candidate is EntityBounds => candidate !== null)

  if (bounds.length === 0) return null
  return {
    minX: Math.min(...bounds.map((candidate) => candidate.minX)),
    minY: Math.min(...bounds.map((candidate) => candidate.minY)),
    maxX: Math.max(...bounds.map((candidate) => candidate.maxX)),
    maxY: Math.max(...bounds.map((candidate) => candidate.maxY)),
  }
}

export function createScaleHandleGeometry(
  bounds: EntityBounds,
  padding: number,
): ScaleHandleGeometry {
  const padded = {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  }
  return {
    bounds: padded,
    center: {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    },
    handles: [
      {
        id: 'min-min',
        position: { x: padded.minX, y: padded.minY },
        cursor: 'nesw-resize',
      },
      {
        id: 'min-max',
        position: { x: padded.minX, y: padded.maxY },
        cursor: 'nwse-resize',
      },
      {
        id: 'max-min',
        position: { x: padded.maxX, y: padded.minY },
        cursor: 'nwse-resize',
      },
      {
        id: 'max-max',
        position: { x: padded.maxX, y: padded.maxY },
        cursor: 'nesw-resize',
      },
    ],
  }
}

function scalePointAroundPivot(point: Vec2, pivot: Vec2, factor: number): Vec2 {
  return {
    x: pivot.x + (point.x - pivot.x) * factor,
    y: pivot.y + (point.y - pivot.y) * factor,
  }
}

function scaledEntity(entity: SceneEntity, pivot: Vec2, factor: number): SceneEntity {
  if (entity.kind === 'body') {
    return {
      ...entity,
      transform: {
        ...entity.transform,
        position: scalePointAroundPivot(entity.transform.position, pivot, factor),
      },
      shape:
        entity.shape.type === 'circle'
          ? { ...entity.shape, radius: entity.shape.radius * factor }
          : {
              ...entity.shape,
              width: entity.shape.width * factor,
              height: entity.shape.height * factor,
            },
    }
  }

  if (entity.kind === 'ground') {
    const geometry = entity.geometry
    if (geometry.type === 'line') {
      return {
        ...entity,
        geometry: {
          ...geometry,
          start: scalePointAroundPivot(geometry.start, pivot, factor),
          end: scalePointAroundPivot(geometry.end, pivot, factor),
        },
      }
    }
    if (geometry.type === 'arc') {
      return {
        ...entity,
        geometry: {
          ...geometry,
          center: scalePointAroundPivot(geometry.center, pivot, factor),
          radius: geometry.radius * factor,
        },
      }
    }
    return {
      ...entity,
      geometry: {
        ...geometry,
        p0: scalePointAroundPivot(geometry.p0, pivot, factor),
        p1: scalePointAroundPivot(geometry.p1, pivot, factor),
        p2: scalePointAroundPivot(geometry.p2, pivot, factor),
        p3: scalePointAroundPivot(geometry.p3, pivot, factor),
      },
    }
  }

  if (entity.kind === 'field' && entity.region.type !== 'infinite') {
    const region = entity.region
    if (region.type === 'rectangle') {
      return {
        ...entity,
        region: {
          ...region,
          center: scalePointAroundPivot(region.center, pivot, factor),
          width: region.width * factor,
          height: region.height * factor,
        },
      }
    }
    if (region.type === 'circle') {
      return {
        ...entity,
        region: {
          ...region,
          center: scalePointAroundPivot(region.center, pivot, factor),
          radius: region.radius * factor,
        },
      }
    }
    if (region.type === 'polygon') {
      return {
        ...entity,
        region: {
          ...region,
          points: region.points.map((point) => scalePointAroundPivot(point, pivot, factor)),
        },
      }
    }
    return {
      ...entity,
      region: {
        ...region,
        nodes: region.nodes.map((node) => ({
          anchor: scalePointAroundPivot(node.anchor, pivot, factor),
          inHandle: scalePointAroundPivot(node.inHandle, pivot, factor),
          outHandle: scalePointAroundPivot(node.outHandle, pivot, factor),
        })),
      },
    }
  }

  return entity
}

function positiveMinimum(values: number[]): number | null {
  const positive = values.filter((value) => Number.isFinite(value) && value > Number.EPSILON)
  return positive.length > 0 ? Math.min(...positive) : null
}

function polylineLength(points: Vec2[]): number {
  return points.reduce((length, point, index) => {
    const previous = points[index - 1]
    return previous ? length + distance(previous, point) : length
  }, 0)
}

function minimumScalableMeasure(entity: SceneEntity): number | null {
  if (entity.kind === 'body') {
    return entity.shape.type === 'circle'
      ? entity.shape.radius
      : positiveMinimum([entity.shape.width, entity.shape.height])
  }
  if (entity.kind === 'ground') {
    if (entity.geometry.type === 'line') {
      return distance(entity.geometry.start, entity.geometry.end)
    }
    if (entity.geometry.type === 'arc') return entity.geometry.radius
    return polylineLength(sampleBezier(entity, 64))
  }
  if (entity.kind === 'field' && entity.region.type !== 'infinite') {
    if (entity.region.type === 'rectangle') {
      return positiveMinimum([entity.region.width, entity.region.height])
    }
    if (entity.region.type === 'circle') return entity.region.radius
    const bounds = getEntityBounds(entity)
    return bounds ? positiveMinimum([bounds.maxX - bounds.minX, bounds.maxY - bounds.minY]) : null
  }
  return null
}

export function scaleEntitiesAroundPivot(
  entities: readonly SceneEntity[],
  targetIds: readonly EntityId[],
  pivot: Vec2,
  requestedFactor: number,
): ScaleEntitiesResult {
  const targets = new Set(targetIds)
  const scalable = entities.filter((entity) => targets.has(entity.id) && isScalableEntity(entity))
  if (scalable.length === 0) return { factor: 1, replacements: [] }

  const minimumFactor = scalable.reduce((minimum, entity) => {
    const measure = minimumScalableMeasure(entity)
    return measure && measure > 0 ? Math.max(minimum, MINIMUM_SCALABLE_SIZE_M / measure) : minimum
  }, Number.EPSILON)
  const finiteFactor = Number.isFinite(requestedFactor) ? requestedFactor : 1
  const factor = Math.max(minimumFactor, finiteFactor)
  const scaledBodyIds = new Set(
    scalable.filter((entity) => entity.kind === 'body').map((entity) => entity.id),
  )
  const replacements: SceneEntity[] = scalable.map((entity) => scaledEntity(entity, pivot, factor))

  for (const entity of entities) {
    if (entity.kind !== 'connector') continue
    const scaleA = scaledBodyIds.has(entity.a.bodyId)
    const scaleB = scaledBodyIds.has(entity.b.bodyId)
    if (!scaleA && !scaleB) continue
    replacements.push({
      ...entity,
      a: scaleA
        ? {
            ...entity.a,
            localAnchor: {
              x: entity.a.localAnchor.x * factor,
              y: entity.a.localAnchor.y * factor,
            },
          }
        : entity.a,
      b: scaleB
        ? {
            ...entity.b,
            localAnchor: {
              x: entity.b.localAnchor.x * factor,
              y: entity.b.localAnchor.y * factor,
            },
          }
        : entity.b,
    })
  }

  return { factor, replacements }
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

export function worldToLocalAnchor(body: BodyEntity, worldPoint: Vec2): Vec2 {
  return rotateVector(subtract(worldPoint, body.transform.position), -body.transform.angleRad)
}

export function closestPointOnSegment(point: Vec2, start: Vec2, end: Vec2): Vec2 {
  const segment = subtract(end, start)
  const lengthSquared = dot(segment, segment)
  if (lengthSquared <= Number.EPSILON) return start
  const ratio = Math.max(0, Math.min(1, dot(subtract(point, start), segment) / lengthSquared))
  return { x: start.x + segment.x * ratio, y: start.y + segment.y * ratio }
}

export function sampleGroundPoints(ground: GroundEntity, segments = 48): Vec2[] {
  const geometry = ground.geometry
  if (geometry.type === 'line') return [geometry.start, geometry.end]
  if (geometry.type === 'cubicBezier') return sampleBezier(ground, segments)
  return Array.from({ length: segments + 1 }, (_, index) => {
    const angle = geometry.startRad + ((geometry.endRad - geometry.startRad) * index) / segments
    return {
      x: geometry.center.x + Math.cos(angle) * geometry.radius,
      y: geometry.center.y + Math.sin(angle) * geometry.radius,
    }
  })
}

export function bodySupportRadius(body: BodyEntity, normal: Vec2): number {
  if (body.shape.type === 'circle') return body.shape.radius
  const localNormal = rotateVector(normal, -body.transform.angleRad)
  return (
    Math.abs(localNormal.x) * (body.shape.width / 2) +
    Math.abs(localNormal.y) * (body.shape.height / 2)
  )
}

export type BodySnapSurfaceTarget = GroundEntity | BodyEntity

interface SnapCandidate {
  position: Vec2
  correctionDistance: number
}

function groundSnapCandidates(body: BodyEntity, ground: GroundEntity): SnapCandidate[] {
  const candidates: SnapCandidate[] = []
  const points = sampleGroundPoints(ground)

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]
    const end = points[index]
    if (!start || !end) continue
    const tangent = subtract(end, start)
    const tangentLength = Math.hypot(tangent.x, tangent.y)
    if (tangentLength <= Number.EPSILON) continue
    const closest = closestPointOnSegment(body.transform.position, start, end)
    const separation = subtract(body.transform.position, closest)
    const centerDistance = Math.hypot(separation.x, separation.y)
    const direction =
      centerDistance > Number.EPSILON
        ? { x: separation.x / centerDistance, y: separation.y / centerDistance }
        : { x: -tangent.y / tangentLength, y: tangent.x / tangentLength }
    const support = bodySupportRadius(body, direction)
    const position = {
      x: closest.x + direction.x * support,
      y: closest.y + direction.y * support,
    }
    candidates.push({
      position,
      correctionDistance: distance(body.transform.position, position),
    })
  }

  return candidates
}

function blockSnapCandidate(body: BodyEntity, target: BodyEntity): SnapCandidate | null {
  if (target.shape.type !== 'box') return null

  const localCenter = rotateVector(
    subtract(body.transform.position, target.transform.position),
    -target.transform.angleRad,
  )
  const halfWidth = target.shape.width / 2
  const halfHeight = target.shape.height / 2
  const outsideX = Math.abs(localCenter.x) > halfWidth
  const outsideY = Math.abs(localCenter.y) > halfHeight

  let localBoundary: Vec2
  let localNormal: Vec2

  if (outsideX || outsideY) {
    localBoundary = {
      x: Math.max(-halfWidth, Math.min(halfWidth, localCenter.x)),
      y: Math.max(-halfHeight, Math.min(halfHeight, localCenter.y)),
    }
    const separation = subtract(localCenter, localBoundary)
    const separationLength = Math.hypot(separation.x, separation.y)
    if (separationLength <= Number.EPSILON) return null
    localNormal = {
      x: separation.x / separationLength,
      y: separation.y / separationLength,
    }
  } else {
    const distanceToVerticalFace = halfWidth - Math.abs(localCenter.x)
    const distanceToHorizontalFace = halfHeight - Math.abs(localCenter.y)
    if (distanceToVerticalFace <= distanceToHorizontalFace) {
      const direction = localCenter.x < 0 ? -1 : 1
      localBoundary = { x: direction * halfWidth, y: localCenter.y }
      localNormal = { x: direction, y: 0 }
    } else {
      const direction = localCenter.y < 0 ? -1 : 1
      localBoundary = { x: localCenter.x, y: direction * halfHeight }
      localNormal = { x: 0, y: direction }
    }
  }

  const normal = rotateVector(localNormal, target.transform.angleRad)
  const boundary = add(
    target.transform.position,
    rotateVector(localBoundary, target.transform.angleRad),
  )
  const support = bodySupportRadius(body, normal)
  const position = add(boundary, { x: normal.x * support, y: normal.y * support })
  const correctionDistance = distance(body.transform.position, position)
  return Number.isFinite(correctionDistance) ? { position, correctionDistance } : null
}

export function snapBodyToSurfaces(
  body: BodyEntity,
  targets: readonly BodySnapSurfaceTarget[],
  thresholdM: number,
  excludedIds: ReadonlySet<EntityId> = new Set<EntityId>(),
): BodyEntity {
  if (!Number.isFinite(thresholdM) || thresholdM < 0) return body

  let bestCandidate: SnapCandidate | null = null
  for (const target of targets) {
    if (!target.visible || target.id === body.id || excludedIds.has(target.id)) continue
    const candidates =
      target.kind === 'ground'
        ? groundSnapCandidates(body, target)
        : target.shape.type === 'box'
          ? [blockSnapCandidate(body, target)]
          : []

    for (const candidate of candidates) {
      if (!candidate || candidate.correctionDistance > thresholdM) continue
      if (
        !bestCandidate ||
        candidate.correctionDistance < bestCandidate.correctionDistance - 1e-12
      ) {
        bestCandidate = candidate
      }
    }
  }

  return bestCandidate
    ? { ...body, transform: { ...body.transform, position: bestCandidate.position } }
    : body
}

export function snapBodyToGround(
  body: BodyEntity,
  grounds: GroundEntity[],
  threshold: number,
): BodyEntity {
  return snapBodyToSurfaces(body, grounds, threshold)
}

export function getEntityById(
  entities: SceneEntity[],
  entityId: EntityId,
): SceneEntity | undefined {
  return entities.find((entity) => entity.id === entityId)
}
