import { resolveGroundJoint, sameGroundEndpoint } from './groundEndpoints'
import type {
  EntityId,
  GroundEndpointKey,
  GroundEntity,
  GroundGeometry,
  GroundJointEntity,
  Material2D,
  SceneEntity,
  Vec2,
} from './types'

export const GROUND_PATH_MAX_ERROR_M = 0.002
export const GROUND_PATH_MAX_SEGMENT_LENGTH_M = 0.1
export const GROUND_PATH_MAX_SEGMENTS = 2048
export const GROUND_PATH_REFERENCE_BODY_RADIUS_M = 0.5
export const GROUND_PATH_MIN_OFFSET_SCALE = 0.08
export const GROUND_JOINT_MIN_SMOOTH_ANGLE_RAD = Math.PI / 180
export const GROUND_JOINT_LINEAR_ANGLE_RAD = (179 * Math.PI) / 180
export const GROUND_JOINT_DIRECT_MAX_GAP_M = 1e-6

const EPSILON = 1e-9
const TAU = Math.PI * 2

export interface GroundPathSamplingOptions {
  maxError: number
  maxSegmentLength: number
  maxSegments: number
}

export interface GroundPathClosestPoint {
  s: number
  point: Vec2
  tangent: Vec2
  normal: Vec2
  curvature: number
  distance: number
  signedDistance: number
}

/**
 * A ground curve parameterized by surface arc length. Open paths clamp `s` to their
 * ends; closed paths wrap it, so callers can follow a full circle for many laps.
 */
export interface GroundPath {
  readonly length: number
  readonly closed: boolean
  pointAt(s: number): Vec2
  tangentAt(s: number): Vec2
  normalAt(s: number): Vec2
  curvatureAt(s: number): number
  closestPoint(point: Vec2): GroundPathClosestPoint
  sample(overrides?: Partial<GroundPathSamplingOptions>): Vec2[]
  trim(startM: number, endM: number): GroundPath | null
  reverse(): GroundPath
}

export interface GroundPathNeighbor {
  segmentId: string
  endpoint: GroundEndpointKey
  jointId: EntityId | null
}

export interface GroundCollisionPathPiece {
  id: string
  path: GroundPath
  startS: number
  endS: number
  sourceGroundId: EntityId
  material: Material2D
}

export interface GroundNetworkSegment {
  id: string
  kind: 'ground' | 'transition'
  path: GroundPath
  sourceGroundId: EntityId | null
  jointId: EntityId | null
  adjacentGroundIds: readonly EntityId[]
  collisionPieces: readonly GroundCollisionPathPiece[]
  neighbors: Partial<Record<GroundEndpointKey, GroundPathNeighbor>>
  materialAt(s: number): Material2D
}

export interface EffectiveGroundPath {
  ground: GroundEntity
  path: GroundPath
  originalPath: GroundPath
  trimStartM: number
  trimEndM: number
  segmentId: string
}

export type GroundJointPathKind = 'quintic' | 'linear' | 'direct' | 'invalid'
export type GroundJointPathIssue =
  | ReturnType<typeof resolveGroundJoint>['issue']
  | 'angle-too-small'
  | 'linear-zero-length'
  | 'transition-invalid'

export interface ResolvedGroundJointPath {
  joint: GroundJointEntity
  issue: GroundJointPathIssue
  path: GroundPath | null
  segmentId: string | null
  kind: GroundJointPathKind
  angleRad: number
  trimA: number
  trimB: number
  directionSign: 1 | -1
  pieces: readonly GroundCollisionPathPiece[]
}

export interface GroundPathNetwork {
  segments: readonly GroundNetworkSegment[]
  segmentById: ReadonlyMap<string, GroundNetworkSegment>
  groundPaths: ReadonlyMap<EntityId, EffectiveGroundPath>
  jointPaths: ReadonlyMap<EntityId, ResolvedGroundJointPath>
}

export interface GroundPathLocation {
  segmentId: string
  s: number
  direction: 1 | -1
}

export interface GroundPathTraversal {
  location: GroundPathLocation
  distanceRemainingM: number
  stoppedAtOpenEnd: boolean
  transitions: number
}

interface ParametricDefinition {
  point(t: number): Vec2
  firstDerivative(t: number): Vec2
  secondDerivative(t: number): Vec2
}

interface ArcLengthSample {
  t: number
  s: number
  point: Vec2
}

interface QuinticControlPoints {
  p0: Vec2
  p1: Vec2
  p2: Vec2
  p3: Vec2
  p4: Vec2
  p5: Vec2
}

interface MutableNetworkSegment extends GroundNetworkSegment {
  neighbors: Partial<Record<GroundEndpointKey, GroundPathNeighbor>>
}

interface CachedGeometryPath {
  signature: string
  path: GroundPath | null
}

interface CachedTransitionPath {
  pathA: GroundPath
  pathB: GroundPath
  requestedTrimA: number
  requestedTrimB: number
  resolvedTrimA: number
  resolvedTrimB: number
  angleRad: number
  directionSign: 1 | -1
  path: GroundPath | null
  kind: GroundJointPathKind
}

interface ValidGroundJointData {
  joint: GroundJointEntity
  resolved: ReturnType<typeof resolveGroundJoint>
  angleRad: number
  desiredA: number
  desiredB: number
  direct: boolean
  directionSign: 1 | -1
}

interface PreparedGroundJointTransition {
  data: ValidGroundJointData
  path: GroundPath | null
  kind: GroundJointPathKind
  trimA: number
  trimB: number
}

const geometryPathCache = new WeakMap<object, CachedGeometryPath>()
const transitionPathCache = new WeakMap<GroundJointEntity, CachedTransitionPath>()

function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y }
}

function subtract(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y }
}

function scale(vector: Vec2, factor: number): Vec2 {
  return { x: vector.x * factor, y: vector.y * factor }
}

function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y
}

function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x
}

function length(vector: Vec2): number {
  return Math.hypot(vector.x, vector.y)
}

function distance(a: Vec2, b: Vec2): number {
  return length(subtract(a, b))
}

function normalize(vector: Vec2): Vec2 {
  const magnitude = length(vector)
  return magnitude > EPSILON ? scale(vector, 1 / magnitude) : { x: 1, y: 0 }
}

function leftNormal(vector: Vec2): Vec2 {
  return { x: -vector.y, y: vector.x }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function pointToSegmentDistance(point: Vec2, start: Vec2, end: Vec2): number {
  const segment = subtract(end, start)
  const denominator = dot(segment, segment)
  if (denominator <= EPSILON) return distance(point, start)
  const fraction = clamp(dot(subtract(point, start), segment) / denominator, 0, 1)
  return distance(point, add(start, scale(segment, fraction)))
}

function normalizedS(path: GroundPath, s: number): number {
  if (!Number.isFinite(s) || path.length <= EPSILON) return 0
  if (!path.closed) return clamp(s, 0, path.length)
  const wrapped = s % path.length
  return wrapped < 0 ? wrapped + path.length : wrapped
}

function makeClosest(path: GroundPath, s: number, point: Vec2): GroundPathClosestPoint {
  const pathPoint = path.pointAt(s)
  const tangent = path.tangentAt(s)
  const normal = leftNormal(tangent)
  const delta = subtract(point, pathPoint)
  return {
    s: normalizedS(path, s),
    point: pathPoint,
    tangent,
    normal,
    curvature: path.curvatureAt(s),
    distance: length(delta),
    signedDistance: dot(delta, normal),
  }
}

function samplePath(path: GroundPath, overrides: Partial<GroundPathSamplingOptions> = {}): Vec2[] {
  const options: GroundPathSamplingOptions = {
    maxError: GROUND_PATH_MAX_ERROR_M,
    maxSegmentLength: GROUND_PATH_MAX_SEGMENT_LENGTH_M,
    maxSegments: GROUND_PATH_MAX_SEGMENTS,
    ...overrides,
  }
  if (path.length <= EPSILON || options.maxSegments < 1) return []

  const result: Vec2[] = [path.pointAt(0)]
  const appendRange = (s0: number, p0: Vec2, s1: number, p1: Vec2, depth: number): void => {
    if (result.length > options.maxSegments) return
    const quarterS = s0 + (s1 - s0) * 0.25
    const middleS = (s0 + s1) / 2
    const threeQuarterS = s0 + (s1 - s0) * 0.75
    const q1 = path.pointAt(quarterS)
    const middle = path.pointAt(middleS)
    const q3 = path.pointAt(threeQuarterS)
    const error = Math.max(
      pointToSegmentDistance(q1, p0, p1),
      pointToSegmentDistance(middle, p0, p1),
      pointToSegmentDistance(q3, p0, p1),
    )
    if (
      depth >= 20 ||
      (error <= Math.max(EPSILON, options.maxError) &&
        s1 - s0 <= Math.max(EPSILON, options.maxSegmentLength))
    ) {
      result.push(p1)
      return
    }
    appendRange(s0, p0, middleS, middle, depth + 1)
    if (result.length > options.maxSegments) return
    appendRange(middleS, middle, s1, p1, depth + 1)
  }

  appendRange(0, result[0]!, path.length, path.pointAt(path.length), 0)
  if (result.length > options.maxSegments + 1) {
    return result.slice(0, options.maxSegments).concat(path.pointAt(path.length))
  }
  return result
}

abstract class BaseGroundPath implements GroundPath {
  abstract readonly length: number
  abstract readonly closed: boolean
  abstract pointAt(s: number): Vec2
  abstract tangentAt(s: number): Vec2
  abstract curvatureAt(s: number): number
  abstract closestPoint(point: Vec2): GroundPathClosestPoint

  normalAt(s: number): Vec2 {
    return leftNormal(this.tangentAt(s))
  }

  sample(overrides: Partial<GroundPathSamplingOptions> = {}): Vec2[] {
    return samplePath(this, overrides)
  }

  trim(startM: number, endM: number): GroundPath | null {
    const start = clamp(finiteNonNegative(startM), 0, this.length)
    const end = clamp(finiteNonNegative(endM), 0, this.length - start)
    if (this.length - start - end <= EPSILON) return null
    if (start <= EPSILON && end <= EPSILON) return this
    return new WindowGroundPath(this, start, this.length - end)
  }

  reverse(): GroundPath {
    return new ReversedGroundPath(this)
  }
}

class LineGroundPath extends BaseGroundPath {
  readonly closed = false
  readonly length: number
  private readonly tangent: Vec2

  constructor(
    private readonly start: Vec2,
    private readonly end: Vec2,
  ) {
    super()
    this.length = distance(start, end)
    this.tangent = normalize(subtract(end, start))
  }

  pointAt(s: number): Vec2 {
    return add(this.start, scale(this.tangent, normalizedS(this, s)))
  }

  tangentAt(): Vec2 {
    return this.tangent
  }

  curvatureAt(): number {
    return 0
  }

  closestPoint(point: Vec2): GroundPathClosestPoint {
    const s = clamp(dot(subtract(point, this.start), this.tangent), 0, this.length)
    return makeClosest(this, s, point)
  }

  override sample(): Vec2[] {
    // A line is already an exact collision primitive. Subdividing it at the curve
    // approximation limit creates redundant collinear Rapier contacts at every vertex.
    return [this.start, this.end]
  }
}

class ArcGroundPath extends BaseGroundPath {
  readonly length: number
  readonly closed: boolean
  private readonly direction: 1 | -1
  private readonly span: number

  constructor(
    private readonly center: Vec2,
    private readonly radius: number,
    private readonly startRad: number,
    private readonly endRad: number,
  ) {
    super()
    this.span = endRad - startRad
    this.direction = this.span >= 0 ? 1 : -1
    this.length = Math.abs(this.span) * radius
    const turns = Math.abs(this.span) / TAU
    this.closed = turns >= 1 - 1e-9 && Math.abs(turns - Math.round(turns)) <= 1e-9
  }

  private angleAt(s: number): number {
    const resolvedS = normalizedS(this, s)
    return this.startRad + (this.direction * resolvedS) / this.radius
  }

  pointAt(s: number): Vec2 {
    const angle = this.angleAt(s)
    return {
      x: this.center.x + this.radius * Math.cos(angle),
      y: this.center.y + this.radius * Math.sin(angle),
    }
  }

  tangentAt(s: number): Vec2 {
    const angle = this.angleAt(s)
    return {
      x: -Math.sin(angle) * this.direction,
      y: Math.cos(angle) * this.direction,
    }
  }

  curvatureAt(): number {
    return this.direction / this.radius
  }

  closestPoint(point: Vec2): GroundPathClosestPoint {
    const pointAngle = Math.atan2(point.y - this.center.y, point.x - this.center.x)
    if (this.closed) {
      let directedAngle = this.direction * (pointAngle - this.startRad)
      directedAngle = ((directedAngle % TAU) + TAU) % TAU
      return makeClosest(this, directedAngle * this.radius, point)
    }

    const directedSpan = Math.abs(this.span)
    const raw = this.direction * (pointAngle - this.startRad)
    let bestAngle = 0
    let bestAngularDistance = Infinity
    for (let turn = -2; turn <= 2; turn += 1) {
      const candidate = raw + turn * TAU * this.direction
      const clamped = clamp(candidate, 0, directedSpan)
      const angularDistance = Math.abs(candidate - clamped)
      if (angularDistance < bestAngularDistance) {
        bestAngularDistance = angularDistance
        bestAngle = clamped
      }
    }
    return makeClosest(this, bestAngle * this.radius, point)
  }
}

class ParametricGroundPath extends BaseGroundPath {
  readonly closed = false
  readonly length: number
  private readonly samples: ArcLengthSample[]

  constructor(private readonly definition: ParametricDefinition) {
    super()
    this.samples = this.buildArcLengthSamples()
    this.length = this.samples.at(-1)?.s ?? 0
  }

  hasRegularDerivative(): boolean {
    for (let index = 0; index <= 256; index += 1) {
      if (length(this.definition.firstDerivative(index / 256)) <= 1e-8) return false
    }
    return true
  }

  private buildArcLengthSamples(): ArcLengthSample[] {
    const start = this.definition.point(0)
    const result: Array<{ t: number; point: Vec2 }> = [{ t: 0, point: start }]
    const subdivide = (t0: number, p0: Vec2, t1: number, p1: Vec2, depth: number): void => {
      const quarterT = t0 + (t1 - t0) * 0.25
      const middleT = (t0 + t1) / 2
      const threeQuarterT = t0 + (t1 - t0) * 0.75
      const q1 = this.definition.point(quarterT)
      const middle = this.definition.point(middleT)
      const q3 = this.definition.point(threeQuarterT)
      const chord = distance(p0, p1)
      const polygon =
        distance(p0, q1) + distance(q1, middle) + distance(middle, q3) + distance(q3, p1)
      const lengthTolerance = Math.max(1e-8, polygon * 1e-7)
      if (depth >= 14 || (t1 - t0 <= 1 / 32 && polygon - chord <= lengthTolerance)) {
        result.push({ t: t1, point: p1 })
        return
      }
      subdivide(t0, p0, middleT, middle, depth + 1)
      subdivide(middleT, middle, t1, p1, depth + 1)
    }
    subdivide(0, start, 1, this.definition.point(1), 0)

    let s = 0
    return result.map((sample, index) => {
      if (index > 0) s += distance(result[index - 1]!.point, sample.point)
      return { ...sample, s }
    })
  }

  private sampleIndexForS(s: number): number {
    const resolved = clamp(s, 0, this.length)
    let low = 0
    let high = this.samples.length - 1
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if ((this.samples[middle]?.s ?? 0) < resolved) low = middle + 1
      else high = middle
    }
    return low
  }

  private sampleIndexForT(t: number): number {
    const resolved = clamp(t, 0, 1)
    let low = 0
    let high = this.samples.length - 1
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if ((this.samples[middle]?.t ?? 0) < resolved) low = middle + 1
      else high = middle
    }
    return low
  }

  private tAtS(s: number): number {
    const resolved = clamp(s, 0, this.length)
    const index = this.sampleIndexForS(resolved)
    const after = this.samples[index] ?? this.samples.at(-1)!
    const before = this.samples[Math.max(0, index - 1)] ?? after
    const span = after.s - before.s
    const fraction = span > EPSILON ? (resolved - before.s) / span : 0
    return before.t + (after.t - before.t) * fraction
  }

  private sAtT(t: number): number {
    const resolved = clamp(t, 0, 1)
    const index = this.sampleIndexForT(resolved)
    const after = this.samples[index] ?? this.samples.at(-1)!
    const before = this.samples[Math.max(0, index - 1)] ?? after
    const span = after.t - before.t
    const fraction = span > EPSILON ? (resolved - before.t) / span : 0
    return before.s + (after.s - before.s) * fraction
  }

  pointAt(s: number): Vec2 {
    return this.definition.point(this.tAtS(s))
  }

  tangentAt(s: number): Vec2 {
    const t = this.tAtS(s)
    const derivative = this.definition.firstDerivative(t)
    if (length(derivative) > EPSILON) return normalize(derivative)
    const delta = Math.max(1e-7, this.length * 1e-6)
    return normalize(subtract(this.pointAt(s + delta), this.pointAt(s - delta)))
  }

  curvatureAt(s: number): number {
    const t = this.tAtS(s)
    const first = this.definition.firstDerivative(t)
    const speed = length(first)
    if (speed <= EPSILON) return 0
    return cross(first, this.definition.secondDerivative(t)) / speed ** 3
  }

  closestPoint(point: Vec2): GroundPathClosestPoint {
    let bestT = 0
    let bestDistanceSquared = Infinity
    for (let index = 1; index < this.samples.length; index += 1) {
      const before = this.samples[index - 1]!
      const after = this.samples[index]!
      const chord = subtract(after.point, before.point)
      const denominator = dot(chord, chord)
      const fraction =
        denominator > EPSILON
          ? clamp(dot(subtract(point, before.point), chord) / denominator, 0, 1)
          : 0
      const candidate = add(before.point, scale(chord, fraction))
      const delta = subtract(candidate, point)
      const candidateDistanceSquared = dot(delta, delta)
      if (candidateDistanceSquared < bestDistanceSquared) {
        bestDistanceSquared = candidateDistanceSquared
        bestT = before.t + (after.t - before.t) * fraction
      }
    }

    for (let iteration = 0; iteration < 10; iteration += 1) {
      const curvePoint = this.definition.point(bestT)
      const first = this.definition.firstDerivative(bestT)
      const second = this.definition.secondDerivative(bestT)
      const delta = subtract(curvePoint, point)
      const numerator = dot(delta, first)
      const denominator = dot(first, first) + dot(delta, second)
      if (Math.abs(denominator) <= EPSILON) break
      const nextT = clamp(bestT - numerator / denominator, 0, 1)
      if (Math.abs(nextT - bestT) <= 1e-12) break
      bestT = nextT
    }
    return makeClosest(this, this.sAtT(bestT), point)
  }
}

class WindowGroundPath extends BaseGroundPath {
  readonly closed = false
  readonly length: number

  constructor(
    private readonly source: GroundPath,
    private readonly sourceStartS: number,
    private readonly sourceEndS: number,
  ) {
    super()
    this.length = sourceEndS - sourceStartS
  }

  private sourceS(s: number): number {
    return this.sourceStartS + clamp(s, 0, this.length)
  }

  pointAt(s: number): Vec2 {
    return this.source.pointAt(this.sourceS(s))
  }

  tangentAt(s: number): Vec2 {
    return this.source.tangentAt(this.sourceS(s))
  }

  curvatureAt(s: number): number {
    return this.source.curvatureAt(this.sourceS(s))
  }

  closestPoint(point: Vec2): GroundPathClosestPoint {
    const sourceClosest = this.source.closestPoint(point)
    const sourceCandidates = this.source.closed
      ? [
          sourceClosest.s - this.source.length,
          sourceClosest.s,
          sourceClosest.s + this.source.length,
        ]
      : [sourceClosest.s]
    const candidates = [0, this.length]
    for (const sourceS of sourceCandidates) {
      candidates.push(clamp(sourceS - this.sourceStartS, 0, this.length))
    }
    let best = makeClosest(this, candidates[0]!, point)
    for (const candidate of candidates.slice(1)) {
      const closest = makeClosest(this, candidate, point)
      if (closest.distance < best.distance) best = closest
    }
    return best
  }

  override sample(overrides: Partial<GroundPathSamplingOptions> = {}): Vec2[] {
    if (this.source instanceof LineGroundPath) {
      return [this.pointAt(0), this.pointAt(this.length)]
    }
    return samplePath(this, overrides)
  }
}

class ReversedGroundPath extends BaseGroundPath {
  readonly closed: boolean
  readonly length: number

  constructor(private readonly source: GroundPath) {
    super()
    this.closed = source.closed
    this.length = source.length
  }

  private sourceS(s: number): number {
    const resolved = normalizedS(this, s)
    return this.length - resolved
  }

  pointAt(s: number): Vec2 {
    return this.source.pointAt(this.sourceS(s))
  }

  tangentAt(s: number): Vec2 {
    return scale(this.source.tangentAt(this.sourceS(s)), -1)
  }

  curvatureAt(s: number): number {
    return -this.source.curvatureAt(this.sourceS(s))
  }

  closestPoint(point: Vec2): GroundPathClosestPoint {
    const closest = this.source.closestPoint(point)
    const s = this.closed
      ? (this.length - closest.s) % this.length
      : clamp(this.length - closest.s, 0, this.length)
    return makeClosest(this, s, point)
  }

  override reverse(): GroundPath {
    return this.source
  }
}

class CompositeGroundPath extends BaseGroundPath {
  readonly closed: boolean
  readonly length: number
  private readonly cumulativeLengths: number[]

  constructor(
    private readonly paths: readonly GroundPath[],
    closed = false,
  ) {
    super()
    this.closed = closed
    let accumulated = 0
    this.cumulativeLengths = paths.map((path) => {
      accumulated += path.length
      return accumulated
    })
    this.length = accumulated
  }

  private locate(s: number): { path: GroundPath; localS: number; index: number } {
    const resolved = normalizedS(this, s)
    let index = this.cumulativeLengths.findIndex((end) => resolved <= end + EPSILON)
    if (index < 0) index = this.paths.length - 1
    const start = index > 0 ? this.cumulativeLengths[index - 1]! : 0
    return { path: this.paths[index]!, localS: resolved - start, index }
  }

  pointAt(s: number): Vec2 {
    const located = this.locate(s)
    return located.path.pointAt(located.localS)
  }

  tangentAt(s: number): Vec2 {
    const located = this.locate(s)
    return located.path.tangentAt(located.localS)
  }

  curvatureAt(s: number): number {
    const located = this.locate(s)
    return located.path.curvatureAt(located.localS)
  }

  closestPoint(point: Vec2): GroundPathClosestPoint {
    let bestS = 0
    let bestDistance = Infinity
    let offset = 0
    for (const path of this.paths) {
      const closest = path.closestPoint(point)
      if (closest.distance < bestDistance) {
        bestDistance = closest.distance
        bestS = offset + closest.s
      }
      offset += path.length
    }
    return makeClosest(this, bestS, point)
  }

  override reverse(): GroundPath {
    return new CompositeGroundPath(
      [...this.paths].reverse().map((path) => path.reverse()),
      this.closed,
    )
  }

  hasRegularDerivative(): boolean {
    return this.paths.every((path) => pathDerivativeIsRegular(path))
  }
}

function pathDerivativeIsRegular(path: GroundPath): boolean {
  if (path instanceof ParametricGroundPath || path instanceof CompositeGroundPath) {
    return path.hasRegularDerivative()
  }
  return true
}

function cubicDefinition(
  geometry: Extract<GroundGeometry, { type: 'cubicBezier' }>,
): ParametricDefinition {
  return {
    point(t) {
      const inverse = 1 - t
      return {
        x:
          inverse ** 3 * geometry.p0.x +
          3 * inverse ** 2 * t * geometry.p1.x +
          3 * inverse * t ** 2 * geometry.p2.x +
          t ** 3 * geometry.p3.x,
        y:
          inverse ** 3 * geometry.p0.y +
          3 * inverse ** 2 * t * geometry.p1.y +
          3 * inverse * t ** 2 * geometry.p2.y +
          t ** 3 * geometry.p3.y,
      }
    },
    firstDerivative(t) {
      const inverse = 1 - t
      return {
        x:
          3 * inverse ** 2 * (geometry.p1.x - geometry.p0.x) +
          6 * inverse * t * (geometry.p2.x - geometry.p1.x) +
          3 * t ** 2 * (geometry.p3.x - geometry.p2.x),
        y:
          3 * inverse ** 2 * (geometry.p1.y - geometry.p0.y) +
          6 * inverse * t * (geometry.p2.y - geometry.p1.y) +
          3 * t ** 2 * (geometry.p3.y - geometry.p2.y),
      }
    },
    secondDerivative(t) {
      return {
        x:
          6 * (1 - t) * (geometry.p2.x - 2 * geometry.p1.x + geometry.p0.x) +
          6 * t * (geometry.p3.x - 2 * geometry.p2.x + geometry.p1.x),
        y:
          6 * (1 - t) * (geometry.p2.y - 2 * geometry.p1.y + geometry.p0.y) +
          6 * t * (geometry.p3.y - 2 * geometry.p2.y + geometry.p1.y),
      }
    },
  }
}

function quinticDefinition(control: QuinticControlPoints): ParametricDefinition {
  const points = [control.p0, control.p1, control.p2, control.p3, control.p4, control.p5]
  return {
    point(t) {
      const inverse = 1 - t
      const weights = [
        inverse ** 5,
        5 * inverse ** 4 * t,
        10 * inverse ** 3 * t ** 2,
        10 * inverse ** 2 * t ** 3,
        5 * inverse * t ** 4,
        t ** 5,
      ]
      return points.reduce((result, point, index) => add(result, scale(point!, weights[index]!)), {
        x: 0,
        y: 0,
      })
    },
    firstDerivative(t) {
      const inverse = 1 - t
      const weights = [
        inverse ** 4,
        4 * inverse ** 3 * t,
        6 * inverse ** 2 * t ** 2,
        4 * inverse * t ** 3,
        t ** 4,
      ]
      let result = { x: 0, y: 0 }
      for (let index = 0; index < 5; index += 1) {
        result = add(
          result,
          scale(subtract(points[index + 1]!, points[index]!), 5 * weights[index]!),
        )
      }
      return result
    },
    secondDerivative(t) {
      const inverse = 1 - t
      const weights = [inverse ** 3, 3 * inverse ** 2 * t, 3 * inverse * t ** 2, t ** 3]
      let result = { x: 0, y: 0 }
      for (let index = 0; index < 4; index += 1) {
        const secondDifference = add(
          subtract(points[index + 2]!, scale(points[index + 1]!, 2)),
          points[index]!,
        )
        result = add(result, scale(secondDifference, 20 * weights[index]!))
      }
      return result
    },
  }
}

function createQuinticHermitePath(
  start: Vec2,
  startTangent: Vec2,
  startCurvature: number,
  end: Vec2,
  endTangent: Vec2,
  endCurvature: number,
  startScale: number,
  endScale: number,
): GroundPath {
  const startVelocity = scale(normalize(startTangent), Math.max(EPSILON, startScale))
  const endVelocity = scale(normalize(endTangent), Math.max(EPSILON, endScale))
  const startAcceleration = scale(
    leftNormal(normalize(startTangent)),
    startCurvature * startScale ** 2,
  )
  const endAcceleration = scale(leftNormal(normalize(endTangent)), endCurvature * endScale ** 2)
  const p1 = add(start, scale(startVelocity, 1 / 5))
  const p2 = add(add(scale(p1, 2), scale(start, -1)), scale(startAcceleration, 1 / 20))
  const p4 = subtract(end, scale(endVelocity, 1 / 5))
  const p3 = add(add(scale(p4, 2), scale(end, -1)), scale(endAcceleration, 1 / 20))
  return new ParametricGroundPath({
    ...quinticDefinition({ p0: start, p1, p2, p3, p4, p5: end }),
  })
}

export function createGroundPath(geometry: GroundGeometry): GroundPath | null {
  const signature = groundGeometrySignature(geometry)
  const cached = geometryPathCache.get(geometry)
  if (cached?.signature === signature) return cached.path

  let path: GroundPath | null
  if (geometry.type === 'line') {
    const line = new LineGroundPath(geometry.start, geometry.end)
    path = line.length > EPSILON ? line : null
  } else if (geometry.type === 'arc') {
    if (geometry.radius <= EPSILON || Math.abs(geometry.endRad - geometry.startRad) <= EPSILON) {
      path = null
    } else {
      path = new ArcGroundPath(geometry.center, geometry.radius, geometry.startRad, geometry.endRad)
    }
  } else {
    const bezier = new ParametricGroundPath(cubicDefinition(geometry))
    path = bezier.length > EPSILON ? bezier : null
  }
  geometryPathCache.set(geometry, { signature, path })
  return path
}

function groundGeometrySignature(geometry: GroundGeometry): string {
  if (geometry.type === 'line') {
    return `line:${geometry.start.x}:${geometry.start.y}:${geometry.end.x}:${geometry.end.y}`
  }
  if (geometry.type === 'arc') {
    return `arc:${geometry.center.x}:${geometry.center.y}:${geometry.radius}:${geometry.startRad}:${geometry.endRad}`
  }
  return `cubic:${geometry.p0.x}:${geometry.p0.y}:${geometry.p1.x}:${geometry.p1.y}:${geometry.p2.x}:${geometry.p2.y}:${geometry.p3.x}:${geometry.p3.y}`
}

export function createCompositeGroundPath(
  paths: readonly GroundPath[],
  closed = false,
): GroundPath | null {
  const nonEmpty = paths.filter((path) => path.length > EPSILON)
  if (nonEmpty.length === 0) return null
  if (nonEmpty.length === 1 && !closed) return nonEmpty[0]!
  return new CompositeGroundPath(nonEmpty, closed)
}

export function groundPathSegmentId(groundId: EntityId): string {
  return `ground:${groundId}`
}

export function groundJointPathSegmentId(jointId: EntityId): string {
  return `joint:${jointId}`
}

function endpointPathS(path: GroundPath, endpoint: GroundEndpointKey, trimM: number): number {
  return endpoint === 'start' ? trimM : path.length - trimM
}

function outwardTangent(path: GroundPath, endpoint: GroundEndpointKey, trimM: number): Vec2 {
  const tangent = path.tangentAt(endpointPathS(path, endpoint, trimM))
  return endpoint === 'start' ? scale(tangent, -1) : tangent
}

function inwardTangent(path: GroundPath, endpoint: GroundEndpointKey, trimM: number): Vec2 {
  return scale(outwardTangent(path, endpoint, trimM), -1)
}

function orientedCurvature(
  path: GroundPath,
  endpoint: GroundEndpointKey,
  trimM: number,
  orientation: 'outward' | 'inward',
): number {
  const base = path.curvatureAt(endpointPathS(path, endpoint, trimM))
  const naturalDirection =
    orientation === 'outward' ? (endpoint === 'end' ? 1 : -1) : endpoint === 'start' ? 1 : -1
  return base * naturalDirection
}

interface SegmentBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function segmentBounds(start: Vec2, end: Vec2): SegmentBounds {
  return {
    minX: Math.min(start.x, end.x),
    minY: Math.min(start.y, end.y),
    maxX: Math.max(start.x, end.x),
    maxY: Math.max(start.y, end.y),
  }
}

function boundsOverlap(a: SegmentBounds, b: SegmentBounds, tolerance: number): boolean {
  return !(
    a.maxX < b.minX - tolerance ||
    b.maxX < a.minX - tolerance ||
    a.maxY < b.minY - tolerance ||
    b.maxY < a.minY - tolerance
  )
}

function pointOnSegment(point: Vec2, start: Vec2, end: Vec2, tolerance: number): boolean {
  const segmentLength = distance(start, end)
  const areaTolerance = tolerance * Math.max(segmentLength, tolerance)
  return (
    Math.abs(cross(subtract(end, start), subtract(point, start))) <= areaTolerance &&
    point.x >= Math.min(start.x, end.x) - tolerance &&
    point.x <= Math.max(start.x, end.x) + tolerance &&
    point.y >= Math.min(start.y, end.y) - tolerance &&
    point.y <= Math.max(start.y, end.y) + tolerance
  )
}

function robustSegmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2, tolerance: number): boolean {
  if (!boundsOverlap(segmentBounds(a, b), segmentBounds(c, d), tolerance)) return false
  const ab = subtract(b, a)
  const cd = subtract(d, c)
  const areaTolerance = tolerance * Math.max(length(ab), length(cd), tolerance)
  const orientations = [
    cross(ab, subtract(c, a)),
    cross(ab, subtract(d, a)),
    cross(cd, subtract(a, c)),
    cross(cd, subtract(b, c)),
  ]
  const signs = orientations.map((value) =>
    value > areaTolerance ? 1 : value < -areaTolerance ? -1 : 0,
  )
  if (signs[0]! * signs[1]! < 0 && signs[2]! * signs[3]! < 0) return true
  return (
    (signs[0] === 0 && pointOnSegment(c, a, b, tolerance)) ||
    (signs[1] === 0 && pointOnSegment(d, a, b, tolerance)) ||
    (signs[2] === 0 && pointOnSegment(a, c, d, tolerance)) ||
    (signs[3] === 0 && pointOnSegment(b, c, d, tolerance))
  )
}

export function groundPathHasSelfIntersection(path: GroundPath): boolean {
  const coarse = path.sample({
    maxError: Math.max(1e-7, path.length * 1e-6),
    maxSegmentLength: Math.max(0.005, path.length / 64),
    maxSegments: 256,
  })
  if (coarse.length < 4) return false
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of coarse) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  const scaleM = Math.max(maxX - minX, maxY - minY, path.length, 1e-6)
  const tolerance = Math.max(1e-9, scaleM * 1e-7)
  const points = path.sample({
    maxError: Math.max(tolerance * 2, scaleM * 2e-6),
    maxSegmentLength: Math.max(tolerance * 8, path.length / 384),
    maxSegments: 1024,
  })
  const bounds = Array.from({ length: Math.max(0, points.length - 1) }, (_, index) =>
    segmentBounds(points[index]!, points[index + 1]!),
  )
  const cellSize = Math.max(scaleM / 64, tolerance * 8)
  const cells = new Map<string, number[]>()
  for (let second = 0; second + 1 < points.length; second += 1) {
    const secondBounds = bounds[second]!
    const minCellX = Math.floor((secondBounds.minX - minX - tolerance) / cellSize)
    const maxCellX = Math.floor((secondBounds.maxX - minX + tolerance) / cellSize)
    const minCellY = Math.floor((secondBounds.minY - minY - tolerance) / cellSize)
    const maxCellY = Math.floor((secondBounds.maxY - minY + tolerance) / cellSize)
    const candidates = new Set<number>()
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
        for (const candidate of cells.get(`${cellX}:${cellY}`) ?? []) candidates.add(candidate)
      }
    }
    for (const first of candidates) {
      if (second <= first + 1) continue
      if (path.closed && first === 0 && second + 1 === points.length - 1) continue
      if (!boundsOverlap(bounds[first]!, secondBounds, tolerance)) continue
      if (
        robustSegmentsIntersect(
          points[first]!,
          points[first + 1]!,
          points[second]!,
          points[second + 1]!,
          tolerance,
        )
      ) {
        return true
      }
    }
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
        const key = `${cellX}:${cellY}`
        const entries = cells.get(key)
        if (entries) entries.push(second)
        else cells.set(key, [second])
      }
    }
  }
  return false
}

export function groundPathMinimumOffsetScale(
  path: GroundPath,
  radiusM = GROUND_PATH_REFERENCE_BODY_RADIUS_M,
): number {
  const radius = finiteNonNegative(radiusM)
  if (radius <= EPSILON) return 1
  const sampleCount = Math.min(4096, Math.max(512, Math.ceil(path.length / 0.01)))
  let minimum = Infinity
  for (let index = 0; index <= sampleCount; index += 1) {
    const curvature = Math.abs(path.curvatureAt((path.length * index) / sampleCount))
    if (!Number.isFinite(curvature)) return -Infinity
    minimum = Math.min(minimum, 1 - radius * curvature)
  }
  return minimum
}

function pathMaximumAbsoluteCurvature(path: GroundPath): number {
  const sampleCount = Math.min(2048, Math.max(256, Math.ceil(path.length / 0.02)))
  let maximum = 0
  for (let index = 0; index <= sampleCount; index += 1) {
    const curvature = Math.abs(path.curvatureAt((path.length * index) / sampleCount))
    if (!Number.isFinite(curvature)) return Infinity
    maximum = Math.max(maximum, curvature)
  }
  return maximum
}

function allowedTransitionCurvature(startCurvature: number, endCurvature: number): number {
  const referenceMaximum = (1 - GROUND_PATH_MIN_OFFSET_SCALE) / GROUND_PATH_REFERENCE_BODY_RADIUS_M
  const endpointMaximum = Math.max(Math.abs(startCurvature), Math.abs(endCurvature))
  // A connected source curve may already be tighter than the reference 0.5 m ball can
  // follow on one side. That is a per-body contact question handled by offsetScale;
  // it must not invalidate an otherwise finite, regular transition for smaller balls.
  return endpointMaximum > referenceMaximum ? Infinity : referenceMaximum
}

function pathIsRegular(path: GroundPath, maximumAbsoluteCurvature: number): boolean {
  if (
    !Number.isFinite(path.length) ||
    path.length <= EPSILON ||
    !pathDerivativeIsRegular(path) ||
    pathMaximumAbsoluteCurvature(path) > maximumAbsoluteCurvature ||
    groundPathHasSelfIntersection(path)
  ) {
    return false
  }
  for (let index = 0; index <= 64; index += 1) {
    const s = (path.length * index) / 64
    const point = path.pointAt(s)
    const tangent = path.tangentAt(s)
    const curvature = path.curvatureAt(s)
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      !Number.isFinite(tangent.x) ||
      !Number.isFinite(tangent.y) ||
      !Number.isFinite(curvature) ||
      Math.abs(length(tangent) - 1) > 1e-4
    ) {
      return false
    }
  }
  return true
}

function pathStaysWithinTransitionEnvelope(
  path: GroundPath,
  start: Vec2,
  end: Vec2,
  trimA: number,
  trimB: number,
): boolean {
  const scaleM = Math.max(distance(start, end), trimA + trimB, 0.01)
  if (path.length > scaleM * 6) return false

  let accumulatedTurn = 0
  let previousTangent = path.tangentAt(0)
  for (let index = 0; index <= 96; index += 1) {
    const s = (path.length * index) / 96
    if (pointToSegmentDistance(path.pointAt(s), start, end) > scaleM * 2) return false
    const tangent = path.tangentAt(s)
    if (index > 0) {
      accumulatedTurn += Math.abs(
        Math.atan2(cross(previousTangent, tangent), dot(previousTangent, tangent)),
      )
      if (accumulatedTurn > Math.PI * 1.5) return false
    }
    previousTangent = tangent
  }
  return true
}

function buildOrdinaryTransition(
  start: Vec2,
  startTangent: Vec2,
  startCurvature: number,
  end: Vec2,
  endTangent: Vec2,
  endCurvature: number,
  trimA: number,
  trimB: number,
): GroundPath | null {
  const chord = distance(start, end)
  const maximumAbsoluteCurvature = allowedTransitionCurvature(startCurvature, endCurvature)
  const angleRad = Math.acos(clamp(dot(normalize(startTangent), normalize(endTangent)), -1, 1))
  const preferredHandleFactor = clamp(2.5 - Math.max(0, angleRad - Math.PI / 2) * 1.308, 0.7, 2.5)
  for (const handleFactor of [
    ...new Set([preferredHandleFactor, 0.5, 0.8, 1, 1.25, 1.6, 2, 2.5, 3, 4, 5, 6]),
  ]) {
    const path = createQuinticHermitePath(
      start,
      startTangent,
      startCurvature,
      end,
      endTangent,
      endCurvature,
      Math.max(chord * 0.5, trimA * handleFactor),
      Math.max(chord * 0.5, trimB * handleFactor),
    )
    if (
      !pathIsRegular(path, maximumAbsoluteCurvature) ||
      !pathStaysWithinTransitionEnvelope(path, start, end, trimA, trimB)
    )
      continue
    return path
  }
  return null
}

function endpointKey(groundId: EntityId, endpoint: GroundEndpointKey): string {
  return `${groundId}:${endpoint}`
}

function connectSegments(
  first: MutableNetworkSegment,
  firstEndpoint: GroundEndpointKey,
  second: MutableNetworkSegment,
  secondEndpoint: GroundEndpointKey,
  jointId: EntityId | null,
): void {
  first.neighbors[firstEndpoint] = {
    segmentId: second.id,
    endpoint: secondEndpoint,
    jointId,
  }
  second.neighbors[secondEndpoint] = {
    segmentId: first.id,
    endpoint: firstEndpoint,
    jointId,
  }
}

function transitionSetting(joint: GroundJointEntity): GroundJointEntity['transition'] {
  return joint.transition ?? { mode: 'auto', directionFlipped: false }
}

function allocateGroundJointTrims(
  dataSet: readonly ValidGroundJointData[],
  grounds: readonly GroundEntity[],
  originalPaths: ReadonlyMap<EntityId, GroundPath>,
): Map<string, number> {
  const trims = new Map<string, number>()
  for (const data of dataSet) {
    trims.set(endpointKey(data.joint.a.groundId, data.joint.a.endpoint), data.desiredA)
    trims.set(endpointKey(data.joint.b.groundId, data.joint.b.endpoint), data.desiredB)
  }
  for (const ground of grounds) {
    const path = originalPaths.get(ground.id)
    if (!path) continue
    const startKey = endpointKey(ground.id, 'start')
    const endKey = endpointKey(ground.id, 'end')
    const start = trims.get(startKey) ?? 0
    const end = trims.get(endKey) ?? 0
    const total = start + end
    const maximum = path.length * 0.9
    if (total > maximum && total > EPSILON) {
      const factor = maximum / total
      trims.set(startKey, start * factor)
      trims.set(endKey, end * factor)
    }
  }

  return trims
}

function prepareGroundJointTransition(
  data: ValidGroundJointData,
  trims: ReadonlyMap<string, number>,
  originalPaths: ReadonlyMap<EntityId, GroundPath>,
): PreparedGroundJointTransition {
  const resolvedA = data.resolved.a
  const resolvedB = data.resolved.b
  const pathA = resolvedA ? originalPaths.get(resolvedA.ground.id) : null
  const pathB = resolvedB ? originalPaths.get(resolvedB.ground.id) : null
  const requestedTrimA = trims.get(endpointKey(data.joint.a.groundId, data.joint.a.endpoint)) ?? 0
  const requestedTrimB = trims.get(endpointKey(data.joint.b.groundId, data.joint.b.endpoint)) ?? 0
  if (!resolvedA || !resolvedB || !pathA || !pathB) {
    return {
      data,
      path: null,
      kind: 'invalid',
      trimA: requestedTrimA,
      trimB: requestedTrimB,
    }
  }

  const cachedTransition = transitionPathCache.get(data.joint)
  if (
    cachedTransition?.pathA === pathA &&
    cachedTransition.pathB === pathB &&
    cachedTransition.requestedTrimA === requestedTrimA &&
    cachedTransition.requestedTrimB === requestedTrimB &&
    cachedTransition.angleRad === data.angleRad &&
    cachedTransition.directionSign === data.directionSign
  ) {
    return {
      data,
      path: cachedTransition.path,
      kind: cachedTransition.kind,
      trimA: cachedTransition.resolvedTrimA,
      trimB: cachedTransition.resolvedTrimB,
    }
  }

  let kind: GroundJointPathKind = 'invalid'
  let path: GroundPath | null = null
  let trimA = requestedTrimA
  let trimB = requestedTrimB
  if (data.direct) {
    trimA = 0
    trimB = 0
    kind = 'direct'
  } else if (data.angleRad >= GROUND_JOINT_LINEAR_ANGLE_RAD) {
    trimA = 0
    trimB = 0
    const start = pathA.pointAt(endpointPathS(pathA, data.joint.a.endpoint, trimA))
    const end = pathB.pointAt(endpointPathS(pathB, data.joint.b.endpoint, trimB))
    path = createGroundPath({ type: 'line', start, end })
    if (path) kind = 'linear'
  } else {
    for (const trimScale of [1, 0.75, 0.5, 0.25, 0.125, 0]) {
      const candidateTrimA = requestedTrimA * trimScale
      const candidateTrimB = requestedTrimB * trimScale
      const start = pathA.pointAt(endpointPathS(pathA, data.joint.a.endpoint, candidateTrimA))
      const end = pathB.pointAt(endpointPathS(pathB, data.joint.b.endpoint, candidateTrimB))
      const startTangent = outwardTangent(pathA, data.joint.a.endpoint, candidateTrimA)
      const endTangent = inwardTangent(pathB, data.joint.b.endpoint, candidateTrimB)
      const startCurvature = orientedCurvature(
        pathA,
        data.joint.a.endpoint,
        candidateTrimA,
        'outward',
      )
      const endCurvature = orientedCurvature(pathB, data.joint.b.endpoint, candidateTrimB, 'inward')
      const candidate = buildOrdinaryTransition(
        start,
        startTangent,
        startCurvature,
        end,
        endTangent,
        endCurvature,
        candidateTrimA,
        candidateTrimB,
      )
      if (!candidate) continue
      path = candidate
      kind = 'quintic'
      trimA = candidateTrimA
      trimB = candidateTrimB
      break
    }
  }
  transitionPathCache.set(data.joint, {
    pathA,
    pathB,
    requestedTrimA,
    requestedTrimB,
    resolvedTrimA: trimA,
    resolvedTrimB: trimB,
    angleRad: data.angleRad,
    directionSign: data.directionSign,
    path,
    kind,
  })
  return { data, path, kind, trimA, trimB }
}

export function buildGroundPathNetwork(entities: readonly SceneEntity[]): GroundPathNetwork {
  const grounds = entities.filter((entity): entity is GroundEntity => entity.kind === 'ground')
  const joints = entities.filter(
    (entity): entity is GroundJointEntity => entity.kind === 'groundJoint',
  )
  const originalPaths = new Map<EntityId, GroundPath>()
  for (const ground of grounds) {
    const path = createGroundPath(ground.geometry)
    if (path) originalPaths.set(ground.id, path)
  }

  const validJointData: ValidGroundJointData[] = []
  const jointPaths = new Map<EntityId, ResolvedGroundJointPath>()
  for (const joint of joints) {
    const resolved = resolveGroundJoint(entities, joint)
    const alignment = clamp(resolved.tangentAlignment, -1, 1)
    const angleRad = Number.isFinite(alignment) ? Math.acos(alignment) : 0
    const crossValue =
      resolved.a && resolved.b
        ? cross(scale(resolved.a.inwardTangent, -1), resolved.b.inwardTangent)
        : 0
    const automaticSign: 1 | -1 = crossValue < -1e-9 ? -1 : 1
    const directionSign = automaticSign
    const direct =
      resolved.gapM <= GROUND_JOINT_DIRECT_MAX_GAP_M &&
      (angleRad >= GROUND_JOINT_LINEAR_ANGLE_RAD - 1e-10 ||
        (angleRad <= GROUND_JOINT_MIN_SMOOTH_ANGLE_RAD + 1e-10 &&
          Boolean(
            resolved.a &&
            resolved.b &&
            (resolved.a.ground.geometry.type !== 'line' ||
              resolved.b.ground.geometry.type !== 'line'),
          )))
    const geometryIssue: GroundJointPathIssue =
      resolved.issue ??
      (!direct && angleRad <= GROUND_JOINT_MIN_SMOOTH_ANGLE_RAD + 1e-10 ? 'angle-too-small' : null)
    const initial: ResolvedGroundJointPath = {
      joint,
      issue: geometryIssue,
      path: null,
      segmentId: null,
      kind: 'invalid',
      angleRad,
      trimA: 0,
      trimB: 0,
      directionSign,
      pieces: [],
    }
    jointPaths.set(joint.id, initial)
    if (geometryIssue || !resolved.a || !resolved.b) continue
    const pathA = originalPaths.get(resolved.a.ground.id)
    const pathB = originalPaths.get(resolved.b.ground.id)
    if (!pathA || !pathB) continue
    const setting = transitionSetting(joint)
    const desired =
      direct || angleRad >= GROUND_JOINT_LINEAR_ANGLE_RAD - 1e-10
        ? 0
        : setting.mode === 'manual'
          ? finiteNonNegative(setting.lengthM)
          : 0.4 * Math.min(pathA.length, pathB.length) * Math.sin(angleRad / 2)
    validJointData.push({
      joint,
      resolved,
      angleRad,
      desiredA: desired,
      desiredB: desired,
      direct,
      directionSign,
    })
  }

  let activeJointData = validJointData
  let trimByEndpoint = new Map<string, number>()
  let preparedTransitions: PreparedGroundJointTransition[] = []
  for (let iteration = 0; iteration <= validJointData.length; iteration += 1) {
    trimByEndpoint = allocateGroundJointTrims(activeJointData, grounds, originalPaths)
    preparedTransitions = activeJointData.map((data) =>
      prepareGroundJointTransition(data, trimByEndpoint, originalPaths),
    )
    const failed = preparedTransitions.filter((prepared) => prepared.kind === 'invalid')
    if (failed.length === 0) break
    const failedIds = new Set(failed.map((prepared) => prepared.data.joint.id))
    for (const prepared of failed) {
      jointPaths.set(prepared.data.joint.id, {
        joint: prepared.data.joint,
        issue: 'transition-invalid',
        path: null,
        segmentId: null,
        kind: 'invalid',
        angleRad: prepared.data.angleRad,
        trimA: 0,
        trimB: 0,
        directionSign: prepared.data.directionSign,
        pieces: [],
      })
    }
    activeJointData = activeJointData.filter((data) => !failedIds.has(data.joint.id))
  }

  trimByEndpoint = new Map<string, number>()
  for (const prepared of preparedTransitions) {
    if (!prepared.path) continue
    trimByEndpoint.set(
      endpointKey(prepared.data.joint.a.groundId, prepared.data.joint.a.endpoint),
      prepared.trimA,
    )
    trimByEndpoint.set(
      endpointKey(prepared.data.joint.b.groundId, prepared.data.joint.b.endpoint),
      prepared.trimB,
    )
  }

  const segments: MutableNetworkSegment[] = []
  const segmentById = new Map<string, MutableNetworkSegment>()
  const groundPaths = new Map<EntityId, EffectiveGroundPath>()
  for (const ground of grounds) {
    const originalPath = originalPaths.get(ground.id)
    if (!originalPath) continue
    const trimStartM = trimByEndpoint.get(endpointKey(ground.id, 'start')) ?? 0
    const trimEndM = trimByEndpoint.get(endpointKey(ground.id, 'end')) ?? 0
    const path = originalPath.trim(trimStartM, trimEndM)
    if (!path) continue
    const segmentId = groundPathSegmentId(ground.id)
    const collisionPiece: GroundCollisionPathPiece = {
      id: `${segmentId}:0`,
      path,
      startS: 0,
      endS: path.length,
      sourceGroundId: ground.id,
      material: ground.material,
    }
    const segment: MutableNetworkSegment = {
      id: segmentId,
      kind: 'ground',
      path,
      sourceGroundId: ground.id,
      jointId: null,
      adjacentGroundIds: [ground.id],
      collisionPieces: [collisionPiece],
      neighbors: {},
      materialAt: () => ground.material,
    }
    segments.push(segment)
    segmentById.set(segmentId, segment)
    groundPaths.set(ground.id, {
      ground,
      path,
      originalPath,
      trimStartM,
      trimEndM,
      segmentId,
    })
  }

  for (const prepared of preparedTransitions) {
    const { data, path, kind, trimA, trimB } = prepared
    const resolved = data.resolved
    if (!resolved.a || !resolved.b) continue
    const segmentA = segmentById.get(groundPathSegmentId(resolved.a.ground.id))
    const segmentB = segmentById.get(groundPathSegmentId(resolved.b.ground.id))
    if (!segmentA || !segmentB) continue

    if (kind === 'direct') {
      connectSegments(
        segmentA,
        data.joint.a.endpoint,
        segmentB,
        data.joint.b.endpoint,
        data.joint.id,
      )
      jointPaths.set(data.joint.id, {
        joint: data.joint,
        issue: null,
        path: null,
        segmentId: null,
        kind,
        angleRad: data.angleRad,
        trimA,
        trimB,
        directionSign: data.directionSign,
        pieces: [],
      })
      continue
    }

    if (!path) continue

    const segmentId = groundJointPathSegmentId(data.joint.id)
    const splitS = path.length / 2
    const firstPath = path.trim(0, path.length - splitS) ?? path
    const secondPath = path.trim(splitS, 0) ?? path
    const pieces: GroundCollisionPathPiece[] = [
      {
        id: `${segmentId}:0`,
        path: firstPath,
        startS: 0,
        endS: splitS,
        sourceGroundId: resolved.a.ground.id,
        material: resolved.a.ground.material,
      },
      {
        id: `${segmentId}:1`,
        path: secondPath,
        startS: splitS,
        endS: path.length,
        sourceGroundId: resolved.b.ground.id,
        material: resolved.b.ground.material,
      },
    ]
    const segment: MutableNetworkSegment = {
      id: segmentId,
      kind: 'transition',
      path,
      sourceGroundId: null,
      jointId: data.joint.id,
      adjacentGroundIds: [resolved.a.ground.id, resolved.b.ground.id],
      collisionPieces: pieces,
      neighbors: {},
      materialAt: (s) =>
        clamp(s, 0, path.length) < splitS ? pieces[0]!.material : pieces[1]!.material,
    }
    segments.push(segment)
    segmentById.set(segmentId, segment)
    connectSegments(segmentA, data.joint.a.endpoint, segment, 'start', data.joint.id)
    connectSegments(segment, 'end', segmentB, data.joint.b.endpoint, data.joint.id)
    jointPaths.set(data.joint.id, {
      joint: data.joint,
      issue: null,
      path,
      segmentId,
      kind,
      angleRad: data.angleRad,
      trimA,
      trimB,
      directionSign: data.directionSign,
      pieces,
    })
  }

  for (const effective of groundPaths.values()) {
    const segment = segmentById.get(effective.segmentId)
    if (!segment || !effective.path.closed) continue
    if (segment.neighbors.start || segment.neighbors.end) continue
    connectSegments(segment, 'end', segment, 'start', null)
  }

  return { segments, segmentById, groundPaths, jointPaths }
}

export function traverseGroundPath(
  network: GroundPathNetwork,
  location: GroundPathLocation,
  distanceM: number,
  maxTransitions = 64,
): GroundPathTraversal {
  let segment = network.segmentById.get(location.segmentId)
  if (!segment) {
    return {
      location,
      distanceRemainingM: finiteNonNegative(distanceM),
      stoppedAtOpenEnd: true,
      transitions: 0,
    }
  }
  let s = clamp(location.s, 0, segment.path.length)
  let direction = location.direction
  let remaining = finiteNonNegative(distanceM)
  let transitions = 0
  while (remaining > EPSILON) {
    const available = direction === 1 ? segment.path.length - s : s
    if (remaining <= available + EPSILON) {
      s = clamp(s + direction * remaining, 0, segment.path.length)
      remaining = 0
      break
    }
    remaining -= available
    const endpoint: GroundEndpointKey = direction === 1 ? 'end' : 'start'
    const neighbor = segment.neighbors[endpoint]
    if (!neighbor || transitions >= maxTransitions) {
      s = endpoint === 'start' ? 0 : segment.path.length
      return {
        location: { segmentId: segment.id, s, direction },
        distanceRemainingM: remaining,
        stoppedAtOpenEnd: true,
        transitions,
      }
    }
    const next = network.segmentById.get(neighbor.segmentId)
    if (!next || next.path.length <= EPSILON) {
      return {
        location: { segmentId: segment.id, s, direction },
        distanceRemainingM: remaining,
        stoppedAtOpenEnd: true,
        transitions,
      }
    }
    segment = next
    direction = neighbor.endpoint === 'start' ? 1 : -1
    s = neighbor.endpoint === 'start' ? 0 : segment.path.length
    transitions += 1
  }
  return {
    location: { segmentId: segment.id, s, direction },
    distanceRemainingM: remaining,
    stoppedAtOpenEnd: false,
    transitions,
  }
}

export function groundEndpointHasJoint(
  entities: readonly SceneEntity[],
  groundId: EntityId,
  endpoint: GroundEndpointKey,
): boolean {
  return entities.some(
    (entity) =>
      entity.kind === 'groundJoint' &&
      (sameGroundEndpoint(entity.a, { groundId, endpoint }) ||
        sameGroundEndpoint(entity.b, { groundId, endpoint })),
  )
}
