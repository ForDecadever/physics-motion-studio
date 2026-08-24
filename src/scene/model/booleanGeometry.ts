import earcut, { deviation as earcutDeviation, flatten as flattenForEarcut } from 'earcut'
import * as polygonClipping from 'polygon-clipping'

import {
  classifyBooleanEntity,
  findRootBooleanLayers,
  MAX_BOOLEAN_TREE_DEPTH,
  walkSceneTree,
  type BooleanOperandClass,
} from './booleanLayerGraph'
import type {
  BodyEntity,
  BooleanNode,
  EntityId,
  FieldDefinition,
  FieldEntity,
  Material2D,
  SceneDocument,
  SceneEntity,
  SceneTreeItem,
  Vec2,
} from './types'
import { sampleBezierBodyWorldPoints } from './bodyPath'

type Pair = polygonClipping.Pair
export type BooleanMultiPolygon = polygonClipping.MultiPolygon

export const MAX_BOOLEAN_INPUT_VERTICES = 2_048
export const MAX_BOOLEAN_RESULT_VERTICES = 8_192
export const MAX_BOOLEAN_CONVEX_PARTS = 256
export const MAX_SCENE_BOOLEAN_CONVEX_PARTS = 1_024
export const MAX_BOOLEAN_TRIANGULATION_DEVIATION = 1e-7

export interface BooleanBounds {
  min: Vec2
  max: Vec2
}

export interface PolygonMetrics {
  area: number
  centroid: Vec2
  polarMomentAboutOrigin: number
}

export interface ResolvedMassRegion {
  sourceEntityId: EntityId
  geometry: BooleanMultiPolygon
  area: number
  centroid: Vec2
  massKg: number
}

export interface ResolvedChargeRegion {
  sourceEntityId: EntityId
  geometry: BooleanMultiPolygon
  area: number
  centroid: Vec2
  chargeC: number
}

export interface ResolvedMaterialRegion {
  sourceEntityId: EntityId
  geometry: BooleanMultiPolygon
  area: number
  centroid: Vec2
  material: Material2D
  color: string
}

export interface ResolvedFieldRegion {
  sourceEntityId: EntityId
  geometry: BooleanMultiPolygon
  area: number
  centroid: Vec2
  field: FieldDefinition
}

export interface ResolvedConvexPart {
  sourceEntityId: EntityId
  material: Material2D
  worldPoints: Vec2[]
  localPoints: Vec2[]
}

export interface ResolvedCollisionMesh {
  material: Material2D
  vertices: Float32Array
  indices: Uint32Array
  boundaryIndices: Uint32Array
  convexPolygons: Vec2[][]
}

interface ResolvedBooleanBase {
  resultId: EntityId
  nodeId: string
  sourceEntityIds: EntityId[]
  geometry: BooleanMultiPolygon
  bounds: BooleanBounds
  boundaryVertexCount: number
  valid: true
}

export interface ResolvedBooleanBody extends ResolvedBooleanBase {
  kind: 'body'
  massKg: number
  chargeC: number
  centerOfMass: Vec2
  inertiaKgM2: number
  angleRad: number
  initialVelocity: Vec2
  initialAngularVelocityRad: number
  simulationEnabled: boolean
  rotationEnabled: boolean
  continuousCollisionDetection: boolean
  materialRegions: ResolvedMaterialRegion[]
  massRegions: ResolvedMassRegion[]
  chargeRegions: ResolvedChargeRegion[]
  convexParts: ResolvedConvexPart[]
  collisionMeshes: ResolvedCollisionMesh[]
}

export interface ResolvedBooleanField extends ResolvedBooleanBase {
  kind: 'field'
  fieldType: FieldDefinition['type']
  simulationEnabled: boolean
  regions: ResolvedFieldRegion[]
}

export interface InvalidBooleanResult {
  resultId: EntityId
  nodeId: string
  valid: false
  diagnostics: string[]
  sourceEntityIds: EntityId[]
  sourceOutlines: BooleanMultiPolygon[]
}

export type ResolvedBooleanResult =
  ResolvedBooleanBody | ResolvedBooleanField | InvalidBooleanResult

export interface ResolvedBooleanScene {
  roots: ResolvedBooleanResult[]
  byResultId: ReadonlyMap<EntityId, ResolvedBooleanResult>
  rootResultIdBySourceId: ReadonlyMap<EntityId, EntityId>
  totalConvexParts: number
}

interface SourceRegion {
  source: BodyEntity | FieldEntity
  geometry: BooleanMultiPolygon
}

interface DensityRegion {
  sourceEntityId: EntityId
  geometry: BooleanMultiPolygon
  density: number
}

interface OperandResolution {
  revision: number
  rigidFromRevision?: number
  rigidTransform?: RigidTransform
  operandClass: BooleanOperandClass
  geometry: BooleanMultiPolygon
  regions: SourceRegion[]
  massRegions: DensityRegion[]
  chargeRegions: DensityRegion[]
  sourceEntities: (BodyEntity | FieldEntity)[]
  uppermostSource: BodyEntity | FieldEntity
  diagnostics: string[]
  sourceOutlines: BooleanMultiPolygon[]
}

interface BooleanResolveContext {
  entityById: Map<EntityId, SceneEntity>
  sourceCache: Map<EntityId, OperandResolution | null>
  nodeCache: Map<string, OperandResolution | null>
  treeMatchCache: Map<string, boolean>
}

const EMPTY_BOUNDS: BooleanBounds = {
  min: { x: 0, y: 0 },
  max: { x: 0, y: 0 },
}

const sceneCache = new WeakMap<SceneDocument, ResolvedBooleanScene>()
const sourceGeometryCache = new WeakMap<BodyEntity | FieldEntity, OperandResolution>()
const subtreeGeometryCache = new WeakMap<
  BooleanNode,
  {
    upper: OperandResolution
    lower: OperandResolution
    result: OperandResolution
  }
>()
const resolvedResultCache = new WeakMap<
  BooleanNode,
  { operand: OperandResolution; result: ResolvedBooleanResult }
>()

interface RigidTransform {
  angleRad: number
  translation: Vec2
}

interface StableSourceCacheEntry {
  signature: string
  entity: BodyEntity | FieldEntity
  result: OperandResolution
}

interface StableNodeCacheEntry {
  settingsSignature: string
  upperRevision: number
  lowerRevision: number
  result: OperandResolution
}

interface StableResultCacheEntry {
  operandRevision: number
  operand: OperandResolution
  treeNode: BooleanNode
  result: ResolvedBooleanResult
}

const MAX_STABLE_BOOLEAN_CACHE_ENTRIES = 4_096
const stableSourceCache = new Map<EntityId, StableSourceCacheEntry>()
const stableNodeCache = new Map<string, StableNodeCacheEntry>()
const stableResultCache = new Map<string, StableResultCacheEntry>()
let nextBooleanRevision = 1

function readLru<Key, Value>(cache: Map<Key, Value>, key: Key): Value | undefined {
  const value = cache.get(key)
  if (value === undefined) return undefined
  cache.delete(key)
  cache.set(key, value)
  return value
}

function writeLru<Key, Value>(cache: Map<Key, Value>, key: Key, value: Value): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX_STABLE_BOOLEAN_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as Key | undefined
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function sourceSignature(entity: BodyEntity | FieldEntity): string {
  return JSON.stringify(entity)
}

function sameVec(first: Vec2, second: Vec2): boolean {
  return first.x === second.x && first.y === second.y
}

function sameBodyShape(first: BodyEntity['shape'], second: BodyEntity['shape']): boolean {
  if (first.type !== second.type) return false
  if (first.type === 'circle' && second.type === 'circle') {
    return first.radius === second.radius && first.collisionEnabled === second.collisionEnabled
  }
  if (first.type === 'box' && second.type === 'box') {
    return first.width === second.width && first.height === second.height
  }
  if (first.type !== 'bezierPath' || second.type !== 'bezierPath') return false
  return (
    first.nodes.every((node, index) => {
      const other = second.nodes[index]
      if (
        !other ||
        !sameVec(node.anchor, other.anchor) ||
        !sameVec(node.inHandle, other.inHandle) ||
        !sameVec(node.outHandle, other.outHandle)
      ) {
        return false
      }
      if (!node.collapsedHandles || !other.collapsedHandles) {
        return node.collapsedHandles === other.collapsedHandles
      }
      return (
        sameVec(node.collapsedHandles.inOffset, other.collapsedHandles.inOffset) &&
        sameVec(node.collapsedHandles.outOffset, other.collapsedHandles.outOffset)
      )
    }) && first.nodes.length === second.nodes.length
  )
}

function bodyNonTransformEquals(first: BodyEntity, second: BodyEntity): boolean {
  return (
    first.id === second.id &&
    first.name === second.name &&
    first.visible === second.visible &&
    first.locked === second.locked &&
    first.simulationEnabled === second.simulationEnabled &&
    first.preset === second.preset &&
    first.color === second.color &&
    sameBodyShape(first.shape, second.shape) &&
    first.massKg === second.massKg &&
    first.chargeC === second.chargeC &&
    first.material.friction === second.material.friction &&
    first.material.restitution === second.material.restitution &&
    sameVec(first.initialVelocity, second.initialVelocity) &&
    first.initialAngularVelocityRad === second.initialAngularVelocityRad &&
    first.rotationEnabled === second.rotationEnabled &&
    first.continuousCollisionDetection === second.continuousCollisionDetection
  )
}

function nodeSettingsSignature(node: BooleanNode): string {
  return JSON.stringify({ ...node, operands: undefined })
}

function sameBooleanNodeSettings(first: BooleanNode, second: BooleanNode): boolean {
  const sameMass =
    first.massDistribution.mode === second.massDistribution.mode &&
    (first.massDistribution.mode === 'source' ||
      (second.massDistribution.mode === 'uniform' &&
        first.massDistribution.totalMassKg === second.massDistribution.totalMassKg))
  const sameCharge =
    first.chargeDistribution.mode === second.chargeDistribution.mode &&
    (first.chargeDistribution.mode === 'source' ||
      (second.chargeDistribution.mode === 'uniform' &&
        first.chargeDistribution.totalChargeC === second.chargeDistribution.totalChargeC))
  const sameField =
    first.fieldDistribution.mode === second.fieldDistribution.mode &&
    (first.fieldDistribution.mode === 'source' ||
      (second.fieldDistribution.mode === 'uniform' &&
        JSON.stringify(first.fieldDistribution.field) ===
          JSON.stringify(second.fieldDistribution.field)))
  const sameScalarDistribution = (
    firstDistribution: BooleanNode['frictionDistribution'],
    secondDistribution: BooleanNode['frictionDistribution'],
  ): boolean =>
    firstDistribution.mode === secondDistribution.mode &&
    (firstDistribution.mode === 'source' ||
      (secondDistribution.mode === 'uniform' &&
        firstDistribution.value === secondDistribution.value))
  const sameVelocity =
    first.initialVelocity.mode === second.initialVelocity.mode &&
    (first.initialVelocity.mode === 'source' ||
      (second.initialVelocity.mode === 'override' &&
        sameVec(first.initialVelocity.value, second.initialVelocity.value)))
  const sameAngularVelocity =
    first.initialAngularVelocity.mode === second.initialAngularVelocity.mode &&
    (first.initialAngularVelocity.mode === 'source' ||
      (second.initialAngularVelocity.mode === 'override' &&
        first.initialAngularVelocity.valueRadPerSecond ===
          second.initialAngularVelocity.valueRadPerSecond))
  return (
    first.id === second.id &&
    first.resultId === second.resultId &&
    first.operation === second.operation &&
    first.simulationEnabled === second.simulationEnabled &&
    first.rotationEnabled === second.rotationEnabled &&
    first.continuousCollisionDetection === second.continuousCollisionDetection &&
    sameMass &&
    sameCharge &&
    sameField &&
    sameScalarDistribution(first.frictionDistribution, second.frictionDistribution) &&
    sameScalarDistribution(first.restitutionDistribution, second.restitutionDistribution) &&
    sameVelocity &&
    sameAngularVelocity
  )
}

function sameBooleanTree(
  first: SceneTreeItem,
  second: SceneTreeItem,
  cache: Map<string, boolean>,
): boolean {
  if (first.kind !== second.kind) return false
  if (first.kind === 'entity' && second.kind === 'entity') {
    return first.entityId === second.entityId
  }
  if (first.kind !== 'boolean' || second.kind !== 'boolean') return false
  const cached = cache.get(second.id)
  if (cached !== undefined) return cached
  const matches =
    sameBooleanNodeSettings(first, second) &&
    first.operands.length === second.operands.length &&
    first.operands.every((operand, index) => {
      const other = second.operands[index]
      return other ? sameBooleanTree(operand, other, cache) : false
    })
  cache.set(second.id, matches)
  return matches
}

function cloneVec(point: Vec2): Vec2 {
  return { x: point.x, y: point.y }
}

function pair(point: Vec2): Pair {
  return [point.x, point.y]
}

function vec(point: Pair): Vec2 {
  return { x: point[0], y: point[1] }
}

function rigidTransformPoint(point: Vec2, transform: RigidTransform): Vec2 {
  const cosine = Math.cos(transform.angleRad)
  const sine = Math.sin(transform.angleRad)
  return {
    x: point.x * cosine - point.y * sine + transform.translation.x,
    y: point.x * sine + point.y * cosine + transform.translation.y,
  }
}

function rigidTransformGeometry(
  geometry: BooleanMultiPolygon,
  transform: RigidTransform,
): BooleanMultiPolygon {
  const cosine = Math.cos(transform.angleRad)
  const sine = Math.sin(transform.angleRad)
  return geometry.map((polygon) =>
    polygon.map((ring) =>
      ring.map(([x, y]) => [
        x * cosine - y * sine + transform.translation.x,
        x * sine + y * cosine + transform.translation.y,
      ]),
    ),
  )
}

function bodyRigidTransform(before: BodyEntity, after: BodyEntity): RigidTransform {
  const angleRad = after.transform.angleRad - before.transform.angleRad
  const cosine = Math.cos(angleRad)
  const sine = Math.sin(angleRad)
  return {
    angleRad,
    translation: {
      x:
        after.transform.position.x -
        (before.transform.position.x * cosine - before.transform.position.y * sine),
      y:
        after.transform.position.y -
        (before.transform.position.x * sine + before.transform.position.y * cosine),
    },
  }
}

function sameRigidTransform(first: RigidTransform, second: RigidTransform): boolean {
  return (
    Math.abs(first.angleRad - second.angleRad) <= 1e-10 &&
    Math.hypot(
      first.translation.x - second.translation.x,
      first.translation.y - second.translation.y,
    ) <= 1e-9
  )
}

function rigidTransformOperandSource(
  source: BodyEntity | FieldEntity,
  currentSources: ReadonlyMap<EntityId, BodyEntity | FieldEntity>,
): BodyEntity | FieldEntity {
  const current = currentSources.get(source.id)
  if (!current || source.kind !== 'body' || current.kind !== 'body') return source
  return { ...current, material: source.material }
}

function rigidTransformOperand(
  previous: OperandResolution,
  transform: RigidTransform,
  sourceEntities: (BodyEntity | FieldEntity)[],
  uppermostSource: BodyEntity | FieldEntity,
): OperandResolution {
  const currentSources = new Map(sourceEntities.map((source) => [source.id, source] as const))
  const transformDensityRegions = (regions: DensityRegion[]): DensityRegion[] =>
    regions.map((region) => ({
      ...region,
      geometry: rigidTransformGeometry(region.geometry, transform),
    }))
  return {
    ...previous,
    revision: nextBooleanRevision++,
    rigidFromRevision: previous.revision,
    rigidTransform: transform,
    geometry: rigidTransformGeometry(previous.geometry, transform),
    regions: previous.regions.map((region) => ({
      source: rigidTransformOperandSource(region.source, currentSources),
      geometry: rigidTransformGeometry(region.geometry, transform),
    })),
    massRegions: transformDensityRegions(previous.massRegions),
    chargeRegions: transformDensityRegions(previous.chargeRegions),
    sourceEntities,
    uppermostSource,
    sourceOutlines: previous.sourceOutlines.map((outline) =>
      rigidTransformGeometry(outline, transform),
    ),
  }
}

function closeRing(points: Vec2[]): Pair[] {
  if (points.length === 0) return []
  const ring = points.map(pair)
  const first = ring[0]!
  const last = ring[ring.length - 1]!
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]])
  return ring
}

function asMultiPolygon(points: Vec2[]): BooleanMultiPolygon {
  const ring = closeRing(points)
  return ring.length >= 4 ? [[ring]] : []
}

function normalizedGeometry(geometry: BooleanMultiPolygon): BooleanMultiPolygon {
  return geometry.filter((polygon) => polygon.length > 0 && polygon[0]!.length >= 4)
}

function unionGeometry(
  first: BooleanMultiPolygon,
  second: BooleanMultiPolygon,
): BooleanMultiPolygon {
  if (first.length === 0) return second
  if (second.length === 0) return first
  return normalizedGeometry(polygonClipping.union(first, second))
}

function differenceGeometry(
  subject: BooleanMultiPolygon,
  clip: BooleanMultiPolygon,
): BooleanMultiPolygon {
  if (subject.length === 0) return []
  if (clip.length === 0) return subject
  return normalizedGeometry(polygonClipping.difference(subject, clip))
}

function intersectionGeometry(
  first: BooleanMultiPolygon,
  second: BooleanMultiPolygon,
): BooleanMultiPolygon {
  if (first.length === 0 || second.length === 0) return []
  return normalizedGeometry(polygonClipping.intersection(first, second))
}

function featureTolerance(featureSize: number): number {
  return Math.min(5e-4, Math.max(1e-6, featureSize * 1e-4))
}

function circleSegments(radius: number, sweepRad: number): number {
  const tolerance = featureTolerance(radius * 2)
  const ratio = Math.min(2, Math.max(0, tolerance / radius))
  const maxStep = Math.max(1e-4, 2 * Math.acos(1 - ratio))
  return Math.max(3, Math.ceil(Math.abs(sweepRad) / maxStep))
}

function sampleCircle(
  center: Vec2,
  radius: number,
  startRad = 0,
  sweepRad = Math.PI * 2,
  sector = false,
): Vec2[] {
  const steps = circleSegments(radius, sweepRad)
  const points: Vec2[] = sector && Math.abs(sweepRad) < Math.PI * 2 - 1e-9 ? [cloneVec(center)] : []
  for (let index = 0; index <= steps; index += 1) {
    const angle = startRad + (sweepRad * index) / steps
    points.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius })
  }
  return points
}

function rotateAround(point: Vec2, center: Vec2, angleRad: number): Vec2 {
  const cosine = Math.cos(angleRad)
  const sine = Math.sin(angleRad)
  const x = point.x - center.x
  const y = point.y - center.y
  return { x: center.x + x * cosine - y * sine, y: center.y + x * sine + y * cosine }
}

function rectanglePoints(center: Vec2, width: number, height: number, angleRad: number): Vec2[] {
  const halfWidth = width / 2
  const halfHeight = height / 2
  return [
    { x: center.x - halfWidth, y: center.y - halfHeight },
    { x: center.x + halfWidth, y: center.y - halfHeight },
    { x: center.x + halfWidth, y: center.y + halfHeight },
    { x: center.x - halfWidth, y: center.y + halfHeight },
  ].map((point) => rotateAround(point, center, angleRad))
}

function cubicPoint(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, ratio: number): Vec2 {
  const inverse = 1 - ratio
  return {
    x:
      inverse ** 3 * p0.x +
      3 * inverse ** 2 * ratio * p1.x +
      3 * inverse * ratio ** 2 * p2.x +
      ratio ** 3 * p3.x,
    y:
      inverse ** 3 * p0.y +
      3 * inverse ** 2 * ratio * p1.y +
      3 * inverse * ratio ** 2 * p2.y +
      ratio ** 3 * p3.y,
  }
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function sampleBezierField(entity: FieldEntity): Vec2[] {
  if (entity.region.type !== 'bezierPath') return []
  const nodes = entity.region.nodes
  const anchors = nodes.map((node) => node.anchor)
  const xs = anchors.map((point) => point.x)
  const ys = anchors.map((point) => point.y)
  const featureSize = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  const tolerance = featureTolerance(Math.max(featureSize, 1e-6))
  const points: Vec2[] = []
  for (let index = 0; index < nodes.length; index += 1) {
    const current = nodes[index]!
    const next = nodes[(index + 1) % nodes.length]!
    const controlLength =
      distance(current.anchor, current.outHandle) +
      distance(current.outHandle, next.inHandle) +
      distance(next.inHandle, next.anchor)
    const steps = Math.max(2, Math.ceil(controlLength / Math.sqrt(Math.max(tolerance, 1e-12))))
    for (let step = 0; step < steps; step += 1) {
      points.push(
        cubicPoint(current.anchor, current.outHandle, next.inHandle, next.anchor, step / steps),
      )
      if (points.length > MAX_BOOLEAN_INPUT_VERTICES) return points
    }
  }
  return points
}

export function entityToBooleanGeometry(entity: BodyEntity | FieldEntity): BooleanMultiPolygon {
  if (entity.kind === 'body') {
    if (entity.shape.type === 'circle') {
      return asMultiPolygon(
        sampleCircle(entity.transform.position, entity.shape.radius, 0, Math.PI * 2),
      )
    }
    if (entity.shape.type === 'bezierPath') {
      return asMultiPolygon(sampleBezierBodyWorldPoints(entity))
    }
    return asMultiPolygon(
      rectanglePoints(
        entity.transform.position,
        entity.shape.width,
        entity.shape.height,
        entity.transform.angleRad,
      ),
    )
  }
  switch (entity.region.type) {
    case 'infinite':
      return []
    case 'rectangle':
      return asMultiPolygon(
        rectanglePoints(
          entity.region.center,
          entity.region.width,
          entity.region.height,
          entity.region.angleRad,
        ),
      )
    case 'circle':
      return asMultiPolygon(
        sampleCircle(
          entity.region.center,
          entity.region.radius,
          entity.region.startRad,
          entity.region.sweepRad,
          true,
        ),
      )
    case 'polygon':
      return asMultiPolygon(entity.region.points)
    case 'bezierPath':
      return asMultiPolygon(sampleBezierField(entity))
  }
}

function ringMetrics(ring: Pair[]): PolygonMetrics {
  let doubleArea = 0
  let centroidXTimesSixArea = 0
  let centroidYTimesSixArea = 0
  let polarMomentTimesTwelve = 0
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index]!
    const next = ring[index + 1]!
    const cross = current[0] * next[1] - next[0] * current[1]
    doubleArea += cross
    centroidXTimesSixArea += (current[0] + next[0]) * cross
    centroidYTimesSixArea += (current[1] + next[1]) * cross
    polarMomentTimesTwelve +=
      cross *
      (current[0] ** 2 +
        current[0] * next[0] +
        next[0] ** 2 +
        current[1] ** 2 +
        current[1] * next[1] +
        next[1] ** 2)
  }
  const area = doubleArea / 2
  if (Math.abs(area) < 1e-14) {
    return { area: 0, centroid: { x: 0, y: 0 }, polarMomentAboutOrigin: 0 }
  }
  return {
    area,
    centroid: {
      x: centroidXTimesSixArea / (6 * area),
      y: centroidYTimesSixArea / (6 * area),
    },
    polarMomentAboutOrigin: polarMomentTimesTwelve / 12,
  }
}

export function polygonMetrics(geometry: BooleanMultiPolygon): PolygonMetrics {
  let area = 0
  let firstMomentX = 0
  let firstMomentY = 0
  let polarMoment = 0
  for (const polygon of geometry) {
    for (const ring of polygon) {
      const metrics = ringMetrics(ring)
      area += metrics.area
      firstMomentX += metrics.area * metrics.centroid.x
      firstMomentY += metrics.area * metrics.centroid.y
      polarMoment += metrics.polarMomentAboutOrigin
    }
  }
  if (area < 0) {
    area = -area
    firstMomentX = -firstMomentX
    firstMomentY = -firstMomentY
    polarMoment = -polarMoment
  }
  if (area < 1e-14) {
    return { area: 0, centroid: { x: 0, y: 0 }, polarMomentAboutOrigin: 0 }
  }
  return {
    area,
    centroid: { x: firstMomentX / area, y: firstMomentY / area },
    polarMomentAboutOrigin: polarMoment,
  }
}

function countVertices(geometry: BooleanMultiPolygon): number {
  return geometry.reduce(
    (total, polygon) =>
      total +
      polygon.reduce((polygonTotal, ring) => polygonTotal + Math.max(0, ring.length - 1), 0),
    0,
  )
}

function boundsForGeometry(geometry: BooleanMultiPolygon): BooleanBounds {
  const points = geometry.flatMap((polygon) => polygon.flatMap((ring) => ring))
  if (points.length === 0) return EMPTY_BOUNDS
  return {
    min: {
      x: Math.min(...points.map((point) => point[0])),
      y: Math.min(...points.map((point) => point[1])),
    },
    max: {
      x: Math.max(...points.map((point) => point[0])),
      y: Math.max(...points.map((point) => point[1])),
    },
  }
}

function classMatches(first: BooleanOperandClass, second: BooleanOperandClass): boolean {
  if (first.kind !== second.kind) return false
  if (first.kind === 'field' && second.kind === 'field') return first.fieldType === second.fieldType
  return first.kind === 'body'
}

function sourceResolution(entity: SceneEntity | undefined): OperandResolution | null {
  const operandClass = classifyBooleanEntity(entity)
  if (!entity || (entity.kind !== 'body' && entity.kind !== 'field')) return null
  const cached = sourceGeometryCache.get(entity)
  if (cached) return cached
  const signature = sourceSignature(entity)
  const stableCached = readLru(stableSourceCache, entity.id)
  if (stableCached?.signature === signature) {
    sourceGeometryCache.set(entity, stableCached.result)
    return stableCached.result
  }
  if (
    entity.kind === 'body' &&
    stableCached?.entity.kind === 'body' &&
    bodyNonTransformEquals(stableCached.entity, entity)
  ) {
    const transformed = rigidTransformOperand(
      stableCached.result,
      bodyRigidTransform(stableCached.entity, entity),
      [entity],
      entity,
    )
    sourceGeometryCache.set(entity, transformed)
    writeLru(stableSourceCache, entity.id, {
      signature,
      entity,
      result: transformed,
    })
    return transformed
  }
  const geometry = entityToBooleanGeometry(entity)
  const diagnostics: string[] = []
  if (operandClass.kind === 'unsupported') diagnostics.push('该实体类型不能作为布尔输入。')
  if (countVertices(geometry) > MAX_BOOLEAN_INPUT_VERTICES) {
    diagnostics.push(`单个输入不能超过 ${MAX_BOOLEAN_INPUT_VERTICES} 个采样顶点。`)
  }
  if (polygonMetrics(geometry).area <= 0) diagnostics.push('布尔输入的有限区域为空或退化。')
  const resolved: OperandResolution = {
    revision: nextBooleanRevision++,
    operandClass,
    geometry,
    regions: [{ source: entity, geometry }],
    massRegions:
      entity.kind === 'body' && polygonMetrics(geometry).area > 0
        ? [
            {
              sourceEntityId: entity.id,
              geometry,
              density: entity.massKg / polygonMetrics(geometry).area,
            },
          ]
        : [],
    chargeRegions:
      entity.kind === 'body' && polygonMetrics(geometry).area > 0
        ? [
            {
              sourceEntityId: entity.id,
              geometry,
              density: entity.chargeC / polygonMetrics(geometry).area,
            },
          ]
        : [],
    sourceEntities: [entity],
    uppermostSource: entity,
    diagnostics,
    sourceOutlines: [geometry],
  }
  sourceGeometryCache.set(entity, resolved)
  writeLru(stableSourceCache, entity.id, {
    signature,
    entity,
    result: resolved,
  })
  return resolved
}

function resolveOperand(
  operand: SceneTreeItem,
  context: BooleanResolveContext,
  depth: number,
  stack: Set<string>,
): OperandResolution | null {
  if (operand.kind === 'entity') {
    if (!context.sourceCache.has(operand.entityId)) {
      context.sourceCache.set(
        operand.entityId,
        sourceResolution(context.entityById.get(operand.entityId)),
      )
    }
    return context.sourceCache.get(operand.entityId) ?? null
  }
  return resolveNode(operand, context, depth + 1, stack)
}

function uppermostSourceForLayer(
  layer: BooleanNode,
  upper: OperandResolution,
): BodyEntity | FieldEntity {
  return upper.uppermostSource.kind === 'body'
    ? {
        ...upper.uppermostSource,
        initialVelocity:
          layer.initialVelocity.mode === 'override'
            ? cloneVec(layer.initialVelocity.value)
            : cloneVec(upper.uppermostSource.initialVelocity),
        initialAngularVelocityRad:
          layer.initialAngularVelocity.mode === 'override'
            ? layer.initialAngularVelocity.valueRadPerSecond
            : upper.uppermostSource.initialAngularVelocityRad,
      }
    : upper.uppermostSource
}

function cacheStableNode(
  layer: BooleanNode,
  settingsSignature: string,
  upper: OperandResolution,
  lower: OperandResolution,
  result: OperandResolution,
): void {
  writeLru(stableNodeCache, layer.id, {
    settingsSignature,
    upperRevision: upper.revision,
    lowerRevision: lower.revision,
    result,
  })
}

function resolveNode(
  layer: BooleanNode,
  context: BooleanResolveContext,
  depth: number,
  stack: Set<string>,
): OperandResolution | null {
  if (depth > MAX_BOOLEAN_TREE_DEPTH || stack.has(layer.id) || layer.operands.length !== 2)
    return null
  if (context.nodeCache.has(layer.id)) return context.nodeCache.get(layer.id) ?? null
  stack.add(layer.id)
  const upper = resolveOperand(layer.operands[0]!, context, depth, stack)
  const lower = resolveOperand(layer.operands[1]!, context, depth, stack)
  stack.delete(layer.id)
  if (!upper || !lower) {
    context.nodeCache.set(layer.id, null)
    return null
  }
  const subtreeCached = subtreeGeometryCache.get(layer)
  if (subtreeCached?.upper === upper && subtreeCached.lower === lower) {
    context.nodeCache.set(layer.id, subtreeCached.result)
    return subtreeCached.result
  }

  const settingsSignature = nodeSettingsSignature(layer)
  const stableCached = readLru(stableNodeCache, layer.id)
  if (
    stableCached?.settingsSignature === settingsSignature &&
    stableCached.upperRevision === upper.revision &&
    stableCached.lowerRevision === lower.revision
  ) {
    context.nodeCache.set(layer.id, stableCached.result)
    subtreeGeometryCache.set(layer, { upper, lower, result: stableCached.result })
    return stableCached.result
  }
  if (
    stableCached?.settingsSignature === settingsSignature &&
    upper.rigidFromRevision === stableCached.upperRevision &&
    lower.rigidFromRevision === stableCached.lowerRevision &&
    upper.rigidTransform &&
    lower.rigidTransform &&
    sameRigidTransform(upper.rigidTransform, lower.rigidTransform)
  ) {
    const transformed = rigidTransformOperand(
      stableCached.result,
      upper.rigidTransform,
      [...upper.sourceEntities, ...lower.sourceEntities],
      uppermostSourceForLayer(layer, upper),
    )
    context.nodeCache.set(layer.id, transformed)
    subtreeGeometryCache.set(layer, { upper, lower, result: transformed })
    cacheStableNode(layer, settingsSignature, upper, lower, transformed)
    return transformed
  }

  const diagnostics = [...upper.diagnostics, ...lower.diagnostics]
  if (!classMatches(upper.operandClass, lower.operandClass)) {
    diagnostics.push('两个输入必须是物体，或是同一种有限场。')
  }
  const geometry =
    layer.operation === 'union'
      ? unionGeometry(upper.geometry, lower.geometry)
      : layer.operation === 'intersection'
        ? intersectionGeometry(upper.geometry, lower.geometry)
        : differenceGeometry(upper.geometry, lower.geometry)
  const resultArea = polygonMetrics(geometry).area
  const uppermostSource = uppermostSourceForLayer(layer, upper)
  if (resultArea <= 0) {
    diagnostics.push(
      layer.operation === 'difference'
        ? '上方输入已被下方完全覆盖；减法按上方减下方执行。'
        : layer.operation === 'intersection'
          ? '两个输入没有共同覆盖区域。'
          : '布尔运算结果为空。',
    )
    const emptyResult: OperandResolution = {
      revision: nextBooleanRevision++,
      operandClass: upper.operandClass,
      geometry,
      regions: [],
      massRegions: [],
      chargeRegions: [],
      sourceEntities: [...upper.sourceEntities, ...lower.sourceEntities],
      uppermostSource,
      diagnostics,
      sourceOutlines: [upper.geometry, lower.geometry],
    }
    context.nodeCache.set(layer.id, emptyResult)
    subtreeGeometryCache.set(layer, { upper, lower, result: emptyResult })
    cacheStableNode(layer, settingsSignature, upper, lower, emptyResult)
    return emptyResult
  }
  const lowerVisibleGeometry = differenceGeometry(lower.geometry, upper.geometry)
  const sourceRegions =
    layer.operation === 'union'
      ? [
          ...upper.regions,
          ...lower.regions
            .map((region) => ({
              ...region,
              geometry: differenceGeometry(region.geometry, upper.geometry),
            }))
            .filter((region) => polygonMetrics(region.geometry).area > 0),
        ]
      : upper.regions
          .map((region) => ({
            ...region,
            geometry:
              layer.operation === 'intersection'
                ? intersectionGeometry(region.geometry, lower.geometry)
                : differenceGeometry(region.geometry, lower.geometry),
          }))
          .filter((region) => polygonMetrics(region.geometry).area > 0)
  const distributedRegions: SourceRegion[] =
    layer.fieldDistribution.mode === 'uniform' && upper.operandClass.kind === 'field'
      ? [
          {
            source: {
              ...upper.uppermostSource,
              kind: 'field',
              field: layer.fieldDistribution.field,
            } as FieldEntity,
            geometry,
          },
        ]
      : sourceRegions
  const regions = distributedRegions.map((region): SourceRegion => {
    if (region.source.kind !== 'body') return region
    return {
      ...region,
      source: {
        ...region.source,
        material: {
          friction:
            layer.frictionDistribution.mode === 'uniform'
              ? layer.frictionDistribution.value
              : region.source.material.friction,
          restitution:
            layer.restitutionDistribution.mode === 'uniform'
              ? layer.restitutionDistribution.value
              : region.source.material.restitution,
        },
      },
    }
  })
  const combineDensityRegions = (
    upperRegions: DensityRegion[],
    lowerRegions: DensityRegion[],
  ): DensityRegion[] =>
    layer.operation === 'union'
      ? [
          ...upperRegions,
          ...lowerRegions
            .map((region) => ({
              ...region,
              geometry: differenceGeometry(region.geometry, upper.geometry),
            }))
            .filter((region) => polygonMetrics(region.geometry).area > 0),
        ]
      : upperRegions
          .map((region) => ({
            ...region,
            geometry:
              layer.operation === 'intersection'
                ? intersectionGeometry(region.geometry, lower.geometry)
                : differenceGeometry(region.geometry, lower.geometry),
          }))
          .filter((region) => polygonMetrics(region.geometry).area > 0)
  const sourceMassRegions = combineDensityRegions(upper.massRegions, lower.massRegions)
  const sourceChargeRegions = combineDensityRegions(upper.chargeRegions, lower.chargeRegions)
  const massRegions =
    layer.massDistribution.mode === 'uniform' && resultArea > 0
      ? [
          {
            sourceEntityId: layer.resultId,
            geometry,
            density: layer.massDistribution.totalMassKg / resultArea,
          },
        ]
      : sourceMassRegions
  const chargeRegions =
    layer.chargeDistribution.mode === 'uniform' && resultArea > 0
      ? [
          {
            sourceEntityId: layer.resultId,
            geometry,
            density: layer.chargeDistribution.totalChargeC / resultArea,
          },
        ]
      : sourceChargeRegions
  if (countVertices(geometry) > MAX_BOOLEAN_RESULT_VERTICES) {
    diagnostics.push(`单个布尔结果不能超过 ${MAX_BOOLEAN_RESULT_VERTICES} 个边界顶点。`)
  }
  const resolved: OperandResolution = {
    revision: nextBooleanRevision++,
    operandClass: upper.operandClass,
    geometry,
    regions,
    massRegions,
    chargeRegions,
    sourceEntities: [...upper.sourceEntities, ...lower.sourceEntities],
    uppermostSource,
    diagnostics,
    sourceOutlines: [upper.geometry, lowerVisibleGeometry],
  }
  context.nodeCache.set(layer.id, resolved)
  subtreeGeometryCache.set(layer, { upper, lower, result: resolved })
  cacheStableNode(layer, settingsSignature, upper, lower, resolved)
  return resolved
}

function triangulateRegion(region: SourceRegion): Vec2[][] {
  const triangles: Vec2[][] = []
  for (const polygon of region.geometry) {
    const normalizedRings = polygon.map((ring) => ring.slice(0, -1))
    const flattened = flattenForEarcut(normalizedRings)
    const indices = earcut(flattened.vertices, flattened.holes, flattened.dimensions)
    const areaDeviation = earcutDeviation(
      flattened.vertices,
      flattened.holes,
      flattened.dimensions,
      indices,
    )
    if (!Number.isFinite(areaDeviation) || areaDeviation > MAX_BOOLEAN_TRIANGULATION_DEVIATION) {
      throw new Error(`三角剖分面积偏差 ${areaDeviation} 超过允许值。`)
    }
    for (let index = 0; index < indices.length; index += 3) {
      const points = [indices[index]!, indices[index + 1]!, indices[index + 2]!].map(
        (vertexIndex) => ({
          x: flattened.vertices[vertexIndex * 2]!,
          y: flattened.vertices[vertexIndex * 2 + 1]!,
        }),
      )
      if (polygonMetrics(asMultiPolygon(points)).area > 1e-14) triangles.push(points)
    }
  }
  return triangles
}

function convexHull(points: Vec2[]): Vec2[] {
  const unique = [...new Map(points.map((point) => [`${point.x},${point.y}`, point])).values()]
  if (unique.length <= 3) return unique
  unique.sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (origin: Vec2, a: Vec2, b: Vec2): number =>
    (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
  const lower: Vec2[] = []
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 1e-12) lower.pop()
    lower.push(point)
  }
  const upper: Vec2[] = []
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index]!
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 1e-12) upper.pop()
    upper.push(point)
  }
  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

function signedPolygonArea(points: Vec2[]): number {
  return (
    points.reduce((area, point, index) => {
      const next = points[(index + 1) % points.length]
      return next ? area + point.x * next.y - next.x * point.y : area
    }, 0) / 2
  )
}

function geometryPerimeter(geometry: BooleanMultiPolygon): number {
  let perimeter = 0
  for (const polygon of geometry) {
    for (const ring of polygon) {
      for (let index = 0; index < ring.length; index += 1) {
        const current = ring[index]!
        const next = ring[(index + 1) % ring.length]!
        perimeter += Math.hypot(next[0] - current[0], next[1] - current[1])
      }
    }
  }
  return perimeter
}

function toFloat32Points(points: readonly Vec2[]): Vec2[] {
  return points.map((point) => ({ x: Math.fround(point.x), y: Math.fround(point.y) }))
}

function maximumPointDisplacement(first: readonly Vec2[], second: readonly Vec2[]): number {
  return first.reduce(
    (maximum, point, index) =>
      Math.max(maximum, Math.hypot(point.x - second[index]!.x, point.y - second[index]!.y)),
    0,
  )
}

function canonicalFloat32ConvexPart(points: Vec2[]): Vec2[] | null {
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null
  const hull = convexHull(
    points.map((point) => ({ x: Math.fround(point.x), y: Math.fround(point.y) })),
  )
  if (hull.length < 3) return null
  const area = signedPolygonArea(hull)
  if (!Number.isFinite(area) || Math.abs(area) <= Number.EPSILON) return null
  return area < 0 ? hull.reverse() : hull
}

function mergeConvexTriangles(triangles: Vec2[][]): Vec2[][] {
  const parts = [...triangles]
  let changed = true
  while (changed) {
    changed = false
    mergeLoop: for (let firstIndex = 0; firstIndex < parts.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < parts.length; secondIndex += 1) {
        const first = parts[firstIndex]!
        const second = parts[secondIndex]!
        const hull = convexHull([...first, ...second])
        const combinedArea =
          polygonMetrics(asMultiPolygon(first)).area + polygonMetrics(asMultiPolygon(second)).area
        const hullArea = polygonMetrics(asMultiPolygon(hull)).area
        if (Math.abs(hullArea - combinedArea) > Math.max(1e-10, combinedArea * 1e-9)) continue
        parts[firstIndex] = hull
        parts.splice(secondIndex, 1)
        changed = true
        break mergeLoop
      }
    }
  }
  return parts
}

function buildCollisionMeshes(
  parts: readonly ResolvedConvexPart[],
  geometry: BooleanMultiPolygon,
): ResolvedCollisionMesh[] {
  const groups = new Map<string, { material: Material2D; parts: ResolvedConvexPart[] }>()
  for (const part of parts) {
    const key = `${part.material.friction}:${part.material.restitution}`
    const group = groups.get(key)
    if (group) group.parts.push(part)
    else groups.set(key, { material: part.material, parts: [part] })
  }

  const meshes: ResolvedCollisionMesh[] = []
  let acceptedArea = 0
  for (const group of groups.values()) {
    const vertices: number[] = []
    const indices: number[] = []
    const vertexIndexByPosition = new Map<string, number>()
    const triangleKeys = new Set<string>()
    const indexForPoint = (point: Vec2): number => {
      const x = Math.fround(point.x)
      const y = Math.fround(point.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error('布尔碰撞网格包含非有限坐标。')
      }
      const key = `${x},${y}`
      const existing = vertexIndexByPosition.get(key)
      if (existing !== undefined) return existing
      const next = vertices.length / 2
      vertices.push(x, y)
      vertexIndexByPosition.set(key, next)
      return next
    }

    const convexPolygons = mergeConvexTriangles(group.parts.map((part) => part.localPoints))
    for (const polygon of convexPolygons) {
      if (polygon.length < 3) continue
      const first = indexForPoint(polygon[0]!)
      for (let index = 1; index < polygon.length - 1; index += 1) {
        let second = indexForPoint(polygon[index]!)
        let third = indexForPoint(polygon[index + 1]!)
        const ax = vertices[first * 2]!
        const ay = vertices[first * 2 + 1]!
        const bx = vertices[second * 2]!
        const by = vertices[second * 2 + 1]!
        const cx = vertices[third * 2]!
        const cy = vertices[third * 2 + 1]!
        let doubleArea = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
        if (doubleArea < 0) {
          ;[second, third] = [third, second]
          doubleArea = -doubleArea
        }
        if (!Number.isFinite(doubleArea) || doubleArea <= Number.EPSILON) continue
        const triangleKey = [first, second, third].sort((a, b) => a - b).join(',')
        if (triangleKeys.has(triangleKey)) continue
        triangleKeys.add(triangleKey)
        indices.push(first, second, third)
        acceptedArea += doubleArea / 2
      }
    }
    if (indices.length > 0) {
      meshes.push({
        material: group.material,
        vertices: new Float32Array(vertices),
        indices: new Uint32Array(indices),
        boundaryIndices: new Uint32Array(),
        convexPolygons,
      })
    }
  }

  const edgeOccurrences = new Map<
    string,
    Array<{ meshIndex: number; first: number; second: number }>
  >()
  meshes.forEach((mesh, meshIndex) => {
    const coordinateKey = (vertexIndex: number): string =>
      `${mesh.vertices[vertexIndex * 2]},${mesh.vertices[vertexIndex * 2 + 1]}`
    for (let index = 0; index < mesh.indices.length; index += 3) {
      const triangle = [mesh.indices[index]!, mesh.indices[index + 1]!, mesh.indices[index + 2]!]
      const edges: ReadonlyArray<readonly [number, number]> = [
        [triangle[0]!, triangle[1]!],
        [triangle[1]!, triangle[2]!],
        [triangle[2]!, triangle[0]!],
      ]
      for (const [first, second] of edges) {
        const firstKey = coordinateKey(first)
        const secondKey = coordinateKey(second)
        const key = firstKey < secondKey ? `${firstKey}|${secondKey}` : `${secondKey}|${firstKey}`
        const occurrences = edgeOccurrences.get(key) ?? []
        occurrences.push({ meshIndex, first, second })
        edgeOccurrences.set(key, occurrences)
      }
    }
  })
  const boundaryIndicesByMesh = meshes.map(() => [] as number[])
  for (const occurrences of edgeOccurrences.values()) {
    if (occurrences.length !== 1) continue
    const edge = occurrences[0]!
    boundaryIndicesByMesh[edge.meshIndex]!.push(edge.first, edge.second)
  }
  meshes.forEach((mesh, meshIndex) => {
    mesh.boundaryIndices = new Uint32Array(boundaryIndicesByMesh[meshIndex]!)
  })

  const expectedArea = parts.reduce(
    (total, part) => total + Math.abs(signedPolygonArea(part.localPoints)),
    0,
  )
  const bounds = boundsForGeometry(geometry)
  const featureSize = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, 1e-6)
  const allowedAreaError = Math.max(
    featureTolerance(featureSize) ** 2,
    expectedArea * MAX_BOOLEAN_TRIANGULATION_DEVIATION,
  )
  if (
    meshes.length === 0 ||
    meshes.every((mesh) => mesh.boundaryIndices.length === 0) ||
    Math.abs(expectedArea - acceptedArea) > allowedAreaError
  ) {
    throw new Error('布尔碰撞网格在 Float32 合并后面积偏差超过允许值。')
  }
  return meshes
}

function toLocalPoints(points: Vec2[], center: Vec2, angleRad: number): Vec2[] {
  const cosine = Math.cos(-angleRad)
  const sine = Math.sin(-angleRad)
  return points.map((point) => {
    const x = point.x - center.x
    const y = point.y - center.y
    return { x: x * cosine - y * sine, y: x * sine + y * cosine }
  })
}

function toWorldPoints(points: Vec2[], center: Vec2, angleRad: number): Vec2[] {
  const cosine = Math.cos(angleRad)
  const sine = Math.sin(angleRad)
  return points.map((point) => ({
    x: center.x + point.x * cosine - point.y * sine,
    y: center.y + point.x * sine + point.y * cosine,
  }))
}

function resolveBody(
  layer: BooleanNode,
  node: OperandResolution,
): ResolvedBooleanBody | InvalidBooleanResult {
  const bodySources = node.sourceEntities.filter(
    (entity): entity is BodyEntity => entity.kind === 'body',
  )
  const materialRegions: ResolvedMaterialRegion[] = []
  const massRegions: ResolvedMassRegion[] = []
  const chargeRegions: ResolvedChargeRegion[] = []
  let totalMass = 0
  let totalCharge = 0
  let massFirstMomentX = 0
  let massFirstMomentY = 0
  for (const region of node.regions) {
    if (region.source.kind !== 'body') continue
    const retained = polygonMetrics(region.geometry)
    if (retained.area <= 0) continue
    materialRegions.push({
      sourceEntityId: region.source.id,
      geometry: region.geometry,
      area: retained.area,
      centroid: retained.centroid,
      material: region.source.material,
      color: region.source.color,
    })
  }
  for (const region of node.massRegions) {
    const retained = polygonMetrics(region.geometry)
    if (retained.area <= 0) continue
    const massKg = region.density * retained.area
    totalMass += massKg
    massFirstMomentX += massKg * retained.centroid.x
    massFirstMomentY += massKg * retained.centroid.y
    massRegions.push({
      sourceEntityId: region.sourceEntityId,
      geometry: region.geometry,
      area: retained.area,
      centroid: retained.centroid,
      massKg,
    })
  }
  for (const region of node.chargeRegions) {
    const retained = polygonMetrics(region.geometry)
    if (retained.area <= 0) continue
    const chargeC = region.density * retained.area
    totalCharge += chargeC
    chargeRegions.push({
      sourceEntityId: region.sourceEntityId,
      geometry: region.geometry,
      area: retained.area,
      centroid: retained.centroid,
      chargeC,
    })
  }
  const centerOfMass =
    totalMass > 0
      ? { x: massFirstMomentX / totalMass, y: massFirstMomentY / totalMass }
      : { x: 0, y: 0 }
  let inertiaKgM2 = 0
  for (const region of node.massRegions) {
    const retained = polygonMetrics(region.geometry)
    inertiaKgM2 +=
      region.density *
      (retained.polarMomentAboutOrigin -
        2 *
          retained.area *
          (centerOfMass.x * retained.centroid.x + centerOfMass.y * retained.centroid.y) +
        retained.area * (centerOfMass.x ** 2 + centerOfMass.y ** 2))
  }
  const upper = node.uppermostSource
  const diagnostics = [...node.diagnostics]
  if (upper.kind !== 'body' || bodySources.length !== node.sourceEntities.length) {
    diagnostics.push('布尔物体树只能包含物体。')
  }
  const convexParts: ResolvedConvexPart[] = []
  let collisionMeshes: ResolvedCollisionMesh[] = []
  try {
    for (const region of node.regions) {
      if (region.source.kind !== 'body') continue
      const expectedArea = polygonMetrics(region.geometry).area
      const bounds = boundsForGeometry(region.geometry)
      const featureSize = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y)
      const allowedAreaError = Math.max(
        featureTolerance(Math.max(featureSize, 1e-6)) ** 2,
        expectedArea * MAX_BOOLEAN_TRIANGULATION_DEVIATION,
      )
      let acceptedArea = 0
      let float32InputArea = 0
      let maximumFloat32Displacement = 0
      const regionParts: ResolvedConvexPart[] = []
      for (const worldPoints of mergeConvexTriangles(triangulateRegion(region))) {
        const localInputPoints = toLocalPoints(
          worldPoints,
          centerOfMass,
          upper.kind === 'body' ? upper.transform.angleRad : 0,
        )
        const float32InputPoints = toFloat32Points(localInputPoints)
        maximumFloat32Displacement = Math.max(
          maximumFloat32Displacement,
          maximumPointDisplacement(localInputPoints, float32InputPoints),
        )
        float32InputArea += Math.abs(signedPolygonArea(float32InputPoints))
        const localPoints = canonicalFloat32ConvexPart(float32InputPoints)
        if (!localPoints) continue
        acceptedArea += Math.abs(signedPolygonArea(localPoints))
        regionParts.push({
          sourceEntityId: region.source.id,
          material: region.source.material,
          worldPoints: toWorldPoints(
            localPoints,
            centerOfMass,
            upper.kind === 'body' ? upper.transform.angleRad : 0,
          ),
          localPoints,
        })
      }
      const coordinateTolerance = featureTolerance(Math.max(featureSize, 1e-6))
      if (maximumFloat32Displacement > coordinateTolerance) {
        throw new Error('布尔碰撞凸片转换为 Float32 后坐标误差超过允许值。')
      }
      const quantizationAreaAllowance =
        allowedAreaError +
        geometryPerimeter(region.geometry) * maximumFloat32Displacement +
        Math.PI * maximumFloat32Displacement ** 2
      if (Math.abs(expectedArea - float32InputArea) > quantizationAreaAllowance) {
        throw new Error('布尔碰撞凸片转换为 Float32 后几何面积误差超过允许值。')
      }
      const normalizedAreaLoss = Math.abs(float32InputArea - acceptedArea)
      if (normalizedAreaLoss > allowedAreaError) {
        throw new Error(
          `布尔碰撞凸片在 Float32 规范化时丢失 ${normalizedAreaLoss.toExponential(3)} m²，超过允许值 ${allowedAreaError.toExponential(3)} m²。`,
        )
      }
      convexParts.push(...regionParts)
    }
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : '三角剖分失败。')
  }
  if (convexParts.length > MAX_BOOLEAN_CONVEX_PARTS) {
    diagnostics.push(`单个布尔结果不能超过 ${MAX_BOOLEAN_CONVEX_PARTS} 个凸碰撞片。`)
  }
  if (diagnostics.length === 0) {
    try {
      collisionMeshes = buildCollisionMeshes(convexParts, node.geometry)
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : '碰撞网格合并失败。')
    }
  }
  if (diagnostics.length > 0 || upper.kind !== 'body' || totalMass <= 0) {
    return invalidResult(layer, node, diagnostics)
  }
  return {
    kind: 'body',
    resultId: layer.resultId,
    nodeId: layer.id,
    valid: true,
    sourceEntityIds: bodySources.map((source) => source.id),
    geometry: node.geometry,
    bounds: boundsForGeometry(node.geometry),
    boundaryVertexCount: countVertices(node.geometry),
    massKg: totalMass,
    chargeC: totalCharge,
    centerOfMass,
    inertiaKgM2: Math.max(0, inertiaKgM2),
    angleRad: upper.transform.angleRad,
    initialVelocity: cloneVec(upper.initialVelocity),
    initialAngularVelocityRad: upper.initialAngularVelocityRad,
    simulationEnabled: layer.simulationEnabled,
    rotationEnabled: layer.rotationEnabled,
    continuousCollisionDetection: layer.continuousCollisionDetection,
    materialRegions,
    massRegions,
    chargeRegions,
    convexParts,
    collisionMeshes,
  }
}

export function resolveBezierPathBody(
  entity: BodyEntity,
): ResolvedBooleanBody | InvalidBooleanResult {
  const operand = sourceResolution(entity)
  const layer: BooleanNode = {
    kind: 'boolean',
    id: `bezier-body:${entity.id}`,
    resultId: entity.id,
    name: entity.name,
    visible: entity.visible,
    locked: entity.locked,
    operation: 'union',
    operands: [],
    simulationEnabled: entity.simulationEnabled,
    rotationEnabled: entity.rotationEnabled,
    continuousCollisionDetection: entity.continuousCollisionDetection,
    massDistribution: { mode: 'source' },
    chargeDistribution: { mode: 'source' },
    fieldDistribution: { mode: 'source' },
    frictionDistribution: { mode: 'source' },
    restitutionDistribution: { mode: 'source' },
    initialVelocity: { mode: 'source' },
    initialAngularVelocity: { mode: 'source' },
  }
  if (entity.shape.type !== 'bezierPath' || !operand) {
    return invalidResult(layer, operand, ['该物体不是有效的钢笔物块。'])
  }
  return resolveBody(layer, operand)
}

function resolveField(
  layer: BooleanNode,
  node: OperandResolution,
): ResolvedBooleanField | InvalidBooleanResult {
  const upper = node.uppermostSource
  const diagnostics = [...node.diagnostics]
  if (upper.kind !== 'field') diagnostics.push('布尔场树只能包含同一种有限场。')
  if (
    upper.kind === 'field' &&
    layer.fieldDistribution.mode === 'uniform' &&
    layer.fieldDistribution.field.type !== upper.field.type
  ) {
    diagnostics.push('布尔统一场强必须与来源场保持同一类型。')
  }
  const regions: ResolvedFieldRegion[] = node.regions.flatMap((region) => {
    if (region.source.kind !== 'field') return []
    const metrics = polygonMetrics(region.geometry)
    return metrics.area > 0
      ? [
          {
            sourceEntityId: region.source.id,
            geometry: region.geometry,
            area: metrics.area,
            centroid: metrics.centroid,
            field: region.source.field,
          },
        ]
      : []
  })
  if (diagnostics.length > 0 || upper.kind !== 'field')
    return invalidResult(layer, node, diagnostics)
  return {
    kind: 'field',
    resultId: layer.resultId,
    nodeId: layer.id,
    valid: true,
    sourceEntityIds: node.sourceEntities.map((source) => source.id),
    geometry: node.geometry,
    bounds: boundsForGeometry(node.geometry),
    boundaryVertexCount: countVertices(node.geometry),
    fieldType: upper.field.type,
    simulationEnabled: layer.simulationEnabled,
    regions,
  }
}

function invalidResult(
  layer: BooleanNode,
  node: OperandResolution | null,
  diagnostics: string[],
): InvalidBooleanResult {
  return {
    resultId: layer.resultId,
    nodeId: layer.id,
    valid: false,
    diagnostics: [
      ...new Set(diagnostics.length > 0 ? diagnostics : ['布尔图层需要两个有效输入。']),
    ],
    sourceEntityIds: node?.sourceEntities.map((source) => source.id) ?? [],
    sourceOutlines: node?.sourceOutlines ?? [],
  }
}

function rigidTransformResolvedBody(
  previous: ResolvedBooleanBody,
  operand: OperandResolution,
  transform: RigidTransform,
): ResolvedBooleanBody {
  const transformGeometryRegion = <
    Region extends { geometry: BooleanMultiPolygon; centroid: Vec2 },
  >(
    region: Region,
  ): Region => ({
    ...region,
    geometry: rigidTransformGeometry(region.geometry, transform),
    centroid: rigidTransformPoint(region.centroid, transform),
  })
  const geometry = rigidTransformGeometry(previous.geometry, transform)
  return {
    ...previous,
    sourceEntityIds: operand.sourceEntities.map((source) => source.id),
    geometry,
    bounds: boundsForGeometry(geometry),
    centerOfMass: rigidTransformPoint(previous.centerOfMass, transform),
    angleRad: previous.angleRad + transform.angleRad,
    materialRegions: previous.materialRegions.map(transformGeometryRegion),
    massRegions: previous.massRegions.map(transformGeometryRegion),
    chargeRegions: previous.chargeRegions.map(transformGeometryRegion),
    convexParts: previous.convexParts.map((part) => ({
      ...part,
      worldPoints: part.worldPoints.map((point) => rigidTransformPoint(point, transform)),
    })),
    collisionMeshes: previous.collisionMeshes,
  }
}

function tryRigidTransformRoot(
  context: BooleanResolveContext,
  cached: StableResultCacheEntry,
  layer: BooleanNode,
): {
  operand: OperandResolution
  result: ResolvedBooleanBody
} | null {
  if (
    !sameBooleanTree(cached.treeNode, layer, context.treeMatchCache) ||
    !cached.result.valid ||
    cached.result.kind !== 'body' ||
    cached.operand.operandClass.kind !== 'body' ||
    cached.operand.sourceEntities.length === 0
  ) {
    return null
  }

  const currentSources: BodyEntity[] = []
  let transform: RigidTransform | null = null
  for (const previousSource of cached.operand.sourceEntities) {
    const currentSource = context.entityById.get(previousSource.id)
    if (
      previousSource.kind !== 'body' ||
      currentSource?.kind !== 'body' ||
      !bodyNonTransformEquals(previousSource, currentSource)
    ) {
      return null
    }
    const currentTransform = bodyRigidTransform(previousSource, currentSource)
    if (transform && !sameRigidTransform(transform, currentTransform)) return null
    transform ??= currentTransform
    currentSources.push(currentSource)
  }
  if (!transform) return null
  if (
    Math.abs(transform.angleRad) <= 1e-12 &&
    Math.hypot(transform.translation.x, transform.translation.y) <= 1e-12
  ) {
    return {
      operand: cached.operand,
      result: cached.result,
    }
  }

  const uppermostSource = context.entityById.get(cached.operand.uppermostSource.id)
  if (uppermostSource?.kind !== 'body') return null
  // 根级刚体快速路径只需保存下一次修订比较所需的来源快照。中间几何保持缓存值，
  // 最终派生结果在下方只变换一次；一旦局部几何改变，正常解析会重新物化整棵树。
  const operand: OperandResolution = {
    ...cached.operand,
    revision: nextBooleanRevision++,
    rigidFromRevision: cached.operand.revision,
    rigidTransform: transform,
    sourceEntities: currentSources,
    uppermostSource,
  }
  return {
    operand,
    result: rigidTransformResolvedBody(cached.result, operand, transform),
  }
}

function resolveRoot(layer: BooleanNode, context: BooleanResolveContext): ResolvedBooleanResult {
  const stableCached = readLru(stableResultCache, layer.id)
  if (stableCached) {
    const transformed = tryRigidTransformRoot(context, stableCached, layer)
    if (transformed) {
      resolvedResultCache.set(layer, transformed)
      writeLru(stableResultCache, layer.id, {
        operandRevision: transformed.operand.revision,
        operand: transformed.operand,
        treeNode: stableCached.treeNode,
        result: transformed.result,
      })
      return transformed.result
    }
  }
  const node = resolveNode(layer, context, 1, new Set())
  if (!node) return invalidResult(layer, null, ['布尔图层需要两个有效且无循环的输入。'])
  const cached = resolvedResultCache.get(layer)
  if (cached?.operand === node) return cached.result
  if (stableCached?.operandRevision === node.revision) {
    resolvedResultCache.set(layer, { operand: node, result: stableCached.result })
    return stableCached.result
  }
  if (
    stableCached &&
    node.rigidFromRevision === stableCached.operandRevision &&
    node.rigidTransform &&
    stableCached.result.valid &&
    stableCached.result.kind === 'body' &&
    node.operandClass.kind === 'body'
  ) {
    const transformed = rigidTransformResolvedBody(stableCached.result, node, node.rigidTransform)
    resolvedResultCache.set(layer, { operand: node, result: transformed })
    writeLru(stableResultCache, layer.id, {
      operandRevision: node.revision,
      operand: node,
      treeNode: structuredClone(layer),
      result: transformed,
    })
    return transformed
  }
  const result =
    node.operandClass.kind === 'body'
      ? resolveBody(layer, node)
      : node.operandClass.kind === 'field'
        ? resolveField(layer, node)
        : invalidResult(layer, node, node.diagnostics)
  resolvedResultCache.set(layer, { operand: node, result })
  writeLru(stableResultCache, layer.id, {
    operandRevision: node.revision,
    operand: node,
    treeNode: structuredClone(layer),
    result,
  })
  return result
}

export function resolveBooleanScene(scene: SceneDocument): ResolvedBooleanScene {
  const cached = sceneCache.get(scene)
  if (cached) return cached
  const entityById = new Map(scene.entities.map((entity) => [entity.id, entity] as const))
  const context: BooleanResolveContext = {
    entityById,
    sourceCache: new Map(),
    nodeCache: new Map(),
    treeMatchCache: new Map(),
  }
  const allNodes: BooleanNode[] = []
  walkSceneTree(scene.rootItems, ({ item }) => {
    if (item.kind === 'boolean') allNodes.push(item)
  })
  const allResults = allNodes.map((layer) => resolveRoot(layer, context))
  const allByResultId = new Map(allResults.map((result) => [result.resultId, result] as const))
  const roots = findRootBooleanLayers(scene.rootItems).map(
    (layer) => allByResultId.get(layer.resultId) ?? resolveRoot(layer, context),
  )
  let totalConvexParts = roots.reduce(
    (total, result) =>
      total + (result.valid && result.kind === 'body' ? result.convexParts.length : 0),
    0,
  )
  if (totalConvexParts > MAX_SCENE_BOOLEAN_CONVEX_PARTS) {
    for (let index = 0; index < roots.length; index += 1) {
      const result = roots[index]!
      if (result.valid && result.kind === 'body') {
        roots[index] = {
          resultId: result.resultId,
          nodeId: result.nodeId,
          valid: false,
          diagnostics: [
            `全场景布尔凸片不能超过 ${MAX_SCENE_BOOLEAN_CONVEX_PARTS} 个，当前为 ${totalConvexParts} 个。`,
          ],
          sourceEntityIds: result.sourceEntityIds,
          sourceOutlines: [result.geometry],
        }
      }
    }
    totalConvexParts = 0
  }
  const byResultId = new Map(allByResultId)
  for (const root of roots) byResultId.set(root.resultId, root)
  const rootResultIdBySourceId = new Map<EntityId, EntityId>()
  for (const result of roots) {
    for (const sourceId of result.sourceEntityIds)
      rootResultIdBySourceId.set(sourceId, result.resultId)
  }
  const resolved = { roots, byResultId, rootResultIdBySourceId, totalConvexParts }
  sceneCache.set(scene, resolved)
  return resolved
}

export function pointInBooleanGeometry(point: Vec2, geometry: BooleanMultiPolygon): boolean {
  const pointInRing = (ring: Pair[]): boolean => {
    let inside = false
    for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
      const a = ring[current]!
      const b = ring[previous]!
      const intersects =
        a[1] > point.y !== b[1] > point.y &&
        point.x < ((b[0] - a[0]) * (point.y - a[1])) / (b[1] - a[1]) + a[0]
      if (intersects) inside = !inside
    }
    return inside
  }
  return geometry.some((polygon) => {
    const outer = polygon[0]
    if (!outer || !pointInRing(outer)) return false
    return !polygon.slice(1).some(pointInRing)
  })
}

export function closestPointOnBooleanBoundary(
  point: Vec2,
  geometry: BooleanMultiPolygon,
): Vec2 | null {
  let closest: Vec2 | null = null
  let closestDistanceSquared = Number.POSITIVE_INFINITY
  for (const polygon of geometry) {
    for (const ring of polygon) {
      for (let index = 1; index < ring.length; index += 1) {
        const start = ring[index - 1]!
        const end = ring[index]!
        const deltaX = end[0] - start[0]
        const deltaY = end[1] - start[1]
        const lengthSquared = deltaX ** 2 + deltaY ** 2
        const ratio =
          lengthSquared <= Number.EPSILON
            ? 0
            : Math.min(
                1,
                Math.max(
                  0,
                  ((point.x - start[0]) * deltaX + (point.y - start[1]) * deltaY) / lengthSquared,
                ),
              )
        const candidate = {
          x: start[0] + deltaX * ratio,
          y: start[1] + deltaY * ratio,
        }
        const distanceSquared = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2
        if (distanceSquared < closestDistanceSquared) {
          closest = candidate
          closestDistanceSquared = distanceSquared
        }
      }
    }
  }
  return closest
}

export function booleanGeometryRings(geometry: BooleanMultiPolygon): Vec2[][][] {
  return geometry.map((polygon) => polygon.map((ring) => ring.slice(0, -1).map(vec)))
}

export function transformBooleanBodyGeometry(
  result: ResolvedBooleanBody,
  position: Vec2 = result.centerOfMass,
  angleRad: number = result.angleRad,
  geometry: BooleanMultiPolygon = result.geometry,
): BooleanMultiPolygon {
  const deltaAngle = angleRad - result.angleRad
  const cosine = Math.cos(deltaAngle)
  const sine = Math.sin(deltaAngle)
  return geometry.map((polygon) =>
    polygon.map((ring) =>
      ring.map(([x, y]) => {
        const localX = x - result.centerOfMass.x
        const localY = y - result.centerOfMass.y
        return [
          position.x + localX * cosine - localY * sine,
          position.y + localX * sine + localY * cosine,
        ] as Pair
      }),
    ),
  )
}

export function booleanBodyWorldToLocal(
  result: ResolvedBooleanBody,
  point: Vec2,
  position: Vec2 = result.centerOfMass,
  angleRad: number = result.angleRad,
): Vec2 {
  const cosine = Math.cos(-angleRad)
  const sine = Math.sin(-angleRad)
  const x = point.x - position.x
  const y = point.y - position.y
  return { x: x * cosine - y * sine, y: x * sine + y * cosine }
}

export function booleanBodyLocalToWorld(
  result: ResolvedBooleanBody,
  point: Vec2,
  position: Vec2 = result.centerOfMass,
  angleRad: number = result.angleRad,
): Vec2 {
  const cosine = Math.cos(angleRad)
  const sine = Math.sin(angleRad)
  return {
    x: position.x + point.x * cosine - point.y * sine,
    y: position.y + point.x * sine + point.y * cosine,
  }
}
