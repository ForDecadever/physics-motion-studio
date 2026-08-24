import RAPIER from '@dimforge/rapier2d-compat'

import type {
  BodyEntity,
  ConnectorEndpoint,
  ConnectorEntity,
  EntityId,
  FieldDefinition,
  FieldEntity,
  ForceEntity,
  GroundEntity,
  GroundJointEntity,
  Material2D,
  ParticleSourceEntity,
  SceneDocument,
  Vec2,
} from '../../scene/model/types'
import {
  compileScalarExpression,
  type CompiledScalarExpression,
} from '../../scene/expressions/scalarExpression'
import {
  evaluateFieldDefinition,
  type CompiledFieldDefinitionExpressions,
} from '../../scene/model/fieldExpressions'
import { globalVariableValues } from '../../scene/model/propertyExpressions'
import {
  pointInBooleanGeometry,
  resolveBezierPathBody,
  resolveBooleanScene,
  type ResolvedBooleanBody,
  type ResolvedBooleanField,
} from '../../scene/model/booleanGeometry'
import { sampleAdaptiveClosedBezierPath, worldBezierPathNodes } from '../../scene/model/bodyPath'
import { resolveGroundJoint } from '../../scene/model/groundEndpoints'
import { MIN_COLLIDING_ROPE_MASS_KG } from '../../scene/model/connectorRules'
import type {
  RuntimeBodyState,
  RuntimeConnectorState,
  RuntimeContactSource,
  RuntimeParticleSourceState,
} from '../worker/messages'
import {
  buildGroundPathNetwork,
  type GroundCollisionPathPiece,
  type GroundNetworkSegment,
  type GroundPathNetwork,
} from '../../scene/model/groundPath'
import { regionContainsPoint } from './fieldRegions'
import {
  advancePointInMagneticField,
  addForce,
  coulombForceOnFirst,
  electricForce,
  rotateVelocityInMagneticField,
  scaleForce,
  springForceOnFirst,
} from './forces'
import { flattenGroundPoints } from './groundSampling'
import { particleEmissionSamples, type ParticleEmissionSample } from './particleEmission'
import {
  applyCoulombPathFriction,
  combinedMaterialRestitution,
  combinedPathFriction,
  dotVectors,
  findGroundPathContactCandidate,
  requiredGroundSupportForceN,
  resolveGroundPathContactFrame,
  traverseGroundPathCenterDistance,
  type GroundPathContactCandidate,
  type GroundPathContactFrame,
  type PersistentGroundPathContact,
} from './groundPathMotion'
import { buildGroundCollisionChains } from './groundCollisionChains'
import { requiredRopeXpbdMicrosteps, solveRopeXpbd } from './rope/RopeXpbdSolver'

await RAPIER.init()

const MIN_FIXED_TIME_STEP = 1 / 1000
const MAX_FIXED_TIME_STEP = 1 / 30
const PARTICLE_COULOMB_MIN_DISTANCE_M = 1e-6
const PARTICLE_MAGNETIC_BOUNDARY_SUBSTEPS = 16
const PARTICLE_EMISSION_TIME_TOLERANCE_SECONDS = 1e-9
const ROD_SOLVER_ITERATIONS = 8
const ROD_POSITION_TOLERANCE_M = 1e-6
const ROD_VELOCITY_TOLERANCE_MPS = 1e-6
const FLEXIBLE_POSITION_ITERATIONS = 16
const FLEXIBLE_SPRING_MINIMUM_POSITION_ITERATIONS = 4
const FLEXIBLE_SPRING_ITERATION_LINK_BUDGET = 96
const FLEXIBLE_ROPE_POSITION_ITERATIONS = 8
const FLEXIBLE_ROPE_VELOCITY_ITERATIONS = 2
const FLEXIBLE_ROPE_TOTAL_LENGTH_PROJECTION_ITERATIONS = 8
const FLEXIBLE_ROPE_LINK_OVER_RELAXATION = 1.5
const FLEXIBLE_POSITION_TOLERANCE_M = 1e-5
const FLEXIBLE_VELOCITY_TOLERANCE_MPS = 1e-5
const FLEXIBLE_ROPE_RELATIVE_LENGTH_TOLERANCE = 1e-4
const FLEXIBLE_ROPE_ABSOLUTE_LENGTH_TOLERANCE_M = 1e-4
const FLEXIBLE_ROPE_LONG_RANGE_ACTIVATION_RATIO = 0.9
const ARC_CONTACT_DISTANCE_TOLERANCE = 0.003
const ARC_RADIAL_SEPARATION_SPEED_TOLERANCE = 0.001
const PATH_ENTRY_SEPARATION_SPEED_TOLERANCE = 0.005
const PATH_RELEASE_CLEARANCE_M = ARC_CONTACT_DISTANCE_TOLERANCE * 2
const PATH_SUPPORT_FORCE_TOLERANCE_N = 1e-6
const BLOCK_GROUND_HALF_THICKNESS_M = 0.0005
const BLOCK_GROUND_CAP_CLEARANCE_M = 0.002
const MAX_SPRING_PHASE_STEP = 0.1
const MAX_SPRING_INTERNAL_SUBSTEPS = 32
const MAX_PATH_TANGENT_STEP_RAD = 0.025
const MAX_PATH_CENTER_TRAVEL_RADIUS_RATIO = 0.25
const MIN_SPRING_IMPULSE_NS = 1e-12
const ADAPTIVE_CCD_RADIUS_RATIO = 0.5
// Rapier 2D 的动态凹网格启用 CCD 后会冻结；仅当单步位移足以跨过常见薄障碍时，
// 且沿速度方向确实即将碰撞时，临时切换到等价的凸片代理执行 CCD。
const BOOLEAN_CCD_PROXY_STEP_DISTANCE_M = 0.05
const BOOLEAN_CCD_APPROACH_SPEED_MPS = 1e-6
const BOOLEAN_BOUNDARY_CONTACT_TOLERANCE_M = 0.003
const BOOLEAN_BOUNDARY_RELEASE_CLEARANCE_M = 0.006
const FULLY_ELASTIC_RESTITUTION_TOLERANCE = 1e-9
const GROUND_IMPACT_SWEEP_SUBDIVISIONS_PER_RADIUS = 4
const MAX_GROUND_IMPACT_SWEEP_SUBDIVISIONS = 512
const CIRCLE_BODY_GROUP = 0x0001
const CIRCLE_GROUND_GROUP = 0x0002
const BOX_GROUND_GROUP = 0x0004
const CONNECTOR_GROUP = 0x0008
const BOOLEAN_BOUNDARY_GROUP = 0x0010
const BOX_BODY_GROUP = 0x0020
const BOOLEAN_BODY_GROUP = 0x0040
const BOOLEAN_GROUND_GROUP = 0x0080
const DYNAMIC_BODY_GROUPS = CIRCLE_BODY_GROUP | BOX_BODY_GROUP | BOOLEAN_BODY_GROUP
const MAX_CONNECTOR_SEGMENTS = 64
const MAX_SCENE_CONNECTOR_SEGMENTS = 256
const CONNECTOR_CONTACT_TOLERANCE_M = 0.002
const CONNECTOR_CONTACT_RELEASE_GAP_M = 0.004
const CONNECTOR_CONTACT_MERGE_DISTANCE_M = 0.002
const CONNECTOR_CONTACT_MERGE_NORMAL_DOT = 0.98
const CONNECTOR_CONTACT_SEPARATION_SPEED_MPS = 1e-4
const CONNECTOR_CCD_BISECTION_ITERATIONS = 4

function interactionGroups(membership: number, filter: number): number {
  return (membership << 16) | filter
}

const CIRCLE_BODY_COLLISION_GROUPS = interactionGroups(
  CIRCLE_BODY_GROUP,
  CIRCLE_BODY_GROUP |
    BOX_BODY_GROUP |
    BOOLEAN_BODY_GROUP |
    CIRCLE_GROUND_GROUP |
    CONNECTOR_GROUP |
    BOOLEAN_BOUNDARY_GROUP,
)
const BOX_BODY_COLLISION_GROUPS = interactionGroups(
  BOX_BODY_GROUP,
  DYNAMIC_BODY_GROUPS | BOX_GROUND_GROUP | CONNECTOR_GROUP,
)
const BOOLEAN_SOLID_COLLISION_GROUPS = interactionGroups(
  BOOLEAN_BODY_GROUP,
  BOX_BODY_GROUP | BOOLEAN_BODY_GROUP | BOOLEAN_GROUND_GROUP | CONNECTOR_GROUP,
)
const BOOLEAN_CCD_PROXY_COLLISION_GROUPS = interactionGroups(
  BOOLEAN_BODY_GROUP,
  DYNAMIC_BODY_GROUPS | BOOLEAN_GROUND_GROUP | CONNECTOR_GROUP,
)
const CIRCLE_GROUND_COLLISION_GROUPS = interactionGroups(
  CIRCLE_GROUND_GROUP,
  CIRCLE_BODY_GROUP | CONNECTOR_GROUP,
)
const BOX_GROUND_COLLISION_GROUPS = interactionGroups(
  BOX_GROUND_GROUP,
  BOX_BODY_GROUP | CONNECTOR_GROUP,
)
const CONNECTOR_COLLISION_GROUPS = interactionGroups(
  CONNECTOR_GROUP,
  DYNAMIC_BODY_GROUPS | CIRCLE_GROUND_GROUP | CONNECTOR_GROUP,
)
const BOOLEAN_BOUNDARY_COLLISION_GROUPS = interactionGroups(
  BOOLEAN_BOUNDARY_GROUP,
  CIRCLE_BODY_GROUP,
)
const BOOLEAN_GROUND_COLLISION_GROUPS = interactionGroups(BOOLEAN_GROUND_GROUP, BOOLEAN_BODY_GROUP)

interface DynamicBodyRecord {
  entity: BodyEntity
  rigidBody: RAPIER.RigidBody
  collider: RAPIER.Collider | null
  colliders: RAPIER.Collider[]
  circleBoundaryColliders: RAPIER.Collider[]
  ccdProxyColliders: RAPIER.Collider[]
  booleanResult: ResolvedBooleanBody | null
  booleanBoundaryPaths: BooleanBoundaryPath[]
  boundingRadius: number
  netForce: Vec2
  pathForce: Vec2
  constraintForce: Vec2
  magneticFieldTesla: number
  ccdEnabled: boolean
}

interface RuntimeForceRecord {
  entity: ForceEntity
  magnitudeExpression: CompiledScalarExpression | null
  directionDegreesExpression: CompiledScalarExpression | null
}

interface BooleanBoundaryColliderDescription {
  desc: RAPIER.ColliderDesc
  material: Material2D
}

interface BooleanBoundaryPath {
  points: Vec2[]
  cumulativeLengths: number[]
  lengthM: number
  closed: boolean
  segmentMaterials: Material2D[]
  analyticCircleSegments: Array<{
    center: Vec2
    radiusM: number
    startM: number
    endM: number
    direction: 1 | -1
  }>
}

interface BooleanCirclePathContact {
  booleanId: EntityId
  pathIndex: number
  distanceM: number
  emptySide: 1 | -1
  speedMps: number
}

interface ReleasedBooleanCircleContact {
  circleId: EntityId
  booleanId: EntityId
}

interface GroundRecord {
  entity: GroundEntity
  colliders: GroundColliderRecord[]
}

interface GroundColliderRecord {
  ground: GroundRecord
  collider: RAPIER.Collider
  segment: GroundNetworkSegment
  piece: GroundCollisionPathPiece
  minX: number
  minY: number
  maxX: number
  maxY: number
  linearEndpoints: { start: Vec2; end: Vec2; normal: Vec2 } | null
}

interface BlockGroundColliderRecord {
  collider: RAPIER.Collider
  colliderHandle: number
  start: Vec2
  end: Vec2
  collisionStart: Vec2
  collisionEnd: Vec2
}

interface ConveyorGroundColliderRecord {
  collider: RAPIER.Collider
  tangent: Vec2
  speedMps: number
  material: Material2D
}

interface BlockGroundColliderChain {
  colliders: BlockGroundColliderRecord[]
  closed: boolean
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface GroundContactProposal {
  colliderRecord: GroundColliderRecord
  candidate: GroundPathContactCandidate
  contact: PersistentGroundPathContact
  frame: GroundPathContactFrame
  separatingSpeedMps: number
  preStepSeparatingSpeedMps: number
  mayProjectSolverSeparation: boolean
  supportForceN: number
}

interface SweptGroundImpact {
  timeSeconds: number
  normal: Vec2
}

interface ReleasedGroundContact {
  naturalSide: 1 | -1
}

interface PreviousBodyState {
  position: Vec2
  linearVelocity: Vec2
  angleRad: number
  angularVelocityRad: number
}

interface ConnectorBodyContactCandidate {
  key: string
  record: ConnectorCollisionSegmentRecord
  body: DynamicBodyRecord
  bodyId: EntityId
  timeRatio: number
  normal: Vec2
  centerlinePoint: Vec2
  separation: number
  previousBody: PreviousBodyState
  referenceNormal: Vec2
  source: 'physicalSweep' | 'constraintProjection' | 'persistent'
  isNew: boolean
  sweptImpact: boolean
  impactNormalSpeed: number
  accumulatedPositionLambda: number
  accumulatedNormalImpulse: number
  accumulatedFrictionImpulse: number
}

interface ConnectorBodyBroadphaseCandidate {
  bodyId: EntityId
  body: DynamicBodyRecord
  previousBody: PreviousBodyState
  minX: number
  maxX: number
  minY: number
  maxY: number
}

interface ConnectorBodyContactGeometry {
  normal: Vec2
  centerlinePoint: Vec2
  separation: number
}

interface ConnectorRecord {
  entity: ConnectorEntity
  first: ConnectorRuntimeEndpoint
  second: ConnectorRuntimeEndpoint
}

interface ConnectorRuntimeEndpoint {
  definition: ConnectorEndpoint
  body: DynamicBodyRecord | null
  rigidBody: RAPIER.RigidBody
  localAnchor: Vec2
  fixed: boolean
}

interface RodConnectorRecord extends ConnectorRecord {
  entity: ConnectorEntity & {
    connector: Extract<ConnectorEntity['connector'], { type: 'rod' }>
  }
}

interface SpringConnectorRecord extends ConnectorRecord {
  entity: ConnectorEntity & {
    connector: Extract<ConnectorEntity['connector'], { type: 'spring' }>
  }
  effectiveStiffness: number
  effectiveInverseMassUpperBound: number
  restLength: number
  damping: number
}

interface SpringBumperRecord {
  entity: ConnectorEntity & {
    connector: Extract<ConnectorEntity['connector'], { type: 'spring' }>
  }
  mode: 'single' | 'double'
  attached: ConnectorRuntimeEndpoint | null
  freeKey: 'a' | 'b' | null
  axis: Vec2
  center: Vec2
  authoredLengthM: number
  initialLengthM: number
  inwardTravelM: number
  simulationStarted: boolean
  effectiveStiffness: number
  damping: number
  effectiveInverseMassUpperBound: number
  substepStartCapCenters: Vec2[]
}

interface SpringBumperCap {
  center: Vec2
  outward: Vec2
  compressionScale: number
}

interface SpringBumperContactBase {
  cap: SpringBumperCap
  inwardTravelM: number
  compressionRateMps: number
  contactPoint: Vec2
}

interface SpringBumperBodyContact extends SpringBumperContactBase {
  kind: 'body'
  body: DynamicBodyRecord
  bodyId: EntityId
}

interface SpringBumperGroundContact extends SpringBumperContactBase {
  kind: 'ground'
  ground: GroundColliderRecord
}

type SpringBumperContact = SpringBumperBodyContact | SpringBumperGroundContact

interface ConnectorMassBodyRecord {
  entity: ConnectorEntity
  rigidBody: RAPIER.RigidBody
  collider: RAPIER.Collider | null
  massKg: number
}

interface FlexibleConnectorRecord extends ConnectorRecord {
  chain: ConnectorRuntimeEndpoint[]
  nodes: ConnectorRuntimeEndpoint[]
  linkLength: number
  kind: 'rope' | 'spring'
  linkStiffness: number
  linkDamping: number
  previousNodePositions: Vec2[]
  constraintProjectionSegments: Array<{ start: Vec2; end: Vec2 }>
  ropeScratch?: FlexibleRopeScratch
}

interface FlexibleRopeScratch {
  positions: Vec2[]
  velocities: Vec2[]
  directions: Vec2[]
  gradients: Vec2[]
  states: ConnectorEndpointState[]
  pointMassInverseMasses: Array<Vec2 | null>
}

interface MassiveRodRecord extends ConnectorRecord {
  rigidBody: RAPIER.RigidBody
}

interface ConnectorCollisionSegmentRecord {
  entity: ConnectorEntity
  first: ConnectorRuntimeEndpoint
  second: ConnectorRuntimeEndpoint
  responseFirst: ConnectorRuntimeEndpoint
  responseSecond: ConnectorRuntimeEndpoint
  startRatio: number
  endRatio: number
  previousStart: Vec2
  previousEnd: Vec2
  ropeShape: MasslessRopeShapeRecord | null
  segmentIndex: number
  responseMode: 'distributed' | 'segment'
}

interface MasslessRopeShapeRecord extends ConnectorRecord {
  points: Vec2[]
  maximumLinkLength: number
}

interface MasslessConnectorGroundCandidate {
  timeRatio: number
  centerPoint: Vec2
  contactPoint: Vec2
  pathNormal: Vec2
  signedDistance: number
  separation: number
  endpointRatio: number
  material: Material2D
  ground: GroundColliderRecord
}

interface ConnectorGroundPositionConstraint {
  record: ConnectorCollisionSegmentRecord
  ground: GroundColliderRecord
  localRatio: number
  reactionDirection: Vec2
  contactPoint: Vec2
  material: Material2D
  impactNormalSpeed: number
  accumulatedNormalImpulse: number
  accumulatedFrictionImpulse: number
}

interface SpringFrame {
  firstEndpoint: ConnectorEndpointState
  secondEndpoint: ConnectorEndpointState
  direction: Vec2
  length: number
  effectiveInverseMass: number
}

interface ConnectorEndpointState {
  position: Vec2
  velocity: Vec2
  offset: Vec2
}

interface RodFrame {
  firstEndpoint: ConnectorEndpointState
  secondEndpoint: ConnectorEndpointState
  direction: Vec2
  distance: number
  effectiveInverseMass: number
}

interface RodAngularMomentumTarget {
  records: DynamicBodyRecord[]
  angularMomentum: number
}

export interface SimulationWarning {
  message: string
  entityId?: EntityId
}

function validatedTimeStep(value: number): number {
  return Number.isFinite(value) && value >= MIN_FIXED_TIME_STEP && value <= MAX_FIXED_TIME_STEP
    ? value
    : 1 / 120
}

function applyMaterial(desc: RAPIER.ColliderDesc, material: Material2D): RAPIER.ColliderDesc {
  // Rapier 的 Multiply 规则作用于两个碰撞体。分别存入 sqrt(mu) 与 sqrt(e)，接触时得到几何平均值。
  return desc
    .setFriction(Math.sqrt(Math.max(0, material.friction)))
    .setRestitution(Math.sqrt(Math.min(1, Math.max(0, material.restitution))))
    .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
}

function booleanConvexColliderDescriptions(points: readonly Vec2[]): RAPIER.ColliderDesc[] {
  if (points.length < 3) return []
  if (points.length === 3) {
    return [RAPIER.ColliderDesc.triangle(points[0]!, points[1]!, points[2]!)]
  }
  const convex = RAPIER.ColliderDesc.convexPolyline(
    new Float32Array(points.flatMap((point) => [point.x, point.y])),
  )
  if (convex) {
    const rawShape = convex.shape.intoRaw()
    if (rawShape) {
      rawShape.free()
      return [convex]
    }
  }
  const first = points[0]!
  return points
    .slice(1, -1)
    .map((point, index) => RAPIER.ColliderDesc.triangle(first, point, points[index + 2]!))
}

function sameMaterial(first: Material2D, second: Material2D): boolean {
  return first.friction === second.friction && first.restitution === second.restitution
}

function booleanBoundaryColliderDescriptions(
  result: ResolvedBooleanBody,
): BooleanBoundaryColliderDescription[] {
  const cosine = Math.cos(-result.angleRad)
  const sine = Math.sin(-result.angleRad)
  const toLocal = ([x, y]: readonly [number, number]): Vec2 => {
    const offsetX = x - result.centerOfMass.x
    const offsetY = y - result.centerOfMass.y
    return {
      x: Math.fround(offsetX * cosine - offsetY * sine),
      y: Math.fround(offsetX * sine + offsetY * cosine),
    }
  }
  const materialForSegment = (
    start: readonly [number, number],
    end: readonly [number, number],
  ): Material2D => {
    const tangent = { x: end[0] - start[0], y: end[1] - start[1] }
    const length = Math.hypot(tangent.x, tangent.y)
    const midpoint = { x: (start[0] + end[0]) / 2, y: (start[1] + end[1]) / 2 }
    const probeDistance = Math.max(1e-6, length * 1e-4)
    const normal =
      length > Number.EPSILON ? { x: -tangent.y / length, y: tangent.x / length } : { x: 0, y: 1 }
    const probes = [normal, { x: -normal.x, y: -normal.y }]
      .map((direction) => ({
        x: midpoint.x + direction.x * probeDistance,
        y: midpoint.y + direction.y * probeDistance,
      }))
      .filter((probe) => pointInBooleanGeometry(probe, result.geometry))
    for (const probe of probes) {
      const region = result.materialRegions.find((candidate) =>
        pointInBooleanGeometry(probe, candidate.geometry),
      )
      if (region) return region.material
    }
    return result.materialRegions[0]?.material ?? { friction: 0, restitution: 0 }
  }

  const descriptions: BooleanBoundaryColliderDescription[] = []
  for (const polygon of result.geometry) {
    for (const ring of polygon) {
      if (ring.length < 3) continue
      const segmentCount = ring.length - 1
      const materials = Array.from({ length: segmentCount }, (_, index) =>
        materialForSegment(ring[index]!, ring[index + 1]!),
      )
      const transition = materials.findIndex(
        (material, index) =>
          !sameMaterial(material, materials[(index + segmentCount - 1) % segmentCount]!),
      )
      if (transition < 0) {
        descriptions.push({
          desc: RAPIER.ColliderDesc.polyline(
            new Float32Array(
              ring.flatMap((point) => {
                const local = toLocal(point)
                return [local.x, local.y]
              }),
            ),
          ),
          material: materials[0]!,
        })
        continue
      }

      let runMaterial = materials[transition]!
      const runPoints: Vec2[] = [toLocal(ring[transition]!)]
      for (let offset = 0; offset < segmentCount; offset += 1) {
        const segmentIndex = (transition + offset) % segmentCount
        const material = materials[segmentIndex]!
        if (!sameMaterial(material, runMaterial) && runPoints.length >= 2) {
          descriptions.push({
            desc: RAPIER.ColliderDesc.polyline(
              new Float32Array(runPoints.flatMap((point) => [point.x, point.y])),
            ),
            material: runMaterial,
          })
          runMaterial = material
          runPoints.length = 0
          runPoints.push(toLocal(ring[segmentIndex]!))
        }
        runPoints.push(toLocal(ring[segmentIndex + 1 === segmentCount ? 0 : segmentIndex + 1]!))
      }
      if (runPoints.length >= 2) {
        descriptions.push({
          desc: RAPIER.ColliderDesc.polyline(
            new Float32Array(runPoints.flatMap((point) => [point.x, point.y])),
          ),
          material: runMaterial,
        })
      }
    }
  }
  return descriptions
}

function materialForBooleanBoundarySegment(
  result: ResolvedBooleanBody,
  start: Vec2,
  end: Vec2,
): Material2D {
  const tangent = { x: end.x - start.x, y: end.y - start.y }
  const length = Math.hypot(tangent.x, tangent.y)
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const normal =
    length > Number.EPSILON ? { x: -tangent.y / length, y: tangent.x / length } : { x: 0, y: 1 }
  const probeDistance = Math.max(1e-6, length * 1e-4)
  for (const direction of [normal, scaleVector(normal, -1)]) {
    const probe = {
      x: midpoint.x + direction.x * probeDistance,
      y: midpoint.y + direction.y * probeDistance,
    }
    if (!pointInBooleanGeometry(probe, result.geometry)) continue
    const region = result.materialRegions.find((candidate) =>
      pointInBooleanGeometry(probe, candidate.geometry),
    )
    if (region) return region.material
  }
  return result.materialRegions[0]?.material ?? { friction: 0, restitution: 0 }
}

function booleanBoundaryPaths(result: ResolvedBooleanBody): BooleanBoundaryPath[] {
  const cosine = Math.cos(-result.angleRad)
  const sine = Math.sin(-result.angleRad)
  const toLocal = ([x, y]: readonly [number, number]): Vec2 => {
    const offsetX = x - result.centerOfMass.x
    const offsetY = y - result.centerOfMass.y
    return {
      x: offsetX * cosine - offsetY * sine,
      y: offsetX * sine + offsetY * cosine,
    }
  }
  const paths: BooleanBoundaryPath[] = []
  for (const polygon of result.geometry) {
    for (const ring of polygon) {
      if (ring.length < 3) continue
      const points = ring.map(toLocal)
      const cumulativeLengths = [0]
      for (let index = 1; index < points.length; index += 1) {
        cumulativeLengths.push(
          cumulativeLengths.at(-1)! +
            Math.hypot(
              points[index]!.x - points[index - 1]!.x,
              points[index]!.y - points[index - 1]!.y,
            ),
        )
      }
      const lengthM = cumulativeLengths.at(-1)!
      if (lengthM <= Number.EPSILON) continue
      const segmentMaterials = ring
        .slice(0, -1)
        .map((point, index) =>
          materialForBooleanBoundarySegment(
            result,
            { x: point[0], y: point[1] },
            { x: ring[index + 1]![0], y: ring[index + 1]![1] },
          ),
        )
      paths.push({
        points,
        cumulativeLengths,
        lengthM,
        closed:
          Math.hypot(points[0]!.x - points.at(-1)!.x, points[0]!.y - points.at(-1)!.y) <= 1e-7,
        segmentMaterials,
        analyticCircleSegments: [],
      })
    }
  }
  return paths
}

interface BooleanBoundaryPathFrame {
  position: Vec2
  tangent: Vec2
  normal: Vec2
  curvaturePerM: number
  distanceM: number
  centerDistanceScale: number
  material: Material2D
}

function normalizedBoundaryDistance(path: BooleanBoundaryPath, distanceM: number): number {
  if (!path.closed) return Math.max(0, Math.min(path.lengthM, distanceM))
  return ((distanceM % path.lengthM) + path.lengthM) % path.lengthM
}

function boundaryPathFrameAt(
  path: BooleanBoundaryPath,
  distanceM: number,
): BooleanBoundaryPathFrame {
  const distance = normalizedBoundaryDistance(path, distanceM)
  const polylineFrame = boundaryPathPolylineFrameAt(path, distance)
  const material = polylineFrame.material
  const analyticCircle = path.analyticCircleSegments.find(
    (segment) => distance >= segment.startM - 1e-9 && distance <= segment.endM + 1e-9,
  )
  if (analyticCircle) {
    const startIndex = Math.max(
      0,
      path.cumulativeLengths.findIndex((value) => Math.abs(value - analyticCircle.startM) <= 1e-8),
    )
    const start = path.points[startIndex]!
    const startAngle = Math.atan2(
      start.y - analyticCircle.center.y,
      start.x - analyticCircle.center.x,
    )
    const direction = analyticCircle.direction
    const angle =
      startAngle + (direction * (distance - analyticCircle.startM)) / analyticCircle.radiusM
    return {
      position: {
        x: analyticCircle.center.x + analyticCircle.radiusM * Math.cos(angle),
        y: analyticCircle.center.y + analyticCircle.radiusM * Math.sin(angle),
      },
      tangent: { x: -Math.sin(angle) * direction, y: Math.cos(angle) * direction },
      normal: { x: -Math.cos(angle) * direction, y: -Math.sin(angle) * direction },
      curvaturePerM: direction / analyticCircle.radiusM,
      distanceM: distance,
      centerDistanceScale: 1,
      material,
    }
  }
  return polylineFrame
}

function boundaryPathPolylineFrameAt(
  path: BooleanBoundaryPath,
  distanceM: number,
): BooleanBoundaryPathFrame {
  const distance = normalizedBoundaryDistance(path, distanceM)
  let segment = 0
  while (
    segment < path.cumulativeLengths.length - 2 &&
    path.cumulativeLengths[segment + 1]! < distance
  ) {
    segment += 1
  }
  const material = path.segmentMaterials[segment] ?? path.segmentMaterials[0]!
  const start = path.points[segment]!
  const end = path.points[segment + 1]!
  const segmentLength = Math.max(
    Number.EPSILON,
    path.cumulativeLengths[segment + 1]! - path.cumulativeLengths[segment]!,
  )
  const ratio = (distance - path.cumulativeLengths[segment]!) / segmentLength
  const segmentTangent = {
    x: (end.x - start.x) / segmentLength,
    y: (end.y - start.y) / segmentLength,
  }
  return {
    position: { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio },
    tangent: segmentTangent,
    normal: { x: -segmentTangent.y, y: segmentTangent.x },
    curvaturePerM: 0,
    distanceM: distance,
    centerDistanceScale: 1,
    material,
  }
}

function closestBooleanBoundaryPathFrame(
  paths: readonly BooleanBoundaryPath[],
  point: Vec2,
): { pathIndex: number; frame: BooleanBoundaryPathFrame; distanceToPathM: number } | null {
  let best: { pathIndex: number; frame: BooleanBoundaryPathFrame; distanceToPathM: number } | null =
    null
  for (let pathIndex = 0; pathIndex < paths.length; pathIndex += 1) {
    const path = paths[pathIndex]!
    for (const analyticCircle of path.analyticCircleSegments) {
      const delta = {
        x: point.x - analyticCircle.center.x,
        y: point.y - analyticCircle.center.y,
      }
      const angle = Math.atan2(delta.y, delta.x)
      const startIndex = Math.max(
        0,
        path.cumulativeLengths.findIndex(
          (value) => Math.abs(value - analyticCircle.startM) <= 1e-8,
        ),
      )
      const start = path.points[startIndex]!
      const startAngle = Math.atan2(
        start.y - analyticCircle.center.y,
        start.x - analyticCircle.center.x,
      )
      const direction = analyticCircle.direction
      let directedAngle = direction * (angle - startAngle)
      directedAngle = ((directedAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
      const distanceM = analyticCircle.startM + directedAngle * analyticCircle.radiusM
      if (distanceM > analyticCircle.endM + 1e-8) continue
      const frame = boundaryPathFrameAt(path, distanceM)
      const distanceToPathM = Math.abs(Math.hypot(delta.x, delta.y) - analyticCircle.radiusM)
      if (!best || distanceToPathM < best.distanceToPathM) {
        best = { pathIndex, frame, distanceToPathM }
      }
    }
    for (let segment = 0; segment < path.points.length - 1; segment += 1) {
      const segmentMiddleM =
        (path.cumulativeLengths[segment]! + path.cumulativeLengths[segment + 1]!) / 2
      if (
        path.analyticCircleSegments.some(
          (circle) =>
            segmentMiddleM >= circle.startM - 1e-9 && segmentMiddleM <= circle.endM + 1e-9,
        )
      ) {
        continue
      }
      const start = path.points[segment]!
      const end = path.points[segment + 1]!
      const ratio = closestSegmentRatio(start, end, point)
      const position = {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
      }
      const distanceToPathM = Math.hypot(point.x - position.x, point.y - position.y)
      if (best && distanceToPathM >= best.distanceToPathM) continue
      const distanceM =
        path.cumulativeLengths[segment]! +
        ratio * (path.cumulativeLengths[segment + 1]! - path.cumulativeLengths[segment]!)
      best = {
        pathIndex,
        frame: boundaryPathFrameAt(path, distanceM),
        distanceToPathM,
      }
    }
  }
  return best
}

function detectBooleanBoundaryCircles(
  path: BooleanBoundaryPath,
  candidates: readonly BodyEntity[],
): Array<{
  center: Vec2
  radiusM: number
  startM: number
  endM: number
  direction: 1 | -1
}> {
  const circleCandidates: Array<{ center: Vec2; radiusM: number; maximumErrorM: number }> = []
  const appendCircleCandidate = (center: Vec2, radiusM: number, maximumErrorM: number): void => {
    if (
      circleCandidates.some(
        (candidate) =>
          Math.hypot(candidate.center.x - center.x, candidate.center.y - center.y) <=
            maximumErrorM && Math.abs(candidate.radiusM - radiusM) <= maximumErrorM,
      )
    ) {
      return
    }
    circleCandidates.push({ center, radiusM, maximumErrorM })
  }
  const cross = (first: Vec2, second: Vec2): number => first.x * second.y - first.y * second.x
  const cubicPoint = (start: Vec2, first: Vec2, second: Vec2, end: Vec2, ratio: number): Vec2 => {
    const inverse = 1 - ratio
    return {
      x:
        inverse ** 3 * start.x +
        3 * inverse ** 2 * ratio * first.x +
        3 * inverse * ratio ** 2 * second.x +
        ratio ** 3 * end.x,
      y:
        inverse ** 3 * start.y +
        3 * inverse ** 2 * ratio * first.y +
        3 * inverse * ratio ** 2 * second.y +
        ratio ** 3 * end.y,
    }
  }
  for (const candidate of candidates) {
    if (candidate.shape.type === 'circle') {
      appendCircleCandidate(
        { ...candidate.transform.position },
        candidate.shape.radius,
        Math.max(2e-5, candidate.shape.radius * 2e-4),
      )
      continue
    }
    if (candidate.shape.type !== 'bezierPath') continue
    const nodes = worldBezierPathNodes(candidate)
    for (let index = 0; index < nodes.length; index += 1) {
      const current = nodes[index]!
      const next = nodes[(index + 1) % nodes.length]!
      const startHandle = {
        x: current.outHandle.x - current.anchor.x,
        y: current.outHandle.y - current.anchor.y,
      }
      const endHandle = {
        x: next.anchor.x - next.inHandle.x,
        y: next.anchor.y - next.inHandle.y,
      }
      const startHandleLength = Math.hypot(startHandle.x, startHandle.y)
      const endHandleLength = Math.hypot(endHandle.x, endHandle.y)
      if (startHandleLength <= 1e-8 || endHandleLength <= 1e-8) continue
      const startTangent = scaleVector(startHandle, 1 / startHandleLength)
      const endTangent = scaleVector(endHandle, 1 / endHandleLength)
      const startNormal = { x: -startTangent.y, y: startTangent.x }
      const endNormal = { x: -endTangent.y, y: endTangent.x }
      const normalCross = cross(startNormal, endNormal)
      if (Math.abs(normalCross) <= 1e-6) continue
      const endpointDelta = {
        x: next.anchor.x - current.anchor.x,
        y: next.anchor.y - current.anchor.y,
      }
      const startNormalScale = cross(endpointDelta, endNormal) / normalCross
      const center = {
        x: current.anchor.x + startNormal.x * startNormalScale,
        y: current.anchor.y + startNormal.y * startNormalScale,
      }
      const startRadius = Math.hypot(current.anchor.x - center.x, current.anchor.y - center.y)
      const endRadius = Math.hypot(next.anchor.x - center.x, next.anchor.y - center.y)
      const radiusM = (startRadius + endRadius) / 2
      if (radiusM <= 1e-6 || Math.abs(startRadius - endRadius) > Math.max(2e-5, radiusM * 1e-4)) {
        continue
      }
      const startRadial = {
        x: current.anchor.x - center.x,
        y: current.anchor.y - center.y,
      }
      const direction: 1 | -1 = cross(startRadial, startTangent) >= 0 ? 1 : -1
      const expectedEndTangent = {
        x: (-direction * (next.anchor.y - center.y)) / radiusM,
        y: (direction * (next.anchor.x - center.x)) / radiusM,
      }
      if (dotVectors(expectedEndTangent, endTangent) < 0.9999) continue
      const maximumErrorM = Math.max(2e-5, radiusM * 4e-4)
      const radialErrorIsSmall = [0.25, 0.5, 0.75].every((ratio) => {
        const point = cubicPoint(
          current.anchor,
          current.outHandle,
          next.inHandle,
          next.anchor,
          ratio,
        )
        return (
          Math.abs(Math.hypot(point.x - center.x, point.y - center.y) - radiusM) <= maximumErrorM
        )
      })
      if (radialErrorIsSmall) appendCircleCandidate(center, radiusM, maximumErrorM)
    }
  }
  if (path.points.length < 9 || circleCandidates.length === 0) return []
  const circles: Array<{
    center: Vec2
    radiusM: number
    startM: number
    endM: number
    direction: 1 | -1
  }> = []
  for (const candidate of circleCandidates) {
    let runStart = -1
    for (let segment = 0; segment < path.points.length - 1; segment += 1) {
      const start = path.points[segment]!
      const end = path.points[segment + 1]!
      const segmentMatches = [start, end].every(
        (point) =>
          Math.abs(
            Math.hypot(point.x - candidate.center.x, point.y - candidate.center.y) -
              candidate.radiusM,
          ) <= candidate.maximumErrorM,
      )
      if (segmentMatches && runStart < 0) runStart = segment
      const runEnded = runStart >= 0 && (!segmentMatches || segment === path.points.length - 2)
      if (!runEnded) continue
      const runEnd = segmentMatches ? segment + 1 : segment
      if (runEnd - runStart >= 7) {
        const startPoint = path.points[runStart]!
        const nextPoint = path.points[runStart + 1]!
        const startAngle = Math.atan2(
          startPoint.y - candidate.center.y,
          startPoint.x - candidate.center.x,
        )
        const nextAngle = Math.atan2(
          nextPoint.y - candidate.center.y,
          nextPoint.x - candidate.center.x,
        )
        circles.push({
          center: { ...candidate.center },
          radiusM: candidate.radiusM,
          startM: path.cumulativeLengths[runStart]!,
          endM: path.cumulativeLengths[runEnd]!,
          direction: Math.sin(nextAngle - startAngle) >= 0 ? 1 : -1,
        })
      }
      runStart = -1
    }
  }
  return circles
}

function colliderForBody(entity: BodyEntity): RAPIER.ColliderDesc | null {
  const shape = entity.shape
  if (shape.type === 'circle') {
    return shape.collisionEnabled ? RAPIER.ColliderDesc.ball(shape.radius) : null
  }
  return shape.type === 'box' ? RAPIER.ColliderDesc.cuboid(shape.width / 2, shape.height / 2) : null
}

function scaleVector(vector: Vec2, factor: number): Vec2 {
  return { x: vector.x * factor, y: vector.y * factor }
}

function solveThreeByThree(matrix: number[][], right: number[]): [number, number, number] | null {
  const augmented = matrix.map((row, index) => [...row, right[index]!])
  for (let column = 0; column < 3; column += 1) {
    let pivot = column
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row
    }
    if (Math.abs(augmented[pivot]![column]!) <= 1e-15) return null
    ;[augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!]
    const divisor = augmented[column]![column]!
    for (let index = column; index < 4; index += 1) augmented[column]![index]! /= divisor
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue
      const factor = augmented[row]![column]!
      for (let index = column; index < 4; index += 1) {
        augmented[row]![index]! -= factor * augmented[column]![index]!
      }
    }
  }
  return [augmented[0]![3]!, augmented[1]![3]!, augmented[2]![3]!]
}

function implicitMagneticVelocity(
  velocity: Vec2,
  angularVelocityRad: number,
  massKg: number,
  inertiaKgM2: number,
  chargeFieldSum: number,
  chargeFieldXMoment: number,
  chargeFieldYMoment: number,
  timeStep: number,
): { velocity: Vec2; angularVelocityRad: number } {
  const halfStep = timeStep / 2
  const matrixA = [
    [0, chargeFieldSum, chargeFieldXMoment],
    [-chargeFieldSum, 0, chargeFieldYMoment],
    [-chargeFieldXMoment, -chargeFieldYMoment, 0],
  ]
  const massMatrix = [massKg, massKg, inertiaKgM2]
  const current = [velocity.x, velocity.y, angularVelocityRad]
  const right = massMatrix.map(
    (mass, row) =>
      mass * current[row]! +
      halfStep * matrixA[row]!.reduce((sum, value, column) => sum + value * current[column]!, 0),
  )
  const left = matrixA.map((row, rowIndex) =>
    row.map((value, columnIndex) =>
      rowIndex === columnIndex ? massMatrix[rowIndex]! - halfStep * value : -halfStep * value,
    ),
  )
  const solved = solveThreeByThree(left, right)
  return solved
    ? { velocity: { x: solved[0], y: solved[1] }, angularVelocityRad: solved[2] }
    : { velocity, angularVelocityRad }
}

function interpolateVector(first: Vec2, second: Vec2, ratio: number): Vec2 {
  return {
    x: first.x + (second.x - first.x) * ratio,
    y: first.y + (second.y - first.y) * ratio,
  }
}

function shortestAngleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from))
}

function closestSegmentRatio(start: Vec2, end: Vec2, point: Vec2): number {
  const deltaX = end.x - start.x
  const deltaY = end.y - start.y
  const lengthSquared = deltaX ** 2 + deltaY ** 2
  if (lengthSquared <= Number.EPSILON) return 0.5
  return Math.min(
    1,
    Math.max(0, ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared),
  )
}

function closestSegmentPairRatios(
  firstStart: Vec2,
  firstEnd: Vec2,
  secondStart: Vec2,
  secondEnd: Vec2,
): { first: number; second: number } {
  const firstDeltaX = firstEnd.x - firstStart.x
  const firstDeltaY = firstEnd.y - firstStart.y
  const secondDeltaX = secondEnd.x - secondStart.x
  const secondDeltaY = secondEnd.y - secondStart.y
  const offsetX = firstStart.x - secondStart.x
  const offsetY = firstStart.y - secondStart.y
  const firstLengthSquared = firstDeltaX ** 2 + firstDeltaY ** 2
  const secondLengthSquared = secondDeltaX ** 2 + secondDeltaY ** 2
  const offsetOnSecond = secondDeltaX * offsetX + secondDeltaY * offsetY
  if (firstLengthSquared <= Number.EPSILON && secondLengthSquared <= Number.EPSILON) {
    return { first: 0, second: 0 }
  }
  if (firstLengthSquared <= Number.EPSILON) {
    return { first: 0, second: Math.min(1, Math.max(0, offsetOnSecond / secondLengthSquared)) }
  }
  const offsetOnFirst = firstDeltaX * offsetX + firstDeltaY * offsetY
  if (secondLengthSquared <= Number.EPSILON) {
    return { first: Math.min(1, Math.max(0, -offsetOnFirst / firstLengthSquared)), second: 0 }
  }
  const deltaDot = firstDeltaX * secondDeltaX + firstDeltaY * secondDeltaY
  const denominator = firstLengthSquared * secondLengthSquared - deltaDot ** 2
  if (denominator <= Number.EPSILON) {
    const projectedStart = Math.min(1, Math.max(0, -offsetOnFirst / firstLengthSquared))
    const projectedEnd = Math.min(1, Math.max(0, (deltaDot - offsetOnFirst) / firstLengthSquared))
    let bestFirstRatio = 0
    let bestSecondRatio = 0
    let bestDistanceSquared = Infinity
    for (let candidateIndex = 0; candidateIndex < 5; candidateIndex += 1) {
      const firstRatio =
        candidateIndex === 0
          ? 0
          : candidateIndex === 1
            ? 0.5
            : candidateIndex === 2
              ? 1
              : candidateIndex === 3
                ? projectedStart
                : projectedEnd
      const secondRatio = Math.min(
        1,
        Math.max(0, (deltaDot * firstRatio + offsetOnSecond) / secondLengthSquared),
      )
      const separationX =
        firstStart.x + firstDeltaX * firstRatio - (secondStart.x + secondDeltaX * secondRatio)
      const separationY =
        firstStart.y + firstDeltaY * firstRatio - (secondStart.y + secondDeltaY * secondRatio)
      const distanceSquared = separationX ** 2 + separationY ** 2
      if (
        distanceSquared < bestDistanceSquared - Number.EPSILON ||
        (Math.abs(distanceSquared - bestDistanceSquared) <= Number.EPSILON &&
          Math.abs(firstRatio - 0.5) < Math.abs(bestFirstRatio - 0.5))
      ) {
        bestFirstRatio = firstRatio
        bestSecondRatio = secondRatio
        bestDistanceSquared = distanceSquared
      }
    }
    return { first: bestFirstRatio, second: bestSecondRatio }
  }
  let firstRatio = Math.min(
    1,
    Math.max(0, (deltaDot * offsetOnSecond - offsetOnFirst * secondLengthSquared) / denominator),
  )
  let secondRatio = (deltaDot * firstRatio + offsetOnSecond) / secondLengthSquared
  if (secondRatio < 0) {
    secondRatio = 0
    firstRatio = Math.min(1, Math.max(0, -offsetOnFirst / firstLengthSquared))
  } else if (secondRatio > 1) {
    secondRatio = 1
    firstRatio = Math.min(1, Math.max(0, (deltaDot - offsetOnFirst) / firstLengthSquared))
  }
  return { first: firstRatio, second: secondRatio }
}

function colliderPairKey(firstHandle: number, secondHandle: number): string {
  return firstHandle < secondHandle
    ? `${firstHandle}:${secondHandle}`
    : `${secondHandle}:${firstHandle}`
}

function collisionGroupsInteract(first: number, second: number): boolean {
  const firstMembership = (first >>> 16) & 0xffff
  const firstFilter = first & 0xffff
  const secondMembership = (second >>> 16) & 0xffff
  const secondFilter = second & 0xffff
  return (firstMembership & secondFilter) !== 0 && (secondMembership & firstFilter) !== 0
}

function travelTimeForDistance(
  distanceM: number,
  initialSpeedMps: number,
  accelerationMps2: number,
  maximumTimeS: number,
): number {
  if (distanceM <= 0 || maximumTimeS <= 0) return 0
  if (Math.abs(accelerationMps2) <= 1e-10) {
    return Math.min(maximumTimeS, distanceM / Math.max(initialSpeedMps, 1e-10))
  }
  const discriminant = initialSpeedMps ** 2 + 2 * accelerationMps2 * distanceM
  if (discriminant < 0) return maximumTimeS
  const denominator = initialSpeedMps + Math.sqrt(discriminant)
  if (denominator <= 1e-10) return maximumTimeS
  return Math.min(maximumTimeS, Math.max(0, (2 * distanceM) / denominator))
}

function collisionRadius(entity: BodyEntity): number | null {
  if (entity.shape.type === 'circle' && entity.shape.collisionEnabled) return entity.shape.radius
  return null
}

function materialsAreFrictionlessAndFullyElastic(first: Material2D, second: Material2D): boolean {
  return (
    combinedPathFriction(first, second) <= Number.EPSILON &&
    combinedMaterialRestitution(first, second) >= 1 - FULLY_ELASTIC_RESTITUTION_TOLERANCE
  )
}

function bodyBoundingRadius(entity: BodyEntity): number {
  if (entity.shape.type === 'circle') return entity.shape.radius
  if (entity.shape.type === 'box') return Math.hypot(entity.shape.width, entity.shape.height) / 2
  return Math.max(
    1e-6,
    ...sampleAdaptiveClosedBezierPath(entity.shape.nodes).map((point) =>
      Math.hypot(point.x, point.y),
    ),
  )
}

interface RuntimeParticleIon {
  id: number
  t: number
  bornAt: number
  continuous: boolean
  position: Vec2
  velocity: Vec2
}

interface RuntimeParticleSource {
  entity: ParticleSourceEntity
  samples: ParticleEmissionSample[]
  ions: RuntimeParticleIon[]
  nextIonId: number
  nextSampleIndex: number
  nextEmissionIndex: number
  nextEmissionTime: number
}

export interface SimulationRuntimeDiagnostics {
  warningCount: number
  connectorBodyContactManifoldCount: number
  persistentGroundContactCount: number
  persistentBooleanCircleContactCount: number
  releasedGroundContactPairCount: number
  releasedBooleanCircleContactCount: number
}

export class SimulationWorld {
  readonly fixedTimeStep: number
  readonly warnings: SimulationWarning[] = []

  private world: RAPIER.World
  private currentTimeStep: number
  private springSubstepCount = 1
  private pathSubstepLimitWarningShown = false
  private readonly booleanCcdProxyFailureIds = new Set<EntityId>()
  private readonly eventQueue = new RAPIER.EventQueue(true)
  private readonly suppressedContactPairs = new Set<string>()
  private readonly permanentlySuppressedContactPairs = new Set<string>()
  private readonly physicsHooks: RAPIER.PhysicsHooks = {
    filterContactPair: (collider1, collider2) =>
      this.shouldSuppressContactPair(collider1, collider2)
        ? RAPIER.SolverFlags.EMPTY
        : RAPIER.SolverFlags.COMPUTE_IMPULSE,
    filterIntersectionPair: () => true,
  }
  private readonly dynamicBodies = new Map<EntityId, DynamicBodyRecord>()
  private readonly dynamicColliders = new Map<number, DynamicBodyRecord>()
  private readonly fields: FieldEntity[] = []
  private readonly booleanFields: ResolvedBooleanField[] = []
  private readonly forces: RuntimeForceRecord[] = []
  private readonly scalarVariables: Readonly<Record<string, number>>
  private readonly fieldExpressionCompilers = new Map<
    FieldDefinition,
    CompiledFieldDefinitionExpressions
  >()
  private readonly fieldEvaluationCache = new Map<FieldDefinition, FieldDefinition | null>()
  private readonly expressionWarningKeys = new Set<string>()
  private readonly particleSources: RuntimeParticleSource[] = []
  private currentSubstepStartTime = 0
  private readonly rods: RodConnectorRecord[] = []
  private readonly springs: SpringConnectorRecord[] = []
  private readonly springBumpers: SpringBumperRecord[] = []
  private readonly connectorRuntimeRecords = new Map<EntityId, ConnectorRecord>()
  private readonly connectorMassBodies: ConnectorMassBodyRecord[] = []
  private readonly flexibleConnectors: FlexibleConnectorRecord[] = []
  private readonly flexibleConnectorsById = new Map<EntityId, FlexibleConnectorRecord>()
  private readonly massiveRods: MassiveRodRecord[] = []
  private readonly connectorCollisionSegments: ConnectorCollisionSegmentRecord[] = []
  private readonly connectorCollisionSegmentsByEntity = new Map<
    EntityId,
    ConnectorCollisionSegmentRecord[]
  >()
  private readonly connectorBodyContactManifolds = new Map<string, ConnectorBodyContactCandidate>()
  private readonly retainedConnectorBodyContactKeys = new Set<string>()
  private readonly connectorBodyBroadphaseCandidates: ConnectorBodyBroadphaseCandidate[] = []
  private readonly connectorBodyBroadphaseById = new Map<
    EntityId,
    ConnectorBodyBroadphaseCandidate
  >()
  private readonly activeFlexibleRopeBodyContacts = new Map<
    EntityId,
    ConnectorBodyContactCandidate[]
  >()
  private readonly ropeConstraintWarningIds = new Set<EntityId>()
  private readonly masslessRopeShapes = new Map<EntityId, MasslessRopeShapeRecord>()
  private connectorSegmentCount = 0
  private readonly groundsById = new Map<EntityId, GroundRecord>()
  private readonly groundsByCollider = new Map<number, GroundColliderRecord>()
  private readonly groundCollidersByPieceId = new Map<string, GroundColliderRecord>()
  private readonly blockGroundColliderChains: BlockGroundColliderChain[] = []
  private readonly conveyorGroundColliders: ConveyorGroundColliderRecord[] = []
  private groundPathNetwork!: GroundPathNetwork
  private hasFrictionlessFullyElasticGroundImpactPairs = false
  private readonly persistentGroundContacts = new Map<EntityId, PersistentGroundPathContact>()
  private readonly persistentBooleanCircleContacts = new Map<EntityId, BooleanCirclePathContact>()
  private readonly releasedBooleanCircleContacts = new Map<string, ReleasedBooleanCircleContact>()
  private readonly releasedContactPairs = new Map<string, ReleasedGroundContact>()
  private simulationTimeValue = 0
  private disposed = false

  constructor(private readonly scene: SceneDocument) {
    this.fixedTimeStep = validatedTimeStep(scene.settings.fixedTimeStep)
    this.currentTimeStep = this.fixedTimeStep
    this.scalarVariables = globalVariableValues(scene)
    this.world = new RAPIER.World({ x: 0, y: 0 })
    this.world.timestep = this.fixedTimeStep
    try {
      this.buildScene()
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  get simulationTime(): number {
    return this.simulationTimeValue
  }

  getRuntimeDiagnostics(): SimulationRuntimeDiagnostics {
    return {
      warningCount: this.warnings.length,
      connectorBodyContactManifoldCount: this.connectorBodyContactManifolds.size,
      persistentGroundContactCount: this.persistentGroundContacts.size,
      persistentBooleanCircleContactCount: this.persistentBooleanCircleContacts.size,
      releasedGroundContactPairCount: this.releasedContactPairs.size,
      releasedBooleanCircleContactCount: this.releasedBooleanCircleContacts.size,
    }
  }

  getConfiguredSpringSubstepCount(): number {
    return this.springSubstepCount
  }

  getFlexibleConnectorMechanicalEnergyJ(entityId: EntityId): number | null {
    const record = this.flexibleConnectors.find(
      (candidate) => candidate.entity.id === entityId && candidate.kind === 'spring',
    )
    if (!record) return null
    const kineticEnergyJ = this.connectorMassBodies
      .filter((massBody) => massBody.entity.id === entityId)
      .reduce((total, massBody) => {
        const velocity = massBody.rigidBody.linvel()
        const translational = (massBody.massKg * (velocity.x ** 2 + velocity.y ** 2)) / 2
        const rotational =
          (massBody.rigidBody.effectiveAngularInertia() * massBody.rigidBody.angvel() ** 2) / 2
        return total + translational + rotational
      }, 0)
    const chain = this.flexibleChain(record)
    const potentialEnergyJ = chain.slice(1).reduce((total, endpoint, index) => {
      const first = this.connectorEndpointState(chain[index]!).position
      const second = this.connectorEndpointState(endpoint).position
      const extension = Math.hypot(second.x - first.x, second.y - first.y) - record.linkLength
      return total + (record.linkStiffness * extension ** 2) / 2
    }, 0)
    return kineticEnergyJ + potentialEnergyJ
  }

  private shouldSuppressContactPair(collider1: number, collider2: number): boolean {
    return this.suppressedContactPairs.has(colliderPairKey(collider1, collider2))
  }

  private activeBodyColliders(record: DynamicBodyRecord): RAPIER.Collider[] {
    return record.ccdProxyColliders.length > 0 ? record.ccdProxyColliders : record.colliders
  }

  private inheritPermanentContactSuppressions(
    record: DynamicBodyRecord,
    proxy: RAPIER.Collider,
  ): void {
    const baseHandles = new Set(record.colliders.map((collider) => collider.handle))
    for (const pair of [...this.permanentlySuppressedContactPairs]) {
      const [firstText, secondText] = pair.split(':')
      const first = Number(firstText)
      const second = Number(secondText)
      if (baseHandles.has(first)) {
        this.permanentlySuppressedContactPairs.add(colliderPairKey(proxy.handle, second))
      } else if (baseHandles.has(second)) {
        this.permanentlySuppressedContactPairs.add(colliderPairKey(proxy.handle, first))
      }
    }
  }

  private removeColliderSuppressions(collider: RAPIER.Collider): void {
    const handleText = String(collider.handle)
    for (const pair of [...this.permanentlySuppressedContactPairs]) {
      const [first, second] = pair.split(':')
      if (first === handleText || second === handleText) {
        this.permanentlySuppressedContactPairs.delete(pair)
      }
    }
  }

  private booleanBodyNeedsCcdProxy(record: DynamicBodyRecord, stepDistance: number): boolean {
    if (
      !record.booleanResult ||
      !record.entity.continuousCollisionDetection ||
      stepDistance < BOOLEAN_CCD_PROXY_STEP_DISTANCE_M ||
      this.booleanCcdProxyFailureIds.has(record.entity.id)
    ) {
      return false
    }
    if (
      [...this.persistentBooleanCircleContacts.values()].some(
        (contact) => contact.booleanId === record.entity.id,
      )
    ) {
      return false
    }

    const bodyPosition = record.rigidBody.translation()
    const bodyRotation = record.rigidBody.rotation()
    const bodyVelocity = record.rigidBody.linvel()
    const activeColliders = this.activeBodyColliders(record)
    let impendingCollision = false
    this.world.forEachCollider((target) => {
      if (impendingCollision || !target.isEnabled() || target.isSensor()) return
      const targetBody = target.parent()
      if (targetBody?.handle === record.rigidBody.handle) return
      if (!collisionGroupsInteract(BOOLEAN_CCD_PROXY_COLLISION_GROUPS, target.collisionGroups())) {
        return
      }
      if (
        activeColliders.some((base) => this.shouldSuppressContactPair(base.handle, target.handle))
      ) {
        return
      }

      const targetVelocity = targetBody?.linvel() ?? { x: 0, y: 0 }
      const relativeVelocity = {
        x: bodyVelocity.x - targetVelocity.x,
        y: bodyVelocity.y - targetVelocity.y,
      }
      const targetRotation = target.rotation()
      const targetCosine = Math.cos(targetRotation)
      const targetSine = Math.sin(targetRotation)
      let hasExistingContact = false
      for (const base of [...activeColliders, ...record.circleBoundaryColliders]) {
        if (!base.isEnabled()) continue
        this.world.contactPair(base, target, () => {
          hasExistingContact = true
        })
        if (hasExistingContact) break
      }
      if (hasExistingContact) return
      for (const mesh of record.booleanResult!.collisionMeshes) {
        for (const polygon of mesh.convexPolygons) {
          for (const colliderDesc of booleanConvexColliderDescriptions(polygon)) {
            const hit = target.castShape(
              targetVelocity,
              colliderDesc.shape,
              bodyPosition,
              bodyRotation,
              bodyVelocity,
              0,
              this.currentTimeStep,
              false,
            )
            if (!hit) continue
            const worldNormal = {
              x: hit.normal1.x * targetCosine - hit.normal1.y * targetSine,
              y: hit.normal1.x * targetSine + hit.normal1.y * targetCosine,
            }
            if (
              relativeVelocity.x * worldNormal.x + relativeVelocity.y * worldNormal.y <
              -BOOLEAN_CCD_APPROACH_SPEED_MPS
            ) {
              impendingCollision = true
              return
            }
          }
        }
      }
    })
    return impendingCollision
  }

  private activateBooleanCcdProxies(record: DynamicBodyRecord): boolean {
    if (!record.booleanResult || record.ccdProxyColliders.length > 0) return true
    const created: RAPIER.Collider[] = []
    try {
      for (const mesh of record.booleanResult.collisionMeshes) {
        for (const polygon of mesh.convexPolygons) {
          for (const colliderDesc of booleanConvexColliderDescriptions(polygon)) {
            const proxyDesc = applyMaterial(colliderDesc, mesh.material)
              .setDensity(0)
              .setCollisionGroups(BOOLEAN_CCD_PROXY_COLLISION_GROUPS)
            proxyDesc.setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS)
            const proxy = this.world.createCollider(proxyDesc, record.rigidBody)
            created.push(proxy)
            this.dynamicColliders.set(proxy.handle, record)
            this.inheritPermanentContactSuppressions(record, proxy)
          }
        }
      }
      if (created.length === 0) throw new Error('布尔 CCD 代理为空。')
    } catch {
      for (const collider of created) {
        this.removeColliderSuppressions(collider)
        this.dynamicColliders.delete(collider.handle)
        this.world.removeCollider(collider, false)
      }
      this.booleanCcdProxyFailureIds.add(record.entity.id)
      this.warnings.push({
        entityId: record.entity.id,
        message: '布尔结果的高速连续碰撞代理创建失败；该结果已停用 CCD，普通碰撞仍可继续。',
      })
      return false
    }

    for (const collider of [...record.colliders, ...record.circleBoundaryColliders]) {
      collider.setEnabled(false)
    }
    record.ccdProxyColliders.push(...created)
    record.collider = created[0] ?? null
    return true
  }

  private deactivateBooleanCcdProxies(record: DynamicBodyRecord): void {
    for (const collider of record.ccdProxyColliders) {
      this.removeColliderSuppressions(collider)
      this.dynamicColliders.delete(collider.handle)
      this.world.removeCollider(collider, false)
    }
    record.ccdProxyColliders.length = 0
    for (const collider of [...record.colliders, ...record.circleBoundaryColliders]) {
      collider.setEnabled(true)
    }
    record.collider = record.colliders[0] ?? null
  }

  private refreshSuppressedContactPairs(): void {
    this.suppressedContactPairs.clear()
    for (const pair of this.permanentlySuppressedContactPairs) {
      this.suppressedContactPairs.add(pair)
    }
    for (const [entityId, contact] of this.persistentGroundContacts) {
      const record = this.dynamicBodies.get(entityId)
      if (!record?.collider) continue
      for (const groundCollider of this.colliderRecordsForContactSuppression(contact)) {
        for (const collider of this.activeBodyColliders(record)) {
          this.suppressedContactPairs.add(
            colliderPairKey(groundCollider.collider.handle, collider.handle),
          )
        }
      }
    }
    for (const record of this.dynamicBodies.values()) {
      if (record.booleanResult || record.entity.shape.type !== 'box' || !record.collider) continue
      const position = record.rigidBody.translation()
      const possibleContactDistance =
        record.boundingRadius + BLOCK_GROUND_HALF_THICKNESS_M + BLOCK_GROUND_CAP_CLEARANCE_M
      const possibleContactDistanceSquared = possibleContactDistance ** 2
      const velocity = record.rigidBody.linvel()
      const sweepX = possibleContactDistance + Math.abs(velocity.x) * this.currentTimeStep
      const sweepY = possibleContactDistance + Math.abs(velocity.y) * this.currentTimeStep
      for (const chainRecord of this.blockGroundColliderChains) {
        if (
          position.x + sweepX < chainRecord.minX ||
          position.x - sweepX > chainRecord.maxX ||
          position.y + sweepY < chainRecord.minY ||
          position.y - sweepY > chainRecord.maxY
        ) {
          continue
        }
        const chain = chainRecord.colliders
        let selectedIndex = -1
        let selectedDistanceSquared = Infinity
        for (let index = 0; index < chain.length; index += 1) {
          const ground = chain[index]!
          const distanceSquared = this.blockGroundDistanceSquared(
            position,
            ground.start,
            ground.end,
          )
          if (distanceSquared >= selectedDistanceSquared) continue
          selectedDistanceSquared = distanceSquared
          selectedIndex = index
        }
        for (let index = 0; index < chain.length; index += 1) {
          const directIndexDistance = Math.abs(index - selectedIndex)
          const indexDistance = chainRecord.closed
            ? Math.min(directIndexDistance, chain.length - directIndexDistance)
            : directIndexDistance
          if (indexDistance <= 1) continue
          const ground = chain[index]!
          const collisionDistanceSquared = this.blockGroundDistanceSquared(
            position,
            ground.collisionStart,
            ground.collisionEnd,
          )
          if (collisionDistanceSquared > possibleContactDistanceSquared) continue
          for (const collider of this.activeBodyColliders(record)) {
            this.suppressedContactPairs.add(colliderPairKey(collider.handle, ground.colliderHandle))
          }
        }
      }
    }
  }

  private requiredPathSubstepCount(): number {
    let requiredSubsteps = 1
    for (const [entityId, contact] of this.persistentGroundContacts) {
      const record = this.dynamicBodies.get(entityId)
      if (!record) continue
      const frame = resolveGroundPathContactFrame(this.groundPathNetwork, contact)
      if (!frame) continue
      const velocity = record.rigidBody.linvel()
      const speedMps = Math.max(contact.speedMps, Math.hypot(velocity.x, velocity.y))
      const acceleration = this.constraintAcceleration(record)
      const accelerationMagnitude = Math.hypot(acceleration.x, acceleration.y)
      const centerTravelM =
        speedMps * this.fixedTimeStep + 0.5 * accelerationMagnitude * this.fixedTimeStep ** 2
      if (centerTravelM <= Number.EPSILON) continue

      let maximumCenterCurvature = Math.abs(frame.centerCurvaturePerM)
      const sampleCount = Math.min(
        64,
        Math.max(4, Math.ceil(centerTravelM / Math.max(contact.radiusM * 0.125, 0.005))),
      )
      for (let sample = 1; sample <= sampleCount; sample += 1) {
        const traversal = traverseGroundPathCenterDistance(
          this.groundPathNetwork,
          contact,
          (centerTravelM * sample) / sampleCount,
        )
        if (!traversal) break
        maximumCenterCurvature = Math.max(
          maximumCenterCurvature,
          Math.abs(traversal.frame.centerCurvaturePerM),
        )
        if (traversal.stoppedAtOpenEnd) break
      }

      const tangentSubsteps = Math.ceil(
        (maximumCenterCurvature * centerTravelM) / MAX_PATH_TANGENT_STEP_RAD,
      )
      const travelSubsteps = Math.ceil(
        centerTravelM / Math.max(contact.radiusM * MAX_PATH_CENTER_TRAVEL_RADIUS_RATIO, 0.001),
      )
      requiredSubsteps = Math.max(requiredSubsteps, tangentSubsteps, travelSubsteps)
    }

    if (requiredSubsteps > MAX_SPRING_INTERNAL_SUBSTEPS && !this.pathSubstepLimitWarningShown) {
      this.pathSubstepLimitWarningShown = true
      this.warnings.push({
        message: `高速曲面接触需要 ${requiredSubsteps} 个内部子步，已使用实时上限 ${MAX_SPRING_INTERNAL_SUBSTEPS}；请增大过渡长度或降低速度。`,
      })
    }
    return Math.min(requiredSubsteps, MAX_SPRING_INTERNAL_SUBSTEPS)
  }

  private blockGroundDistanceSquared(position: Vec2, start: Vec2, end: Vec2): number {
    const dx = end.x - start.x
    const dy = end.y - start.y
    const lengthSquared = dx * dx + dy * dy
    if (lengthSquared <= 1e-18) return Infinity
    const t = Math.min(
      1,
      Math.max(0, ((position.x - start.x) * dx + (position.y - start.y) * dy) / lengthSquared),
    )
    const closestX = start.x + dx * t
    const closestY = start.y + dy * t
    return (position.x - closestX) ** 2 + (position.y - closestY) ** 2
  }

  private refreshAdaptiveCcd(): void {
    for (const record of this.dynamicBodies.values()) {
      const shape = record.entity.shape
      let ccdEnabled = record.entity.continuousCollisionDetection
      if (record.booleanResult) {
        const velocity = record.rigidBody.linvel()
        const stepDistance = Math.hypot(velocity.x, velocity.y) * this.currentTimeStep
        const useProxyColliders = this.booleanBodyNeedsCcdProxy(record, stepDistance)
        if (useProxyColliders && record.ccdProxyColliders.length === 0) {
          ccdEnabled = this.activateBooleanCcdProxies(record)
        } else if (!useProxyColliders && record.ccdProxyColliders.length > 0) {
          this.deactivateBooleanCcdProxies(record)
          ccdEnabled = false
        } else {
          ccdEnabled = useProxyColliders
        }
      }
      if (shape.type === 'circle' && shape.collisionEnabled && !ccdEnabled) {
        const velocity = record.rigidBody.linvel()
        const stepDistance = Math.hypot(velocity.x, velocity.y) * this.currentTimeStep
        ccdEnabled = stepDistance >= shape.radius * ADAPTIVE_CCD_RADIUS_RATIO
      }
      if (record.ccdEnabled === ccdEnabled) continue
      record.rigidBody.enableCcd(ccdEnabled)
      record.ccdEnabled = ccdEnabled
    }
  }

  step(stepCount = 1): void {
    const count = Math.max(0, Math.floor(stepCount))
    if (count === 0) return

    try {
      for (let index = 0; index < count; index += 1) {
        this.fieldEvaluationCache.clear()
        const internalSubstepCount = Math.max(
          this.springSubstepCount,
          this.requiredPathSubstepCount(),
        )
        this.currentTimeStep = this.fixedTimeStep / internalSubstepCount
        this.world.timestep = this.currentTimeStep
        const logicalPreviousBodyStates = this.captureBodyStates()
        for (let substep = 0; substep < internalSubstepCount; substep += 1) {
          this.currentSubstepStartTime = this.simulationTimeValue + substep * this.currentTimeStep
          const previousBodyStates = this.captureBodyStates()
          this.captureSpringBumperCapStarts()
          this.beginSpringBumperSimulation()
          this.resetExternalForces()
          this.applyFieldForces()
          this.applyForces()
          this.applyPairwiseElectrostatics()
          this.stepParticleSources()
          this.recordSpringConstraintForces()
          this.applySpringDampingImpulse(this.currentTimeStep / 2)
          this.applySpringElasticImpulse(this.currentTimeStep / 2)
          this.refreshSpringBumperCompression()
          this.applySpringBumperImpulse(this.currentTimeStep / 2)
          this.refreshAdaptiveCcd()
          this.preparePersistentGroundContacts()
          this.updateMasslessConnectorColliders()
          this.refreshSuppressedContactPairs()
          this.preparePersistentBooleanCircleContacts()
          const solverInputBodyStates = this.captureBodyStates()
          this.world.step(this.eventQueue, this.physicsHooks)
          this.applyConveyorGroundImpulses()
          this.resolveSpringBumperContacts()
          this.updateMasslessRopeShapes()
          this.resolveFrictionlessFullyElasticGroundImpacts(
            previousBodyStates,
            solverInputBodyStates,
          )
          this.applySpringElasticImpulse(this.currentTimeStep / 2)
          this.applySpringDampingImpulse(this.currentTimeStep / 2)
          this.applySpringBumperImpulse(this.currentTimeStep / 2)
          this.advancePersistentGroundContacts(previousBodyStates)
          this.advancePersistentBooleanCircleContacts(previousBodyStates)
          this.refreshReleasedContactPairs()
          this.refreshReleasedBooleanCircleContacts()
          this.acquirePersistentGroundContacts(previousBodyStates)
          this.acquirePersistentBooleanCircleContacts(previousBodyStates)
          this.solveFlexibleConnectorConstraints()
          this.solveRodConstraints()
          this.resolveConnectorBodyContacts(previousBodyStates)
          const connectorGroundConstraints = this.resolveMasslessConnectorGroundContacts()
          this.solveFlexibleRopesXpbd(connectorGroundConstraints)
        }
        this.updateNetForcesFromMomentum(logicalPreviousBodyStates)
        this.simulationTimeValue += this.fixedTimeStep
      }
    } finally {
      this.currentTimeStep = this.fixedTimeStep
      this.world.timestep = this.fixedTimeStep
    }
  }

  getBodyStates(): RuntimeBodyState[] {
    return [...this.dynamicBodies.entries()].map(([entityId, record]) => {
      const position = record.rigidBody.translation()
      const linearVelocity = record.rigidBody.linvel()
      const angularVelocityRad = record.rigidBody.angvel()
      const massKg = record.entity.massKg
      const translationalKineticEnergyJ =
        0.5 * massKg * (linearVelocity.x ** 2 + linearVelocity.y ** 2)
      const angularInertia = record.rigidBody.effectiveAngularInertia()
      const rotationalKineticEnergyJ =
        Number.isFinite(angularInertia) && angularInertia > 0
          ? 0.5 * angularInertia * angularVelocityRad ** 2
          : 0
      return {
        entityId,
        position: { x: position.x, y: position.y },
        angleRad: record.rigidBody.rotation(),
        linearVelocity: { x: linearVelocity.x, y: linearVelocity.y },
        angularVelocityRad,
        netForce: record.netForce,
        acceleration: {
          x: record.netForce.x / massKg,
          y: record.netForce.y / massKg,
        },
        translationalKineticEnergyJ,
        rotationalKineticEnergyJ,
        kineticEnergyJ: translationalKineticEnergyJ + rotationalKineticEnergyJ,
        contactSources: this.runtimeContactSources(entityId, record),
      }
    })
  }

  private runtimeContactSources(
    entityId: EntityId,
    record: DynamicBodyRecord,
  ): RuntimeContactSource[] {
    const accumulated = new Map<
      string,
      { sourceEntityId: EntityId; sourceKind: RuntimeContactSource['sourceKind']; direction: Vec2 }
    >()
    const add = (
      sourceEntityId: EntityId | null | undefined,
      sourceKind: RuntimeContactSource['sourceKind'],
      direction: Vec2,
    ) => {
      if (!sourceEntityId || sourceEntityId === entityId) return
      const magnitude = Math.hypot(direction.x, direction.y)
      if (magnitude <= Number.EPSILON) return
      const key = `${sourceKind}:${sourceEntityId}`
      const current = accumulated.get(key)
      const normalized = { x: direction.x / magnitude, y: direction.y / magnitude }
      if (current) {
        current.direction.x += normalized.x
        current.direction.y += normalized.y
      } else {
        accumulated.set(key, { sourceEntityId, sourceKind, direction: normalized })
      }
    }

    const persistentGroundContact = this.persistentGroundContacts.get(entityId)
    if (persistentGroundContact) {
      const frame = resolveGroundPathContactFrame(this.groundPathNetwork, persistentGroundContact)
      if (frame) {
        add(frame.segment.sourceGroundId ?? frame.segment.jointId, 'ground', frame.contactNormal)
      }
    }

    for (const contact of this.connectorBodyContactManifolds.values()) {
      if (contact.bodyId === entityId) {
        add(contact.record.entity.id, 'connector', contact.normal)
      }
    }
    for (const bumper of this.springBumpers) {
      for (const contact of this.collectSpringBumperContacts(bumper)) {
        if (contact.kind === 'body' && contact.bodyId === entityId) {
          add(bumper.entity.id, 'connector', contact.cap.outward)
        }
      }
    }

    const bodyPosition = record.rigidBody.translation()
    const nearestGroundDirection = (): { sourceEntityId: EntityId; direction: Vec2 } | null => {
      let nearest: { sourceEntityId: EntityId; direction: Vec2; distance: number } | null = null
      for (const { ground, path } of this.groundPathNetwork.groundPaths.values()) {
        const closest = path.closestPoint(bodyPosition)
        const point = path.pointAt(closest.s)
        const offset = { x: bodyPosition.x - point.x, y: bodyPosition.y - point.y }
        const distance = Math.hypot(offset.x, offset.y)
        const direction =
          distance > Number.EPSILON
            ? { x: offset.x / distance, y: offset.y / distance }
            : path.normalAt(closest.s)
        if (!nearest || distance < nearest.distance) {
          nearest = { sourceEntityId: ground.id, direction, distance }
        }
      }
      return nearest
    }

    for (const collider of this.activeBodyColliders(record)) {
      this.world.contactPairsWith(collider, (other) => {
        if (!this.hasValidSolverContact(collider, other)) return
        const ground = this.groundsByCollider.get(other.handle)
        if (ground) {
          const closest = ground.piece.path.closestPoint(bodyPosition)
          const point = ground.piece.path.pointAt(closest.s)
          add(ground.ground.entity.id, 'ground', {
            x: bodyPosition.x - point.x,
            y: bodyPosition.y - point.y,
          })
          return
        }
        if (
          other.collisionGroups() === BOX_GROUND_COLLISION_GROUPS ||
          other.collisionGroups() === BOOLEAN_GROUND_COLLISION_GROUPS
        ) {
          const nearest = nearestGroundDirection()
          if (nearest) add(nearest.sourceEntityId, 'ground', nearest.direction)
          return
        }
        const otherBody = this.dynamicColliders.get(other.handle)
        if (otherBody && otherBody !== record) {
          const otherPosition = otherBody.rigidBody.translation()
          add(otherBody.entity.id, 'body', {
            x: bodyPosition.x - otherPosition.x,
            y: bodyPosition.y - otherPosition.y,
          })
          return
        }
        const connector = this.connectorMassBodies.find(
          (candidate) => candidate.collider?.handle === other.handle,
        )
        if (connector) {
          const otherPosition = connector.rigidBody.translation()
          add(connector.entity.id, 'connector', {
            x: bodyPosition.x - otherPosition.x,
            y: bodyPosition.y - otherPosition.y,
          })
        }
      })
    }

    return [...accumulated.values()].map((source) => {
      const magnitude = Math.hypot(source.direction.x, source.direction.y)
      return {
        sourceEntityId: source.sourceEntityId,
        sourceKind: source.sourceKind,
        direction:
          magnitude > Number.EPSILON
            ? { x: source.direction.x / magnitude, y: source.direction.y / magnitude }
            : { x: 0, y: 0 },
      }
    })
  }

  getConnectorStates(): RuntimeConnectorState[] {
    const states: RuntimeConnectorState[] = []
    const recorded = new Set<EntityId>()
    for (const shape of this.masslessRopeShapes.values()) {
      states.push({
        entityId: shape.entity.id,
        points: shape.points.map((point) => ({ ...point })),
      })
      recorded.add(shape.entity.id)
    }
    for (const bumper of this.springBumpers) {
      const points = this.springBumperPoints(bumper)
      states.push({ entityId: bumper.entity.id, points: [points.a, points.b] })
      recorded.add(bumper.entity.id)
    }
    for (const connector of this.flexibleConnectors) {
      const points = [
        this.connectorEndpointState(connector.first).position,
        ...connector.nodes.map((node) => this.connectorEndpointState(node).position),
        this.connectorEndpointState(connector.second).position,
      ]
      states.push({ entityId: connector.entity.id, points })
      recorded.add(connector.entity.id)
    }
    for (const rod of this.massiveRods) {
      const center = rod.rigidBody.translation()
      const angle = rod.rigidBody.rotation() + Math.PI / 2
      const halfLength = rod.entity.connector.type === 'rod' ? rod.entity.connector.length / 2 : 0
      const offset = { x: Math.cos(angle) * halfLength, y: Math.sin(angle) * halfLength }
      states.push({
        entityId: rod.entity.id,
        points: [
          { x: center.x - offset.x, y: center.y - offset.y },
          { x: center.x + offset.x, y: center.y + offset.y },
        ],
      })
      recorded.add(rod.entity.id)
    }
    for (const record of this.connectorCollisionSegments) {
      if (recorded.has(record.entity.id)) continue
      states.push({
        entityId: record.entity.id,
        points: [
          this.connectorEndpointState(record.first).position,
          this.connectorEndpointState(record.second).position,
        ],
      })
      recorded.add(record.entity.id)
    }
    for (const record of this.connectorRuntimeRecords.values()) {
      if (recorded.has(record.entity.id)) continue
      states.push({
        entityId: record.entity.id,
        points: [
          this.connectorEndpointState(record.first).position,
          this.connectorEndpointState(record.second).position,
        ],
      })
      recorded.add(record.entity.id)
    }
    return states
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.dynamicBodies.clear()
    this.dynamicColliders.clear()
    this.booleanCcdProxyFailureIds.clear()
    this.fields.length = 0
    this.booleanFields.length = 0
    this.forces.length = 0
    this.fieldExpressionCompilers.clear()
    this.fieldEvaluationCache.clear()
    this.expressionWarningKeys.clear()
    this.rods.length = 0
    this.springs.length = 0
    this.springBumpers.length = 0
    this.connectorRuntimeRecords.clear()
    this.connectorMassBodies.length = 0
    this.flexibleConnectors.length = 0
    this.flexibleConnectorsById.clear()
    this.massiveRods.length = 0
    this.connectorCollisionSegments.length = 0
    this.masslessRopeShapes.clear()
    this.permanentlySuppressedContactPairs.clear()
    this.groundsById.clear()
    this.groundsByCollider.clear()
    this.groundCollidersByPieceId.clear()
    this.blockGroundColliderChains.length = 0
    this.conveyorGroundColliders.length = 0
    this.persistentGroundContacts.clear()
    this.persistentBooleanCircleContacts.clear()
    this.releasedBooleanCircleContacts.clear()
    this.releasedContactPairs.clear()
    this.suppressedContactPairs.clear()
    this.eventQueue.free()
    this.world.free()
  }

  private buildScene(): void {
    const resolvedBooleanScene = resolveBooleanScene(this.scene)
    const booleanSourceIds = new Set(
      resolvedBooleanScene.roots.flatMap((result) => result.sourceEntityIds),
    )
    const enabledEntities = this.scene.entities.filter(
      (entity) => entity.simulationEnabled && !booleanSourceIds.has(entity.id),
    )
    const enabledBooleanBodies = resolvedBooleanScene.roots.filter(
      (result): result is ResolvedBooleanBody =>
        result.valid && result.kind === 'body' && result.simulationEnabled,
    )
    const standaloneBezierBodies = enabledEntities.filter(
      (entity): entity is BodyEntity =>
        entity.kind === 'body' && entity.shape.type === 'bezierPath',
    )
    const standaloneBezierResults = standaloneBezierBodies.map((entity) => ({
      entity,
      result: resolveBezierPathBody(entity),
    }))
    const enabledCompoundBodyCount =
      enabledBooleanBodies.length +
      standaloneBezierResults.filter(
        ({ result }) => result.valid && result.kind === 'body' && result.simulationEnabled,
      ).length
    this.groundPathNetwork = buildGroundPathNetwork(enabledEntities)
    const hasCircleColliders = enabledEntities.some(
      (entity) =>
        (entity.kind === 'body' &&
          entity.shape.type === 'circle' &&
          entity.shape.collisionEnabled) ||
        (entity.kind === 'connector' &&
          (entity.collisionEnabled ||
            (entity.connector.type === 'spring' &&
              (entity.a.type === 'free' || entity.b.type === 'free')))),
    )
    const hasBoxColliders = enabledEntities.some(
      (entity) => entity.kind === 'body' && entity.shape.type === 'box',
    )
    this.hasFrictionlessFullyElasticGroundImpactPairs = enabledEntities.some(
      (entity) =>
        entity.kind === 'body' &&
        entity.shape.type === 'circle' &&
        entity.shape.collisionEnabled &&
        this.groundPathNetwork.segments.some((segment) =>
          segment.collisionPieces.some((piece) =>
            materialsAreFrictionlessAndFullyElastic(entity.material, piece.material),
          ),
        ),
    )
    const maximumBoxRadius = enabledEntities.reduce(
      (maximum, entity) =>
        entity.kind === 'body' && entity.shape.type === 'box'
          ? Math.max(maximum, Math.hypot(entity.shape.width, entity.shape.height) / 2)
          : maximum,
      0,
    )

    const connectors: ConnectorEntity[] = []
    const forces: ForceEntity[] = []
    const groundJoints: GroundJointEntity[] = []
    for (const entity of enabledEntities) {
      if (entity.kind !== 'ground') continue
      this.groundsById.set(entity.id, { entity, colliders: [] })
    }

    if (hasCircleColliders) {
      for (const segment of this.groundPathNetwork.segments) {
        for (const piece of segment.collisionPieces) {
          const ground = this.groundsById.get(piece.sourceGroundId)
          if (!ground) continue
          const points = piece.path.sample()
          if (points.length < 2) continue
          const collider = this.world.createCollider(
            applyMaterial(
              RAPIER.ColliderDesc.polyline(flattenGroundPoints(points)),
              ground.entity.conveyor.enabled ? { ...piece.material, friction: 0 } : piece.material,
            ).setCollisionGroups(CIRCLE_GROUND_COLLISION_GROUPS),
          )
          const linearEndpoints =
            points.length === 2 && Math.abs(piece.path.curvatureAt(piece.path.length / 2)) <= 1e-9
              ? (() => {
                  const start = points[0]!
                  const end = points[1]!
                  const length = Math.hypot(end.x - start.x, end.y - start.y)
                  return {
                    start,
                    end,
                    normal:
                      length > Number.EPSILON
                        ? { x: -(end.y - start.y) / length, y: (end.x - start.x) / length }
                        : { x: 0, y: 1 },
                  }
                })()
              : null
          const colliderRecord: GroundColliderRecord = {
            ground,
            collider,
            segment,
            piece,
            minX: Math.min(...points.map((point) => point.x)),
            minY: Math.min(...points.map((point) => point.y)),
            maxX: Math.max(...points.map((point) => point.x)),
            maxY: Math.max(...points.map((point) => point.y)),
            linearEndpoints,
          }
          ground.colliders.push(colliderRecord)
          this.groundsByCollider.set(collider.handle, colliderRecord)
          this.groundCollidersByPieceId.set(piece.id, colliderRecord)
        }
      }
    }

    for (const result of resolvedBooleanScene.roots) {
      if (!result.valid) {
        this.warnings.push({
          entityId: result.resultId,
          message: `布尔结果已停用：${result.diagnostics.join('；')}`,
        })
      } else if (result.kind === 'body' && result.simulationEnabled) {
        this.createBooleanBody(result)
      } else if (result.kind === 'field' && result.simulationEnabled) {
        this.booleanFields.push(result)
      }
    }
    for (const { entity, result } of standaloneBezierResults) {
      if (!result.valid) {
        this.warnings.push({
          entityId: entity.id,
          message: `钢笔物块已停用：${result.diagnostics.join('；')}`,
        })
      } else if (result.kind === 'body' && result.simulationEnabled) {
        this.createBooleanBody(result, entity)
      }
    }

    if (hasBoxColliders) {
      for (const chain of buildGroundCollisionChains(this.groundPathNetwork)) {
        const chainColliders: BlockGroundColliderRecord[] = []
        for (let index = 0; index < chain.points.length - 1; index += 1) {
          const start = chain.points[index]!
          const end = chain.points[index + 1]!
          const dx = end.x - start.x
          const dy = end.y - start.y
          const length = Math.hypot(dx, dy)
          if (length <= 1e-9) continue
          const tangentX = dx / length
          const tangentY = dy / length
          const startConnected = index > 0 || chain.startConnected
          const endConnected = index < chain.points.length - 2 || chain.endConnected
          const startExtension = startConnected
            ? maximumBoxRadius + BLOCK_GROUND_CAP_CLEARANCE_M
            : 0
          const endExtension = endConnected ? maximumBoxRadius + BLOCK_GROUND_CAP_CLEARANCE_M : 0
          const extendedStart = {
            x: start.x - tangentX * startExtension,
            y: start.y - tangentY * startExtension,
          }
          const extendedEnd = {
            x: end.x + tangentX * endExtension,
            y: end.y + tangentY * endExtension,
          }
          const extendedLength = length + startExtension + endExtension
          const collider = this.world.createCollider(
            applyMaterial(
              RAPIER.ColliderDesc.cuboid(extendedLength / 2, BLOCK_GROUND_HALF_THICKNESS_M)
                .setTranslation(
                  (extendedStart.x + extendedEnd.x) / 2,
                  (extendedStart.y + extendedEnd.y) / 2,
                )
                .setRotation(Math.atan2(dy, dx)),
              chain.conveyor.enabled ? { ...chain.material, friction: 0 } : chain.material,
            ).setCollisionGroups(BOX_GROUND_COLLISION_GROUPS),
          )
          chainColliders.push({
            collider,
            colliderHandle: collider.handle,
            start,
            end,
            collisionStart: extendedStart,
            collisionEnd: extendedEnd,
          })
          if (chain.conveyor.enabled) {
            this.conveyorGroundColliders.push({
              collider,
              tangent: { x: tangentX, y: tangentY },
              speedMps: chain.conveyorSpeedAlongPointsMps,
              material: chain.material,
            })
          }
        }
        if (chainColliders.length > 3) {
          const collisionPoints = chainColliders.flatMap((record) => [
            record.collisionStart,
            record.collisionEnd,
          ])
          this.blockGroundColliderChains.push({
            colliders: chainColliders,
            closed: chain.closed,
            minX:
              Math.min(...collisionPoints.map((point) => point.x)) - BLOCK_GROUND_HALF_THICKNESS_M,
            minY:
              Math.min(...collisionPoints.map((point) => point.y)) - BLOCK_GROUND_HALF_THICKNESS_M,
            maxX:
              Math.max(...collisionPoints.map((point) => point.x)) + BLOCK_GROUND_HALF_THICKNESS_M,
            maxY:
              Math.max(...collisionPoints.map((point) => point.y)) + BLOCK_GROUND_HALF_THICKNESS_M,
          })
        }
      }
    }

    if (enabledCompoundBodyCount > 0) {
      for (const chain of buildGroundCollisionChains(this.groundPathNetwork)) {
        for (let index = 0; index < chain.points.length - 1; index += 1) {
          const start = chain.points[index]!
          const end = chain.points[index + 1]!
          const dx = end.x - start.x
          const dy = end.y - start.y
          const length = Math.hypot(dx, dy)
          if (length <= 1e-9) continue
          const tangent = { x: dx / length, y: dy / length }
          const startExtension =
            index > 0 || chain.startConnected ? BLOCK_GROUND_CAP_CLEARANCE_M : 0
          const endExtension =
            index < chain.points.length - 2 || chain.endConnected ? BLOCK_GROUND_CAP_CLEARANCE_M : 0
          const collisionStart = {
            x: start.x - tangent.x * startExtension,
            y: start.y - tangent.y * startExtension,
          }
          const collisionEnd = {
            x: end.x + tangent.x * endExtension,
            y: end.y + tangent.y * endExtension,
          }
          const collider = this.world.createCollider(
            applyMaterial(
              RAPIER.ColliderDesc.cuboid(
                (length + startExtension + endExtension) / 2,
                BLOCK_GROUND_HALF_THICKNESS_M,
              )
                .setTranslation(
                  (collisionStart.x + collisionEnd.x) / 2,
                  (collisionStart.y + collisionEnd.y) / 2,
                )
                .setRotation(Math.atan2(dy, dx)),
              chain.conveyor.enabled ? { ...chain.material, friction: 0 } : chain.material,
            ).setCollisionGroups(BOOLEAN_GROUND_COLLISION_GROUPS),
          )
          if (chain.conveyor.enabled) {
            this.conveyorGroundColliders.push({
              collider,
              tangent,
              speedMps: chain.conveyorSpeedAlongPointsMps,
              material: chain.material,
            })
          }
        }
      }
    }

    for (const ground of this.groundsById.values()) {
      if (!this.groundPathNetwork.groundPaths.has(ground.entity.id)) {
        this.warnings.push({ message: '地面长度为零，已忽略。', entityId: ground.entity.id })
      }
    }

    for (const entity of enabledEntities) {
      if (entity.kind === 'groundJoint') {
        groundJoints.push(entity)
      } else if (entity.kind === 'body' && entity.shape.type !== 'bezierPath') {
        this.createBody(entity)
      } else if (entity.kind === 'field') {
        this.fields.push(entity)
      } else if (entity.kind === 'particleSource') {
        this.particleSources.push(this.emitIonGeneration(entity))
      } else if (entity.kind === 'force') {
        forces.push(entity)
      } else if (entity.kind === 'connector') {
        connectors.push(entity)
      }
    }

    for (const connector of connectors) this.createConnector(connector)
    for (const force of forces) this.createForce(force)
    this.configureSpringIntegration()
    this.validateGroundJoints(enabledEntities, groundJoints)
  }

  private validateGroundJoints(
    enabledEntities: SceneDocument['entities'],
    joints: GroundJointEntity[],
  ): void {
    for (const joint of joints) {
      const resolved = resolveGroundJoint(enabledEntities, joint)
      if (resolved.issue || !resolved.a || !resolved.b || !resolved.position) {
        const reason =
          resolved.issue === 'same-ground'
            ? '两个端点属于同一块地面'
            : resolved.issue === 'endpoint-conflict'
              ? '至少一个端点已被其他连接点占用'
              : resolved.issue === 'degenerate-tangent'
                ? '端点切线无法确定'
                : '引用的地面不存在'
        this.warnings.push({
          message: `地面连接点无效（${reason}），已按普通独立地面处理。`,
          entityId: joint.id,
        })
        continue
      }

      const jointPath = this.groundPathNetwork.jointPaths.get(joint.id)
      if (jointPath?.issue) {
        const reason =
          jointPath.issue === 'angle-too-small'
            ? '两块地面的方向几乎重合'
            : jointPath.issue === 'linear-zero-length'
              ? '反向端点重合，直线长度为零'
              : '无法生成满足曲率、长度与无自交要求的安全过渡'
        this.warnings.push({
          message: `地面连接点无效（${reason}），已保留两块独立地面。`,
          entityId: joint.id,
        })
        continue
      }

      const firstGround = this.groundsById.get(resolved.a.ground.id)
      const secondGround = this.groundsById.get(resolved.b.ground.id)
      if (
        !firstGround ||
        !secondGround ||
        !this.groundPathNetwork.groundPaths.has(resolved.a.ground.id) ||
        !this.groundPathNetwork.groundPaths.has(resolved.b.ground.id)
      ) {
        this.warnings.push({
          message: '地面连接点引用的地面没有有效碰撞几何，已忽略。',
          entityId: joint.id,
        })
      }
    }
  }

  private createBody(entity: BodyEntity): void {
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(entity.transform.position.x, entity.transform.position.y)
      .setRotation(entity.transform.angleRad)
      .setLinvel(entity.initialVelocity.x, entity.initialVelocity.y)
      .setAngvel(entity.rotationEnabled ? entity.initialAngularVelocityRad : 0)
      .setCcdEnabled(entity.continuousCollisionDetection)
    if (!entity.rotationEnabled) bodyDesc.lockRotations()
    const rigidBody = this.world.createRigidBody(bodyDesc)
    const colliderDesc = colliderForBody(entity)
    const record: DynamicBodyRecord = {
      entity,
      rigidBody,
      collider: null,
      colliders: [],
      circleBoundaryColliders: [],
      ccdProxyColliders: [],
      booleanResult: null,
      booleanBoundaryPaths: [],
      boundingRadius: bodyBoundingRadius(entity),
      netForce: { x: 0, y: 0 },
      pathForce: { x: 0, y: 0 },
      constraintForce: { x: 0, y: 0 },
      magneticFieldTesla: 0,
      ccdEnabled: entity.continuousCollisionDetection,
    }

    if (colliderDesc) {
      const preparedCollider = applyMaterial(colliderDesc, entity.material)
        .setMass(entity.massKg)
        .setCollisionGroups(
          entity.shape.type === 'circle' ? CIRCLE_BODY_COLLISION_GROUPS : BOX_BODY_COLLISION_GROUPS,
        )
      preparedCollider.setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS)
      const collider = this.world.createCollider(preparedCollider, rigidBody)
      record.collider = collider
      record.colliders.push(collider)
      this.dynamicColliders.set(collider.handle, record)
    } else {
      rigidBody.setAdditionalMass(entity.massKg, false)
    }
    rigidBody.recomputeMassPropertiesFromColliders()
    if (!entity.rotationEnabled) {
      rigidBody.lockRotations(true, false)
      rigidBody.setAngvel(0, false)
    }
    this.dynamicBodies.set(entity.id, record)
  }

  private createBooleanBody(result: ResolvedBooleanBody, sourceEntity?: BodyEntity): void {
    const firstRegion = result.materialRegions[0]
    const width = Math.max(1e-6, result.bounds.max.x - result.bounds.min.x)
    const height = Math.max(1e-6, result.bounds.max.y - result.bounds.min.y)
    const entity: BodyEntity = sourceEntity ?? {
      id: result.resultId,
      kind: 'body',
      preset: 'block',
      color: '#725bd8',
      name: '布尔复合物体',
      visible: true,
      locked: false,
      simulationEnabled: result.simulationEnabled,
      shape: { type: 'box', width, height },
      transform: { position: result.centerOfMass, angleRad: result.angleRad },
      massKg: result.massKg,
      chargeC: result.chargeC,
      material: firstRegion?.material ?? { friction: 0, restitution: 0 },
      initialVelocity: result.initialVelocity,
      initialAngularVelocityRad: result.initialAngularVelocityRad,
      rotationEnabled: result.rotationEnabled,
      continuousCollisionDetection: result.continuousCollisionDetection,
    }
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(result.centerOfMass.x, result.centerOfMass.y)
      .setRotation(result.angleRad)
      .setLinvel(result.initialVelocity.x, result.initialVelocity.y)
      .setAngvel(result.rotationEnabled ? result.initialAngularVelocityRad : 0)
      .setCcdEnabled(false)
    if (!result.rotationEnabled) bodyDesc.lockRotations()
    const rigidBody = this.world.createRigidBody(bodyDesc)
    const record: DynamicBodyRecord = {
      entity,
      rigidBody,
      collider: null,
      colliders: [],
      circleBoundaryColliders: [],
      ccdProxyColliders: [],
      booleanResult: result,
      booleanBoundaryPaths: booleanBoundaryPaths(result),
      boundingRadius: Math.max(
        1e-6,
        ...result.convexParts.flatMap((part) =>
          part.localPoints.map((point) => Math.hypot(point.x, point.y)),
        ),
      ),
      netForce: { x: 0, y: 0 },
      pathForce: { x: 0, y: 0 },
      constraintForce: { x: 0, y: 0 },
      magneticFieldTesla: 0,
      ccdEnabled: false,
    }
    const sourceBodies = result.sourceEntityIds
      .map((sourceId) => this.scene.entities.find((entity) => entity.id === sourceId))
      .filter((entity): entity is BodyEntity => entity?.kind === 'body')
    for (const path of record.booleanBoundaryPaths) {
      const initialPath: BooleanBoundaryPath = {
        ...path,
        points: path.points.map((point) => {
          const cosine = Math.cos(result.angleRad)
          const sine = Math.sin(result.angleRad)
          return {
            x: result.centerOfMass.x + point.x * cosine - point.y * sine,
            y: result.centerOfMass.y + point.x * sine + point.y * cosine,
          }
        }),
      }
      const cosine = Math.cos(-result.angleRad)
      const sine = Math.sin(-result.angleRad)
      path.analyticCircleSegments = detectBooleanBoundaryCircles(initialPath, sourceBodies)
        .map((circle) => {
          const offsetX = circle.center.x - result.centerOfMass.x
          const offsetY = circle.center.y - result.centerOfMass.y
          return {
            center: {
              x: offsetX * cosine - offsetY * sine,
              y: offsetX * sine + offsetY * cosine,
            },
            radiusM: circle.radiusM,
            startM: circle.startM,
            endM: circle.endM,
            direction: circle.direction,
          }
        })
        .sort((first, second) => first.startM - second.startM)
    }
    try {
      for (const mesh of result.collisionMeshes) {
        const flags =
          RAPIER.TriMeshFlags.ORIENTED |
          RAPIER.TriMeshFlags.MERGE_DUPLICATE_VERTICES |
          RAPIER.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES |
          RAPIER.TriMeshFlags.DELETE_DUPLICATE_TRIANGLES |
          RAPIER.TriMeshFlags.DELETE_BAD_TOPOLOGY_TRIANGLES
        const prepared = applyMaterial(
          RAPIER.ColliderDesc.trimesh(mesh.vertices, mesh.indices, flags),
          mesh.material,
        )
          .setDensity(0)
          .setCollisionGroups(BOOLEAN_SOLID_COLLISION_GROUPS)
        prepared.setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS)
        const collider = this.world.createCollider(prepared, rigidBody)
        record.collider ??= collider
        record.colliders.push(collider)
        this.dynamicColliders.set(collider.handle, record)
      }
      if (record.colliders.length === 0) {
        throw new Error('布尔结果没有可用的碰撞网格。')
      }
      for (const boundary of booleanBoundaryColliderDescriptions(result)) {
        const prepared = applyMaterial(boundary.desc, boundary.material)
          .setDensity(0)
          .setCollisionGroups(BOOLEAN_BOUNDARY_COLLISION_GROUPS)
        prepared.setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS)
        const collider = this.world.createCollider(prepared, rigidBody)
        record.circleBoundaryColliders.push(collider)
        this.dynamicColliders.set(collider.handle, record)
      }
      rigidBody.setAdditionalMassProperties(
        result.massKg,
        { x: 0, y: 0 },
        Math.max(result.inertiaKgM2, 1e-12),
        false,
      )
      rigidBody.recomputeMassPropertiesFromColliders()
      rigidBody.wakeUp()
    } catch {
      for (const collider of [
        ...record.colliders,
        ...record.circleBoundaryColliders,
        ...record.ccdProxyColliders,
      ]) {
        this.dynamicColliders.delete(collider.handle)
      }
      this.world.removeRigidBody(rigidBody)
      this.warnings.push({
        entityId: result.resultId,
        message: sourceEntity
          ? '钢笔物块的复合碰撞体创建失败，已停用该物体的模拟。'
          : '布尔结果的复合碰撞体创建失败，已停用该结果的模拟。',
      })
      return
    }
    if (!result.rotationEnabled) {
      rigidBody.lockRotations(true, false)
      rigidBody.setAngvel(0, false)
    }
    this.dynamicBodies.set(result.resultId, record)
  }

  private createConnector(entity: ConnectorEntity): void {
    let effectiveEntity = entity
    if (entity.connector.type === 'rope') {
      const massKg = entity.collisionEnabled
        ? Math.max(MIN_COLLIDING_ROPE_MASS_KG, entity.massKg)
        : 0
      if (massKg !== entity.massKg) effectiveEntity = { ...entity, massKg }
    } else if (
      entity.connector.type === 'spring' &&
      (entity.massKg !== 0 || entity.collisionEnabled)
    ) {
      effectiveEntity = { ...entity, massKg: 0, collisionEnabled: false }
    }
    if (effectiveEntity !== entity) {
      this.warnings.push({
        message:
          entity.connector.type === 'spring'
            ? '弹簧运行时固定为 0 kg 并关闭普通碰撞。'
            : entity.collisionEnabled
              ? `碰撞绳质量低于 ${MIN_COLLIDING_ROPE_MASS_KG} kg，运行时已使用最低质量 ${MIN_COLLIDING_ROPE_MASS_KG} kg。`
              : '未开启碰撞的绳运行时固定为 0 kg。',
        entityId: entity.id,
      })
    }
    if (
      effectiveEntity.connector.type === 'spring' &&
      (effectiveEntity.a.type === 'free' || effectiveEntity.b.type === 'free')
    ) {
      this.createSpringBumper(effectiveEntity as SpringBumperRecord['entity'])
      return
    }
    const first = this.createConnectorRuntimeEndpoint(effectiveEntity.a)
    const second = this.createConnectorRuntimeEndpoint(effectiveEntity.b)
    if (!first || !second || first.rigidBody === second.rigidBody) {
      this.warnings.push({ message: '连接器端点无效，已忽略。', entityId: effectiveEntity.id })
      return
    }
    this.connectorRuntimeRecords.set(effectiveEntity.id, {
      entity: effectiveEntity,
      first,
      second,
    })

    if (effectiveEntity.massKg > 0) {
      if (effectiveEntity.connector.type === 'rod') {
        this.createMassiveRod(effectiveEntity, first, second)
      } else {
        this.createMassiveFlexibleConnector(effectiveEntity, first, second)
      }
      return
    }

    if (effectiveEntity.connector.type === 'rope') {
      const joint = RAPIER.JointData.rope(
        effectiveEntity.connector.maxLength,
        first.localAnchor,
        second.localAnchor,
      )
      this.world.createImpulseJoint(joint, first.rigidBody, second.rigidBody, true)
    } else if (effectiveEntity.connector.type === 'rod') {
      const rod = {
        entity: effectiveEntity as RodConnectorRecord['entity'],
        first,
        second,
      }
      const { a, b } = effectiveEntity.connector.endpointRotation
      if (a === 'free' && b === 'free') {
        this.rods.push(rod)
      } else if (a === 'fixed' && b === 'fixed') {
        this.createFixedRodJoint(rod)
      } else {
        this.createPinnedRodJoint(rod, a === 'fixed' ? 'a' : 'b')
      }
    } else {
      this.springs.push({
        entity: effectiveEntity as SpringConnectorRecord['entity'],
        first,
        second,
        effectiveStiffness: effectiveEntity.connector.stiffness,
        effectiveInverseMassUpperBound: 0,
        restLength: effectiveEntity.connector.restLength,
        damping: effectiveEntity.connector.damping,
      })
    }
    if (effectiveEntity.collisionEnabled) {
      this.createMasslessConnectorCollision(effectiveEntity, first, second)
    }
  }

  private createConnectorRuntimeEndpoint(
    endpoint: ConnectorEndpoint,
  ): ConnectorRuntimeEndpoint | null {
    if (endpoint.type === 'body') {
      const body = this.dynamicBodies.get(endpoint.bodyId)
      return body
        ? {
            definition: endpoint,
            body,
            rigidBody: body.rigidBody,
            localAnchor: endpoint.localAnchor,
            fixed: false,
          }
        : null
    }

    let position: Vec2 | null = null
    if (endpoint.type === 'world' || endpoint.type === 'free') {
      position = endpoint.position
    } else if (endpoint.type === 'ground') {
      const path = this.groundPathNetwork.groundPaths.get(endpoint.groundId)?.path
      if (path) position = path.pointAt(path.length * Math.min(1, Math.max(0, endpoint.pathRatio)))
    } else {
      const path = this.groundPathNetwork.jointPaths.get(endpoint.groundJointId)?.path
      if (path) position = path.pointAt(path.length * Math.min(1, Math.max(0, endpoint.pathRatio)))
    }
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null
    const rigidBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(position.x, position.y),
    )
    return {
      definition: endpoint,
      body: null,
      rigidBody,
      localAnchor: { x: 0, y: 0 },
      fixed: true,
    }
  }

  private createSpringBumper(entity: SpringBumperRecord['entity']): void {
    const freeA = entity.a.type === 'free'
    if (entity.a.type === 'free' && entity.b.type === 'free') {
      const delta = {
        x: entity.b.position.x - entity.a.position.x,
        y: entity.b.position.y - entity.a.position.y,
      }
      const length = Math.hypot(delta.x, delta.y)
      const restLength = entity.connector.restLength
      this.springBumpers.push({
        entity,
        mode: 'double',
        attached: null,
        freeKey: null,
        axis:
          length > Number.EPSILON ? { x: delta.x / length, y: delta.y / length } : { x: 1, y: 0 },
        center: {
          x: (entity.a.position.x + entity.b.position.x) / 2,
          y: (entity.a.position.y + entity.b.position.y) / 2,
        },
        authoredLengthM: length,
        initialLengthM: restLength,
        inwardTravelM: Math.max(0, restLength - length),
        simulationStarted: false,
        effectiveStiffness: entity.connector.stiffness,
        damping: entity.connector.damping,
        effectiveInverseMassUpperBound: 0,
        substepStartCapCenters: [],
      })
      return
    }

    const freeKey: 'a' | 'b' = freeA ? 'a' : 'b'
    const attachedDefinition = entity[freeKey === 'a' ? 'b' : 'a']
    const freeDefinition = entity[freeKey]
    if (freeDefinition.type !== 'free') return
    const attached = this.createConnectorRuntimeEndpoint(attachedDefinition)
    if (!attached) {
      this.warnings.push({ message: '弹簧固定端点无效，已忽略。', entityId: entity.id })
      return
    }
    const anchor = this.connectorEndpointState(attached).position
    const delta = {
      x: freeDefinition.position.x - anchor.x,
      y: freeDefinition.position.y - anchor.y,
    }
    const length = Math.hypot(delta.x, delta.y)
    const restLength = entity.connector.restLength
    const worldAxis =
      length > Number.EPSILON ? { x: delta.x / length, y: delta.y / length } : { x: 1, y: 0 }
    const angle = attached.rigidBody.rotation()
    this.springBumpers.push({
      entity,
      mode: 'single',
      attached,
      freeKey,
      axis: {
        x: Math.cos(angle) * worldAxis.x + Math.sin(angle) * worldAxis.y,
        y: -Math.sin(angle) * worldAxis.x + Math.cos(angle) * worldAxis.y,
      },
      center: { x: 0, y: 0 },
      authoredLengthM: length,
      initialLengthM: restLength,
      inwardTravelM: Math.max(0, restLength - length),
      simulationStarted: false,
      effectiveStiffness: entity.connector.stiffness,
      damping: entity.connector.damping,
      effectiveInverseMassUpperBound: 0,
      substepStartCapCenters: [],
    })
  }

  private springBumperAxis(record: SpringBumperRecord): Vec2 {
    if (record.mode === 'double' || !record.attached) return record.axis
    const angle = record.attached.rigidBody.rotation()
    return {
      x: Math.cos(angle) * record.axis.x - Math.sin(angle) * record.axis.y,
      y: Math.sin(angle) * record.axis.x + Math.cos(angle) * record.axis.y,
    }
  }

  private springBumperPoints(record: SpringBumperRecord): { a: Vec2; b: Vec2 } {
    const axis = this.springBumperAxis(record)
    const length = record.simulationStarted
      ? Math.max(0, record.initialLengthM - record.inwardTravelM)
      : record.authoredLengthM
    if (record.mode === 'double') {
      const offset = scaleVector(axis, length / 2)
      return {
        a: { x: record.center.x - offset.x, y: record.center.y - offset.y },
        b: { x: record.center.x + offset.x, y: record.center.y + offset.y },
      }
    }
    if (!record.attached || !record.freeKey) return { a: record.center, b: record.center }
    const anchor = this.connectorEndpointState(record.attached).position
    const free = { x: anchor.x + axis.x * length, y: anchor.y + axis.y * length }
    return record.freeKey === 'a' ? { a: free, b: anchor } : { a: anchor, b: free }
  }

  private springBumperCompression(
    record: SpringBumperRecord,
    inwardTravelM = record.inwardTravelM,
  ): number {
    const currentLengthM = record.simulationStarted
      ? Math.max(0, record.initialLengthM - inwardTravelM)
      : record.authoredLengthM
    return Math.min(
      record.entity.connector.restLength,
      Math.max(0, record.entity.connector.restLength - currentLengthM),
    )
  }

  private allocateConnectorSegments(entity: ConnectorEntity, requested: number): number {
    const perConnector = Math.min(MAX_CONNECTOR_SEGMENTS, Math.max(1, Math.ceil(requested)))
    const remaining = Math.max(0, MAX_SCENE_CONNECTOR_SEGMENTS - this.connectorSegmentCount)
    const allocated = Math.min(perConnector, remaining)
    this.connectorSegmentCount += allocated
    if (allocated < requested || requested > MAX_CONNECTOR_SEGMENTS) {
      this.warnings.push({
        message: `连接器需要 ${Math.ceil(requested)} 个碰撞分段，已按实时上限使用 ${allocated} 个；质量、刚度和阻尼保持不变。`,
        entityId: entity.id,
      })
    }
    return allocated
  }

  private createConnectorMassBody(
    entity: ConnectorEntity,
    position: Vec2,
    massKg: number,
    colliderDesc: RAPIER.ColliderDesc | null,
    rotation = 0,
  ): ConnectorMassBodyRecord {
    const rigidBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y)
        .setRotation(rotation)
        .setCcdEnabled(true),
    )
    let collider: RAPIER.Collider | null = null
    if (colliderDesc) {
      const prepared = applyMaterial(colliderDesc, entity.material)
        .setMass(massKg)
        .setCollisionGroups(CONNECTOR_COLLISION_GROUPS)
        .setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS)
      collider = this.world.createCollider(prepared, rigidBody)
    } else {
      rigidBody.setAdditionalMass(massKg, false)
    }
    rigidBody.recomputeMassPropertiesFromColliders()
    const record = { entity, rigidBody, collider, massKg }
    this.connectorMassBodies.push(record)
    return record
  }

  private suppressConnectorEndpointContacts(
    collider: RAPIER.Collider | null,
    first: ConnectorRuntimeEndpoint,
    second: ConnectorRuntimeEndpoint,
  ): void {
    if (!collider) return
    for (const endpoint of [first, second]) {
      if (!endpoint.body?.collider) continue
      for (const bodyCollider of endpoint.body.colliders) {
        this.permanentlySuppressedContactPairs.add(
          colliderPairKey(collider.handle, bodyCollider.handle),
        )
      }
    }
  }

  private createMassiveRod(
    entity: ConnectorEntity,
    first: ConnectorRuntimeEndpoint,
    second: ConnectorRuntimeEndpoint,
  ): void {
    if (entity.connector.type !== 'rod') return
    this.world.maxCcdSubsteps = Math.max(this.world.maxCcdSubsteps, 4)
    const firstState = this.connectorEndpointState(first)
    const secondState = this.connectorEndpointState(second)
    const delta = {
      x: secondState.position.x - firstState.position.x,
      y: secondState.position.y - firstState.position.y,
    }
    const directionAngle =
      Math.hypot(delta.x, delta.y) > Number.EPSILON
        ? Math.atan2(delta.y, delta.x)
        : first.rigidBody.rotation()
    const bodyAngle = directionAngle - Math.PI / 2
    const center = {
      x: (firstState.position.x + secondState.position.x) / 2,
      y: (firstState.position.y + secondState.position.y) / 2,
    }
    const halfHeight = Math.max(0, entity.connector.length / 2 - entity.radiusM)
    const collisionSegments = entity.collisionEnabled
      ? this.allocateConnectorSegments(entity, 1)
      : 0
    const massBody = this.createConnectorMassBody(
      entity,
      center,
      entity.massKg,
      collisionSegments > 0 ? RAPIER.ColliderDesc.capsule(halfHeight, entity.radiusM) : null,
      bodyAngle,
    )
    const rodEndpoints = [
      { endpoint: first, localAnchor: { x: 0, y: -entity.connector.length / 2 }, key: 'a' },
      { endpoint: second, localAnchor: { x: 0, y: entity.connector.length / 2 }, key: 'b' },
    ] as const
    for (const { endpoint, localAnchor, key } of rodEndpoints) {
      const rotation = entity.connector.endpointRotation[key]
      const jointData =
        rotation === 'free'
          ? RAPIER.JointData.revolute(endpoint.localAnchor, localAnchor)
          : RAPIER.JointData.fixed(
              endpoint.localAnchor,
              bodyAngle - endpoint.rigidBody.rotation(),
              localAnchor,
              0,
            )
      const joint = this.world.createImpulseJoint(
        jointData,
        endpoint.rigidBody,
        massBody.rigidBody,
        true,
      )
      joint.setContactsEnabled(false)
    }
    this.suppressConnectorEndpointContacts(massBody.collider, first, second)
    this.massiveRods.push({ entity, first, second, rigidBody: massBody.rigidBody })
  }

  private createMassiveFlexibleConnector(
    entity: ConnectorEntity,
    first: ConnectorRuntimeEndpoint,
    second: ConnectorRuntimeEndpoint,
  ): void {
    if (entity.connector.type === 'rod') return
    const firstState = this.connectorEndpointState(first)
    const secondState = this.connectorEndpointState(second)
    const delta = {
      x: secondState.position.x - firstState.position.x,
      y: secondState.position.y - firstState.position.y,
    }
    const configuredLength =
      entity.connector.type === 'rope' ? entity.connector.maxLength : entity.connector.restLength
    const endpointDistance = Math.hypot(delta.x, delta.y)
    const impossibleFixedRope =
      entity.connector.type === 'rope' &&
      first.fixed &&
      second.fixed &&
      endpointDistance > configuredLength + FLEXIBLE_ROPE_ABSOLUTE_LENGTH_TOLERANCE_M
    const physicalLength = impossibleFixedRope ? endpointDistance : configuredLength
    if (impossibleFixedRope) {
      this.warnings.push({
        entityId: entity.id,
        message:
          `绳的两个固定端点相距 ${endpointDistance.toPrecision(6)} m，超过最大长度 ` +
          `${configuredLength.toPrecision(6)} m；本次模拟按固定端点距离拉直显示。`,
      })
    }
    const requestedSegments = Math.max(
      4,
      Math.ceil(physicalLength / Math.max(entity.radiusM * 4, 0.1)),
    )
    const allocatedSegments = this.allocateConnectorSegments(entity, requestedSegments)
    const segmentCount = Math.max(2, allocatedSegments || 2)
    const nodeCount = segmentCount - 1
    const freeEndpointCount = Number(entity.a.type === 'free') + Number(entity.b.type === 'free')
    const ownedMassPointCount = nodeCount + freeEndpointCount
    const massPerPoint = entity.massKg / ownedMassPointCount
    const nodes: ConnectorRuntimeEndpoint[] = []
    const createFreeEndpoint = (
      definition: Extract<ConnectorEndpoint, { type: 'free' }>,
    ): ConnectorRuntimeEndpoint => {
      const massBody = this.createConnectorMassBody(entity, definition.position, massPerPoint, null)
      return {
        definition,
        body: null,
        rigidBody: massBody.rigidBody,
        localAnchor: { x: 0, y: 0 },
        fixed: false,
      }
    }
    const resolvedFirst = entity.a.type === 'free' ? createFreeEndpoint(entity.a) : first
    const resolvedSecond = entity.b.type === 'free' ? createFreeEndpoint(entity.b) : second
    for (let index = 0; index < nodeCount; index += 1) {
      const ratio = (index + 1) / (nodeCount + 1)
      const position = {
        x: firstState.position.x + delta.x * ratio,
        y: firstState.position.y + delta.y * ratio,
      }
      const massBody = this.createConnectorMassBody(entity, position, massPerPoint, null)
      nodes.push({
        definition: { type: 'world', position },
        body: null,
        rigidBody: massBody.rigidBody,
        localAnchor: { x: 0, y: 0 },
        fixed: false,
      })
      this.suppressConnectorEndpointContacts(massBody.collider, resolvedFirst, resolvedSecond)
    }

    const chain = [resolvedFirst, ...nodes, resolvedSecond]
    const linkCount = chain.length - 1
    const flexibleRecord: FlexibleConnectorRecord = {
      entity,
      first: resolvedFirst,
      second: resolvedSecond,
      chain,
      nodes,
      kind: entity.connector.type,
      linkLength: physicalLength / linkCount,
      linkStiffness:
        entity.connector.type === 'spring' ? entity.connector.stiffness * linkCount : 0,
      linkDamping: entity.connector.type === 'spring' ? entity.connector.damping * linkCount : 0,
      previousNodePositions: nodes.map((node) => ({
        ...this.connectorEndpointState(node).position,
      })),
      constraintProjectionSegments: [],
    }
    this.flexibleConnectors.push(flexibleRecord)
    this.flexibleConnectorsById.set(entity.id, flexibleRecord)
    if (entity.collisionEnabled && allocatedSegments > 0) {
      for (let index = 0; index < linkCount; index += 1) {
        const linkFirst = chain[index]!
        const linkSecond = chain[index + 1]!
        const start = this.connectorEndpointState(linkFirst).position
        const end = this.connectorEndpointState(linkSecond).position
        this.createConnectorCollisionSegment(
          entity,
          linkFirst,
          linkSecond,
          start,
          end,
          0,
          1,
          null,
          index,
          entity.connector.type === 'rope' ? resolvedFirst : linkFirst,
          entity.connector.type === 'rope' ? resolvedSecond : linkSecond,
          entity.connector.type === 'rope' ? 'segment' : 'distributed',
        )
      }
    }
  }

  private connectorPolylinePoint(
    entity: ConnectorEntity,
    first: Vec2,
    second: Vec2,
    ratio: number,
    segmentCount: number,
  ): Vec2 {
    const base = {
      x: first.x + (second.x - first.x) * ratio,
      y: first.y + (second.y - first.y) * ratio,
    }
    if (entity.connector.type !== 'spring' || ratio <= 0 || ratio >= 1) return base
    const delta = { x: second.x - first.x, y: second.y - first.y }
    const length = Math.hypot(delta.x, delta.y)
    if (length <= Number.EPSILON) return base
    const index = Math.round(ratio * segmentCount)
    const amplitude = Math.min(Math.max(entity.radiusM * 2, 0.05), length / 10)
    const sign = index % 2 === 0 ? -1 : 1
    return {
      x: base.x - (delta.y / length) * amplitude * sign,
      y: base.y + (delta.x / length) * amplitude * sign,
    }
  }

  private createMasslessConnectorCollision(
    entity: ConnectorEntity,
    first: ConnectorRuntimeEndpoint,
    second: ConnectorRuntimeEndpoint,
  ): void {
    const firstPosition = this.connectorEndpointState(first).position
    const secondPosition = this.connectorEndpointState(second).position
    const length = Math.hypot(
      secondPosition.x - firstPosition.x,
      secondPosition.y - firstPosition.y,
    )
    const requested =
      entity.connector.type === 'spring'
        ? Math.max(4, Math.ceil(length / Math.max(entity.radiusM * 3, 0.2)))
        : entity.connector.type === 'rope'
          ? Math.max(4, Math.ceil(length / Math.max(entity.radiusM * 4, 0.1)))
          : 1
    const segmentCount = this.allocateConnectorSegments(entity, requested)
    const ropeShape: MasslessRopeShapeRecord | null =
      entity.connector.type === 'rope' && segmentCount > 1
        ? {
            entity,
            first,
            second,
            points: Array.from({ length: segmentCount + 1 }, (_, index) => {
              const ratio = index / segmentCount
              return {
                x: firstPosition.x + (secondPosition.x - firstPosition.x) * ratio,
                y: firstPosition.y + (secondPosition.y - firstPosition.y) * ratio,
              }
            }),
            maximumLinkLength: entity.connector.maxLength / segmentCount,
          }
        : null
    if (ropeShape) this.masslessRopeShapes.set(entity.id, ropeShape)
    for (let index = 0; index < segmentCount; index += 1) {
      const startRatio = index / segmentCount
      const endRatio = (index + 1) / segmentCount
      const start =
        ropeShape?.points[index] ??
        this.connectorPolylinePoint(entity, firstPosition, secondPosition, startRatio, segmentCount)
      const end =
        ropeShape?.points[index + 1] ??
        this.connectorPolylinePoint(entity, firstPosition, secondPosition, endRatio, segmentCount)
      this.createConnectorCollisionSegment(
        entity,
        first,
        second,
        start,
        end,
        startRatio,
        endRatio,
        ropeShape,
        index,
      )
    }
  }

  private createConnectorCollisionSegment(
    entity: ConnectorEntity,
    first: ConnectorRuntimeEndpoint,
    second: ConnectorRuntimeEndpoint,
    start: Vec2,
    end: Vec2,
    startRatio: number,
    endRatio: number,
    ropeShape: MasslessRopeShapeRecord | null,
    segmentIndex: number,
    responseFirst = first,
    responseSecond = second,
    responseMode: ConnectorCollisionSegmentRecord['responseMode'] = 'distributed',
  ): void {
    const record = {
      entity,
      first,
      second,
      responseFirst,
      responseSecond,
      startRatio,
      endRatio,
      previousStart: start,
      previousEnd: end,
      ropeShape,
      segmentIndex,
      responseMode,
    }
    this.connectorCollisionSegments.push(record)
    const segments = this.connectorCollisionSegmentsByEntity.get(entity.id) ?? []
    segments.push(record)
    this.connectorCollisionSegmentsByEntity.set(entity.id, segments)
  }

  private solveMasslessRopeShape(shape: MasslessRopeShapeRecord): void {
    const lastIndex = shape.points.length - 1
    for (let iteration = 0; iteration < FLEXIBLE_POSITION_ITERATIONS; iteration += 1) {
      let maximumError = 0
      const reverse = iteration % 2 === 1
      for (let offset = 0; offset < lastIndex; offset += 1) {
        const index = reverse ? lastIndex - 1 - offset : offset
        const first = shape.points[index]!
        const second = shape.points[index + 1]!
        const delta = { x: second.x - first.x, y: second.y - first.y }
        const distance = Math.hypot(delta.x, delta.y)
        const error = distance - shape.maximumLinkLength
        if (error <= FLEXIBLE_POSITION_TOLERANCE_M || distance <= Number.EPSILON) continue
        maximumError = Math.max(maximumError, error)
        const firstWeight = index === 0 ? 0 : 1
        const secondWeight = index + 1 === lastIndex ? 0 : 1
        const totalWeight = firstWeight + secondWeight
        if (totalWeight === 0) continue
        const correctionX = (delta.x / distance) * error
        const correctionY = (delta.y / distance) * error
        if (firstWeight > 0) {
          first.x += (correctionX * firstWeight) / totalWeight
          first.y += (correctionY * firstWeight) / totalWeight
        }
        if (secondWeight > 0) {
          second.x -= (correctionX * secondWeight) / totalWeight
          second.y -= (correctionY * secondWeight) / totalWeight
        }
      }
      if (maximumError <= FLEXIBLE_POSITION_TOLERANCE_M) break
    }
  }

  private updateMasslessRopeShapes(): void {
    for (const shape of this.masslessRopeShapes.values()) {
      const previousFirst = shape.points[0]!
      const previousSecond = shape.points.at(-1)!
      const first = this.connectorEndpointState(shape.first).position
      const second = this.connectorEndpointState(shape.second).position
      const firstDelta = { x: first.x - previousFirst.x, y: first.y - previousFirst.y }
      const secondDelta = { x: second.x - previousSecond.x, y: second.y - previousSecond.y }
      const lastIndex = shape.points.length - 1
      for (let index = 1; index < lastIndex; index += 1) {
        const ratio = index / lastIndex
        const point = shape.points[index]!
        point.x += firstDelta.x * (1 - ratio) + secondDelta.x * ratio
        point.y += firstDelta.y * (1 - ratio) + secondDelta.y * ratio
      }
      shape.points[0] = { ...first }
      shape.points[lastIndex] = { ...second }
      this.solveMasslessRopeShape(shape)
    }
  }

  private masslessConnectorSegmentPoints(record: ConnectorCollisionSegmentRecord): {
    start: Vec2
    end: Vec2
  } {
    if (record.ropeShape) {
      return {
        start: record.ropeShape.points[record.segmentIndex]!,
        end: record.ropeShape.points[record.segmentIndex + 1]!,
      }
    }
    const first = this.connectorEndpointState(record.first).position
    const second = this.connectorEndpointState(record.second).position
    const segmentCount = Math.max(1, Math.round(1 / (record.endRatio - record.startRatio)))
    return {
      start: this.connectorPolylinePoint(
        record.entity,
        first,
        second,
        record.startRatio,
        segmentCount,
      ),
      end: this.connectorPolylinePoint(record.entity, first, second, record.endRatio, segmentCount),
    }
  }

  private updateMasslessConnectorColliders(): void {
    this.updateMasslessRopeShapes()
    for (const connector of this.flexibleConnectors) {
      for (let index = 0; index < connector.nodes.length; index += 1) {
        connector.previousNodePositions[index] = {
          ...this.connectorEndpointState(connector.nodes[index]!).position,
        }
      }
    }
    for (const record of this.connectorCollisionSegments) {
      const { start, end } = this.masslessConnectorSegmentPoints(record)
      record.previousStart = start
      record.previousEnd = end
    }
  }

  private bodyCollisionShape(entity: BodyEntity): RAPIER.Shape | null {
    if (entity.shape.type === 'circle') {
      return entity.shape.collisionEnabled ? new RAPIER.Ball(entity.shape.radius) : null
    }
    return entity.shape.type === 'box'
      ? new RAPIER.Cuboid(entity.shape.width / 2, entity.shape.height / 2)
      : null
  }

  private bodyCollisionShapes(record: DynamicBodyRecord): RAPIER.Shape[] {
    if (record.booleanResult) {
      return this.activeBodyColliders(record).map((collider) => collider.shape)
    }
    const shape = this.bodyCollisionShape(record.entity)
    return shape ? [shape] : []
  }

  private bodySupportRadius(
    entity: BodyEntity,
    angleRad: number,
    direction: Vec2,
    booleanResult: ResolvedBooleanBody | null = null,
  ): number {
    if (booleanResult) {
      const cosine = Math.cos(angleRad)
      const sine = Math.sin(angleRad)
      const localDirection = {
        x: cosine * direction.x + sine * direction.y,
        y: -sine * direction.x + cosine * direction.y,
      }
      return Math.max(
        0,
        ...booleanResult.convexParts.flatMap((part) =>
          part.localPoints.map((point) => point.x * localDirection.x + point.y * localDirection.y),
        ),
      )
    }
    if (entity.shape.type === 'circle') return entity.shape.radius
    const cosine = Math.cos(angleRad)
    const sine = Math.sin(angleRad)
    const localDirection = {
      x: cosine * direction.x + sine * direction.y,
      y: -sine * direction.x + cosine * direction.y,
    }
    if (entity.shape.type === 'bezierPath') {
      return Math.max(
        0,
        ...sampleAdaptiveClosedBezierPath(entity.shape.nodes).map(
          (point) => point.x * localDirection.x + point.y * localDirection.y,
        ),
      )
    }
    return (
      Math.abs(localDirection.x) * (entity.shape.width / 2) +
      Math.abs(localDirection.y) * (entity.shape.height / 2)
    )
  }

  private connectorBodyContactAt(
    record: ConnectorCollisionSegmentRecord,
    body: DynamicBodyRecord,
    previousBody: PreviousBodyState,
    currentStart: Vec2,
    currentEnd: Vec2,
    timeRatio: number,
    predictionDistance = CONNECTOR_CONTACT_TOLERANCE_M,
    previousStart = record.previousStart,
    previousEnd = record.previousEnd,
  ): ConnectorBodyContactGeometry | null {
    const start = interpolateVector(previousStart, currentStart, timeRatio)
    const end = interpolateVector(previousEnd, currentEnd, timeRatio)
    const currentBodyPosition = body.rigidBody.translation()
    const bodyPosition = interpolateVector(previousBody.position, currentBodyPosition, timeRatio)
    if (body.entity.shape.type === 'circle') {
      if (!body.entity.shape.collisionEnabled) return null
      const localRatio = closestSegmentRatio(start, end, bodyPosition)
      const closestPoint = interpolateVector(start, end, localRatio)
      const offset = {
        x: bodyPosition.x - closestPoint.x,
        y: bodyPosition.y - closestPoint.y,
      }
      const distance = Math.hypot(offset.x, offset.y)
      const separation = distance - record.entity.radiusM - body.entity.shape.radius
      if (separation > predictionDistance) {
        return null
      }
      if (distance > Number.EPSILON) {
        return {
          normal: { x: offset.x / distance, y: offset.y / distance },
          centerlinePoint: closestPoint,
          separation,
        }
      }
      const tangent = { x: end.x - start.x, y: end.y - start.y }
      const tangentLength = Math.hypot(tangent.x, tangent.y)
      return {
        normal:
          tangentLength > Number.EPSILON
            ? { x: -tangent.y / tangentLength, y: tangent.x / tangentLength }
            : { x: 0, y: 1 },
        centerlinePoint: closestPoint,
        separation,
      }
    }
    const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
    const length = Math.hypot(end.x - start.x, end.y - start.y)
    const capsule = new RAPIER.Capsule(length / 2, record.entity.radiusM)
    const capsuleRotation = Math.atan2(end.y - start.y, end.x - start.x) - Math.PI / 2
    const currentBodyAngle = body.rigidBody.rotation()
    const bodyAngle =
      previousBody.angleRad +
      shortestAngleDelta(previousBody.angleRad, currentBodyAngle) * timeRatio
    const bodyShapes = this.bodyCollisionShapes(body)
    const contact = bodyShapes
      .map((bodyShape) =>
        capsule.contactShape(
          center,
          capsuleRotation,
          bodyShape,
          bodyPosition,
          bodyAngle,
          predictionDistance,
        ),
      )
      .filter((candidate): candidate is RAPIER.ShapeContact => Boolean(candidate))
      .sort((first, second) => first.distance - second.distance)[0]
    if (!contact || contact.distance > predictionDistance) return null
    const magnitude = Math.hypot(contact.normal1.x, contact.normal1.y)
    if (magnitude <= Number.EPSILON) return null
    const normal = { x: contact.normal1.x / magnitude, y: contact.normal1.y / magnitude }
    return {
      normal,
      centerlinePoint: {
        x: contact.point1.x - normal.x * record.entity.radiusM,
        y: contact.point1.y - normal.y * record.entity.radiusM,
      },
      separation: contact.distance,
    }
  }

  private sweptConnectorBodyContact(
    record: ConnectorCollisionSegmentRecord,
    bodyId: EntityId,
    body: DynamicBodyRecord,
    previousBody: PreviousBodyState,
    constraintProjectionStart?: { start: Vec2; end: Vec2 },
  ): ConnectorBodyContactCandidate | null {
    const previousStart = constraintProjectionStart?.start ?? record.previousStart
    const previousEnd = constraintProjectionStart?.end ?? record.previousEnd
    const source = constraintProjectionStart ? 'constraintProjection' : 'physicalSweep'
    const { start: currentStart, end: currentEnd } = this.masslessConnectorSegmentPoints(record)
    const makeCandidate = (
      timeRatio: number,
      geometry: ConnectorBodyContactGeometry,
      sweptImpact: boolean,
    ): ConnectorBodyContactCandidate => {
      const candidate: ConnectorBodyContactCandidate = {
        key: `${record.entity.id}:${record.segmentIndex}:${bodyId}`,
        record,
        body,
        bodyId,
        timeRatio,
        normal: geometry.normal,
        centerlinePoint: geometry.centerlinePoint,
        separation: geometry.separation,
        previousBody,
        referenceNormal: { ...geometry.normal },
        source,
        isNew: true,
        sweptImpact: sweptImpact || source === 'constraintProjection',
        impactNormalSpeed: 0,
        accumulatedPositionLambda: 0,
        accumulatedNormalImpulse: 0,
        accumulatedFrictionImpulse: 0,
      }
      candidate.impactNormalSpeed = this.connectorBodyRelativeSpeed(candidate, geometry.normal)
      return candidate
    }
    const bodyPosition = body.rigidBody.translation()
    const connectorTravel = Math.max(
      Math.hypot(currentStart.x - previousStart.x, currentStart.y - previousStart.y),
      Math.hypot(currentEnd.x - previousEnd.x, currentEnd.y - previousEnd.y),
    )
    const bodyTravel = Math.hypot(
      bodyPosition.x - previousBody.position.x,
      bodyPosition.y - previousBody.position.y,
    )
    const bodyFeature =
      body.entity.shape.type === 'circle'
        ? body.entity.shape.radius
        : body.entity.shape.type === 'box'
          ? Math.min(body.entity.shape.width, body.entity.shape.height) / 2
          : body.boundingRadius
    const sweepSpacing = Math.max(0.002, Math.min(record.entity.radiusM, bodyFeature) * 0.5)
    if (connectorTravel + bodyTravel <= sweepSpacing) {
      const currentContact = this.connectorBodyContactAt(
        record,
        body,
        previousBody,
        currentStart,
        currentEnd,
        1,
        CONNECTOR_CONTACT_TOLERANCE_M,
        previousStart,
        previousEnd,
      )
      return currentContact ? makeCandidate(1, currentContact, false) : null
    }
    const subdivisions = Math.min(
      512,
      Math.max(1, Math.ceil((connectorTravel + bodyTravel) / sweepSpacing)),
    )
    let previousTime = 0
    const initialContact = this.connectorBodyContactAt(
      record,
      body,
      previousBody,
      currentStart,
      currentEnd,
      0,
      CONNECTOR_CONTACT_TOLERANCE_M,
      previousStart,
      previousEnd,
    )
    if (initialContact) {
      return makeCandidate(0, initialContact, false)
    }
    for (let index = 1; index <= subdivisions; index += 1) {
      const timeRatio = index / subdivisions
      const currentContact = this.connectorBodyContactAt(
        record,
        body,
        previousBody,
        currentStart,
        currentEnd,
        timeRatio,
        CONNECTOR_CONTACT_TOLERANCE_M,
        previousStart,
        previousEnd,
      )
      if (currentContact) {
        let lower = previousTime
        let upper = timeRatio
        let geometry = currentContact
        for (let iteration = 0; iteration < CONNECTOR_CCD_BISECTION_ITERATIONS; iteration += 1) {
          const middle = (lower + upper) / 2
          const middleContact = this.connectorBodyContactAt(
            record,
            body,
            previousBody,
            currentStart,
            currentEnd,
            middle,
            CONNECTOR_CONTACT_TOLERANCE_M,
            previousStart,
            previousEnd,
          )
          if (middleContact) {
            upper = middle
            geometry = middleContact
          } else {
            lower = middle
          }
        }
        return makeCandidate(upper, geometry, true)
      }
      previousTime = timeRatio
    }
    return null
  }

  private bodyDirectionalInverseMassAtPoint(
    body: DynamicBodyRecord,
    point: Vec2,
    direction: Vec2,
  ): number {
    return this.bodyCrossInverseMassAtPoint(body, point, direction, direction)
  }

  private bodyCrossInverseMassAtPoint(
    body: DynamicBodyRecord,
    point: Vec2,
    responseDirection: Vec2,
    measuredDirection: Vec2,
  ): number {
    const inverseMass = body.rigidBody.effectiveInvMass()
    const translational =
      responseDirection.x * measuredDirection.x * inverseMass.x +
      responseDirection.y * measuredDirection.y * inverseMass.y
    if (!body.entity.rotationEnabled) return translational
    const center = body.rigidBody.translation()
    const offset = { x: point.x - center.x, y: point.y - center.y }
    const responseLeverArm = offset.x * responseDirection.y - offset.y * responseDirection.x
    const measuredLeverArm = offset.x * measuredDirection.y - offset.y * measuredDirection.x
    const inertia = body.rigidBody.effectiveAngularInertia()
    return (
      translational +
      (inertia > Number.EPSILON ? (responseLeverArm * measuredLeverArm) / inertia : 0)
    )
  }

  private applyBodyPositionMultiplier(
    body: DynamicBodyRecord,
    point: Vec2,
    gradient: Vec2,
    multiplier: number,
  ): void {
    const inverseMass = body.rigidBody.effectiveInvMass()
    const translation = body.rigidBody.translation()
    body.rigidBody.setTranslation(
      {
        x: translation.x + gradient.x * multiplier * inverseMass.x,
        y: translation.y + gradient.y * multiplier * inverseMass.y,
      },
      true,
    )
    if (!body.entity.rotationEnabled) return
    const inertia = body.rigidBody.effectiveAngularInertia()
    if (inertia <= Number.EPSILON) return
    const offset = { x: point.x - translation.x, y: point.y - translation.y }
    const leverArm = offset.x * gradient.y - offset.y * gradient.x
    body.rigidBody.setRotation(body.rigidBody.rotation() + (leverArm * multiplier) / inertia, true)
  }

  private flexibleRopeCanBendAtContact(entityId: EntityId): boolean {
    const record = this.flexibleConnectorsById.get(entityId)
    if (!record || record.kind !== 'rope') return false
    const chain = this.flexibleChain(record)
    const first = chain[0]!
    const last = chain.at(-1)!
    if (!first.fixed || !last.fixed) return true
    const firstPosition = this.connectorEndpointState(first).position
    const lastPosition = this.connectorEndpointState(last).position
    const endpointDistance = Math.hypot(
      lastPosition.x - firstPosition.x,
      lastPosition.y - firstPosition.y,
    )
    const maximumLength = record.linkLength * (chain.length - 1)
    return endpointDistance < maximumLength - this.flexibleRopeLengthTolerance(record)
  }

  private connectorResponseRatio(
    record: ConnectorCollisionSegmentRecord,
    localRatio: number,
  ): number {
    if (record.responseMode !== 'segment') {
      return record.startRatio + (record.endRatio - record.startRatio) * localRatio
    }
    const segmentCount = this.connectorCollisionSegmentsByEntity.get(record.entity.id)?.length ?? 1
    return Math.min(1, Math.max(0, (record.segmentIndex + localRatio) / segmentCount))
  }

  private refreshConnectorBodyContactCandidate(
    candidate: ConnectorBodyContactCandidate,
    predictionDistance = CONNECTOR_CONTACT_RELEASE_GAP_M,
  ): boolean {
    const { start, end } = this.masslessConnectorSegmentPoints(candidate.record)
    let geometry = this.connectorBodyContactAt(
      candidate.record,
      candidate.body,
      candidate.previousBody,
      start,
      end,
      1,
      predictionDistance,
    )
    const usesStableRopeSide =
      candidate.record.entity.connector.type === 'rope' && candidate.record.entity.massKg > 0
    if (!usesStableRopeSide) {
      if (!geometry) return false
      candidate.referenceNormal = { ...geometry.normal }
      candidate.timeRatio = 1
      candidate.normal = geometry.normal
      candidate.centerlinePoint = geometry.centerlinePoint
      candidate.separation = geometry.separation
      return true
    }
    const stableSideGeometry = (): ConnectorBodyContactGeometry | null => {
      const bodyPosition = candidate.body.rigidBody.translation()
      const supportRadius = this.bodySupportRadius(
        candidate.body.entity,
        candidate.body.rigidBody.rotation(),
        candidate.referenceNormal,
        candidate.body.booleanResult,
      )
      const signedDistanceFrom = (point: Vec2) =>
        dotVectors(
          { x: bodyPosition.x - point.x, y: bodyPosition.y - point.y },
          candidate.referenceNormal,
        )
      const startDistance = signedDistanceFrom(start)
      const endDistance = signedDistanceFrom(end)
      const useSegmentSupportPlane = candidate.body.entity.shape.type === 'box'
      const centerlinePoint = useSegmentSupportPlane
        ? startDistance <= endDistance
          ? start
          : end
        : interpolateVector(start, end, closestSegmentRatio(start, end, bodyPosition))
      const signedCenterDistance = useSegmentSupportPlane
        ? Math.min(startDistance, endDistance)
        : signedDistanceFrom(centerlinePoint)
      const stableSeparation =
        signedCenterDistance - candidate.record.entity.radiusM - supportRadius
      if (stableSeparation > predictionDistance) return null
      return {
        normal: candidate.referenceNormal,
        centerlinePoint,
        separation: stableSeparation,
      }
    }
    if (!geometry) {
      if (!candidate.sweptImpact) return false
      geometry = stableSideGeometry()
      if (!geometry) return false
    } else if (
      dotVectors(candidate.referenceNormal, geometry.normal) < CONNECTOR_CONTACT_MERGE_NORMAL_DOT
    ) {
      if (!candidate.sweptImpact) return false
      geometry = stableSideGeometry()
      if (!geometry) return false
    } else {
      candidate.referenceNormal = { ...geometry.normal }
    }
    candidate.timeRatio = 1
    candidate.normal = geometry.normal
    candidate.centerlinePoint = geometry.centerlinePoint
    candidate.separation = geometry.separation
    return true
  }

  private connectorBodyRelativeSpeed(
    candidate: ConnectorBodyContactCandidate,
    direction: Vec2,
    useConstraintCoupledResponse = false,
  ): number {
    const { record, body } = candidate
    const { start, end } = this.masslessConnectorSegmentPoints(record)
    const bodyPosition = body.rigidBody.translation()
    const localRatio = closestSegmentRatio(start, end, bodyPosition)
    const endpointRatio = this.connectorResponseRatio(record, localRatio)
    const useSegmentResponse =
      !useConstraintCoupledResponse &&
      record.responseMode === 'segment' &&
      this.flexibleRopeCanBendAtContact(record.entity.id)
    const first = useSegmentResponse ? record.first : record.responseFirst
    const second = useSegmentResponse ? record.second : record.responseSecond
    const ratio = useSegmentResponse ? localRatio : endpointRatio
    const supportRadius = this.bodySupportRadius(
      body.entity,
      body.rigidBody.rotation(),
      direction,
      body.booleanResult,
    )
    const bodyContactPoint = {
      x: bodyPosition.x - direction.x * supportRadius,
      y: bodyPosition.y - direction.y * supportRadius,
    }
    const firstState = this.connectorEndpointState(first)
    const secondState = this.connectorEndpointState(second)
    const connectorVelocity = {
      x: firstState.velocity.x * (1 - ratio) + secondState.velocity.x * ratio,
      y: firstState.velocity.y * (1 - ratio) + secondState.velocity.y * ratio,
    }
    const bodyLinearVelocity = body.rigidBody.linvel()
    const bodyAngularVelocity = body.entity.rotationEnabled ? body.rigidBody.angvel() : 0
    const bodyCenter = body.rigidBody.translation()
    const bodyOffset = {
      x: bodyContactPoint.x - bodyCenter.x,
      y: bodyContactPoint.y - bodyCenter.y,
    }
    const relativeVelocity = {
      x: bodyLinearVelocity.x - bodyAngularVelocity * bodyOffset.y - connectorVelocity.x,
      y: bodyLinearVelocity.y + bodyAngularVelocity * bodyOffset.x - connectorVelocity.y,
    }
    return dotVectors(relativeVelocity, direction)
  }

  private connectorBodyContactShouldSolve(candidate: ConnectorBodyContactCandidate): boolean {
    if (candidate.sweptImpact) return true
    if (candidate.separation < -FLEXIBLE_POSITION_TOLERANCE_M) return true
    return (
      this.connectorBodyRelativeSpeed(candidate, candidate.normal) <=
      CONNECTOR_CONTACT_SEPARATION_SPEED_MPS
    )
  }

  private projectConnectorBodyContact(candidate: ConnectorBodyContactCandidate): boolean {
    const preserveSweptSide = candidate.isNew && candidate.sweptImpact
    if (!preserveSweptSide && !this.refreshConnectorBodyContactCandidate(candidate)) {
      return false
    }
    const { record, body, normal } = candidate
    const { start, end } = this.masslessConnectorSegmentPoints(record)
    const bodyPosition = body.rigidBody.translation()
    const localRatio = closestSegmentRatio(
      start,
      end,
      body.entity.shape.type === 'box' ? candidate.centerlinePoint : bodyPosition,
    )
    const endpointRatio = this.connectorResponseRatio(record, localRatio)
    const useSegmentResponse =
      record.responseMode === 'segment' && this.flexibleRopeCanBendAtContact(record.entity.id)
    const first = useSegmentResponse ? record.first : record.responseFirst
    const second = useSegmentResponse ? record.second : record.responseSecond
    const ratio = useSegmentResponse ? localRatio : endpointRatio
    const centerlinePoint = interpolateVector(start, end, localRatio)
    const supportRadius = this.bodySupportRadius(
      body.entity,
      body.rigidBody.rotation(),
      normal,
      body.booleanResult,
    )
    const bodyContactPoint = {
      x: bodyPosition.x - normal.x * supportRadius,
      y: bodyPosition.y - normal.y * supportRadius,
    }
    const signedCenterDistance = dotVectors(
      {
        x: bodyPosition.x - centerlinePoint.x,
        y: bodyPosition.y - centerlinePoint.y,
      },
      normal,
    )
    const positionError = preserveSweptSide
      ? Math.max(0, record.entity.radiusM + supportRadius - signedCenterDistance)
      : Math.max(0, -candidate.separation)
    const localFirstPositionState = this.connectorEndpointState(first)
    const localSecondPositionState = this.connectorEndpointState(second)
    const responseFirstPositionState = this.connectorEndpointState(record.responseFirst)
    const responseSecondPositionState = this.connectorEndpointState(record.responseSecond)
    const responsePositionInverseMass =
      (1 - endpointRatio) ** 2 *
        this.directionalInverseMassAtPoint(
          record.responseFirst,
          responseFirstPositionState.position,
          normal,
        ) +
      endpointRatio ** 2 *
        this.directionalInverseMassAtPoint(
          record.responseSecond,
          responseSecondPositionState.position,
          normal,
        )
    const bodyPositionInverseMass = this.bodyDirectionalInverseMassAtPoint(
      body,
      bodyContactPoint,
      normal,
    )
    const useConstraintCoupledPosition =
      useSegmentResponse &&
      candidate.accumulatedPositionLambda > Number.EPSILON &&
      bodyPositionInverseMass + Number.EPSILON >= responsePositionInverseMass
    const positionFirst = useConstraintCoupledPosition ? record.responseFirst : first
    const positionSecond = useConstraintCoupledPosition ? record.responseSecond : second
    const positionRatio = useConstraintCoupledPosition ? endpointRatio : ratio
    const firstPositionState = useConstraintCoupledPosition
      ? responseFirstPositionState
      : localFirstPositionState
    const secondPositionState = useConstraintCoupledPosition
      ? responseSecondPositionState
      : localSecondPositionState
    const connectorPositionInverseMass =
      (1 - positionRatio) ** 2 *
        this.directionalInverseMassAtPoint(positionFirst, firstPositionState.position, normal) +
      positionRatio ** 2 *
        this.directionalInverseMassAtPoint(positionSecond, secondPositionState.position, normal)
    const positionInverseMass = connectorPositionInverseMass + bodyPositionInverseMass
    let corrected = false
    if (positionError > FLEXIBLE_POSITION_TOLERANCE_M && positionInverseMass > Number.EPSILON) {
      const nextLambda = Math.max(
        0,
        candidate.accumulatedPositionLambda + positionError / positionInverseMass,
      )
      const multiplier = nextLambda - candidate.accumulatedPositionLambda
      candidate.accumulatedPositionLambda = nextLambda
      this.applyBodyPositionMultiplier(body, bodyContactPoint, normal, multiplier)
      this.applyConnectorPositionMultiplier(
        positionFirst,
        firstPositionState,
        scaleVector(normal, -(1 - positionRatio)),
        multiplier,
      )
      this.applyConnectorPositionMultiplier(
        positionSecond,
        secondPositionState,
        scaleVector(normal, -positionRatio),
        multiplier,
      )
      corrected = Math.abs(multiplier) > Number.EPSILON
    }
    candidate.centerlinePoint = centerlinePoint
    candidate.separation = -positionError
    candidate.timeRatio = 1
    return corrected
  }

  private solveConnectorBodyContactVelocity(
    candidate: ConnectorBodyContactCandidate,
    allowRestitution: boolean,
  ): boolean {
    if (!this.refreshConnectorBodyContactCandidate(candidate)) return false
    const { record, body, normal } = candidate
    const { start, end } = this.masslessConnectorSegmentPoints(record)
    const bodyPosition = body.rigidBody.translation()
    const localRatio = closestSegmentRatio(start, end, bodyPosition)
    const endpointRatio = this.connectorResponseRatio(record, localRatio)
    const useSegmentResponse =
      record.responseMode === 'segment' && this.flexibleRopeCanBendAtContact(record.entity.id)
    const first = useSegmentResponse ? record.first : record.responseFirst
    const second = useSegmentResponse ? record.second : record.responseSecond
    const ratio = useSegmentResponse ? localRatio : endpointRatio
    const centerlinePoint = interpolateVector(start, end, localRatio)
    const supportRadius = this.bodySupportRadius(
      body.entity,
      body.rigidBody.rotation(),
      normal,
      body.booleanResult,
    )
    const bodyContactPoint = {
      x: bodyPosition.x - normal.x * supportRadius,
      y: bodyPosition.y - normal.y * supportRadius,
    }
    const connectorContactPoint = {
      x: centerlinePoint.x + normal.x * record.entity.radiusM,
      y: centerlinePoint.y + normal.y * record.entity.radiusM,
    }
    const restitution =
      allowRestitution && candidate.isNew && candidate.source === 'physicalSweep'
        ? combinedMaterialRestitution(record.entity.material, body.entity.material)
        : 0
    const useConstraintCoupledRestitution = useSegmentResponse && restitution > Number.EPSILON
    const normalFirst = useConstraintCoupledRestitution ? record.responseFirst : first
    const normalSecond = useConstraintCoupledRestitution ? record.responseSecond : second
    const normalRatio = useConstraintCoupledRestitution ? endpointRatio : ratio
    const connectorVelocityInverseMass =
      (1 - normalRatio) ** 2 *
        this.directionalInverseMassAtPoint(normalFirst, connectorContactPoint, normal) +
      normalRatio ** 2 *
        this.directionalInverseMassAtPoint(normalSecond, connectorContactPoint, normal)
    const bodyVelocityInverseMass = this.bodyDirectionalInverseMassAtPoint(
      body,
      bodyContactPoint,
      normal,
    )
    const velocityInverseMass = connectorVelocityInverseMass + bodyVelocityInverseMass
    if (velocityInverseMass <= Number.EPSILON) return false
    const normalSpeed = this.connectorBodyRelativeSpeed(
      candidate,
      normal,
      useConstraintCoupledRestitution,
    )
    const targetNormalSpeed = -restitution * Math.min(0, candidate.impactNormalSpeed)
    const nextAccumulatedNormalImpulse = Math.max(
      0,
      candidate.accumulatedNormalImpulse + (targetNormalSpeed - normalSpeed) / velocityInverseMass,
    )
    const normalImpulseMagnitude = nextAccumulatedNormalImpulse - candidate.accumulatedNormalImpulse
    candidate.accumulatedNormalImpulse = nextAccumulatedNormalImpulse
    const corrected = Math.abs(normalImpulseMagnitude) > Number.EPSILON
    if (corrected) {
      const normalImpulse = scaleVector(normal, normalImpulseMagnitude)
      body.rigidBody.applyImpulseAtPoint(normalImpulse, bodyContactPoint, true)
      this.applyMasslessConnectorImpulse(
        record,
        scaleVector(normalImpulse, -1),
        connectorContactPoint,
        normalRatio,
        !useConstraintCoupledRestitution && useSegmentResponse,
      )
    }

    const friction = combinedPathFriction(record.entity.material, body.entity.material)
    if (friction <= Number.EPSILON) return corrected
    const tangent = { x: -normal.y, y: normal.x }
    const tangentSpeed = this.connectorBodyRelativeSpeed(candidate, tangent)
    const connectorTangentInverseMass =
      (1 - ratio) ** 2 * this.directionalInverseMassAtPoint(first, connectorContactPoint, tangent) +
      ratio ** 2 * this.directionalInverseMassAtPoint(second, connectorContactPoint, tangent)
    const bodyTangentInverseMass = this.bodyDirectionalInverseMassAtPoint(
      body,
      bodyContactPoint,
      tangent,
    )
    const tangentInverseMass = connectorTangentInverseMass + bodyTangentInverseMass
    if (tangentInverseMass <= Number.EPSILON || candidate.accumulatedNormalImpulse <= 0) {
      return corrected
    }
    const maximumFrictionImpulse = friction * candidate.accumulatedNormalImpulse
    const nextAccumulatedFrictionImpulse = Math.min(
      maximumFrictionImpulse,
      Math.max(
        -maximumFrictionImpulse,
        candidate.accumulatedFrictionImpulse - tangentSpeed / tangentInverseMass,
      ),
    )
    const tangentImpulseMagnitude =
      nextAccumulatedFrictionImpulse - candidate.accumulatedFrictionImpulse
    candidate.accumulatedFrictionImpulse = nextAccumulatedFrictionImpulse
    if (Math.abs(tangentImpulseMagnitude) <= Number.EPSILON) return corrected
    const tangentImpulse = scaleVector(tangent, tangentImpulseMagnitude)
    body.rigidBody.applyImpulseAtPoint(tangentImpulse, bodyContactPoint, true)
    this.applyMasslessConnectorImpulse(
      record,
      scaleVector(tangentImpulse, -1),
      connectorContactPoint,
      ratio,
      useSegmentResponse,
    )
    return true
  }

  private addFlexibleRopeBodyContact(candidate: ConnectorBodyContactCandidate): void {
    const contacts = this.activeFlexibleRopeBodyContacts.get(candidate.record.entity.id) ?? []
    const duplicate = contacts.find(
      (contact) =>
        contact.bodyId === candidate.bodyId &&
        Math.abs(contact.record.segmentIndex - candidate.record.segmentIndex) <= 1 &&
        Math.hypot(
          contact.centerlinePoint.x - candidate.centerlinePoint.x,
          contact.centerlinePoint.y - candidate.centerlinePoint.y,
        ) < CONNECTOR_CONTACT_MERGE_DISTANCE_M &&
        dotVectors(contact.normal, candidate.normal) >= CONNECTOR_CONTACT_MERGE_NORMAL_DOT,
    )
    if (duplicate) {
      if (candidate.timeRatio < duplicate.timeRatio) {
        duplicate.timeRatio = candidate.timeRatio
        duplicate.normal = candidate.normal
        duplicate.referenceNormal = { ...candidate.referenceNormal }
        duplicate.centerlinePoint = candidate.centerlinePoint
        duplicate.separation = candidate.separation
        duplicate.impactNormalSpeed = Math.min(
          duplicate.impactNormalSpeed,
          candidate.impactNormalSpeed,
        )
      }
      if (candidate.source === 'physicalSweep') duplicate.source = 'physicalSweep'
      duplicate.sweptImpact ||= candidate.sweptImpact
      this.retainedConnectorBodyContactKeys.add(duplicate.key)
      return
    }
    contacts.push(candidate)
    this.activeFlexibleRopeBodyContacts.set(candidate.record.entity.id, contacts)
    this.retainedConnectorBodyContactKeys.add(candidate.key)
  }

  private resolveConnectorBodyContacts(previousBodyStates: Map<EntityId, PreviousBodyState>): void {
    this.retainedConnectorBodyContactKeys.clear()
    for (const contacts of this.activeFlexibleRopeBodyContacts.values()) contacts.length = 0
    const bodyCandidates = this.connectorBodyBroadphaseCandidates
    bodyCandidates.length = 0
    for (const [bodyId, body] of this.dynamicBodies) {
      if (!body.collider) continue
      const previousBody = previousBodyStates.get(bodyId)
      if (!previousBody) continue
      const currentPosition = body.rigidBody.translation()
      const candidate = this.connectorBodyBroadphaseById.get(bodyId) ?? {
        bodyId,
        body,
        previousBody,
        minX: 0,
        maxX: 0,
        minY: 0,
        maxY: 0,
      }
      candidate.body = body
      candidate.previousBody = previousBody
      candidate.minX = Math.min(previousBody.position.x, currentPosition.x) - body.boundingRadius
      candidate.maxX = Math.max(previousBody.position.x, currentPosition.x) + body.boundingRadius
      candidate.minY = Math.min(previousBody.position.y, currentPosition.y) - body.boundingRadius
      candidate.maxY = Math.max(previousBody.position.y, currentPosition.y) + body.boundingRadius
      this.connectorBodyBroadphaseById.set(bodyId, candidate)
      bodyCandidates.push(candidate)
    }
    bodyCandidates.sort((first, second) => first.minX - second.minX)
    const earliestNonRopeContacts = new Map<string, ConnectorBodyContactCandidate>()
    for (const [entityId, segments] of this.connectorCollisionSegmentsByEntity) {
      let connectorMinX = Number.POSITIVE_INFINITY
      let connectorMaxX = Number.NEGATIVE_INFINITY
      let connectorMinY = Number.POSITIVE_INFINITY
      let connectorMaxY = Number.NEGATIVE_INFINITY
      for (const record of segments) {
        const { start, end } = this.masslessConnectorSegmentPoints(record)
        connectorMinX = Math.min(
          connectorMinX,
          record.previousStart.x,
          record.previousEnd.x,
          start.x,
          end.x,
        )
        connectorMaxX = Math.max(
          connectorMaxX,
          record.previousStart.x,
          record.previousEnd.x,
          start.x,
          end.x,
        )
        connectorMinY = Math.min(
          connectorMinY,
          record.previousStart.y,
          record.previousEnd.y,
          start.y,
          end.y,
        )
        connectorMaxY = Math.max(
          connectorMaxY,
          record.previousStart.y,
          record.previousEnd.y,
          start.y,
          end.y,
        )
      }
      const entity = segments[0]?.entity
      if (!entity) continue
      connectorMinX -= entity.radiusM
      connectorMaxX += entity.radiusM
      connectorMinY -= entity.radiusM
      connectorMaxY += entity.radiusM
      for (const candidateBody of bodyCandidates) {
        if (candidateBody.maxX < connectorMinX) continue
        if (candidateBody.minX > connectorMaxX) break
        const { bodyId, body, previousBody } = candidateBody
        if (
          (entity.a.type === 'body' && entity.a.bodyId === bodyId) ||
          (entity.b.type === 'body' && entity.b.bodyId === bodyId)
        ) {
          continue
        }
        if (connectorMaxY < candidateBody.minY || connectorMinY > candidateBody.maxY) {
          continue
        }
        for (const record of segments) {
          const { start, end } = this.masslessConnectorSegmentPoints(record)
          const segmentMinX =
            Math.min(record.previousStart.x, record.previousEnd.x, start.x, end.x) - entity.radiusM
          const segmentMaxX =
            Math.max(record.previousStart.x, record.previousEnd.x, start.x, end.x) + entity.radiusM
          const segmentMinY =
            Math.min(record.previousStart.y, record.previousEnd.y, start.y, end.y) - entity.radiusM
          const segmentMaxY =
            Math.max(record.previousStart.y, record.previousEnd.y, start.y, end.y) + entity.radiusM
          if (
            segmentMaxX < candidateBody.minX ||
            segmentMinX > candidateBody.maxX ||
            segmentMaxY < candidateBody.minY ||
            segmentMinY > candidateBody.maxY
          ) {
            continue
          }
          const manifoldKey = `${entityId}:${record.segmentIndex}:${bodyId}`
          const persistent = this.connectorBodyContactManifolds.get(manifoldKey)
          let candidate: ConnectorBodyContactCandidate | null = null
          if (persistent) {
            persistent.previousBody = previousBody
            persistent.accumulatedNormalImpulse = 0
            persistent.accumulatedFrictionImpulse = 0
            persistent.isNew = false
            persistent.sweptImpact = false
            persistent.source = 'persistent'
            persistent.impactNormalSpeed = 0
            persistent.accumulatedPositionLambda = 0
            if (this.refreshConnectorBodyContactCandidate(persistent)) {
              this.retainedConnectorBodyContactKeys.add(manifoldKey)
              if (this.connectorBodyContactShouldSolve(persistent)) candidate = persistent
              else continue
            }
          }
          candidate ??= this.sweptConnectorBodyContact(record, bodyId, body, previousBody)
          if (!candidate) continue
          if (entity.connector.type === 'rope' && entity.massKg > 0) {
            if (!this.connectorBodyContactShouldSolve(candidate)) continue
            this.connectorBodyContactManifolds.set(manifoldKey, candidate)
            this.addFlexibleRopeBodyContact(candidate)
            continue
          }
          const pairKey = `${entityId}:${bodyId}`
          const previous = earliestNonRopeContacts.get(pairKey)
          if (!previous || candidate.timeRatio < previous.timeRatio) {
            earliestNonRopeContacts.set(pairKey, candidate)
          }
        }
      }
    }
    for (const key of this.connectorBodyContactManifolds.keys()) {
      if (!this.retainedConnectorBodyContactKeys.has(key)) {
        this.connectorBodyContactManifolds.delete(key)
      }
    }
    const ordered = [...earliestNonRopeContacts.values()].sort(
      (first, second) => first.timeRatio - second.timeRatio,
    )
    for (const candidate of ordered) {
      this.projectConnectorBodyContact(candidate)
      this.solveConnectorBodyContactVelocity(candidate, true)
    }
    if (ordered.length > 0) this.updateMasslessRopeShapes()
  }

  private masslessConnectorPointRatio(
    record: ConnectorCollisionSegmentRecord,
    point: Vec2,
  ): number {
    const { start: first, end: second } = this.masslessConnectorSegmentPoints(record)
    const delta = { x: second.x - first.x, y: second.y - first.y }
    const lengthSquared = delta.x ** 2 + delta.y ** 2
    const localRatio =
      lengthSquared > Number.EPSILON
        ? Math.min(
            1,
            Math.max(
              0,
              ((point.x - first.x) * delta.x + (point.y - first.y) * delta.y) / lengthSquared,
            ),
          )
        : 0.5
    return record.startRatio + (record.endRatio - record.startRatio) * localRatio
  }

  private applyMasslessConnectorImpulse(
    record: ConnectorCollisionSegmentRecord,
    impulse: Vec2,
    point: Vec2,
    endpointRatio = this.masslessConnectorPointRatio(record, point),
    useGeometryEndpoints = false,
  ): void {
    const ratio = Math.min(1, Math.max(0, endpointRatio))
    const apply = (endpoint: ConnectorRuntimeEndpoint, weight: number) => {
      if (endpoint.fixed || weight <= Number.EPSILON) return
      const weightedImpulse = scaleVector(impulse, weight)
      endpoint.rigidBody.applyImpulseAtPoint(weightedImpulse, point, true)
      if (endpoint.body) {
        endpoint.body.constraintForce = addForce(endpoint.body.constraintForce, {
          x: (impulse.x * weight) / this.currentTimeStep,
          y: (impulse.y * weight) / this.currentTimeStep,
        })
      }
    }
    apply(useGeometryEndpoints ? record.first : record.responseFirst, 1 - ratio)
    apply(useGeometryEndpoints ? record.second : record.responseSecond, ratio)
  }

  private closestMasslessConnectorGroundCandidate(
    record: ConnectorCollisionSegmentRecord,
    ground: GroundColliderRecord,
    start: Vec2,
    end: Vec2,
    timeRatio: number,
  ): MasslessConnectorGroundCandidate {
    if (ground.linearEndpoints) {
      const ratios = closestSegmentPairRatios(
        start,
        end,
        ground.linearEndpoints.start,
        ground.linearEndpoints.end,
      )
      const centerPoint = interpolateVector(start, end, ratios.first)
      const contactPoint = interpolateVector(
        ground.linearEndpoints.start,
        ground.linearEndpoints.end,
        ratios.second,
      )
      const offset = {
        x: centerPoint.x - contactPoint.x,
        y: centerPoint.y - contactPoint.y,
      }
      return {
        timeRatio,
        centerPoint,
        contactPoint,
        pathNormal: ground.linearEndpoints.normal,
        signedDistance: dotVectors(offset, ground.linearEndpoints.normal),
        separation: Math.hypot(offset.x, offset.y) - record.entity.radiusM,
        endpointRatio: record.startRatio + (record.endRatio - record.startRatio) * ratios.first,
        material: ground.piece.material,
        ground,
      }
    }
    const delta = { x: end.x - start.x, y: end.y - start.y }
    const centerlineLength = Math.hypot(delta.x, delta.y)
    const subdivisions = Math.min(
      512,
      Math.max(2, Math.ceil(centerlineLength / Math.max(record.entity.radiusM * 0.5, 0.01))),
    )
    const evaluate = (localRatio: number) => {
      const centerPoint = {
        x: start.x + delta.x * localRatio,
        y: start.y + delta.y * localRatio,
      }
      return { localRatio, centerPoint, closest: ground.piece.path.closestPoint(centerPoint) }
    }

    let best = evaluate(0)
    let bestIndex = 0
    for (let index = 1; index <= subdivisions; index += 1) {
      const candidate = evaluate(index / subdivisions)
      if (
        candidate.closest.distance < best.closest.distance - 1e-9 ||
        (Math.abs(candidate.closest.distance - best.closest.distance) <= 1e-9 &&
          Math.abs(candidate.localRatio - 0.5) < Math.abs(best.localRatio - 0.5))
      ) {
        best = candidate
        bestIndex = index
      }
    }

    let lower = Math.max(0, (bestIndex - 1) / subdivisions)
    let upper = Math.min(1, (bestIndex + 1) / subdivisions)
    for (let iteration = 0; iteration < 14; iteration += 1) {
      const firstRatio = lower + (upper - lower) / 3
      const secondRatio = upper - (upper - lower) / 3
      const first = evaluate(firstRatio)
      const second = evaluate(secondRatio)
      if (first.closest.distance <= second.closest.distance) {
        upper = secondRatio
        if (first.closest.distance < best.closest.distance) best = first
      } else {
        lower = firstRatio
        if (second.closest.distance < best.closest.distance) best = second
      }
    }

    const endpointRatio =
      record.startRatio + (record.endRatio - record.startRatio) * best.localRatio
    return {
      timeRatio,
      centerPoint: best.centerPoint,
      contactPoint: best.closest.point,
      pathNormal: best.closest.normal,
      signedDistance: best.closest.signedDistance,
      separation: best.closest.distance - record.entity.radiusM,
      endpointRatio,
      material: ground.piece.material,
      ground,
    }
  }

  private sweptMasslessConnectorGroundCandidate(
    record: ConnectorCollisionSegmentRecord,
    ground: GroundColliderRecord,
    currentStart: Vec2,
    currentEnd: Vec2,
  ): MasslessConnectorGroundCandidate | null {
    const interpolate = (first: Vec2, second: Vec2, ratio: number): Vec2 => ({
      x: first.x + (second.x - first.x) * ratio,
      y: first.y + (second.y - first.y) * ratio,
    })
    const evaluate = (timeRatio: number) =>
      this.closestMasslessConnectorGroundCandidate(
        record,
        ground,
        interpolate(record.previousStart, currentStart, timeRatio),
        interpolate(record.previousEnd, currentEnd, timeRatio),
        timeRatio,
      )
    const startTravel = Math.hypot(
      currentStart.x - record.previousStart.x,
      currentStart.y - record.previousStart.y,
    )
    const endTravel = Math.hypot(
      currentEnd.x - record.previousEnd.x,
      currentEnd.y - record.previousEnd.y,
    )
    const maximumTravel = Math.max(startTravel, endTravel)
    const sweepSpacing = Math.max(record.entity.radiusM * 0.5, 0.005)
    if (ground.linearEndpoints) {
      const line = ground.linearEndpoints
      const lineDelta = { x: line.end.x - line.start.x, y: line.end.y - line.start.y }
      const lineLength = Math.hypot(lineDelta.x, lineDelta.y)
      const tangent =
        lineLength > Number.EPSILON
          ? { x: lineDelta.x / lineLength, y: lineDelta.y / lineLength }
          : { x: 1, y: 0 }
      const projection = (point: Vec2) =>
        (point.x - line.start.x) * tangent.x + (point.y - line.start.y) * tangent.y
      const staysInsideLine = [
        record.previousStart,
        record.previousEnd,
        currentStart,
        currentEnd,
      ].every((point) => {
        const along = projection(point)
        return along >= 0 && along <= lineLength
      })
      if (staysInsideLine) {
        const previous = evaluate(0)
        const current = evaluate(1)
        if (previous.separation <= 0) {
          if (current.separation <= 0) return current
          const previousSide = Math.sign(previous.signedDistance)
          const currentSide = Math.sign(current.signedDistance)
          return previousSide !== 0 && currentSide !== 0 && previousSide !== currentSide
            ? previous
            : null
        }
        const signedDistance = (point: Vec2) =>
          (point.x - line.start.x) * line.normal.x + (point.y - line.start.y) * line.normal.y
        const roots: number[] = []
        for (const [previousPoint, currentPoint] of [
          [record.previousStart, currentStart],
          [record.previousEnd, currentEnd],
        ] as const) {
          const startDistance = signedDistance(previousPoint)
          const distanceChange = signedDistance(currentPoint) - startDistance
          if (Math.abs(distanceChange) <= Number.EPSILON) continue
          for (const boundary of [-record.entity.radiusM, record.entity.radiusM]) {
            const timeRatio = (boundary - startDistance) / distanceChange
            if (timeRatio > 0 && timeRatio <= 1) roots.push(timeRatio)
          }
        }
        roots.sort((first, second) => first - second)
        for (const timeRatio of roots) {
          const candidate = evaluate(Math.min(1, timeRatio + 1e-9))
          if (candidate.separation <= CONNECTOR_CONTACT_TOLERANCE_M) return candidate
        }
        return current.separation <= 0 ? current : null
      }
    }
    if (maximumTravel <= sweepSpacing) {
      const current = evaluate(1)
      return current.separation <= 0 ? current : null
    }
    const subdivisions = Math.min(256, Math.max(1, Math.ceil(maximumTravel / sweepSpacing)))
    let previous = evaluate(0)
    if (previous.separation <= 0) {
      const current = evaluate(1)
      if (current.separation <= 0) return current
      const previousSide = Math.sign(previous.signedDistance)
      const currentSide = Math.sign(current.signedDistance)
      return previousSide !== 0 && currentSide !== 0 && previousSide !== currentSide
        ? previous
        : null
    }
    let deepestOverlap: MasslessConnectorGroundCandidate | null = null
    for (let index = 1; index <= subdivisions; index += 1) {
      const current = evaluate(index / subdivisions)
      if (current.separation <= 0) {
        if (previous.separation > 0) {
          let lower = previous.timeRatio
          let upper = current.timeRatio
          let contact = current
          for (let iteration = 0; iteration < CONNECTOR_CCD_BISECTION_ITERATIONS; iteration += 1) {
            const middle = (lower + upper) / 2
            const candidate = evaluate(middle)
            if (candidate.separation <= 0) {
              upper = middle
              contact = candidate
            } else {
              lower = middle
            }
          }
          return contact
        }
        if (!deepestOverlap || current.separation < deepestOverlap.separation) {
          deepestOverlap = current
        }
      }
      previous = current
    }
    return deepestOverlap
  }

  private projectConnectorGroundConstraint(
    constraint: ConnectorGroundPositionConstraint,
    localRatio = constraint.localRatio,
  ): boolean {
    const { record, ground } = constraint
    const { start, end } = this.masslessConnectorSegmentPoints(record)
    const center = {
      x: start.x + (end.x - start.x) * localRatio,
      y: start.y + (end.y - start.y) * localRatio,
    }
    let closestPoint: Vec2
    let closestNormal: Vec2
    if (ground.linearEndpoints) {
      const line = ground.linearEndpoints
      const delta = { x: line.end.x - line.start.x, y: line.end.y - line.start.y }
      const lengthSquared = delta.x ** 2 + delta.y ** 2
      const ratio =
        lengthSquared > Number.EPSILON
          ? Math.min(
              1,
              Math.max(
                0,
                ((center.x - line.start.x) * delta.x + (center.y - line.start.y) * delta.y) /
                  lengthSquared,
              ),
            )
          : 0
      closestPoint = {
        x: line.start.x + delta.x * ratio,
        y: line.start.y + delta.y * ratio,
      }
      closestNormal = line.normal
    } else {
      const closest = ground.piece.path.closestPoint(center)
      closestPoint = closest.point
      closestNormal = closest.normal
    }
    let reactionDirection = closestNormal
    if (dotVectors(reactionDirection, constraint.reactionDirection) < 0) {
      reactionDirection = scaleVector(reactionDirection, -1)
    }
    const normalDistance = dotVectors(
      { x: center.x - closestPoint.x, y: center.y - closestPoint.y },
      reactionDirection,
    )
    const positionError = record.entity.radiusM - normalDistance
    if (positionError <= FLEXIBLE_POSITION_TOLERANCE_M) return false

    const firstState = this.connectorEndpointState(record.first)
    const secondState = this.connectorEndpointState(record.second)
    const positionInverseMass =
      (1 - localRatio) ** 2 *
        this.directionalInverseMassAtPoint(record.first, firstState.position, reactionDirection) +
      localRatio ** 2 *
        this.directionalInverseMassAtPoint(record.second, secondState.position, reactionDirection)
    if (positionInverseMass <= Number.EPSILON) return false
    const multiplier = positionError / positionInverseMass
    this.applyConnectorPositionMultiplier(
      record.first,
      firstState,
      scaleVector(reactionDirection, 1 - localRatio),
      multiplier,
    )
    this.applyConnectorPositionMultiplier(
      record.second,
      secondState,
      scaleVector(reactionDirection, localRatio),
      multiplier,
    )
    return true
  }

  private projectConnectorGroundConstraints(
    constraints: ConnectorGroundPositionConstraint[],
    reverseOrder: boolean,
  ): boolean {
    let corrected = false
    let previous: ConnectorGroundPositionConstraint | null = null
    for (let offset = 0; offset < constraints.length; offset += 1) {
      const constraint = constraints[reverseOrder ? constraints.length - 1 - offset : offset]!
      const sharesNodeWithPrevious =
        previous !== null &&
        previous.record.entity.id === constraint.record.entity.id &&
        previous.ground.collider.handle === constraint.ground.collider.handle &&
        (reverseOrder
          ? previous.record.segmentIndex === constraint.record.segmentIndex + 1
          : previous.record.segmentIndex + 1 === constraint.record.segmentIndex)
      if (reverseOrder) {
        if (!sharesNodeWithPrevious) {
          corrected = this.projectConnectorGroundConstraint(constraint, 1) || corrected
        }
        corrected = this.projectConnectorGroundConstraint(constraint, 0) || corrected
      } else {
        if (!sharesNodeWithPrevious) {
          corrected = this.projectConnectorGroundConstraint(constraint, 0) || corrected
        }
        corrected = this.projectConnectorGroundConstraint(constraint, 1) || corrected
      }
      previous = constraint
    }
    return corrected
  }

  private connectorEndpointMatchesGround(
    endpoint: ConnectorRuntimeEndpoint,
    ground: GroundColliderRecord,
  ): boolean {
    if (endpoint.definition.type === 'ground') {
      return (
        ground.segment.kind === 'ground' && ground.ground.entity.id === endpoint.definition.groundId
      )
    }
    if (endpoint.definition.type === 'groundJoint') {
      return ground.segment.jointId === endpoint.definition.groundJointId
    }
    return false
  }

  private isConnectorGroundAnchorSelfContact(
    record: ConnectorCollisionSegmentRecord,
    candidate: MasslessConnectorGroundCandidate,
  ): boolean {
    if (record.entity.connector.type !== 'rope') return false
    const clearance = record.entity.radiusM + CONNECTOR_CONTACT_TOLERANCE_M
    for (const endpoint of [record.first, record.second]) {
      if (!this.connectorEndpointMatchesGround(endpoint, candidate.ground)) continue
      const anchor = this.connectorEndpointState(endpoint).position
      if (
        Math.hypot(candidate.contactPoint.x - anchor.x, candidate.contactPoint.y - anchor.y) <=
        clearance
      ) {
        return true
      }
    }
    return false
  }

  private resolveMasslessConnectorGroundContacts(): ConnectorGroundPositionConstraint[] {
    const constraints: ConnectorGroundPositionConstraint[] = []
    let correctedPosition = false
    for (let offset = 0; offset < this.connectorCollisionSegments.length; offset += 1) {
      const record = this.connectorCollisionSegments[offset]!
      const { start, end } = this.masslessConnectorSegmentPoints(record)
      const minX =
        Math.min(start.x, end.x, record.previousStart.x, record.previousEnd.x) -
        record.entity.radiusM
      const minY =
        Math.min(start.y, end.y, record.previousStart.y, record.previousEnd.y) -
        record.entity.radiusM
      const maxX =
        Math.max(start.x, end.x, record.previousStart.x, record.previousEnd.x) +
        record.entity.radiusM
      const maxY =
        Math.max(start.y, end.y, record.previousStart.y, record.previousEnd.y) +
        record.entity.radiusM
      let best: MasslessConnectorGroundCandidate | null = null

      for (const ground of this.groundsByCollider.values()) {
        if (maxX < ground.minX || minX > ground.maxX || maxY < ground.minY || minY > ground.maxY) {
          continue
        }
        const candidate = this.sweptMasslessConnectorGroundCandidate(record, ground, start, end)
        if (candidate && this.isConnectorGroundAnchorSelfContact(record, candidate)) continue
        if (
          candidate &&
          (!best ||
            candidate.timeRatio < best.timeRatio - 1e-9 ||
            (Math.abs(candidate.timeRatio - best.timeRatio) <= 1e-9 &&
              candidate.separation < best.separation))
        ) {
          best = candidate
        }
      }
      if (!best) continue
      const { centerPoint, contactPoint, separation } = best
      const localRatio = Math.min(
        1,
        Math.max(
          0,
          (best.endpointRatio - record.startRatio) /
            Math.max(record.endRatio - record.startRatio, Number.EPSILON),
        ),
      )
      const firstState = this.connectorEndpointState(record.first)
      const secondState = this.connectorEndpointState(record.second)
      const velocity = {
        x: firstState.velocity.x * (1 - localRatio) + secondState.velocity.x * localRatio,
        y: firstState.velocity.y * (1 - localRatio) + secondState.velocity.y * localRatio,
      }
      const centerToGround = {
        x: contactPoint.x - centerPoint.x,
        y: contactPoint.y - centerPoint.y,
      }
      const centerDistance = Math.hypot(centerToGround.x, centerToGround.y)
      let reactionDirection: Vec2
      if (centerDistance > 1e-9) {
        reactionDirection = {
          x: -centerToGround.x / centerDistance,
          y: -centerToGround.y / centerDistance,
        }
      } else {
        const previousCenter = {
          x: record.previousStart.x + (record.previousEnd.x - record.previousStart.x) * localRatio,
          y: record.previousStart.y + (record.previousEnd.y - record.previousStart.y) * localRatio,
        }
        const previousSide = Math.sign(
          (previousCenter.x - contactPoint.x) * best.pathNormal.x +
            (previousCenter.y - contactPoint.y) * best.pathNormal.y,
        )
        const velocitySide = Math.sign(
          velocity.x * best.pathNormal.x + velocity.y * best.pathNormal.y,
        )
        const side = previousSide || (velocitySide <= 0 ? 1 : -1)
        reactionDirection = scaleVector(best.pathNormal, side)
      }
      const approachSpeed = -(velocity.x * reactionDirection.x + velocity.y * reactionDirection.y)
      const positionConstraint: ConnectorGroundPositionConstraint = {
        record,
        ground: best.ground,
        localRatio,
        reactionDirection,
        contactPoint,
        material: best.material,
        impactNormalSpeed: -approachSpeed,
        accumulatedNormalImpulse: 0,
        accumulatedFrictionImpulse: 0,
      }
      constraints.push(positionConstraint)
      if (record.entity.connector.type === 'rope' && record.entity.massKg > 0) continue
      const effectiveInverseMass =
        (1 - localRatio) ** 2 *
          this.directionalInverseMassAtPoint(record.first, contactPoint, reactionDirection) +
        localRatio ** 2 *
          this.directionalInverseMassAtPoint(record.second, contactPoint, reactionDirection)
      if (effectiveInverseMass <= Number.EPSILON) continue
      const restitution = combinedMaterialRestitution(record.entity.material, best.material)
      const penetrationBias =
        separation < 0 ? Math.min(2, (-separation * 0.2) / this.currentTimeStep) : 0
      const targetSpeed = Math.max(0, approachSpeed * (1 + restitution) + penetrationBias)
      correctedPosition =
        this.projectConnectorGroundConstraint(positionConstraint) || correctedPosition
      if (targetSpeed <= Number.EPSILON) continue
      const normalImpulseMagnitude = targetSpeed / effectiveInverseMass
      this.applyMasslessConnectorImpulse(
        record,
        scaleVector(reactionDirection, normalImpulseMagnitude),
        contactPoint,
        localRatio,
        true,
      )
      const friction = combinedPathFriction(record.entity.material, best.material)
      if (friction <= Number.EPSILON) continue
      const tangent = { x: -reactionDirection.y, y: reactionDirection.x }
      const tangentSpeed = velocity.x * tangent.x + velocity.y * tangent.y
      const tangentInverseMass =
        (1 - localRatio) ** 2 *
          this.directionalInverseMassAtPoint(record.first, contactPoint, tangent) +
        localRatio ** 2 * this.directionalInverseMassAtPoint(record.second, contactPoint, tangent)
      if (tangentInverseMass <= Number.EPSILON) continue
      const maximumFrictionImpulse = friction * Math.abs(normalImpulseMagnitude)
      const frictionImpulse = Math.min(
        maximumFrictionImpulse,
        Math.max(-maximumFrictionImpulse, -tangentSpeed / tangentInverseMass),
      )
      this.applyMasslessConnectorImpulse(
        record,
        scaleVector(tangent, frictionImpulse),
        contactPoint,
        localRatio,
        true,
      )
    }
    if (correctedPosition) this.updateMasslessRopeShapes()
    return constraints
  }

  private solveFlexibleRopeGroundContactVelocity(
    constraint: ConnectorGroundPositionConstraint,
    allowRestitution: boolean,
  ): boolean {
    const { record, localRatio, reactionDirection, contactPoint } = constraint
    const firstState = this.connectorEndpointState(record.first)
    const secondState = this.connectorEndpointState(record.second)
    const velocity = {
      x: firstState.velocity.x * (1 - localRatio) + secondState.velocity.x * localRatio,
      y: firstState.velocity.y * (1 - localRatio) + secondState.velocity.y * localRatio,
    }
    const normalSpeed = dotVectors(velocity, reactionDirection)
    const inverseMass =
      (1 - localRatio) ** 2 *
        this.directionalInverseMassAtPoint(record.first, contactPoint, reactionDirection) +
      localRatio ** 2 *
        this.directionalInverseMassAtPoint(record.second, contactPoint, reactionDirection)
    if (inverseMass <= Number.EPSILON) return false
    const restitution = allowRestitution
      ? combinedMaterialRestitution(record.entity.material, constraint.material)
      : 0
    const targetNormalSpeed = -restitution * Math.min(0, constraint.impactNormalSpeed)
    const nextNormalImpulse = Math.max(
      0,
      constraint.accumulatedNormalImpulse + (targetNormalSpeed - normalSpeed) / inverseMass,
    )
    const normalImpulseMagnitude = nextNormalImpulse - constraint.accumulatedNormalImpulse
    constraint.accumulatedNormalImpulse = nextNormalImpulse
    let corrected = false
    if (Math.abs(normalImpulseMagnitude) > Number.EPSILON) {
      this.applyMasslessConnectorImpulse(
        record,
        scaleVector(reactionDirection, normalImpulseMagnitude),
        contactPoint,
        localRatio,
        true,
      )
      corrected = true
    }

    const friction = combinedPathFriction(record.entity.material, constraint.material)
    if (friction <= Number.EPSILON || constraint.accumulatedNormalImpulse <= 0) return corrected
    const tangent = { x: -reactionDirection.y, y: reactionDirection.x }
    const tangentSpeed = dotVectors(velocity, tangent)
    const tangentInverseMass =
      (1 - localRatio) ** 2 *
        this.directionalInverseMassAtPoint(record.first, contactPoint, tangent) +
      localRatio ** 2 * this.directionalInverseMassAtPoint(record.second, contactPoint, tangent)
    if (tangentInverseMass <= Number.EPSILON) return corrected
    const maximumFrictionImpulse = friction * constraint.accumulatedNormalImpulse
    const nextFrictionImpulse = Math.min(
      maximumFrictionImpulse,
      Math.max(
        -maximumFrictionImpulse,
        constraint.accumulatedFrictionImpulse - tangentSpeed / tangentInverseMass,
      ),
    )
    const frictionImpulseMagnitude = nextFrictionImpulse - constraint.accumulatedFrictionImpulse
    constraint.accumulatedFrictionImpulse = nextFrictionImpulse
    if (Math.abs(frictionImpulseMagnitude) <= Number.EPSILON) return corrected
    this.applyMasslessConnectorImpulse(
      record,
      scaleVector(tangent, frictionImpulseMagnitude),
      contactPoint,
      localRatio,
      true,
    )
    return true
  }

  private flexibleRopeMaximumRelativeTravel(
    record: FlexibleConnectorRecord,
    contacts: ConnectorBodyContactCandidate[],
  ): number {
    let maximumTravel = 0
    const segments = this.connectorCollisionSegmentsByEntity.get(record.entity.id) ?? []
    for (const segment of segments) {
      const { start, end } = this.masslessConnectorSegmentPoints(segment)
      maximumTravel = Math.max(
        maximumTravel,
        Math.hypot(start.x - segment.previousStart.x, start.y - segment.previousStart.y),
        Math.hypot(end.x - segment.previousEnd.x, end.y - segment.previousEnd.y),
      )
    }
    for (const contact of contacts) {
      const current = contact.body.rigidBody.translation()
      maximumTravel = Math.max(
        maximumTravel,
        Math.hypot(
          current.x - contact.previousBody.position.x,
          current.y - contact.previousBody.position.y,
        ),
      )
    }
    return maximumTravel
  }

  private captureFlexibleRopeConstraintProjectionSegments(record: FlexibleConnectorRecord): void {
    const segments = this.connectorCollisionSegmentsByEntity.get(record.entity.id) ?? []
    while (record.constraintProjectionSegments.length < segments.length) {
      record.constraintProjectionSegments.push({
        start: { x: 0, y: 0 },
        end: { x: 0, y: 0 },
      })
    }
    for (let index = 0; index < segments.length; index += 1) {
      const points = this.masslessConnectorSegmentPoints(segments[index]!)
      const snapshot = record.constraintProjectionSegments[index]!
      snapshot.start.x = points.start.x
      snapshot.start.y = points.start.y
      snapshot.end.x = points.end.x
      snapshot.end.y = points.end.y
    }
  }

  private refreshFlexibleRopeContactsAfterLengthProjection(record: FlexibleConnectorRecord): void {
    const segments = this.connectorCollisionSegmentsByEntity.get(record.entity.id) ?? []
    let contacts = this.activeFlexibleRopeBodyContacts.get(record.entity.id) ?? []
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex]!
      const snapshot = record.constraintProjectionSegments[segmentIndex]
      if (!snapshot) continue
      const current = this.masslessConnectorSegmentPoints(segment)
      const maximumTravel = Math.max(
        Math.hypot(current.start.x - snapshot.start.x, current.start.y - snapshot.start.y),
        Math.hypot(current.end.x - snapshot.end.x, current.end.y - snapshot.end.y),
      )
      if (maximumTravel <= FLEXIBLE_POSITION_TOLERANCE_M) continue
      const padding = segment.entity.radiusM + CONNECTOR_CONTACT_RELEASE_GAP_M
      const minimumX =
        Math.min(snapshot.start.x, snapshot.end.x, current.start.x, current.end.x) - padding
      const maximumX =
        Math.max(snapshot.start.x, snapshot.end.x, current.start.x, current.end.x) + padding
      const minimumY =
        Math.min(snapshot.start.y, snapshot.end.y, current.start.y, current.end.y) - padding
      const maximumY =
        Math.max(snapshot.start.y, snapshot.end.y, current.start.y, current.end.y) + padding

      for (const bodyCandidate of this.connectorBodyBroadphaseCandidates) {
        if (bodyCandidate.maxX + CONNECTOR_CONTACT_RELEASE_GAP_M < minimumX) continue
        if (bodyCandidate.minX - CONNECTOR_CONTACT_RELEASE_GAP_M > maximumX) break
        if (
          bodyCandidate.maxY + CONNECTOR_CONTACT_RELEASE_GAP_M < minimumY ||
          bodyCandidate.minY - CONNECTOR_CONTACT_RELEASE_GAP_M > maximumY
        ) {
          continue
        }
        const { bodyId, body } = bodyCandidate
        if (
          (segment.entity.a.type === 'body' && segment.entity.a.bodyId === bodyId) ||
          (segment.entity.b.type === 'body' && segment.entity.b.bodyId === bodyId)
        ) {
          continue
        }
        const manifoldKey = `${segment.entity.id}:${segment.segmentIndex}:${bodyId}`
        const existing = this.connectorBodyContactManifolds.get(manifoldKey)
        if (existing && contacts.includes(existing)) {
          if (this.refreshConnectorBodyContactCandidate(existing)) {
            continue
          }
        }
        const position = body.rigidBody.translation()
        const velocity = body.rigidBody.linvel()
        const previousBody: PreviousBodyState = {
          position: { x: position.x, y: position.y },
          linearVelocity: { x: velocity.x, y: velocity.y },
          angleRad: body.rigidBody.rotation(),
          angularVelocityRad: body.entity.rotationEnabled ? body.rigidBody.angvel() : 0,
        }
        const candidate = this.sweptConnectorBodyContact(
          segment,
          bodyId,
          body,
          previousBody,
          snapshot,
        )
        if (!candidate) continue
        if (existing && contacts.includes(existing)) {
          existing.sweptImpact = true
          existing.isNew = true
          if (existing.source !== 'physicalSweep') {
            existing.source = 'constraintProjection'
          }
          existing.timeRatio = candidate.timeRatio
          if (
            dotVectors(existing.referenceNormal, candidate.referenceNormal) >=
            CONNECTOR_CONTACT_MERGE_NORMAL_DOT
          ) {
            existing.normal = candidate.normal
            existing.referenceNormal = { ...candidate.referenceNormal }
          }
          existing.centerlinePoint = candidate.centerlinePoint
          existing.separation = candidate.separation
          continue
        }
        this.addFlexibleRopeBodyContact(candidate)
        if (contacts.includes(candidate)) {
          this.connectorBodyContactManifolds.set(candidate.key, candidate)
        }
      }
    }
    contacts = this.activeFlexibleRopeBodyContacts.get(record.entity.id) ?? []
    for (let index = contacts.length - 1; index >= 0; index -= 1) {
      const contact = contacts[index]!
      if (
        contact.sweptImpact ||
        (this.refreshConnectorBodyContactCandidate(contact) &&
          this.connectorBodyContactShouldSolve(contact))
      ) {
        continue
      }
      contacts.splice(index, 1)
      this.connectorBodyContactManifolds.delete(contact.key)
    }
  }

  private measureFlexibleRopePositionError(record: FlexibleConnectorRecord): number {
    const chain = this.flexibleChain(record)
    let totalLength = 0
    let maximumLinkError = 0
    for (let index = 1; index < chain.length; index += 1) {
      const first = this.connectorEndpointState(chain[index - 1]!).position
      const second = this.connectorEndpointState(chain[index]!).position
      const length = Math.hypot(second.x - first.x, second.y - first.y)
      totalLength += length
      maximumLinkError = Math.max(maximumLinkError, length - record.linkLength)
    }
    const maximumLength = record.linkLength * Math.max(0, chain.length - 1)
    return Math.max(0, maximumLinkError, totalLength - maximumLength)
  }

  private projectFlexibleRopeEndpointBodyOverlaps(record: FlexibleConnectorRecord): boolean {
    let corrected = false
    const processedPairs = new Set<string>()
    for (const endpoint of [record.first, record.second]) {
      const endpointBody = endpoint.body
      if (!endpointBody?.collider) continue
      const endpointShapes = this.bodyCollisionShapes(endpointBody)
      if (endpointShapes.length === 0) continue
      for (const [otherId, otherBody] of this.dynamicBodies) {
        if (otherId === endpointBody.entity.id || !otherBody.collider) continue
        const pairKey = [endpointBody.entity.id, otherId].sort().join(':')
        if (processedPairs.has(pairKey)) continue
        processedPairs.add(pairKey)
        const otherShapes = this.bodyCollisionShapes(otherBody)
        if (otherShapes.length === 0) continue
        const endpointPosition = endpointBody.rigidBody.translation()
        const otherPosition = otherBody.rigidBody.translation()
        if (
          Math.hypot(otherPosition.x - endpointPosition.x, otherPosition.y - endpointPosition.y) >
          endpointBody.boundingRadius + otherBody.boundingRadius + CONNECTOR_CONTACT_RELEASE_GAP_M
        ) {
          continue
        }
        const contact = endpointShapes
          .flatMap((endpointShape) =>
            otherShapes.flatMap((otherShape) => {
              const candidate = endpointShape.contactShape(
                endpointPosition,
                endpointBody.rigidBody.rotation(),
                otherShape,
                otherPosition,
                otherBody.rigidBody.rotation(),
                0,
              )
              return candidate ? [candidate] : []
            }),
          )
          .sort((first, second) => first.distance - second.distance)[0]
        if (!contact || contact.distance >= -FLEXIBLE_POSITION_TOLERANCE_M) continue
        const normalLength = Math.hypot(contact.normal1.x, contact.normal1.y)
        if (normalLength <= Number.EPSILON) continue
        const normal = {
          x: contact.normal1.x / normalLength,
          y: contact.normal1.y / normalLength,
        }
        const endpointInverseMass = this.bodyDirectionalInverseMassAtPoint(
          endpointBody,
          contact.point1,
          normal,
        )
        const otherInverseMass = this.bodyDirectionalInverseMassAtPoint(
          otherBody,
          contact.point2,
          normal,
        )
        const totalInverseMass = endpointInverseMass + otherInverseMass
        if (totalInverseMass <= Number.EPSILON) continue
        const multiplier = -contact.distance / totalInverseMass
        this.applyBodyPositionMultiplier(
          endpointBody,
          contact.point1,
          scaleVector(normal, -1),
          multiplier,
        )
        this.applyBodyPositionMultiplier(otherBody, contact.point2, normal, multiplier)
        corrected = true
      }
    }
    return corrected
  }

  private solveFlexibleRopesXpbd(groundConstraints: ConnectorGroundPositionConstraint[]): void {
    const groundsByRope = new Map<EntityId, ConnectorGroundPositionConstraint[]>()
    for (const constraint of groundConstraints) {
      if (
        constraint.record.entity.connector.type !== 'rope' ||
        constraint.record.entity.massKg <= 0
      ) {
        continue
      }
      const constraints = groundsByRope.get(constraint.record.entity.id) ?? []
      constraints.push(constraint)
      groundsByRope.set(constraint.record.entity.id, constraints)
    }

    for (const record of this.flexibleConnectors) {
      if (record.kind !== 'rope') continue
      let contacts = this.activeFlexibleRopeBodyContacts.get(record.entity.id) ?? []
      const ropeGroundConstraints = groundsByRope.get(record.entity.id) ?? []
      const chain = this.flexibleChain(record)
      if (contacts.length === 0 && ropeGroundConstraints.length === 0) {
        this.captureFlexibleRopeConstraintProjectionSegments(record)
        this.solveFlexibleRopePosition(record, chain)
        this.refreshFlexibleRopeContactsAfterLengthProjection(record)
        contacts = this.activeFlexibleRopeBodyContacts.get(record.entity.id) ?? []
      }
      if (contacts.length === 0 && ropeGroundConstraints.length === 0) {
        this.refreshFlexibleRopeNodeVelocities(record)
        this.solveFlexibleRopeRecord(record, true)
        continue
      }
      const maximumRelativeTravel = this.flexibleRopeMaximumRelativeTravel(record, contacts)
      const microsteps = requiredRopeXpbdMicrosteps(
        maximumRelativeTravel,
        record.entity.radiusM,
        record.linkLength,
      )
      const solveResult = solveRopeXpbd(
        {
          microsteps,
          positionIterationGroups: Math.max(
            microsteps,
            ropeGroundConstraints.length > 0 ||
              contacts.some((contact) => contact.body.entity.shape.type === 'box')
              ? 8
              : 1,
          ),
          positionIterationsPerMicrostep: 4,
          minimumPositionIterations: contacts.some(
            (contact) => contact.body.entity.shape.type === 'box',
          )
            ? 4
            : contacts.length > 0
              ? record.first.body || record.second.body
                ? 2
                : 1
              : ropeGroundConstraints.length > 0
                ? 4
                : 1,
          velocityIterations: 1,
          lengthToleranceM: this.flexibleRopeLengthTolerance(record),
          penetrationToleranceM: FLEXIBLE_POSITION_TOLERANCE_M,
          velocityToleranceMps: FLEXIBLE_VELOCITY_TOLERANCE_MPS,
        },
        {
          beginSolve: () => {
            for (const contact of contacts) {
              contact.accumulatedPositionLambda = 0
              contact.accumulatedNormalImpulse = 0
              contact.accumulatedFrictionImpulse = 0
            }
            for (const constraint of ropeGroundConstraints) {
              constraint.accumulatedNormalImpulse = 0
              constraint.accumulatedFrictionImpulse = 0
            }
          },
          capturePositionsBeforeLengthProjection: () =>
            this.captureFlexibleRopeConstraintProjectionSegments(record),
          solveLengthPositions: (reverse) =>
            this.solveFlexibleRopePositionIteration(record, reverse, contacts.length > 0),
          refreshContactsAfterLengthProjection: () =>
            this.refreshFlexibleRopeContactsAfterLengthProjection(record),
          solveContactPositions: (reverse) => {
            let corrected = this.projectFlexibleRopeEndpointBodyOverlaps(record)
            for (let offset = 0; offset < contacts.length; offset += 1) {
              const contact = contacts[reverse ? contacts.length - 1 - offset : offset]!
              corrected = this.projectConnectorBodyContact(contact) || corrected
            }
            corrected =
              this.projectConnectorGroundConstraints(ropeGroundConstraints, reverse) || corrected
            let maximumPenetrationM = 0
            for (const contact of contacts) {
              if (!this.refreshConnectorBodyContactCandidate(contact)) continue
              maximumPenetrationM = Math.max(maximumPenetrationM, Math.max(0, -contact.separation))
            }
            return {
              corrected,
              maximumConstraintErrorM: 0,
              maximumPenetrationM,
            }
          },
          measureLengthPositionError: () => this.measureFlexibleRopePositionError(record),
          rebuildVelocities: () => this.refreshFlexibleRopeNodeVelocities(record),
          solveContactVelocities: (reverse) => {
            let corrected = false
            for (let offset = 0; offset < contacts.length; offset += 1) {
              const contact = contacts[reverse ? contacts.length - 1 - offset : offset]!
              corrected =
                this.solveConnectorBodyContactVelocity(contact, contact.isNew) || corrected
            }
            for (let offset = 0; offset < ropeGroundConstraints.length; offset += 1) {
              const constraint =
                ropeGroundConstraints[reverse ? ropeGroundConstraints.length - 1 - offset : offset]!
              corrected = this.solveFlexibleRopeGroundContactVelocity(constraint, true) || corrected
            }
            return corrected
          },
          solveLengthVelocities: (reverse) => {
            return Math.max(
              this.solveFlexibleRopeLinks(record, chain, reverse, true),
              this.solveFlexibleRopeLongRangeLimits(record, chain, reverse, true),
              this.solveFlexibleRopeTotalLength(record, chain, true, true),
            )
          },
          finishSolve: () => {
            for (const contact of contacts) contact.isNew = false
          },
        },
      )
      const finalLengthErrorM = this.measureFlexibleRopePositionError(record)
      let finalPenetrationM = 0
      for (const contact of contacts) {
        if (!this.refreshConnectorBodyContactCandidate(contact)) continue
        finalPenetrationM = Math.max(finalPenetrationM, Math.max(0, -contact.separation))
      }
      if (
        !solveResult.converged &&
        (finalLengthErrorM > this.flexibleRopeLengthTolerance(record) ||
          finalPenetrationM > 0.002) &&
        !this.ropeConstraintWarningIds.has(record.entity.id)
      ) {
        this.ropeConstraintWarningIds.add(record.entity.id)
        this.warnings.push({
          entityId: record.entity.id,
          message:
            `绳约束在 ${solveResult.positionIterations} 次统一迭代后仍未完全收敛：` +
            `绳长误差 ${finalLengthErrorM.toPrecision(4)} m，` +
            `穿透 ${finalPenetrationM.toPrecision(4)} m；已优先保留非穿透状态。`,
        })
      }
    }
  }

  private createFixedRodJoint(rod: RodConnectorRecord): void {
    const firstEndpoint = this.connectorEndpointState(rod.first)
    const secondEndpoint = this.connectorEndpointState(rod.second)
    const delta = {
      x: secondEndpoint.position.x - firstEndpoint.position.x,
      y: secondEndpoint.position.y - firstEndpoint.position.y,
    }
    const distance = Math.hypot(delta.x, delta.y)
    const firstAngle = rod.first.rigidBody.rotation()
    const secondAngle = rod.second.rigidBody.rotation()
    const direction =
      distance > Number.EPSILON
        ? { x: delta.x / distance, y: delta.y / distance }
        : { x: Math.cos(firstAngle), y: Math.sin(firstAngle) }
    const desiredOffsetWorld = {
      x: direction.x * rod.entity.connector.length,
      y: direction.y * rod.entity.connector.length,
    }
    const cosine = Math.cos(secondAngle)
    const sine = Math.sin(secondAngle)
    const desiredOffsetLocalToSecond = {
      x: cosine * desiredOffsetWorld.x + sine * desiredOffsetWorld.y,
      y: -sine * desiredOffsetWorld.x + cosine * desiredOffsetWorld.y,
    }
    const secondVirtualAnchor = {
      x: rod.second.localAnchor.x - desiredOffsetLocalToSecond.x,
      y: rod.second.localAnchor.y - desiredOffsetLocalToSecond.y,
    }
    const fixed = RAPIER.JointData.fixed(
      rod.first.localAnchor,
      0,
      secondVirtualAnchor,
      firstAngle - secondAngle,
    )
    const joint = this.world.createImpulseJoint(
      fixed,
      rod.first.rigidBody,
      rod.second.rigidBody,
      true,
    )
    joint.setContactsEnabled(true)
  }

  private createPinnedRodJoint(rod: RodConnectorRecord, fixedEndpoint: 'a' | 'b'): void {
    const firstEndpoint = this.connectorEndpointState(rod.first)
    const secondEndpoint = this.connectorEndpointState(rod.second)
    const delta = {
      x: secondEndpoint.position.x - firstEndpoint.position.x,
      y: secondEndpoint.position.y - firstEndpoint.position.y,
    }
    const distance = Math.hypot(delta.x, delta.y)
    const direction =
      distance > Number.EPSILON
        ? { x: delta.x / distance, y: delta.y / distance }
        : {
            x: Math.cos(rod.first.rigidBody.rotation()),
            y: Math.sin(rod.first.rigidBody.rotation()),
          }
    const worldToLocal = (rigidBody: RAPIER.RigidBody, point: Vec2): Vec2 => {
      const center = rigidBody.translation()
      const angle = rigidBody.rotation()
      const cosine = Math.cos(angle)
      const sine = Math.sin(angle)
      const offset = { x: point.x - center.x, y: point.y - center.y }
      return {
        x: cosine * offset.x + sine * offset.y,
        y: -sine * offset.x + cosine * offset.y,
      }
    }
    const firstAnchor =
      fixedEndpoint === 'a'
        ? worldToLocal(rod.first.rigidBody, {
            x: firstEndpoint.position.x + direction.x * rod.entity.connector.length,
            y: firstEndpoint.position.y + direction.y * rod.entity.connector.length,
          })
        : rod.first.localAnchor
    const secondAnchor =
      fixedEndpoint === 'b'
        ? worldToLocal(rod.second.rigidBody, {
            x: secondEndpoint.position.x - direction.x * rod.entity.connector.length,
            y: secondEndpoint.position.y - direction.y * rod.entity.connector.length,
          })
        : rod.second.localAnchor
    const joint = this.world.createImpulseJoint(
      RAPIER.JointData.revolute(firstAnchor, secondAnchor),
      rod.first.rigidBody,
      rod.second.rigidBody,
      true,
    )
    joint.setContactsEnabled(true)
  }

  private configureSpringIntegration(): void {
    let requiredSubsteps = 1
    for (const spring of this.springs) {
      const firstInverseMass = spring.first.rigidBody.effectiveInvMass()
      const secondInverseMass = spring.second.rigidBody.effectiveInvMass()
      const firstInertia = spring.first.rigidBody.effectiveAngularInertia()
      const secondInertia = spring.second.rigidBody.effectiveAngularInertia()
      const firstAnchorRadiusSquared =
        spring.first.localAnchor.x ** 2 + spring.first.localAnchor.y ** 2
      const secondAnchorRadiusSquared =
        spring.second.localAnchor.x ** 2 + spring.second.localAnchor.y ** 2
      const inverseMassUpperBound =
        Math.max(firstInverseMass.x, firstInverseMass.y) +
        Math.max(secondInverseMass.x, secondInverseMass.y) +
        (firstInertia > Number.EPSILON ? firstAnchorRadiusSquared / firstInertia : 0) +
        (secondInertia > Number.EPSILON ? secondAnchorRadiusSquared / secondInertia : 0)
      spring.effectiveInverseMassUpperBound = inverseMassUpperBound
      if (inverseMassUpperBound <= Number.EPSILON || spring.effectiveStiffness === 0) continue
      const phaseStep =
        this.fixedTimeStep * Math.sqrt(spring.effectiveStiffness) * Math.sqrt(inverseMassUpperBound)
      const springSubsteps = Number.isFinite(phaseStep)
        ? Math.max(1, Math.ceil(phaseStep / MAX_SPRING_PHASE_STEP))
        : MAX_SPRING_INTERNAL_SUBSTEPS + 1
      requiredSubsteps = Math.max(requiredSubsteps, springSubsteps)
    }
    for (const bumper of this.springBumpers) {
      const attachedBodyId =
        bumper.attached?.definition.type === 'body' ? bumper.attached.definition.bodyId : null
      let maximumBodyInverseMass = 0
      for (const [bodyId, body] of this.dynamicBodies) {
        if (bodyId === attachedBodyId || !body.collider) continue
        const inverseMass = body.rigidBody.effectiveInvMass()
        maximumBodyInverseMass = Math.max(maximumBodyInverseMass, inverseMass.x, inverseMass.y)
      }
      const attachedInverseMass = bumper.attached
        ? Math.max(
            bumper.attached.rigidBody.effectiveInvMass().x,
            bumper.attached.rigidBody.effectiveInvMass().y,
          )
        : 0
      const inverseMassUpperBound =
        attachedInverseMass + maximumBodyInverseMass * (bumper.mode === 'double' ? 4 : 1)
      bumper.effectiveInverseMassUpperBound = inverseMassUpperBound
      if (inverseMassUpperBound <= Number.EPSILON || bumper.effectiveStiffness === 0) continue
      const phaseStep =
        this.fixedTimeStep * Math.sqrt(bumper.effectiveStiffness * inverseMassUpperBound)
      const bumperSubsteps = Number.isFinite(phaseStep)
        ? Math.max(1, Math.ceil(phaseStep / MAX_SPRING_PHASE_STEP))
        : MAX_SPRING_INTERNAL_SUBSTEPS + 1
      requiredSubsteps = Math.max(requiredSubsteps, bumperSubsteps)
    }

    this.springSubstepCount = Math.min(requiredSubsteps, MAX_SPRING_INTERNAL_SUBSTEPS)
    for (const spring of this.springs) {
      const inverseMass = spring.effectiveInverseMassUpperBound
      if (inverseMass <= Number.EPSILON) continue
      const maximumStiffness =
        (MAX_SPRING_PHASE_STEP * this.springSubstepCount) ** 2 /
        (this.fixedTimeStep ** 2 * inverseMass)
      if (spring.effectiveStiffness <= maximumStiffness) continue
      const requestedStiffness = spring.effectiveStiffness
      spring.effectiveStiffness = maximumStiffness
      this.warnings.push({
        message:
          `弹簧刚度 ${requestedStiffness.toPrecision(6)} N/m 超出实时稳定范围，` +
          `本次模拟使用 ${maximumStiffness.toPrecision(6)} N/m 和 ` +
          `${MAX_SPRING_INTERNAL_SUBSTEPS} 个内部子步。`,
        entityId: spring.entity.id,
      })
    }
    for (const bumper of this.springBumpers) {
      const inverseMass = bumper.effectiveInverseMassUpperBound
      if (inverseMass <= Number.EPSILON) continue
      const maximumStiffness =
        (MAX_SPRING_PHASE_STEP * this.springSubstepCount) ** 2 /
        (this.fixedTimeStep ** 2 * inverseMass)
      if (bumper.effectiveStiffness <= maximumStiffness) continue
      const requestedStiffness = bumper.effectiveStiffness
      bumper.effectiveStiffness = maximumStiffness
      this.warnings.push({
        message:
          `自由端弹簧刚度 ${requestedStiffness.toPrecision(6)} N/m 超出实时稳定范围，` +
          `本次模拟使用 ${maximumStiffness.toPrecision(6)} N/m 和 ` +
          `${MAX_SPRING_INTERNAL_SUBSTEPS} 个内部子步。`,
        entityId: bumper.entity.id,
      })
    }
  }

  private resetExternalForces(): void {
    for (const record of this.dynamicBodies.values()) {
      record.netForce = { x: 0, y: 0 }
      record.pathForce = { x: 0, y: 0 }
      record.constraintForce = { x: 0, y: 0 }
      record.magneticFieldTesla = 0
      record.rigidBody.resetForces(false)
      record.rigidBody.resetTorques(false)
    }
    for (const record of this.connectorMassBodies) {
      record.rigidBody.resetForces(false)
      record.rigidBody.resetTorques(false)
    }
  }

  private warnExpressionOnce(key: string, message: string, entityId: EntityId): void {
    if (this.expressionWarningKeys.has(key)) return
    this.expressionWarningKeys.add(key)
    this.warnings.push({ message, entityId })
  }

  private compileTimeExpression(
    expression: string | undefined,
    entityId: EntityId,
    role: string,
  ): CompiledScalarExpression | null {
    if (!expression) return null
    try {
      return compileScalarExpression(expression, {
        allowTime: true,
        variableNames: new Set(Object.keys(this.scalarVariables)),
      })
    } catch (error) {
      this.warnExpressionOnce(
        `${entityId}:${role}:compile`,
        `${role}无效，本次模拟已停用：${error instanceof Error ? error.message : '无法解析。'}`,
        entityId,
      )
      return null
    }
  }

  private createForce(entity: ForceEntity): void {
    if (!this.dynamicBodies.has(entity.bodyId)) {
      this.warnings.push({ message: '外加力引用的刚体不存在，已忽略。', entityId: entity.id })
      return
    }
    this.forces.push({
      entity,
      magnitudeExpression: this.compileTimeExpression(
        entity.magnitudeExpression?.expression,
        entity.id,
        '力大小表达式',
      ),
      directionDegreesExpression: this.compileTimeExpression(
        entity.directionDegreesExpression?.expression,
        entity.id,
        '力方向（度）表达式',
      ),
    })
  }

  private evaluateForceScalar(
    record: RuntimeForceRecord,
    property: 'magnitude' | 'direction',
  ): number | null {
    const definition =
      property === 'magnitude'
        ? record.entity.magnitudeExpression
        : record.entity.directionDegreesExpression
    if (!definition) {
      return property === 'magnitude' ? record.entity.magnitudeN : record.entity.directionRad
    }
    const compiled =
      property === 'magnitude' ? record.magnitudeExpression : record.directionDegreesExpression
    const value = compiled?.evaluate({
      time: this.simulationTimeValue,
      variables: this.scalarVariables,
    })
    if (value !== null && value !== undefined) {
      return property === 'direction' ? (value * Math.PI) / 180 : value
    }
    this.warnExpressionOnce(
      `${record.entity.id}:${property}:runtime`,
      `${property === 'magnitude' ? '力大小' : '力方向'}表达式在 t=${this.simulationTimeValue.toPrecision(6)} s 没有有限结果，该步未施加此力。`,
      record.entity.id,
    )
    return null
  }

  private applyForces(): void {
    for (const record of this.forces) {
      const body = this.dynamicBodies.get(record.entity.bodyId)
      if (!body) continue
      const magnitude = this.evaluateForceScalar(record, 'magnitude')
      const direction = this.evaluateForceScalar(record, 'direction')
      if (magnitude === null || direction === null) continue
      const angle = body.rigidBody.rotation()
      const cosine = Math.cos(angle)
      const sine = Math.sin(angle)
      const center = body.rigidBody.translation()
      const anchor = {
        x: center.x + record.entity.localAnchor.x * cosine - record.entity.localAnchor.y * sine,
        y: center.y + record.entity.localAnchor.x * sine + record.entity.localAnchor.y * cosine,
      }
      this.applyForceToBody(
        body,
        { x: Math.cos(direction) * magnitude, y: Math.sin(direction) * magnitude },
        anchor,
      )
    }
  }

  private applyForceToBody(record: DynamicBodyRecord, force: Vec2, point?: Vec2): void {
    record.netForce = addForce(record.netForce, force)
    record.pathForce = addForce(record.pathForce, force)
    record.constraintForce = addForce(record.constraintForce, force)
    if (point) record.rigidBody.addForceAtPoint(force, point, false)
    else record.rigidBody.addForce(force, false)
  }

  private transformedBooleanRegionPoint(record: DynamicBodyRecord, point: Vec2): Vec2 {
    const result = record.booleanResult
    if (!result) return point
    const position = record.rigidBody.translation()
    const angleDelta = record.rigidBody.rotation() - result.angleRad
    const cosine = Math.cos(angleDelta)
    const sine = Math.sin(angleDelta)
    const x = point.x - result.centerOfMass.x
    const y = point.y - result.centerOfMass.y
    return {
      x: position.x + x * cosine - y * sine,
      y: position.y + x * sine + y * cosine,
    }
  }

  private evaluatedFieldDefinition(
    field: FieldDefinition,
    entityId: EntityId,
  ): FieldDefinition | null {
    const hasExpression =
      field.type === 'uniformElectric'
        ? Boolean(field.componentExpressions?.x || field.componentExpressions?.y)
        : Boolean(field.magnitudeExpression)
    if (!hasExpression) return field
    if (this.fieldEvaluationCache.has(field)) {
      return this.fieldEvaluationCache.get(field) ?? null
    }
    let compiled = this.fieldExpressionCompilers.get(field)
    if (compiled === undefined) {
      compiled =
        field.type === 'uniformElectric'
          ? {
              magnitude: null,
              x: this.compileTimeExpression(
                field.componentExpressions?.x?.expression,
                entityId,
                '电场强度 X 表达式',
              ),
              y: this.compileTimeExpression(
                field.componentExpressions?.y?.expression,
                entityId,
                '电场强度 Y 表达式',
              ),
            }
          : {
              magnitude: this.compileTimeExpression(
                field.magnitudeExpression?.expression,
                entityId,
                '场强表达式',
              ),
              x: null,
              y: null,
            }
      this.fieldExpressionCompilers.set(field, compiled)
    }
    const evaluated = evaluateFieldDefinition(
      field,
      this.simulationTimeValue,
      this.scalarVariables,
      compiled,
    )
    if (!evaluated) {
      this.warnExpressionOnce(
        `${entityId}:field:runtime`,
        `场强表达式在 t=${this.simulationTimeValue.toPrecision(6)} s 没有有限结果，该步未施加此场。`,
        entityId,
      )
    }
    this.fieldEvaluationCache.set(field, evaluated)
    return evaluated
  }

  private fieldDefinitionsAtPoint(point: Vec2): FieldDefinition[] {
    const definitions = this.fields.flatMap((field) => {
      if (!regionContainsPoint(field.region, point)) return []
      const evaluated = this.evaluatedFieldDefinition(field.field, field.id)
      return evaluated ? [evaluated] : []
    })
    for (const field of this.booleanFields) {
      for (const region of field.regions) {
        if (!pointInBooleanGeometry(point, region.geometry)) continue
        const evaluated = this.evaluatedFieldDefinition(region.field, field.resultId)
        if (evaluated) definitions.push(evaluated)
      }
    }
    return definitions
  }

  private magneticFieldTeslaAtPoint(point: Vec2): number {
    let bzTesla = 0
    for (const field of this.fieldDefinitionsAtPoint(point)) {
      if (field.type === 'uniformMagnetic') bzTesla += field.bzTesla
    }
    return bzTesla
  }

  private particleCrossesMagneticFieldBoundary(
    ion: RuntimeParticleIon,
    entity: ParticleSourceEntity,
    timeStep: number,
  ): boolean {
    if (entity.chargeC === 0) return false
    const startBz = this.magneticFieldTeslaAtPoint(ion.position)
    const midpoint = advancePointInMagneticField(
      ion.position,
      ion.velocity,
      entity.chargeC,
      startBz,
      entity.massKg,
      timeStep / 2,
    ).position
    const endpoint = advancePointInMagneticField(
      ion.position,
      ion.velocity,
      entity.chargeC,
      startBz,
      entity.massKg,
      timeStep,
    ).position
    const midpointBz = this.magneticFieldTeslaAtPoint(midpoint)
    const endpointBz = this.magneticFieldTeslaAtPoint(endpoint)
    return midpointBz !== startBz || endpointBz !== startBz
  }

  private bodyMassPatches(record: DynamicBodyRecord): Array<{
    position: Vec2
    massKg: number
    area: number
  }> {
    if (!record.booleanResult) {
      const position = record.rigidBody.translation()
      return [
        {
          position: { x: position.x, y: position.y },
          massKg: record.entity.massKg,
          area: Math.PI * record.boundingRadius ** 2,
        },
      ]
    }
    return record.booleanResult.massRegions.map((region) => ({
      position: this.transformedBooleanRegionPoint(record, region.centroid),
      massKg: region.massKg,
      area: region.area,
    }))
  }

  private bodyChargePatches(record: DynamicBodyRecord): Array<{
    position: Vec2
    chargeC: number
    area: number
  }> {
    if (!record.booleanResult) {
      const position = record.rigidBody.translation()
      return [
        {
          position: { x: position.x, y: position.y },
          chargeC: record.entity.chargeC,
          area: Math.PI * record.boundingRadius ** 2,
        },
      ]
    }
    return record.booleanResult.chargeRegions.map((region) => ({
      position: this.transformedBooleanRegionPoint(record, region.centroid),
      chargeC: region.chargeC,
      area: region.area,
    }))
  }

  private applyFieldForces(): void {
    for (const record of this.dynamicBodies.values()) {
      const velocity = record.rigidBody.linvel()
      const center = record.rigidBody.translation()
      let chargeFieldSum = 0
      let chargeFieldXMoment = 0
      let chargeFieldYMoment = 0

      for (const patch of this.bodyMassPatches(record)) {
        for (const field of this.fieldDefinitionsAtPoint(patch.position)) {
          if (field.type === 'uniformGravity' && patch.massKg !== 0) {
            this.applyForceToBody(
              record,
              scaleForce(field.acceleration, patch.massKg),
              patch.position,
            )
          }
        }
      }
      for (const patch of this.bodyChargePatches(record)) {
        for (const field of this.fieldDefinitionsAtPoint(patch.position)) {
          if (field.type === 'uniformElectric' && patch.chargeC !== 0) {
            this.applyForceToBody(
              record,
              electricForce(patch.chargeC, field.strength),
              patch.position,
            )
          } else if (field.type === 'uniformMagnetic' && patch.chargeC !== 0) {
            const chargeField = patch.chargeC * field.bzTesla
            chargeFieldSum += chargeField
            chargeFieldXMoment += chargeField * (patch.position.x - center.x)
            chargeFieldYMoment += chargeField * (patch.position.y - center.y)
          }
        }
      }

      if (chargeFieldSum !== 0 && !this.persistentGroundContacts.has(record.entity.id)) {
        record.magneticFieldTesla =
          record.entity.chargeC !== 0 ? chargeFieldSum / record.entity.chargeC : 0
        if (!record.booleanResult) {
          const nextVelocity = rotateVelocityInMagneticField(
            { x: velocity.x, y: velocity.y },
            record.entity.chargeC,
            record.magneticFieldTesla,
            record.entity.massKg,
            this.currentTimeStep,
          )
          const magneticForceValue = {
            x: (record.entity.massKg * (nextVelocity.x - velocity.x)) / this.currentTimeStep,
            y: (record.entity.massKg * (nextVelocity.y - velocity.y)) / this.currentTimeStep,
          }
          record.netForce = addForce(record.netForce, magneticForceValue)
          record.constraintForce = addForce(record.constraintForce, magneticForceValue)
          record.rigidBody.setLinvel(nextVelocity, true)
          continue
        }
        const angularVelocity = record.rigidBody.angvel()
        const next = implicitMagneticVelocity(
          { x: velocity.x, y: velocity.y },
          angularVelocity,
          record.entity.massKg,
          Math.max(record.rigidBody.effectiveAngularInertia(), 1e-12),
          chargeFieldSum,
          chargeFieldXMoment,
          chargeFieldYMoment,
          this.currentTimeStep,
        )
        const magneticForceValue = {
          x: (record.entity.massKg * (next.velocity.x - velocity.x)) / this.currentTimeStep,
          y: (record.entity.massKg * (next.velocity.y - velocity.y)) / this.currentTimeStep,
        }
        record.netForce = addForce(record.netForce, magneticForceValue)
        record.constraintForce = addForce(record.constraintForce, magneticForceValue)
        record.rigidBody.setLinvel(next.velocity, true)
        if (record.entity.rotationEnabled) {
          record.rigidBody.setAngvel(next.angularVelocityRad, true)
        }
      }
    }
    for (const record of this.connectorMassBodies) {
      const position = record.rigidBody.translation()
      for (const field of this.fieldDefinitionsAtPoint(position)) {
        if (field.type === 'uniformGravity') {
          record.rigidBody.addForce(scaleForce(field.acceleration, record.massKg), false)
        }
      }
    }
  }

  private applyPairwiseElectrostatics(): void {
    if (!this.scene.settings.pairwiseElectrostatics) return
    const chargedBodies = [...this.dynamicBodies.values()].filter((record) =>
      this.bodyChargePatches(record).some((patch) => patch.chargeC !== 0),
    )

    for (let firstIndex = 0; firstIndex < chargedBodies.length; firstIndex += 1) {
      const first = chargedBodies[firstIndex]
      if (!first) continue
      for (let secondIndex = firstIndex + 1; secondIndex < chargedBodies.length; secondIndex += 1) {
        const second = chargedBodies[secondIndex]
        if (!second) continue
        for (const firstPatch of this.bodyChargePatches(first)) {
          if (firstPatch.chargeC === 0) continue
          for (const secondPatch of this.bodyChargePatches(second)) {
            if (secondPatch.chargeC === 0) continue
            const minimumDistance = Math.max(
              1e-6,
              Math.sqrt(firstPatch.area / Math.PI) * 0.1 +
                Math.sqrt(secondPatch.area / Math.PI) * 0.1,
            )
            const force = coulombForceOnFirst(
              firstPatch.chargeC,
              secondPatch.chargeC,
              firstPatch.position,
              secondPatch.position,
              minimumDistance,
            )
            this.applyForceToBody(first, force, firstPatch.position)
            this.applyForceToBody(second, scaleForce(force, -1), secondPatch.position)
          }
        }
      }
    }
  }

  private emitIonGeneration(source: ParticleSourceEntity): RuntimeParticleSource {
    const samples = particleEmissionSamples(source)
    const createIon = (
      sample: ParticleEmissionSample,
      id: number,
      bornAt = 0,
    ): RuntimeParticleIon => ({
      id,
      t: sample.t,
      bornAt,
      continuous: source.continuousEmission.enabled,
      position: { ...sample.position },
      velocity: {
        x: sample.direction.x * source.speedMps,
        y: sample.direction.y * source.speedMps,
      },
    })
    const initialSamples = source.continuousEmission.enabled
      ? source.continuousEmission.simultaneous
        ? samples
        : samples.slice(0, 1)
      : samples
    const ions = initialSamples.map((sample, index) => createIon(sample, index))
    return {
      entity: source,
      samples,
      ions,
      nextIonId: ions.length,
      nextSampleIndex:
        source.continuousEmission.enabled &&
        !source.continuousEmission.simultaneous &&
        samples.length > 0
          ? 1
          : 0,
      nextEmissionIndex: 1,
      nextEmissionTime: source.continuousEmission.enabled
        ? source.continuousEmission.intervalSeconds
        : Number.POSITIVE_INFINITY,
    }
  }

  private advanceParticleIon(
    ion: RuntimeParticleIon,
    entity: ParticleSourceEntity,
    timeStep: number,
    chargedPatches: readonly { position: Vec2; chargeC: number; area: number }[],
  ): void {
    if (timeStep <= 0) return
    const chargeOverMass = entity.chargeC / entity.massKg
    const substepCount = this.particleCrossesMagneticFieldBoundary(ion, entity, timeStep)
      ? PARTICLE_MAGNETIC_BOUNDARY_SUBSTEPS
      : 1
    const particleTimeStep = timeStep / substepCount
    for (let substep = 0; substep < substepCount; substep += 1) {
      let electricX = 0
      let electricY = 0
      let magneticBz = 0
      for (const field of this.fieldDefinitionsAtPoint(ion.position)) {
        if (field.type === 'uniformElectric') {
          electricX += field.strength.x
          electricY += field.strength.y
        } else if (field.type === 'uniformMagnetic') {
          magneticBz += field.bzTesla
        }
      }

      if (entity.chargeC !== 0) {
        ion.velocity.x += chargeOverMass * electricX * particleTimeStep
        ion.velocity.y += chargeOverMass * electricY * particleTimeStep
      }
      const magneticAdvance = advancePointInMagneticField(
        ion.position,
        ion.velocity,
        entity.chargeC,
        magneticBz,
        entity.massKg,
        particleTimeStep,
      )
      ion.position = magneticAdvance.position
      ion.velocity = magneticAdvance.velocity

      if (entity.chargeC !== 0 && entity.coulombEnabled && chargedPatches.length > 0) {
        let coulombX = 0
        let coulombY = 0
        for (const patch of chargedPatches) {
          const minimumDistance = Math.max(
            PARTICLE_COULOMB_MIN_DISTANCE_M,
            Math.sqrt(patch.area / Math.PI) * 0.1,
          )
          const force = coulombForceOnFirst(
            entity.chargeC,
            patch.chargeC,
            ion.position,
            patch.position,
            minimumDistance,
          )
          coulombX += force.x
          coulombY += force.y
        }
        const deltaVelocity = {
          x: (coulombX / entity.massKg) * particleTimeStep,
          y: (coulombY / entity.massKg) * particleTimeStep,
        }
        ion.velocity.x += deltaVelocity.x
        ion.velocity.y += deltaVelocity.y
        ion.position.x += deltaVelocity.x * particleTimeStep
        ion.position.y += deltaVelocity.y * particleTimeStep
      }
    }
  }

  private stepParticleSources(): void {
    if (this.particleSources.length === 0) return
    const chargedPatches: Array<{ position: Vec2; chargeC: number; area: number }> = []
    for (const record of this.dynamicBodies.values()) {
      for (const patch of this.bodyChargePatches(record)) {
        if (patch.chargeC !== 0) chargedPatches.push(patch)
      }
    }
    const dt = this.currentTimeStep
    const stepEndTime = this.currentSubstepStartTime + dt

    for (const source of this.particleSources) {
      const entity = source.entity
      for (const ion of source.ions) {
        this.advanceParticleIon(ion, entity, dt, chargedPatches)
      }
      while (
        entity.continuousEmission.enabled &&
        source.samples.length > 0 &&
        source.nextEmissionTime <= stepEndTime + PARTICLE_EMISSION_TIME_TOLERANCE_SECONDS
      ) {
        const emissionSamples = entity.continuousEmission.simultaneous
          ? source.samples
          : [source.samples[source.nextSampleIndex % source.samples.length]!]
        for (const sample of emissionSamples) {
          const ion: RuntimeParticleIon = {
            id: source.nextIonId,
            t: sample.t,
            bornAt: source.nextEmissionTime,
            continuous: true,
            position: { ...sample.position },
            velocity: {
              x: sample.direction.x * entity.speedMps,
              y: sample.direction.y * entity.speedMps,
            },
          }
          this.advanceParticleIon(
            ion,
            entity,
            Math.max(0, stepEndTime - source.nextEmissionTime),
            chargedPatches,
          )
          source.ions.push(ion)
          source.nextIonId += 1
        }
        if (!entity.continuousEmission.simultaneous) {
          source.nextSampleIndex = (source.nextSampleIndex + 1) % source.samples.length
        }
        source.nextEmissionIndex += 1
        source.nextEmissionTime =
          source.nextEmissionIndex * entity.continuousEmission.intervalSeconds
      }
      if (entity.continuousEmission.enabled) {
        source.ions = source.ions.filter(
          (ion) =>
            stepEndTime - ion.bornAt <
            entity.continuousEmission.lifetimeSeconds - PARTICLE_EMISSION_TIME_TOLERANCE_SECONDS,
        )
      }
    }
  }

  getParticleSourceStates(): RuntimeParticleSourceState[] {
    return this.particleSources.map((source) => ({
      entityId: source.entity.id,
      continuousEmission: source.entity.continuousEmission.enabled,
      ions: source.ions.map((ion) => ({
        id: ion.id,
        t: ion.t,
        bornAt: ion.bornAt,
        continuous: ion.continuous,
        position: { ...ion.position },
      })),
    }))
  }

  private connectorEndpointState(endpoint: ConnectorRuntimeEndpoint): ConnectorEndpointState {
    return this.writeConnectorEndpointState(endpoint, {
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      offset: { x: 0, y: 0 },
    })
  }
  private writeConnectorEndpointState(
    endpoint: ConnectorRuntimeEndpoint,
    state: ConnectorEndpointState,
  ): ConnectorEndpointState {
    const angle = endpoint.rigidBody.rotation()
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    state.offset.x = cosine * endpoint.localAnchor.x - sine * endpoint.localAnchor.y
    state.offset.y = sine * endpoint.localAnchor.x + cosine * endpoint.localAnchor.y
    const translation = endpoint.rigidBody.translation()
    const linearVelocity = endpoint.rigidBody.linvel()
    const angularVelocity =
      endpoint.body?.entity.rotationEnabled === false ? 0 : endpoint.rigidBody.angvel()
    state.position.x = translation.x + state.offset.x
    state.position.y = translation.y + state.offset.y
    state.velocity.x = linearVelocity.x - angularVelocity * state.offset.y
    state.velocity.y = linearVelocity.y + angularVelocity * state.offset.x
    return state
  }

  private directionalInverseMassAtPoint(
    endpoint: ConnectorRuntimeEndpoint,
    point: Vec2,
    direction: Vec2,
  ): number {
    if (endpoint.fixed) return 0
    const inverseMass = endpoint.rigidBody.effectiveInvMass()
    const translational = direction.x ** 2 * inverseMass.x + direction.y ** 2 * inverseMass.y
    const center = endpoint.rigidBody.translation()
    const offset = { x: point.x - center.x, y: point.y - center.y }
    const leverArm = offset.x * direction.y - offset.y * direction.x
    const inertia = endpoint.rigidBody.effectiveAngularInertia()
    const rotational = inertia > Number.EPSILON ? leverArm ** 2 / inertia : 0
    return translational + rotational
  }

  private setConstrainedAngularVelocity(
    record: DynamicBodyRecord,
    angularVelocityRad: number,
    wakeUp = true,
  ): void {
    record.rigidBody.setAngvel(
      record.entity.rotationEnabled && Number.isFinite(angularVelocityRad) ? angularVelocityRad : 0,
      wakeUp,
    )
  }

  private rodFrame(rod: RodConnectorRecord): RodFrame {
    const firstEndpoint = this.connectorEndpointState(rod.first)
    const secondEndpoint = this.connectorEndpointState(rod.second)
    const delta = {
      x: secondEndpoint.position.x - firstEndpoint.position.x,
      y: secondEndpoint.position.y - firstEndpoint.position.y,
    }
    const distance = Math.hypot(delta.x, delta.y)
    const firstAngle = rod.first.rigidBody.rotation()
    const direction =
      distance > Number.EPSILON
        ? { x: delta.x / distance, y: delta.y / distance }
        : { x: Math.cos(firstAngle), y: Math.sin(firstAngle) }
    return {
      firstEndpoint,
      secondEndpoint,
      direction,
      distance,
      effectiveInverseMass:
        this.directionalInverseMassAtPoint(rod.first, firstEndpoint.position, direction) +
        this.directionalInverseMassAtPoint(rod.second, secondEndpoint.position, direction),
    }
  }

  private applyRodPositionImpulse(
    runtimeEndpoint: ConnectorRuntimeEndpoint,
    endpointState: ConnectorEndpointState,
    direction: Vec2,
    jacobianSign: -1 | 1,
    impulseMagnitude: number,
  ): void {
    const record = runtimeEndpoint.body
    if (!record) return
    const signedImpulse = jacobianSign * impulseMagnitude
    const inverseMass = record.rigidBody.effectiveInvMass()
    const position = record.rigidBody.translation()
    record.rigidBody.setTranslation(
      {
        x: position.x + direction.x * signedImpulse * inverseMass.x,
        y: position.y + direction.y * signedImpulse * inverseMass.y,
      },
      true,
    )

    const inertia = record.rigidBody.effectiveAngularInertia()
    if (!record.entity.rotationEnabled || inertia <= Number.EPSILON) return
    const leverArm = endpointState.offset.x * direction.y - endpointState.offset.y * direction.x
    record.rigidBody.setRotation(
      record.rigidBody.rotation() + (signedImpulse * leverArm) / inertia,
      true,
    )
  }

  private rodBodyComponents(): DynamicBodyRecord[][] {
    const neighbors = new Map<DynamicBodyRecord, Set<DynamicBodyRecord>>()
    for (const rod of this.rods) {
      const first = rod.first.body
      const second = rod.second.body
      if (!first || !second) continue
      const firstNeighbors = neighbors.get(first) ?? new Set<DynamicBodyRecord>()
      const secondNeighbors = neighbors.get(second) ?? new Set<DynamicBodyRecord>()
      firstNeighbors.add(second)
      secondNeighbors.add(first)
      neighbors.set(first, firstNeighbors)
      neighbors.set(second, secondNeighbors)
    }

    const components: DynamicBodyRecord[][] = []
    const visited = new Set<DynamicBodyRecord>()
    for (const start of neighbors.keys()) {
      if (visited.has(start)) continue
      const component: DynamicBodyRecord[] = []
      const pending = [start]
      visited.add(start)
      while (pending.length > 0) {
        const record = pending.pop()
        if (!record) continue
        component.push(record)
        for (const neighbor of neighbors.get(record) ?? []) {
          if (visited.has(neighbor)) continue
          visited.add(neighbor)
          pending.push(neighbor)
        }
      }
      components.push(component)
    }
    return components
  }

  private componentCenterOfMass(records: readonly DynamicBodyRecord[]): Vec2 {
    let totalMass = 0
    let weightedX = 0
    let weightedY = 0
    for (const record of records) {
      const position = record.rigidBody.translation()
      totalMass += record.entity.massKg
      weightedX += position.x * record.entity.massKg
      weightedY += position.y * record.entity.massKg
    }
    return totalMass > 0 ? { x: weightedX / totalMass, y: weightedY / totalMass } : { x: 0, y: 0 }
  }

  private componentAngularMomentum(
    records: readonly DynamicBodyRecord[],
    centerOfMass: Vec2,
  ): number {
    let angularMomentum = 0
    for (const record of records) {
      const position = record.rigidBody.translation()
      const velocity = record.rigidBody.linvel()
      const offset = {
        x: position.x - centerOfMass.x,
        y: position.y - centerOfMass.y,
      }
      angularMomentum +=
        record.entity.massKg * (offset.x * velocity.y - offset.y * velocity.x) +
        record.rigidBody.effectiveAngularInertia() * record.rigidBody.angvel()
    }
    return angularMomentum
  }

  private captureRodAngularMomentumTargets(): RodAngularMomentumTarget[] {
    return this.rodBodyComponents()
      .filter((records) => records.every((record) => record.entity.rotationEnabled))
      .map((records) => {
        const centerOfMass = this.componentCenterOfMass(records)
        return {
          records,
          angularMomentum: this.componentAngularMomentum(records, centerOfMass),
        }
      })
  }

  private restoreRodAngularMomentum(targets: readonly RodAngularMomentumTarget[]): void {
    for (const target of targets) {
      const centerOfMass = this.componentCenterOfMass(target.records)
      const currentAngularMomentum = this.componentAngularMomentum(target.records, centerOfMass)
      const angularMomentumError = target.angularMomentum - currentAngularMomentum
      if (Math.abs(angularMomentumError) <= Number.EPSILON) continue

      const componentRecords = new Set(target.records)
      const correctionMode = new Map<
        DynamicBodyRecord,
        { linearVelocity: Vec2; angularVelocity: number }
      >()
      for (const record of target.records) {
        const position = record.rigidBody.translation()
        correctionMode.set(record, {
          linearVelocity: {
            x: -(position.y - centerOfMass.y),
            y: position.x - centerOfMass.x,
          },
          angularVelocity: 0,
        })
      }

      for (let iteration = 0; iteration < ROD_SOLVER_ITERATIONS; iteration += 1) {
        let maximumRelativeSpeed = 0
        for (const rod of this.rods) {
          const firstBody = rod.first.body
          const secondBody = rod.second.body
          if (
            !firstBody ||
            !secondBody ||
            !componentRecords.has(firstBody) ||
            !componentRecords.has(secondBody)
          ) {
            continue
          }
          const frame = this.rodFrame(rod)
          const firstMode = correctionMode.get(firstBody)
          const secondMode = correctionMode.get(secondBody)
          if (!firstMode || !secondMode) continue
          const firstEndpointVelocity = {
            x:
              firstMode.linearVelocity.x - firstMode.angularVelocity * frame.firstEndpoint.offset.y,
            y:
              firstMode.linearVelocity.y + firstMode.angularVelocity * frame.firstEndpoint.offset.x,
          }
          const secondEndpointVelocity = {
            x:
              secondMode.linearVelocity.x -
              secondMode.angularVelocity * frame.secondEndpoint.offset.y,
            y:
              secondMode.linearVelocity.y +
              secondMode.angularVelocity * frame.secondEndpoint.offset.x,
          }
          const relativeSpeed =
            (secondEndpointVelocity.x - firstEndpointVelocity.x) * frame.direction.x +
            (secondEndpointVelocity.y - firstEndpointVelocity.y) * frame.direction.y
          maximumRelativeSpeed = Math.max(maximumRelativeSpeed, Math.abs(relativeSpeed))
          if (
            Math.abs(relativeSpeed) <= ROD_VELOCITY_TOLERANCE_MPS ||
            frame.effectiveInverseMass <= Number.EPSILON
          ) {
            continue
          }

          const impulseMagnitude = -relativeSpeed / frame.effectiveInverseMass
          const firstInverseMass = firstBody.rigidBody.effectiveInvMass()
          const secondInverseMass = secondBody.rigidBody.effectiveInvMass()
          firstMode.linearVelocity.x -= frame.direction.x * impulseMagnitude * firstInverseMass.x
          firstMode.linearVelocity.y -= frame.direction.y * impulseMagnitude * firstInverseMass.y
          secondMode.linearVelocity.x += frame.direction.x * impulseMagnitude * secondInverseMass.x
          secondMode.linearVelocity.y += frame.direction.y * impulseMagnitude * secondInverseMass.y

          const firstInertia = firstBody.rigidBody.effectiveAngularInertia()
          const secondInertia = secondBody.rigidBody.effectiveAngularInertia()
          const firstLever =
            frame.firstEndpoint.offset.x * frame.direction.y -
            frame.firstEndpoint.offset.y * frame.direction.x
          const secondLever =
            frame.secondEndpoint.offset.x * frame.direction.y -
            frame.secondEndpoint.offset.y * frame.direction.x
          if (firstInertia > Number.EPSILON) {
            firstMode.angularVelocity -= (impulseMagnitude * firstLever) / firstInertia
          }
          if (secondInertia > Number.EPSILON) {
            secondMode.angularVelocity += (impulseMagnitude * secondLever) / secondInertia
          }
        }
        if (maximumRelativeSpeed <= ROD_VELOCITY_TOLERANCE_MPS) break
      }

      let modeAngularMomentum = 0
      for (const record of target.records) {
        const mode = correctionMode.get(record)
        if (!mode) continue
        const position = record.rigidBody.translation()
        const offset = {
          x: position.x - centerOfMass.x,
          y: position.y - centerOfMass.y,
        }
        modeAngularMomentum +=
          record.entity.massKg *
            (offset.x * mode.linearVelocity.y - offset.y * mode.linearVelocity.x) +
          record.rigidBody.effectiveAngularInertia() * mode.angularVelocity
      }
      if (Math.abs(modeAngularMomentum) <= Number.EPSILON) continue
      const correctionScale = angularMomentumError / modeAngularMomentum

      for (const record of target.records) {
        const mode = correctionMode.get(record)
        if (!mode) continue
        const velocity = record.rigidBody.linvel()
        record.rigidBody.setLinvel(
          {
            x: velocity.x + correctionScale * mode.linearVelocity.x,
            y: velocity.y + correctionScale * mode.linearVelocity.y,
          },
          true,
        )
        this.setConstrainedAngularVelocity(
          record,
          record.rigidBody.angvel() + correctionScale * mode.angularVelocity,
        )
      }
    }
  }

  private springFrame(spring: SpringConnectorRecord): SpringFrame | null {
    const firstEndpoint = this.connectorEndpointState(spring.first)
    const secondEndpoint = this.connectorEndpointState(spring.second)
    const delta = {
      x: secondEndpoint.position.x - firstEndpoint.position.x,
      y: secondEndpoint.position.y - firstEndpoint.position.y,
    }
    const length = Math.hypot(delta.x, delta.y)
    if (length <= Number.EPSILON) return null
    const direction = { x: delta.x / length, y: delta.y / length }
    return {
      firstEndpoint,
      secondEndpoint,
      direction,
      length,
      effectiveInverseMass:
        this.directionalInverseMassAtPoint(spring.first, firstEndpoint.position, direction) +
        this.directionalInverseMassAtPoint(spring.second, secondEndpoint.position, direction),
    }
  }

  private applySpringImpulse(
    spring: SpringConnectorRecord,
    impulseMagnitude: number,
    frame: SpringFrame,
  ): void {
    if (!Number.isFinite(impulseMagnitude) || Math.abs(impulseMagnitude) <= MIN_SPRING_IMPULSE_NS) {
      return
    }
    const impulse = scaleForce(frame.direction, impulseMagnitude)
    if (!spring.first.fixed) {
      spring.first.rigidBody.applyImpulseAtPoint(impulse, frame.firstEndpoint.position, true)
    }
    if (!spring.second.fixed) {
      spring.second.rigidBody.applyImpulseAtPoint(
        scaleForce(impulse, -1),
        frame.secondEndpoint.position,
        true,
      )
    }
  }

  private recordSpringConstraintForces(): void {
    for (const spring of this.springs) {
      const firstEndpoint = this.connectorEndpointState(spring.first)
      const secondEndpoint = this.connectorEndpointState(spring.second)
      const force = springForceOnFirst(
        firstEndpoint.position,
        firstEndpoint.velocity,
        secondEndpoint.position,
        secondEndpoint.velocity,
        spring.restLength,
        spring.effectiveStiffness,
        spring.damping,
      )
      if (spring.first.body) {
        spring.first.body.constraintForce = addForce(spring.first.body.constraintForce, force)
      }
      if (spring.second.body) {
        spring.second.body.constraintForce = addForce(
          spring.second.body.constraintForce,
          scaleForce(force, -1),
        )
      }
    }
  }

  private applySpringElasticImpulse(durationSeconds: number): void {
    for (const spring of this.springs) {
      if (spring.effectiveStiffness === 0) continue
      const frame = this.springFrame(spring)
      if (!frame) continue
      const forceMagnitude = spring.effectiveStiffness * (frame.length - spring.restLength)
      this.applySpringImpulse(spring, forceMagnitude * durationSeconds, frame)
    }
  }

  private applySpringDampingImpulse(durationSeconds: number): void {
    for (const spring of this.springs) {
      const damping = spring.damping
      if (damping === 0) continue
      const frame = this.springFrame(spring)
      if (!frame || frame.effectiveInverseMass <= Number.EPSILON) continue
      const relativeSpeed =
        (frame.secondEndpoint.velocity.x - frame.firstEndpoint.velocity.x) * frame.direction.x +
        (frame.secondEndpoint.velocity.y - frame.firstEndpoint.velocity.y) * frame.direction.y
      const decay = Math.exp(-damping * frame.effectiveInverseMass * durationSeconds)
      const impulseMagnitude = (relativeSpeed * (1 - decay)) / frame.effectiveInverseMass
      this.applySpringImpulse(spring, impulseMagnitude, frame)
    }
  }

  private springBumperCaps(record: SpringBumperRecord): SpringBumperCap[] {
    const points = this.springBumperPoints(record)
    const axis = this.springBumperAxis(record)
    if (record.mode === 'double') {
      return [
        { center: points.a, outward: scaleVector(axis, -1), compressionScale: 0.5 },
        { center: points.b, outward: axis, compressionScale: 0.5 },
      ]
    }
    return [
      {
        center: record.freeKey === 'a' ? points.a : points.b,
        outward: axis,
        compressionScale: 1,
      },
    ]
  }

  private bodyVelocityAtPoint(body: DynamicBodyRecord, point: Vec2): Vec2 {
    const center = body.rigidBody.translation()
    const velocity = body.rigidBody.linvel()
    const angularVelocity = body.entity.rotationEnabled ? body.rigidBody.angvel() : 0
    const offset = { x: point.x - center.x, y: point.y - center.y }
    return {
      x: velocity.x - angularVelocity * offset.y,
      y: velocity.y + angularVelocity * offset.x,
    }
  }

  private applyConveyorGroundImpulses(): void {
    if (this.conveyorGroundColliders.length === 0) return
    for (const record of this.dynamicBodies.values()) {
      if (!record.collider || (record.entity.shape.type === 'circle' && !record.booleanResult)) {
        continue
      }
      for (const bodyCollider of record.colliders) {
        for (const conveyor of this.conveyorGroundColliders) {
          this.world.contactPair(bodyCollider, conveyor.collider, (manifold) => {
            let normalImpulseNs = 0
            for (let index = 0; index < manifold.numContacts(); index += 1) {
              normalImpulseNs += Math.abs(manifold.contactImpulse(index))
            }
            const pointCount = manifold.numSolverContacts()
            if (normalImpulseNs <= Number.EPSILON || pointCount === 0) return
            const contactPoint = { x: 0, y: 0 }
            for (let index = 0; index < pointCount; index += 1) {
              const point = manifold.solverContactPoint(index)
              contactPoint.x += point.x / pointCount
              contactPoint.y += point.y / pointCount
            }
            const friction = combinedPathFriction(record.entity.material, conveyor.material)
            if (friction <= Number.EPSILON) return
            const inverseMass = this.bodyDirectionalInverseMassAtPoint(
              record,
              contactPoint,
              conveyor.tangent,
            )
            if (inverseMass <= Number.EPSILON) return
            const velocity = this.bodyVelocityAtPoint(record, contactPoint)
            const slipSpeed = dotVectors(velocity, conveyor.tangent) - conveyor.speedMps
            const maximumImpulse = friction * normalImpulseNs
            const impulseMagnitude = Math.max(
              -maximumImpulse,
              Math.min(maximumImpulse, -slipSpeed / inverseMass),
            )
            if (Math.abs(impulseMagnitude) <= Number.EPSILON) return
            record.rigidBody.applyImpulseAtPoint(
              scaleVector(conveyor.tangent, impulseMagnitude),
              contactPoint,
              true,
            )
          })
        }
      }
    }
  }

  private springBumperCapVelocity(record: SpringBumperRecord, cap: SpringBumperCap): Vec2 {
    if (record.mode === 'double' || !record.attached) return { x: 0, y: 0 }
    const anchor = this.connectorEndpointState(record.attached)
    const angularVelocity = record.attached.rigidBody.angvel()
    const offset = { x: cap.center.x - anchor.position.x, y: cap.center.y - anchor.position.y }
    return {
      x: anchor.velocity.x - angularVelocity * offset.y,
      y: anchor.velocity.y + angularVelocity * offset.x,
    }
  }

  private captureSpringBumperCapStarts(): void {
    for (const record of this.springBumpers) {
      record.substepStartCapCenters = this.springBumperCaps(record).map((cap) => ({
        ...cap.center,
      }))
    }
  }

  private beginSpringBumperSimulation(): void {
    for (const record of this.springBumpers) {
      if (record.simulationStarted) continue
      record.simulationStarted = true
    }
  }

  private collectSpringBumperGroundContact(
    record: SpringBumperRecord,
    cap: SpringBumperCap,
    capIndex: number,
  ): SpringBumperGroundContact | null {
    const tangent = { x: -cap.outward.y, y: cap.outward.x }
    const capVelocity = this.springBumperCapVelocity(record, cap)
    const previousCenter = record.substepStartCapCenters[capIndex] ?? {
      x: cap.center.x - capVelocity.x * this.currentTimeStep,
      y: cap.center.y - capVelocity.y * this.currentTimeStep,
    }
    const relativeNormalSpeed = -dotVectors(capVelocity, cap.outward)
    const approaching = relativeNormalSpeed < -FLEXIBLE_VELOCITY_TOLERANCE_MPS
    const currentCompressionM = this.springBumperCompression(record)
    let best: SpringBumperGroundContact | null = null

    for (const ground of this.groundsByCollider.values()) {
      const sweepMinX = Math.min(previousCenter.x, cap.center.x) - record.entity.radiusM
      const sweepMaxX = Math.max(previousCenter.x, cap.center.x) + record.entity.radiusM
      const sweepMinY = Math.min(previousCenter.y, cap.center.y) - record.entity.radiusM
      const sweepMaxY = Math.max(previousCenter.y, cap.center.y) + record.entity.radiusM
      if (
        sweepMaxX < ground.minX ||
        sweepMinX > ground.maxX ||
        sweepMaxY < ground.minY ||
        sweepMinY > ground.maxY
      ) {
        continue
      }

      const evaluate = (center: Vec2) => {
        const closest = ground.piece.path.closestPoint(center)
        const relative = {
          x: closest.point.x - center.x,
          y: closest.point.y - center.y,
        }
        return {
          point: closest.point,
          gapM: dotVectors(relative, cap.outward),
          lateralDistanceM: Math.abs(dotVectors(relative, tangent)),
        }
      }
      const previous = evaluate(previousCenter)
      const current = evaluate(cap.center)
      if (current.lateralDistanceM > record.entity.radiusM + CONNECTOR_CONTACT_TOLERANCE_M) {
        continue
      }
      if (record.attached && this.connectorEndpointMatchesGround(record.attached, ground)) {
        const anchor = this.connectorEndpointState(record.attached).position
        if (
          Math.hypot(current.point.x - anchor.x, current.point.y - anchor.y) <=
          record.entity.radiusM + CONNECTOR_CONTACT_TOLERANCE_M
        ) {
          continue
        }
      }

      const requestedInwardTravelM = record.inwardTravelM - current.gapM / cap.compressionScale
      const crossedFromOutside =
        approaching &&
        previous.gapM >= -CONNECTOR_CONTACT_TOLERANCE_M &&
        current.gapM <= CONNECTOR_CONTACT_TOLERANCE_M
      const restingOnSurface =
        Math.abs(current.gapM) <= CONNECTOR_CONTACT_TOLERANCE_M &&
        (approaching ||
          record.inwardTravelM > FLEXIBLE_POSITION_TOLERANCE_M ||
          currentCompressionM > FLEXIBLE_POSITION_TOLERANCE_M)
      const releasingStoredTravel =
        record.inwardTravelM > FLEXIBLE_POSITION_TOLERANCE_M &&
        requestedInwardTravelM >= -CONNECTOR_CONTACT_TOLERANCE_M
      if (!crossedFromOutside && !restingOnSurface && !releasingStoredTravel) continue
      if (requestedInwardTravelM < -CONNECTOR_CONTACT_TOLERANCE_M) continue
      const contact: SpringBumperGroundContact = {
        kind: 'ground',
        ground,
        cap,
        inwardTravelM: Math.min(record.initialLengthM, requestedInwardTravelM),
        compressionRateMps: -relativeNormalSpeed / cap.compressionScale,
        contactPoint: current.point,
      }
      if (!best || contact.inwardTravelM > best.inwardTravelM) best = contact
    }
    return best
  }

  private collectSpringBumperContacts(record: SpringBumperRecord): SpringBumperContact[] {
    const contacts: SpringBumperContact[] = []
    const attachedBodyId =
      record.attached?.definition.type === 'body' ? record.attached.definition.bodyId : null
    for (const [capIndex, cap] of this.springBumperCaps(record).entries()) {
      const tangent = { x: -cap.outward.y, y: cap.outward.x }
      const capVelocity = this.springBumperCapVelocity(record, cap)
      for (const [bodyId, body] of this.dynamicBodies) {
        if (bodyId === attachedBodyId || !body.collider) continue
        if (body.entity.shape.type === 'circle' && !body.entity.shape.collisionEnabled) continue
        const position = body.rigidBody.translation()
        const angle = body.rigidBody.rotation()
        const supportNormal = this.bodySupportRadius(
          body.entity,
          angle,
          cap.outward,
          body.booleanResult,
        )
        const supportTangent = this.bodySupportRadius(
          body.entity,
          angle,
          tangent,
          body.booleanResult,
        )
        const relative = { x: position.x - cap.center.x, y: position.y - cap.center.y }
        if (
          record.mode === 'double' &&
          dotVectors(
            { x: position.x - record.center.x, y: position.y - record.center.y },
            cap.outward,
          ) < -CONNECTOR_CONTACT_TOLERANCE_M
        ) {
          continue
        }
        const lateralDistance = Math.abs(dotVectors(relative, tangent))
        if (lateralDistance > supportTangent + record.entity.radiusM) continue
        const gapM = dotVectors(relative, cap.outward) - supportNormal
        const contactPoint = {
          x: position.x - cap.outward.x * supportNormal,
          y: position.y - cap.outward.y * supportNormal,
        }
        const bodyVelocity = this.bodyVelocityAtPoint(body, contactPoint)
        const relativeNormalSpeed = dotVectors(
          {
            x: bodyVelocity.x - capVelocity.x,
            y: bodyVelocity.y - capVelocity.y,
          },
          cap.outward,
        )
        const previousGapM = gapM - relativeNormalSpeed * this.currentTimeStep
        const approaching = relativeNormalSpeed < -FLEXIBLE_VELOCITY_TOLERANCE_MPS
        const requestedInwardTravelM = record.inwardTravelM - gapM / cap.compressionScale
        const inwardTravelM = Math.min(record.initialLengthM, requestedInwardTravelM)
        const currentCompressionM = this.springBumperCompression(record)
        if (
          requestedInwardTravelM < -CONNECTOR_CONTACT_TOLERANCE_M ||
          (!approaching &&
            record.inwardTravelM <= FLEXIBLE_POSITION_TOLERANCE_M &&
            currentCompressionM <= FLEXIBLE_POSITION_TOLERANCE_M) ||
          (previousGapM < -CONNECTOR_CONTACT_TOLERANCE_M &&
            record.inwardTravelM <= FLEXIBLE_POSITION_TOLERANCE_M &&
            currentCompressionM <= FLEXIBLE_POSITION_TOLERANCE_M)
        ) {
          continue
        }
        contacts.push({
          kind: 'body',
          body,
          bodyId,
          cap,
          inwardTravelM,
          compressionRateMps: -relativeNormalSpeed / cap.compressionScale,
          contactPoint,
        })
      }
      const groundContact = this.collectSpringBumperGroundContact(record, cap, capIndex)
      if (groundContact) contacts.push(groundContact)
    }
    return contacts
  }

  private synchronizeDoubleSpringBumperToContacts(
    record: SpringBumperRecord,
    contacts: SpringBumperContact[],
  ): boolean {
    if (record.mode !== 'double') return false
    const axis = this.springBumperAxis(record)
    let first: SpringBumperContact | null = null
    let second: SpringBumperContact | null = null
    for (const contact of contacts) {
      if (dotVectors(contact.cap.outward, axis) < 0) {
        if (!first || contact.inwardTravelM > first.inwardTravelM) first = contact
      } else if (!second || contact.inwardTravelM > second.inwardTravelM) {
        second = contact
      }
    }
    if (!first || !second) return false

    const separationM = Math.min(
      record.initialLengthM,
      Math.max(
        0,
        dotVectors(
          {
            x: second.contactPoint.x - first.contactPoint.x,
            y: second.contactPoint.y - first.contactPoint.y,
          },
          axis,
        ),
      ),
    )
    record.center = {
      x: (first.contactPoint.x + second.contactPoint.x) / 2,
      y: (first.contactPoint.y + second.contactPoint.y) / 2,
    }
    record.inwardTravelM = record.initialLengthM - separationM
    return true
  }

  private resolveSpringBumperContacts(): void {
    for (const record of this.springBumpers) {
      const contacts = this.collectSpringBumperContacts(record)
      if (!this.synchronizeDoubleSpringBumperToContacts(record, contacts)) {
        record.inwardTravelM = Math.min(
          record.initialLengthM,
          Math.max(0, ...contacts.map((contact) => contact.inwardTravelM)),
        )
      }
      if (record.inwardTravelM < record.initialLengthM - FLEXIBLE_POSITION_TOLERANCE_M) continue

      for (const contact of this.collectSpringBumperContacts(record)) {
        const attachedState = record.attached ? this.connectorEndpointState(record.attached) : null
        if (contact.kind === 'ground') {
          if (!record.attached || !attachedState) continue
          const closest = contact.ground.piece.path.closestPoint(contact.cap.center)
          const gapM = dotVectors(
            {
              x: closest.point.x - contact.cap.center.x,
              y: closest.point.y - contact.cap.center.y,
            },
            contact.cap.outward,
          )
          if (gapM >= -FLEXIBLE_POSITION_TOLERANCE_M) continue
          const inverseMass = this.directionalInverseMassAtPoint(
            record.attached,
            attachedState.position,
            contact.cap.outward,
          )
          if (inverseMass <= Number.EPSILON) continue
          this.applyConnectorPositionMultiplier(
            record.attached,
            attachedState,
            scaleVector(contact.cap.outward, -1),
            -gapM / inverseMass,
          )
          const capVelocity = this.springBumperCapVelocity(record, contact.cap)
          const relativeSpeed = -dotVectors(capVelocity, contact.cap.outward)
          if (relativeSpeed >= 0) continue
          record.attached.rigidBody.applyImpulseAtPoint(
            scaleVector(contact.cap.outward, relativeSpeed / inverseMass),
            attachedState.position,
            true,
          )
          continue
        }

        const position = contact.body.rigidBody.translation()
        const support = this.bodySupportRadius(
          contact.body.entity,
          contact.body.rigidBody.rotation(),
          contact.cap.outward,
          contact.body.booleanResult,
        )
        const relative = {
          x: position.x - contact.cap.center.x,
          y: position.y - contact.cap.center.y,
        }
        const gapM = dotVectors(relative, contact.cap.outward) - support
        if (gapM >= -FLEXIBLE_POSITION_TOLERANCE_M) continue
        const bodyInverseMass = this.bodyDirectionalInverseMassAtPoint(
          contact.body,
          contact.contactPoint,
          contact.cap.outward,
        )
        const attachedInverseMass =
          record.attached && attachedState
            ? this.directionalInverseMassAtPoint(
                record.attached,
                attachedState.position,
                contact.cap.outward,
              )
            : 0
        const inverseMass = bodyInverseMass + attachedInverseMass
        if (inverseMass <= Number.EPSILON) continue
        const multiplier = -gapM / inverseMass
        this.applyBodyPositionMultiplier(
          contact.body,
          contact.contactPoint,
          contact.cap.outward,
          multiplier,
        )
        if (record.attached && attachedState) {
          this.applyConnectorPositionMultiplier(
            record.attached,
            attachedState,
            scaleVector(contact.cap.outward, -1),
            multiplier,
          )
        }

        const bodyVelocity = this.bodyVelocityAtPoint(contact.body, contact.contactPoint)
        const capVelocity = this.springBumperCapVelocity(record, contact.cap)
        const relativeSpeed = dotVectors(
          { x: bodyVelocity.x - capVelocity.x, y: bodyVelocity.y - capVelocity.y },
          contact.cap.outward,
        )
        if (relativeSpeed >= 0) continue
        const impulseMagnitude = -relativeSpeed / inverseMass
        const impulse = scaleVector(contact.cap.outward, impulseMagnitude)
        contact.body.rigidBody.applyImpulseAtPoint(impulse, contact.contactPoint, true)
        if (record.attached && attachedState) {
          record.attached.rigidBody.applyImpulseAtPoint(
            scaleVector(impulse, -1),
            attachedState.position,
            true,
          )
        }
      }
    }
  }

  private refreshSpringBumperCompression(): void {
    for (const record of this.springBumpers) {
      const contacts = this.collectSpringBumperContacts(record)
      if (!this.synchronizeDoubleSpringBumperToContacts(record, contacts)) {
        record.inwardTravelM = Math.min(
          record.initialLengthM,
          Math.max(0, ...contacts.map((contact) => contact.inwardTravelM)),
        )
      }
    }
  }

  private applySpringBumperImpulse(durationSeconds: number): void {
    for (const record of this.springBumpers) {
      const compressionM = this.springBumperCompression(record)
      if (compressionM <= FLEXIBLE_POSITION_TOLERANCE_M) continue
      const contacts = this.collectSpringBumperContacts(record).filter(
        (contact) =>
          Math.abs(contact.inwardTravelM - record.inwardTravelM) <= CONNECTOR_CONTACT_TOLERANCE_M,
      )
      if (contacts.length === 0) continue
      if (record.mode === 'double') {
        const axis = this.springBumperAxis(record)
        const hasFirstCapContact = contacts.some(
          (contact) => dotVectors(contact.cap.outward, axis) < 0,
        )
        const hasSecondCapContact = contacts.some(
          (contact) => dotVectors(contact.cap.outward, axis) > 0,
        )
        if (!hasFirstCapContact || !hasSecondCapContact) continue
      }
      const compressionRate = Math.max(...contacts.map((contact) => contact.compressionRateMps))
      const generalizedForce = Math.max(
        0,
        record.effectiveStiffness * compressionM + record.damping * compressionRate,
      )
      const contactsPerCap = new Map<SpringBumperCap, number>()
      for (const contact of contacts) {
        contactsPerCap.set(contact.cap, (contactsPerCap.get(contact.cap) ?? 0) + 1)
      }
      for (const contact of contacts) {
        const forceScale = 1 / (contactsPerCap.get(contact.cap) ?? 1)
        const impulse = scaleVector(
          contact.cap.outward,
          generalizedForce * forceScale * durationSeconds,
        )
        if (contact.kind === 'body') {
          contact.body.rigidBody.applyImpulseAtPoint(impulse, contact.contactPoint, true)
          contact.body.constraintForce = addForce(contact.body.constraintForce, {
            x: impulse.x / this.currentTimeStep,
            y: impulse.y / this.currentTimeStep,
          })
        }
        if (!record.attached) continue
        const anchor = this.connectorEndpointState(record.attached)
        record.attached.rigidBody.applyImpulseAtPoint(
          scaleVector(impulse, -1),
          anchor.position,
          true,
        )
        if (record.attached.body) {
          record.attached.body.constraintForce = addForce(
            record.attached.body.constraintForce,
            scaleVector(
              { x: impulse.x / this.currentTimeStep, y: impulse.y / this.currentTimeStep },
              -1,
            ),
          )
        }
      }
    }
  }

  private applyConnectorPositionMultiplier(
    endpoint: ConnectorRuntimeEndpoint,
    endpointState: ConnectorEndpointState,
    gradient: Vec2,
    multiplier: number,
  ): void {
    if (endpoint.fixed || !Number.isFinite(multiplier)) return
    const inverseMass = endpoint.rigidBody.effectiveInvMass()
    const translation = endpoint.rigidBody.translation()
    endpoint.rigidBody.setTranslation(
      {
        x: translation.x + gradient.x * multiplier * inverseMass.x,
        y: translation.y + gradient.y * multiplier * inverseMass.y,
      },
      true,
    )
    const inertia = endpoint.rigidBody.effectiveAngularInertia()
    if (inertia <= Number.EPSILON) return
    const leverArm = endpointState.offset.x * gradient.y - endpointState.offset.y * gradient.x
    endpoint.rigidBody.setRotation(
      endpoint.rigidBody.rotation() + (leverArm * multiplier) / inertia,
      true,
    )
  }

  private applyConnectorVelocityMultiplier(
    endpoint: ConnectorRuntimeEndpoint,
    endpointState: ConnectorEndpointState,
    gradient: Vec2,
    multiplier: number,
  ): void {
    if (endpoint.fixed || !Number.isFinite(multiplier)) return
    const impulse = scaleVector(gradient, multiplier)
    endpoint.rigidBody.applyImpulseAtPoint(impulse, endpointState.position, true)
    if (endpoint.body) {
      endpoint.body.constraintForce = addForce(endpoint.body.constraintForce, {
        x: impulse.x / this.currentTimeStep,
        y: impulse.y / this.currentTimeStep,
      })
      if (!endpoint.body.entity.rotationEnabled)
        this.setConstrainedAngularVelocity(endpoint.body, 0)
    }
  }

  private flexibleChain(record: FlexibleConnectorRecord): ConnectorRuntimeEndpoint[] {
    return record.chain
  }

  private flexibleRopeScratch(
    record: FlexibleConnectorRecord,
    chain: ConnectorRuntimeEndpoint[],
  ): FlexibleRopeScratch {
    if (record.ropeScratch) return record.ropeScratch
    const makeVector = (): Vec2 => ({ x: 0, y: 0 })
    const makeState = (): ConnectorEndpointState => ({
      position: makeVector(),
      velocity: makeVector(),
      offset: makeVector(),
    })
    record.ropeScratch = {
      positions: chain.map(makeVector),
      velocities: chain.map(makeVector),
      directions: Array.from({ length: chain.length - 1 }, makeVector),
      gradients: chain.map(makeVector),
      states: chain.map(makeState),
      pointMassInverseMasses: chain.map((endpoint) => {
        if (
          endpoint.fixed ||
          endpoint.body ||
          Math.abs(endpoint.localAnchor.x) > Number.EPSILON ||
          Math.abs(endpoint.localAnchor.y) > Number.EPSILON
        ) {
          return null
        }
        const inverseMass = endpoint.rigidBody.effectiveInvMass()
        return { x: inverseMass.x, y: inverseMass.y }
      }),
    }
    return record.ropeScratch
  }

  private flexibleRopeLengthTolerance(record: FlexibleConnectorRecord): number {
    const maximumLength = record.linkLength * (record.nodes.length + 1)
    return Math.max(
      FLEXIBLE_ROPE_ABSOLUTE_LENGTH_TOLERANCE_M,
      maximumLength * FLEXIBLE_ROPE_RELATIVE_LENGTH_TOLERANCE,
    )
  }

  private flexibleRopeLengthIsValid(record: FlexibleConnectorRecord): boolean {
    const chain = this.flexibleChain(record)
    const states = this.flexibleRopeScratch(record, chain).states
    const lengthTolerance = this.flexibleRopeLengthTolerance(record)
    const linkTolerance = lengthTolerance / Math.max(1, chain.length - 1)
    let totalLength = 0
    for (let index = 0; index < chain.length; index += 1) {
      this.writeConnectorEndpointState(chain[index]!, states[index]!)
      if (index === 0) continue
      const first = states[index - 1]!.position
      const second = states[index]!.position
      const linkLength = Math.hypot(second.x - first.x, second.y - first.y)
      if (linkLength > record.linkLength + linkTolerance) return false
      totalLength += linkLength
    }
    return totalLength <= record.linkLength * (chain.length - 1) + lengthTolerance
  }

  private flexibleLinkFrame(
    first: ConnectorRuntimeEndpoint,
    second: ConnectorRuntimeEndpoint,
  ): SpringFrame | null {
    const firstEndpoint = this.connectorEndpointState(first)
    const secondEndpoint = this.connectorEndpointState(second)
    const delta = {
      x: secondEndpoint.position.x - firstEndpoint.position.x,
      y: secondEndpoint.position.y - firstEndpoint.position.y,
    }
    const length = Math.hypot(delta.x, delta.y)
    if (length <= Number.EPSILON) return null
    const direction = { x: delta.x / length, y: delta.y / length }
    return {
      firstEndpoint,
      secondEndpoint,
      direction,
      length,
      effectiveInverseMass:
        this.directionalInverseMassAtPoint(first, firstEndpoint.position, direction) +
        this.directionalInverseMassAtPoint(second, secondEndpoint.position, direction),
    }
  }

  private solveFlexibleRopeTotalLength(
    record: FlexibleConnectorRecord,
    chain: ConnectorRuntimeEndpoint[],
    velocityOnly: boolean,
    endpointMotionOnly = false,
  ): number {
    if (record.kind !== 'rope') return 0
    const scratch = this.flexibleRopeScratch(record, chain)
    const states = scratch.states
    const directions = scratch.directions
    const gradients = scratch.gradients
    const pointMassInverseMasses = scratch.pointMassInverseMasses
    for (let index = 0; index < chain.length; index += 1) {
      this.writeConnectorEndpointState(chain[index]!, states[index]!)
    }
    let totalLength = 0
    for (let index = 0; index < states.length - 1; index += 1) {
      const first = states[index]!
      const second = states[index + 1]!
      const delta = {
        x: second.position.x - first.position.x,
        y: second.position.y - first.position.y,
      }
      const length = Math.hypot(delta.x, delta.y)
      const direction = directions[index]!
      if (length <= Number.EPSILON) {
        direction.x = 1
        direction.y = 0
      } else {
        direction.x = delta.x / length
        direction.y = delta.y / length
      }
      totalLength += length
    }
    const maximumLength = record.linkLength * (chain.length - 1)
    const lengthTolerance = this.flexibleRopeLengthTolerance(record)
    for (let index = 0; index < states.length; index += 1) {
      const gradient = gradients[index]!
      if (index === 0) {
        gradient.x = -directions[0]!.x
        gradient.y = -directions[0]!.y
      } else if (index === states.length - 1) {
        gradient.x = directions[index - 1]!.x
        gradient.y = directions[index - 1]!.y
      } else {
        gradient.x = directions[index - 1]!.x - directions[index]!.x
        gradient.y = directions[index - 1]!.y - directions[index]!.y
      }
    }
    let inverseMass = 0
    let constraintSpeed = 0
    for (let index = 0; index < chain.length; index += 1) {
      const gradient = gradients[index]!
      const pointMassInverseMass = pointMassInverseMasses[index]
      // The contact pass can intentionally solve the global rope-length constraint with only
      // the real endpoints. Internal node velocities must then be excluded from Cdot as well as
      // from the effective mass; otherwise their bend motion is converted into endpoint impulse.
      if (pointMassInverseMass && endpointMotionOnly) continue
      inverseMass += pointMassInverseMass
        ? gradient.x ** 2 * pointMassInverseMass.x + gradient.y ** 2 * pointMassInverseMass.y
        : this.directionalInverseMassAtPoint(chain[index]!, states[index]!.position, gradient)
      constraintSpeed +=
        states[index]!.velocity.x * gradient.x + states[index]!.velocity.y * gradient.y
    }
    if (inverseMass <= Number.EPSILON) return Math.max(0, totalLength - maximumLength)
    if (velocityOnly) {
      if (totalLength < maximumLength - lengthTolerance || constraintSpeed <= 0) {
        return 0
      }
      const multiplier = -constraintSpeed / inverseMass
      for (let index = 0; index < chain.length; index += 1) {
        const endpoint = chain[index]!
        const gradient = gradients[index]!
        if (pointMassInverseMasses[index] && endpointMotionOnly) continue
        if (pointMassInverseMasses[index]) {
          endpoint.rigidBody.applyImpulse(
            { x: gradient.x * multiplier, y: gradient.y * multiplier },
            true,
          )
        } else {
          this.applyConnectorVelocityMultiplier(endpoint, states[index]!, gradient, multiplier)
        }
      }
      return Math.abs(constraintSpeed)
    }
    const error = totalLength - maximumLength
    if (error <= lengthTolerance) return Math.max(0, error)
    const multiplier = -error / inverseMass
    for (let index = 0; index < chain.length; index += 1) {
      if (pointMassInverseMasses[index] && endpointMotionOnly) continue
      this.applyConnectorPositionMultiplier(
        chain[index]!,
        states[index]!,
        gradients[index]!,
        multiplier,
      )
    }
    return error
  }

  private solveFlexibleRopeDistanceLimit(
    first: ConnectorRuntimeEndpoint,
    second: ConnectorRuntimeEndpoint,
    maximumLength: number,
    tolerance: number,
    velocityOnly: boolean,
  ): number {
    const frame = this.flexibleLinkFrame(first, second)
    if (!frame || frame.effectiveInverseMass <= Number.EPSILON) return 0
    const error = frame.length - maximumLength
    if (velocityOnly) {
      if (error < -tolerance) return 0
      const relativeSpeed = dotVectors(
        {
          x: frame.secondEndpoint.velocity.x - frame.firstEndpoint.velocity.x,
          y: frame.secondEndpoint.velocity.y - frame.firstEndpoint.velocity.y,
        },
        frame.direction,
      )
      if (relativeSpeed <= FLEXIBLE_VELOCITY_TOLERANCE_MPS) return 0
      const multiplier = -relativeSpeed / frame.effectiveInverseMass
      this.applyConnectorVelocityMultiplier(
        first,
        frame.firstEndpoint,
        scaleVector(frame.direction, -1),
        multiplier,
      )
      this.applyConnectorVelocityMultiplier(
        second,
        frame.secondEndpoint,
        frame.direction,
        multiplier,
      )
      return relativeSpeed
    }
    if (error <= tolerance) return Math.max(0, error)
    const multiplier = -error / frame.effectiveInverseMass
    this.applyConnectorPositionMultiplier(
      first,
      frame.firstEndpoint,
      scaleVector(frame.direction, -1),
      multiplier,
    )
    this.applyConnectorPositionMultiplier(second, frame.secondEndpoint, frame.direction, multiplier)
    return error
  }

  private solveFlexibleRopeLinks(
    record: FlexibleConnectorRecord,
    chain: ConnectorRuntimeEndpoint[],
    reverse: boolean,
    velocityOnly: boolean,
  ): number {
    if (!velocityOnly) return this.solveFlexibleRopeLinkPositions(record, chain, reverse)
    return this.solveFlexibleRopeLinkVelocities(record, chain, reverse)
  }

  private solveFlexibleRopeLinkVelocities(
    record: FlexibleConnectorRecord,
    chain: ConnectorRuntimeEndpoint[],
    reverse: boolean,
  ): number {
    const scratch = this.flexibleRopeScratch(record, chain)
    const { directions, gradients, pointMassInverseMasses, positions, states, velocities } = scratch
    const linkCount = chain.length - 1
    const linkTolerance = this.flexibleRopeLengthTolerance(record) / linkCount
    for (let index = 0; index < chain.length; index += 1) {
      const state = this.writeConnectorEndpointState(chain[index]!, states[index]!)
      positions[index]!.x = state.position.x
      positions[index]!.y = state.position.y
      velocities[index]!.x = state.velocity.x
      velocities[index]!.y = state.velocity.y
    }

    let maximumError = 0
    for (let offset = 0; offset < linkCount; offset += 1) {
      const index = reverse ? linkCount - 1 - offset : offset
      const firstPosition = positions[index]!
      const secondPosition = positions[index + 1]!
      const deltaX = secondPosition.x - firstPosition.x
      const deltaY = secondPosition.y - firstPosition.y
      const length = Math.hypot(deltaX, deltaY)
      if (length <= Number.EPSILON || length < record.linkLength - linkTolerance) continue
      const direction = { x: deltaX / length, y: deltaY / length }
      const firstVelocity = velocities[index]!
      const secondVelocity = velocities[index + 1]!
      const relativeSpeed =
        (secondVelocity.x - firstVelocity.x) * direction.x +
        (secondVelocity.y - firstVelocity.y) * direction.y
      maximumError = Math.max(maximumError, relativeSpeed)
      if (relativeSpeed <= FLEXIBLE_VELOCITY_TOLERANCE_MPS) continue
      const firstInverseMass = pointMassInverseMasses[index]
      const secondInverseMass = pointMassInverseMasses[index + 1]
      const effectiveInverseMass =
        (firstInverseMass
          ? direction.x ** 2 * firstInverseMass.x + direction.y ** 2 * firstInverseMass.y
          : this.directionalInverseMassAtPoint(chain[index]!, firstPosition, direction)) +
        (secondInverseMass
          ? direction.x ** 2 * secondInverseMass.x + direction.y ** 2 * secondInverseMass.y
          : this.directionalInverseMassAtPoint(chain[index + 1]!, secondPosition, direction))
      if (effectiveInverseMass <= Number.EPSILON) continue
      const multiplier = -relativeSpeed / effectiveInverseMass

      if (firstInverseMass) {
        firstVelocity.x -= direction.x * multiplier * firstInverseMass.x
        firstVelocity.y -= direction.y * multiplier * firstInverseMass.y
      } else {
        this.applyConnectorVelocityMultiplier(
          chain[index]!,
          states[index]!,
          scaleVector(direction, -1),
          multiplier,
        )
        const state = this.writeConnectorEndpointState(chain[index]!, states[index]!)
        firstVelocity.x = state.velocity.x
        firstVelocity.y = state.velocity.y
      }
      if (secondInverseMass) {
        secondVelocity.x += direction.x * multiplier * secondInverseMass.x
        secondVelocity.y += direction.y * multiplier * secondInverseMass.y
      } else {
        this.applyConnectorVelocityMultiplier(
          chain[index + 1]!,
          states[index + 1]!,
          direction,
          multiplier,
        )
        const state = this.writeConnectorEndpointState(chain[index + 1]!, states[index + 1]!)
        secondVelocity.x = state.velocity.x
        secondVelocity.y = state.velocity.y
      }
    }
    let totalLength = 0
    for (let index = 0; index < linkCount; index += 1) {
      const first = positions[index]!
      const second = positions[index + 1]!
      const deltaX = second.x - first.x
      const deltaY = second.y - first.y
      const length = Math.hypot(deltaX, deltaY)
      const direction = directions[index]!
      if (length > Number.EPSILON) {
        direction.x = deltaX / length
        direction.y = deltaY / length
      } else {
        direction.x = 1
        direction.y = 0
      }
      totalLength += length
    }
    for (let index = 0; index < chain.length; index += 1) {
      const gradient = gradients[index]!
      if (index === 0) {
        gradient.x = -directions[0]!.x
        gradient.y = -directions[0]!.y
      } else if (index === chain.length - 1) {
        gradient.x = directions[index - 1]!.x
        gradient.y = directions[index - 1]!.y
      } else {
        gradient.x = directions[index - 1]!.x - directions[index]!.x
        gradient.y = directions[index - 1]!.y - directions[index]!.y
      }
    }
    const maximumLength = record.linkLength * linkCount
    const lengthTolerance = this.flexibleRopeLengthTolerance(record)
    let totalInverseMass = 0
    let totalStretchSpeed = 0
    for (let index = 0; index < chain.length; index += 1) {
      const gradient = gradients[index]!
      const inverseMass = pointMassInverseMasses[index]
      totalInverseMass += inverseMass
        ? gradient.x ** 2 * inverseMass.x + gradient.y ** 2 * inverseMass.y
        : this.directionalInverseMassAtPoint(chain[index]!, positions[index]!, gradient)
      totalStretchSpeed += velocities[index]!.x * gradient.x + velocities[index]!.y * gradient.y
    }
    if (
      totalLength >= maximumLength - lengthTolerance &&
      totalStretchSpeed > FLEXIBLE_VELOCITY_TOLERANCE_MPS &&
      totalInverseMass > Number.EPSILON
    ) {
      const multiplier = -totalStretchSpeed / totalInverseMass
      maximumError = Math.max(maximumError, totalStretchSpeed)
      for (let index = 0; index < chain.length; index += 1) {
        const gradient = gradients[index]!
        const inverseMass = pointMassInverseMasses[index]
        const velocity = velocities[index]!
        if (inverseMass) {
          velocity.x += gradient.x * multiplier * inverseMass.x
          velocity.y += gradient.y * multiplier * inverseMass.y
          continue
        }
        this.applyConnectorVelocityMultiplier(chain[index]!, states[index]!, gradient, multiplier)
        const state = this.writeConnectorEndpointState(chain[index]!, states[index]!)
        velocity.x = state.velocity.x
        velocity.y = state.velocity.y
      }
    }
    for (let index = 0; index < chain.length; index += 1) {
      if (!pointMassInverseMasses[index]) continue
      chain[index]!.rigidBody.setLinvel(velocities[index]!, true)
    }
    return maximumError
  }

  private solveFlexibleRopeLinkPositions(
    record: FlexibleConnectorRecord,
    chain: ConnectorRuntimeEndpoint[],
    reverse: boolean,
  ): number {
    const scratch = this.flexibleRopeScratch(record, chain)
    const { pointMassInverseMasses, positions, states } = scratch
    const linkCount = chain.length - 1
    const linkTolerance = this.flexibleRopeLengthTolerance(record) / linkCount
    for (let index = 0; index < chain.length; index += 1) {
      const state = this.writeConnectorEndpointState(chain[index]!, states[index]!)
      positions[index]!.x = state.position.x
      positions[index]!.y = state.position.y
    }

    let maximumError = 0
    for (let offset = 0; offset < linkCount; offset += 1) {
      const index = reverse ? linkCount - 1 - offset : offset
      const firstPosition = positions[index]!
      const secondPosition = positions[index + 1]!
      const deltaX = secondPosition.x - firstPosition.x
      const deltaY = secondPosition.y - firstPosition.y
      const length = Math.hypot(deltaX, deltaY)
      if (length <= Number.EPSILON) continue
      const error = length - record.linkLength
      maximumError = Math.max(maximumError, Math.max(0, error))
      if (error <= linkTolerance) continue

      const direction = { x: deltaX / length, y: deltaY / length }
      const firstInverseMass = pointMassInverseMasses[index]
      const secondInverseMass = pointMassInverseMasses[index + 1]
      const effectiveInverseMass =
        (firstInverseMass
          ? direction.x ** 2 * firstInverseMass.x + direction.y ** 2 * firstInverseMass.y
          : this.directionalInverseMassAtPoint(chain[index]!, firstPosition, direction)) +
        (secondInverseMass
          ? direction.x ** 2 * secondInverseMass.x + direction.y ** 2 * secondInverseMass.y
          : this.directionalInverseMassAtPoint(chain[index + 1]!, secondPosition, direction))
      if (effectiveInverseMass <= Number.EPSILON) continue
      const multiplier = (-error * FLEXIBLE_ROPE_LINK_OVER_RELAXATION) / effectiveInverseMass

      if (firstInverseMass) {
        firstPosition.x -= direction.x * multiplier * firstInverseMass.x
        firstPosition.y -= direction.y * multiplier * firstInverseMass.y
      } else {
        this.applyConnectorPositionMultiplier(
          chain[index]!,
          states[index]!,
          scaleVector(direction, -1),
          multiplier,
        )
        const state = this.writeConnectorEndpointState(chain[index]!, states[index]!)
        firstPosition.x = state.position.x
        firstPosition.y = state.position.y
      }
      if (secondInverseMass) {
        secondPosition.x += direction.x * multiplier * secondInverseMass.x
        secondPosition.y += direction.y * multiplier * secondInverseMass.y
      } else {
        this.applyConnectorPositionMultiplier(
          chain[index + 1]!,
          states[index + 1]!,
          direction,
          multiplier,
        )
        const state = this.writeConnectorEndpointState(chain[index + 1]!, states[index + 1]!)
        secondPosition.x = state.position.x
        secondPosition.y = state.position.y
      }
    }
    for (let index = 0; index < chain.length; index += 1) {
      if (!pointMassInverseMasses[index]) continue
      chain[index]!.rigidBody.setTranslation(positions[index]!, true)
    }
    return maximumError
  }

  private solveFlexibleRopeLongRangeLimits(
    record: FlexibleConnectorRecord,
    chain: ConnectorRuntimeEndpoint[],
    reverse: boolean,
    velocityOnly: boolean,
  ): number {
    const lastIndex = chain.length - 1
    const firstPosition = this.connectorEndpointState(chain[0]!).position
    const lastPosition = this.connectorEndpointState(chain[lastIndex]!).position
    const maximumLength = record.linkLength * lastIndex
    if (
      Math.hypot(lastPosition.x - firstPosition.x, lastPosition.y - firstPosition.y) <
      maximumLength * FLEXIBLE_ROPE_LONG_RANGE_ACTIVATION_RATIO
    ) {
      return 0
    }
    const tolerance = this.flexibleRopeLengthTolerance(record)
    let maximumError = this.solveFlexibleRopeDistanceLimit(
      chain[0]!,
      chain[lastIndex]!,
      record.linkLength * lastIndex,
      tolerance,
      velocityOnly,
    )
    for (let offset = 1; offset < lastIndex; offset += 1) {
      const index = reverse ? lastIndex - offset : offset
      maximumError = Math.max(
        maximumError,
        this.solveFlexibleRopeDistanceLimit(
          chain[0]!,
          chain[index]!,
          record.linkLength * index,
          tolerance,
          velocityOnly,
        ),
        this.solveFlexibleRopeDistanceLimit(
          chain[index]!,
          chain[lastIndex]!,
          record.linkLength * (lastIndex - index),
          tolerance,
          velocityOnly,
        ),
      )
    }
    return maximumError
  }

  private solveFlexibleRopePosition(
    record: FlexibleConnectorRecord,
    chain: ConnectorRuntimeEndpoint[],
    iterationLimit = FLEXIBLE_ROPE_POSITION_ITERATIONS,
  ): number {
    const lengthTolerance = this.flexibleRopeLengthTolerance(record)
    const lastIndex = chain.length - 1
    const firstPosition = this.connectorEndpointState(chain[0]!).position
    const lastPosition = this.connectorEndpointState(chain[lastIndex]!).position
    if (
      chain[0]!.fixed &&
      chain[lastIndex]!.fixed &&
      Math.hypot(lastPosition.x - firstPosition.x, lastPosition.y - firstPosition.y) >=
        record.linkLength * lastIndex - lengthTolerance
    ) {
      for (let iteration = 0; iteration < 4; iteration += 1) {
        this.solveFlexibleRopeDistanceLimit(
          chain[0]!,
          chain[lastIndex]!,
          record.linkLength * lastIndex,
          lengthTolerance,
          false,
        )
      }
      const resolvedFirst = this.connectorEndpointState(chain[0]!).position
      const resolvedLast = this.connectorEndpointState(chain[lastIndex]!).position
      for (let index = 1; index < lastIndex; index += 1) {
        const ratio = index / lastIndex
        chain[index]!.rigidBody.setTranslation(
          {
            x: resolvedFirst.x + (resolvedLast.x - resolvedFirst.x) * ratio,
            y: resolvedFirst.y + (resolvedLast.y - resolvedFirst.y) * ratio,
          },
          true,
        )
      }
      return 0
    }
    for (let iteration = 0; iteration < iterationLimit; iteration += 1) {
      const reverse = iteration % 2 === 1
      const maximumError = Math.max(
        this.solveFlexibleRopeLinks(record, chain, reverse, false),
        this.solveFlexibleRopeLongRangeLimits(record, chain, reverse, false),
        this.solveFlexibleRopeTotalLength(record, chain, false),
      )
      if (maximumError <= lengthTolerance) break
    }
    let residualError = Number.POSITIVE_INFINITY
    const linkTolerance = lengthTolerance / Math.max(1, chain.length - 1)
    for (
      let iteration = 0;
      iteration < FLEXIBLE_ROPE_TOTAL_LENGTH_PROJECTION_ITERATIONS;
      iteration += 1
    ) {
      const reverse = iteration % 2 === 1
      const linkError = this.solveFlexibleRopeLinks(record, chain, reverse, false)
      const longRangeError = this.solveFlexibleRopeLongRangeLimits(record, chain, reverse, false)
      const lengthError = this.solveFlexibleRopeTotalLength(record, chain, false)
      residualError = Math.max(linkError, longRangeError, lengthError)
      if (linkError <= linkTolerance && lengthError <= lengthTolerance) break
    }
    return residualError
  }

  private solveFlexibleRopeRecord(record: FlexibleConnectorRecord, includeVelocity: boolean): void {
    if (record.kind !== 'rope') return
    const chain = this.flexibleChain(record)
    if (!includeVelocity) {
      this.solveFlexibleRopePosition(record, chain)
      return
    }
    for (let iteration = 0; iteration < FLEXIBLE_ROPE_VELOCITY_ITERATIONS; iteration += 1) {
      const reverse = iteration % 2 === 1
      const maximumError = Math.max(
        this.solveFlexibleRopeLinks(record, chain, reverse, true),
        this.solveFlexibleRopeLongRangeLimits(record, chain, reverse, true),
      )
      if (maximumError <= FLEXIBLE_VELOCITY_TOLERANCE_MPS) break
    }
  }

  private solveFlexibleRopePositionIteration(
    record: FlexibleConnectorRecord,
    reverse: boolean,
    endpointMotionOnly = false,
  ): number {
    const chain = this.flexibleChain(record)
    return Math.max(
      this.solveFlexibleRopeLinks(record, chain, reverse, false),
      this.solveFlexibleRopeLongRangeLimits(record, chain, reverse, false),
      this.solveFlexibleRopeTotalLength(record, chain, false, endpointMotionOnly),
    )
  }

  private refreshFlexibleRopeNodeVelocities(record: FlexibleConnectorRecord): void {
    if (record.kind !== 'rope') return
    for (let index = 0; index < record.nodes.length; index += 1) {
      const node = record.nodes[index]!
      const previous = record.previousNodePositions[index]
      if (!previous) continue
      const current = this.connectorEndpointState(node).position
      node.rigidBody.setLinvel(
        {
          x: (current.x - previous.x) / this.currentTimeStep,
          y: (current.y - previous.y) / this.currentTimeStep,
        },
        true,
      )
    }
  }

  private solveFlexibleConnectorConstraints(): void {
    for (const record of this.flexibleConnectors) {
      const chain = this.flexibleChain(record)
      const linkCount = chain.length - 1
      if (record.kind === 'rope') {
        continue
      }
      const lambdas = new Array<number>(linkCount).fill(0)
      const positionIterationLimit = Math.max(
        FLEXIBLE_SPRING_MINIMUM_POSITION_ITERATIONS,
        Math.min(
          FLEXIBLE_POSITION_ITERATIONS,
          Math.ceil(FLEXIBLE_SPRING_ITERATION_LINK_BUDGET / linkCount),
        ),
      )
      for (let iteration = 0; iteration < positionIterationLimit; iteration += 1) {
        let maximumError = 0
        const reverse = iteration % 2 === 1
        for (let offset = 0; offset < linkCount; offset += 1) {
          const index = reverse ? linkCount - 1 - offset : offset
          const first = chain[index]!
          const second = chain[index + 1]!
          const frame = this.flexibleLinkFrame(first, second)
          if (!frame || frame.effectiveInverseMass <= Number.EPSILON) continue
          const error = frame.length - record.linkLength
          if (record.linkStiffness <= Number.EPSILON) continue
          maximumError = Math.max(maximumError, Math.abs(error))
          const compliance = 1 / (record.linkStiffness * this.currentTimeStep ** 2)
          const deltaLambda =
            (-error - compliance * lambdas[index]!) / (frame.effectiveInverseMass + compliance)
          lambdas[index] = lambdas[index]! + deltaLambda
          this.applyConnectorPositionMultiplier(
            first,
            frame.firstEndpoint,
            scaleVector(frame.direction, -1),
            deltaLambda,
          )
          this.applyConnectorPositionMultiplier(
            second,
            frame.secondEndpoint,
            frame.direction,
            deltaLambda,
          )
        }
        if (maximumError <= FLEXIBLE_POSITION_TOLERANCE_M) break
      }

      for (let index = 0; index < linkCount; index += 1) {
        const frame = this.flexibleLinkFrame(chain[index]!, chain[index + 1]!)
        if (!frame) continue
        const impulseMagnitude = -lambdas[index]! / this.currentTimeStep
        this.applyConnectorVelocityMultiplier(
          chain[index]!,
          frame.firstEndpoint,
          frame.direction,
          impulseMagnitude,
        )
        this.applyConnectorVelocityMultiplier(
          chain[index + 1]!,
          frame.secondEndpoint,
          scaleVector(frame.direction, -1),
          impulseMagnitude,
        )
        if (record.linkDamping <= Number.EPSILON || frame.effectiveInverseMass <= Number.EPSILON) {
          continue
        }
        const relativeSpeed =
          (frame.secondEndpoint.velocity.x - frame.firstEndpoint.velocity.x) * frame.direction.x +
          (frame.secondEndpoint.velocity.y - frame.firstEndpoint.velocity.y) * frame.direction.y
        const decay = Math.exp(
          -record.linkDamping * frame.effectiveInverseMass * this.currentTimeStep,
        )
        const dampingImpulse = (relativeSpeed * (1 - decay)) / frame.effectiveInverseMass
        this.applyConnectorVelocityMultiplier(
          chain[index]!,
          frame.firstEndpoint,
          frame.direction,
          dampingImpulse,
        )
        this.applyConnectorVelocityMultiplier(
          chain[index + 1]!,
          frame.secondEndpoint,
          scaleVector(frame.direction, -1),
          dampingImpulse,
        )
      }
    }
  }

  private solveRodConstraints(): void {
    const angularMomentumTargets = this.captureRodAngularMomentumTargets()
    for (let iteration = 0; iteration < ROD_SOLVER_ITERATIONS; iteration += 1) {
      let maximumError = 0
      for (const rod of this.rods) {
        const frame = this.rodFrame(rod)
        const error = frame.distance - rod.entity.connector.length
        maximumError = Math.max(maximumError, Math.abs(error))
        if (
          Math.abs(error) <= ROD_POSITION_TOLERANCE_M ||
          frame.effectiveInverseMass <= Number.EPSILON
        ) {
          continue
        }
        const impulseMagnitude = -error / frame.effectiveInverseMass
        this.applyRodPositionImpulse(
          rod.first,
          frame.firstEndpoint,
          frame.direction,
          -1,
          impulseMagnitude,
        )
        this.applyRodPositionImpulse(
          rod.second,
          frame.secondEndpoint,
          frame.direction,
          1,
          impulseMagnitude,
        )
      }
      if (maximumError <= ROD_POSITION_TOLERANCE_M) break
    }

    for (let iteration = 0; iteration < ROD_SOLVER_ITERATIONS; iteration += 1) {
      let maximumRelativeSpeed = 0
      for (const rod of this.rods) {
        const frame = this.rodFrame(rod)
        const relativeSpeed =
          (frame.secondEndpoint.velocity.x - frame.firstEndpoint.velocity.x) * frame.direction.x +
          (frame.secondEndpoint.velocity.y - frame.firstEndpoint.velocity.y) * frame.direction.y
        maximumRelativeSpeed = Math.max(maximumRelativeSpeed, Math.abs(relativeSpeed))
        if (
          Math.abs(relativeSpeed) <= ROD_VELOCITY_TOLERANCE_MPS ||
          frame.effectiveInverseMass <= Number.EPSILON
        ) {
          continue
        }
        const impulseMagnitude = -relativeSpeed / frame.effectiveInverseMass
        const impulse = scaleForce(frame.direction, impulseMagnitude)
        if (rod.first.body) {
          rod.first.rigidBody.applyImpulseAtPoint(
            scaleForce(impulse, -1),
            frame.firstEndpoint.position,
            true,
          )
        }
        if (rod.second.body) {
          rod.second.rigidBody.applyImpulseAtPoint(impulse, frame.secondEndpoint.position, true)
        }
        if (rod.first.body && !rod.first.body.entity.rotationEnabled) {
          this.setConstrainedAngularVelocity(rod.first.body, 0)
        }
        if (rod.second.body && !rod.second.body.entity.rotationEnabled) {
          this.setConstrainedAngularVelocity(rod.second.body, 0)
        }
      }
      if (maximumRelativeSpeed <= ROD_VELOCITY_TOLERANCE_MPS) break
    }
    this.restoreRodAngularMomentum(angularMomentumTargets)
  }

  private updateNetForcesFromMomentum(previousBodyStates: Map<EntityId, PreviousBodyState>): void {
    for (const [entityId, record] of this.dynamicBodies) {
      const previous = previousBodyStates.get(entityId)
      if (!previous) continue
      const velocity = record.rigidBody.linvel()
      record.netForce = {
        x: (record.entity.massKg * (velocity.x - previous.linearVelocity.x)) / this.fixedTimeStep,
        y: (record.entity.massKg * (velocity.y - previous.linearVelocity.y)) / this.fixedTimeStep,
      }
    }
  }

  private captureBodyStates(): Map<EntityId, PreviousBodyState> {
    return new Map(
      [...this.dynamicBodies.entries()].map(([entityId, record]) => {
        const position = record.rigidBody.translation()
        const linearVelocity = record.rigidBody.linvel()
        return [
          entityId,
          {
            position: { x: position.x, y: position.y },
            linearVelocity: { x: linearVelocity.x, y: linearVelocity.y },
            angleRad: record.rigidBody.rotation(),
            angularVelocityRad: record.rigidBody.angvel(),
          },
        ]
      }),
    )
  }

  private hasValidSolverContact(first: RAPIER.Collider, second: RAPIER.Collider): boolean {
    let hasValidContact = false
    this.world.contactPair(first, second, (manifold) => {
      for (let index = 0; index < manifold.numSolverContacts(); index += 1) {
        const point = manifold.solverContactPoint(index)
        const distance = manifold.solverContactDist(index)
        if (
          Number.isFinite(point.x) &&
          Number.isFinite(point.y) &&
          Number.isFinite(distance) &&
          distance <= ARC_CONTACT_DISTANCE_TOLERANCE
        ) {
          hasValidContact = true
          return
        }
      }
    })
    return hasValidContact
  }

  private validContactColliders(collider: RAPIER.Collider): RAPIER.Collider[] {
    const contacts: RAPIER.Collider[] = []
    this.world.contactPairsWith(collider, (other) => {
      if (this.hasValidSolverContact(collider, other)) contacts.push(other)
    })
    return contacts
  }

  private groundPieceClearance(
    groundCollider: GroundColliderRecord,
    position: Vec2,
  ): { clearanceM: number; normal: Vec2 } {
    const closest = groundCollider.piece.path.closestPoint(position)
    const surface = groundCollider.piece.path.pointAt(closest.s)
    const separation = { x: position.x - surface.x, y: position.y - surface.y }
    const distanceM = Math.hypot(separation.x, separation.y)
    return {
      clearanceM: distanceM,
      normal:
        distanceM > Number.EPSILON
          ? scaleVector(separation, 1 / distanceM)
          : groundCollider.piece.path.normalAt(closest.s),
    }
  }

  private findSweptFullyElasticGroundImpact(
    record: DynamicBodyRecord,
    radiusM: number,
    previous: PreviousBodyState,
    solverInput: PreviousBodyState,
    acceleration: Vec2,
  ): SweptGroundImpact | null {
    if (record.entity.material.restitution < 1 - FULLY_ELASTIC_RESTITUTION_TOLERANCE) {
      return null
    }

    const postStepVelocity = record.rigidBody.linvel()
    const expectedFreeVelocity = {
      x: solverInput.linearVelocity.x + acceleration.x * this.currentTimeStep,
      y: solverInput.linearVelocity.y + acceleration.y * this.currentTimeStep,
    }
    if (
      Math.hypot(
        postStepVelocity.x - expectedFreeVelocity.x,
        postStepVelocity.y - expectedFreeVelocity.y,
      ) <= PATH_ENTRY_SEPARATION_SPEED_TOLERANCE
    ) {
      return null
    }

    const contacts = record.collider ? this.validContactColliders(record.collider) : []
    if (contacts.some((collider) => !this.groundsByCollider.has(collider.handle))) return null
    const contactProposals = contacts.flatMap((collider) => {
      const groundCollider = this.groundsByCollider.get(collider.handle)
      if (
        !groundCollider ||
        !materialsAreFrictionlessAndFullyElastic(
          record.entity.material,
          groundCollider.piece.material,
        )
      ) {
        return []
      }
      const proposal = this.groundContactProposal(record, groundCollider, radiusM, previous)
      return proposal && proposal.preStepSeparatingSpeedMps < -PATH_ENTRY_SEPARATION_SPEED_TOLERANCE
        ? [proposal]
        : []
    })
    contactProposals.sort((first, second) => first.candidate.gapM - second.candidate.gapM)
    const contactProposal = contactProposals[0]
    if (contactProposal) {
      // 过渡段可能同时报告双面折线接触；此时最近解析接触的法线比自由轨迹扫掠更可靠。
      // 后续功—能校准仍会消除把撞击时刻保守地记为步末所产生的速率误差。
      return {
        timeSeconds: this.currentTimeStep,
        normal: contactProposal.frame.contactNormal,
      }
    }

    const speedBound =
      Math.hypot(solverInput.linearVelocity.x, solverInput.linearVelocity.y) +
      Math.hypot(acceleration.x, acceleration.y) * this.currentTimeStep
    const subdivisions = Math.min(
      MAX_GROUND_IMPACT_SWEEP_SUBDIVISIONS,
      Math.max(
        8,
        Math.ceil(
          (speedBound * this.currentTimeStep * GROUND_IMPACT_SWEEP_SUBDIVISIONS_PER_RADIUS) /
            radiusM,
        ),
      ),
    )
    const positionAt = (timeSeconds: number): Vec2 => ({
      x:
        previous.position.x +
        solverInput.linearVelocity.x * timeSeconds +
        0.5 * acceleration.x * timeSeconds ** 2,
      y:
        previous.position.y +
        solverInput.linearVelocity.y * timeSeconds +
        0.5 * acceleration.y * timeSeconds ** 2,
    })

    let earliest: SweptGroundImpact | null = null
    for (const groundCollider of this.groundCollidersByPieceId.values()) {
      if (
        !materialsAreFrictionlessAndFullyElastic(
          record.entity.material,
          groundCollider.piece.material,
        )
      ) {
        continue
      }

      let lowerTime = 0
      const lowerClearance =
        this.groundPieceClearance(groundCollider, previous.position).clearanceM - radiusM
      let impactTime: number | null = lowerClearance <= 0 ? 0 : null
      for (let index = 1; impactTime === null && index <= subdivisions; index += 1) {
        const upperTime = (this.currentTimeStep * index) / subdivisions
        const upperClearance =
          this.groundPieceClearance(groundCollider, positionAt(upperTime)).clearanceM - radiusM
        if (upperClearance <= 0) {
          let upperBound = upperTime
          let lowerBound = lowerTime
          for (let iteration = 0; iteration < 24; iteration += 1) {
            const middle = (lowerBound + upperBound) / 2
            const middleClearance =
              this.groundPieceClearance(groundCollider, positionAt(middle)).clearanceM - radiusM
            if (middleClearance > 0) lowerBound = middle
            else upperBound = middle
          }
          impactTime = upperBound
          break
        }
        lowerTime = upperTime
      }
      if (
        impactTime === null ||
        (earliest !== null && impactTime >= earliest.timeSeconds - Number.EPSILON)
      ) {
        continue
      }

      const geometry = this.groundPieceClearance(groundCollider, positionAt(impactTime))
      const impactVelocity = {
        x: solverInput.linearVelocity.x + acceleration.x * impactTime,
        y: solverInput.linearVelocity.y + acceleration.y * impactTime,
      }
      if (dotVectors(impactVelocity, geometry.normal) >= -PATH_ENTRY_SEPARATION_SPEED_TOLERANCE) {
        continue
      }
      earliest = { timeSeconds: impactTime, normal: geometry.normal }
    }
    return earliest
  }

  private resolveFrictionlessFullyElasticGroundImpacts(
    previousBodyStates: Map<EntityId, PreviousBodyState>,
    solverInputBodyStates: Map<EntityId, PreviousBodyState>,
  ): void {
    if (!this.hasFrictionlessFullyElasticGroundImpactPairs) return

    for (const [entityId, record] of this.dynamicBodies) {
      const radius = collisionRadius(record.entity)
      const previous = previousBodyStates.get(entityId)
      const solverInput = solverInputBodyStates.get(entityId)
      if (
        radius === null ||
        !record.collider ||
        !previous ||
        !solverInput ||
        this.persistentGroundContacts.has(entityId)
      ) {
        continue
      }

      const acceleration = this.externalAcceleration(record)
      const impact = this.findSweptFullyElasticGroundImpact(
        record,
        radius,
        previous,
        solverInput,
        acceleration,
      )
      if (!impact) continue

      const impactVelocity = {
        x: solverInput.linearVelocity.x + acceleration.x * impact.timeSeconds,
        y: solverInput.linearVelocity.y + acceleration.y * impact.timeSeconds,
      }
      const incomingNormalSpeed = dotVectors(impactVelocity, impact.normal)
      if (incomingNormalSpeed >= -PATH_ENTRY_SEPARATION_SPEED_TOLERANCE) continue

      const remainingTime = this.currentTimeStep - impact.timeSeconds
      const reflectedVelocity = {
        x: impactVelocity.x - 2 * incomingNormalSpeed * impact.normal.x,
        y: impactVelocity.y - 2 * incomingNormalSpeed * impact.normal.y,
      }
      const responseDirection = {
        x: reflectedVelocity.x + acceleration.x * remainingTime,
        y: reflectedVelocity.y + acceleration.y * remainingTime,
      }
      const postStepPosition = record.rigidBody.translation()
      const displacement = {
        x: postStepPosition.x - previous.position.x,
        y: postStepPosition.y - previous.position.y,
      }
      const targetSpeedSquared = Math.max(
        0,
        solverInput.linearVelocity.x ** 2 +
          solverInput.linearVelocity.y ** 2 +
          2 * dotVectors(acceleration, displacement),
      )
      const responseSpeed = Math.hypot(responseDirection.x, responseDirection.y)
      const resolvedVelocity =
        responseSpeed > Number.EPSILON
          ? scaleVector(responseDirection, Math.sqrt(targetSpeedSquared) / responseSpeed)
          : { x: 0, y: 0 }
      record.rigidBody.setLinvel(resolvedVelocity, true)
    }
  }

  private externalAcceleration(record: DynamicBodyRecord): Vec2 {
    return scaleVector(record.pathForce, 1 / record.entity.massKg)
  }

  private booleanBoundaryWorldFrame(
    record: DynamicBodyRecord,
    pathIndex: number,
    distanceM: number,
  ): BooleanBoundaryPathFrame | null {
    const path = record.booleanBoundaryPaths[pathIndex]
    if (!path) return null
    const local = boundaryPathFrameAt(path, distanceM)
    const position = record.rigidBody.translation()
    const angle = record.rigidBody.rotation()
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    const rotate = (vector: Vec2): Vec2 => ({
      x: vector.x * cosine - vector.y * sine,
      y: vector.x * sine + vector.y * cosine,
    })
    const offset = rotate(local.position)
    return {
      ...local,
      position: { x: position.x + offset.x, y: position.y + offset.y },
      tangent: rotate(local.tangent),
      normal: rotate(local.normal),
    }
  }

  private booleanBoundaryPointToLocal(record: DynamicBodyRecord, point: Vec2): Vec2 {
    const position = record.rigidBody.translation()
    const angle = -record.rigidBody.rotation()
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    const offset = { x: point.x - position.x, y: point.y - position.y }
    return {
      x: offset.x * cosine - offset.y * sine,
      y: offset.x * sine + offset.y * cosine,
    }
  }

  private booleanBoundaryFrameWithEmptySide(
    record: DynamicBodyRecord,
    pathIndex: number,
    distanceM: number,
    emptySide: 1 | -1,
    radiusM: number,
  ): BooleanBoundaryPathFrame | null {
    const frame = this.booleanBoundaryWorldFrame(record, pathIndex, distanceM)
    if (!frame) return null
    const centerDistanceScale = Math.max(0.08, 1 - frame.curvaturePerM * emptySide * radiusM)
    return {
      ...frame,
      position: {
        x: frame.position.x + frame.normal.x * emptySide * radiusM,
        y: frame.position.y + frame.normal.y * emptySide * radiusM,
      },
      normal: scaleVector(frame.normal, emptySide),
      curvaturePerM: (frame.curvaturePerM * emptySide) / centerDistanceScale,
      centerDistanceScale,
    }
  }

  private closestBooleanBoundaryContact(
    record: DynamicBodyRecord,
    point: Vec2,
    radiusM: number,
  ): {
    pathIndex: number
    distanceM: number
    emptySide: 1 | -1
    frame: BooleanBoundaryPathFrame
    gapM: number
  } | null {
    const localPoint = this.booleanBoundaryPointToLocal(record, point)
    const closest = closestBooleanBoundaryPathFrame(record.booleanBoundaryPaths, localPoint)
    if (!closest) return null
    const path = record.booleanBoundaryPaths[closest.pathIndex]!
    const analyticCircle = path.analyticCircleSegments.find(
      (segment) =>
        closest.frame.distanceM >= segment.startM - 1e-9 &&
        closest.frame.distanceM <= segment.endM + 1e-9,
    )
    let probeDistanceM = closest.frame.distanceM
    if (analyticCircle) {
      const inwardOffsetM = Math.min(1e-4, (analyticCircle.endM - analyticCircle.startM) * 1e-5)
      probeDistanceM = Math.max(
        analyticCircle.startM + inwardOffsetM,
        Math.min(analyticCircle.endM - inwardOffsetM, probeDistanceM),
      )
    }
    const probeFrame = boundaryPathPolylineFrameAt(path, probeDistanceM)
    const positiveProbe = {
      x: probeFrame.position.x + probeFrame.normal.x * 1e-5,
      y: probeFrame.position.y + probeFrame.normal.y * 1e-5,
    }
    const initialAngle = record.booleanResult?.angleRad ?? 0
    const initialCosine = Math.cos(initialAngle)
    const initialSine = Math.sin(initialAngle)
    const initialCenter = record.booleanResult?.centerOfMass ?? { x: 0, y: 0 }
    const worldProbe = {
      x: initialCenter.x + positiveProbe.x * initialCosine - positiveProbe.y * initialSine,
      y: initialCenter.y + positiveProbe.x * initialSine + positiveProbe.y * initialCosine,
    }
    const positiveIsSolid = Boolean(
      record.booleanResult && pointInBooleanGeometry(worldProbe, record.booleanResult.geometry),
    )
    const solidNormal = positiveIsSolid ? probeFrame.normal : scaleVector(probeFrame.normal, -1)
    const analyticPositiveIsSolid = dotVectors(solidNormal, closest.frame.normal) >= 0
    const emptySide: 1 | -1 = analyticPositiveIsSolid ? -1 : 1
    const frame = this.booleanBoundaryFrameWithEmptySide(
      record,
      closest.pathIndex,
      closest.frame.distanceM,
      emptySide,
      radiusM,
    )
    if (!frame) return null
    return {
      pathIndex: closest.pathIndex,
      distanceM: closest.frame.distanceM,
      emptySide,
      frame,
      gapM: closest.distanceToPathM - radiusM,
    }
  }

  private booleanBoundarySurfaceVelocity(record: DynamicBodyRecord, point: Vec2): Vec2 {
    const center = record.rigidBody.translation()
    const velocity = record.rigidBody.linvel()
    const angularVelocity = record.rigidBody.angvel()
    const offset = { x: point.x - center.x, y: point.y - center.y }
    return {
      x: velocity.x - angularVelocity * offset.y,
      y: velocity.y + angularVelocity * offset.x,
    }
  }

  private booleanGroundSupportNormal(record: DynamicBodyRecord): Vec2 | null {
    const weightedNormal = { x: 0, y: 0 }
    let contactCount = 0
    for (const collider of this.activeBodyColliders(record)) {
      this.world.contactPairsWith(collider, (other) => {
        if (other.collisionGroups() !== BOOLEAN_GROUND_COLLISION_GROUPS) return
        this.world.contactPair(collider, other, (manifold) => {
          const normal = manifold.normal()
          for (let index = 0; index < manifold.numSolverContacts(); index += 1) {
            if (manifold.solverContactDist(index) > ARC_CONTACT_DISTANCE_TOLERANCE) continue
            weightedNormal.x -= normal.x
            weightedNormal.y -= normal.y
            contactCount += 1
          }
        })
      })
    }
    const length = Math.hypot(weightedNormal.x, weightedNormal.y)
    return contactCount > 0 && length > Number.EPSILON
      ? { x: weightedNormal.x / length, y: weightedNormal.y / length }
      : null
  }

  private booleanGroundSupportConstrainsRotation(record: DynamicBodyRecord): boolean {
    if (!record.entity.rotationEnabled) return true
    const center = record.rigidBody.translation()
    let minimumLeverArm = Number.POSITIVE_INFINITY
    let maximumLeverArm = Number.NEGATIVE_INFINITY
    for (const collider of this.activeBodyColliders(record)) {
      this.world.contactPairsWith(collider, (other) => {
        if (other.collisionGroups() !== BOOLEAN_GROUND_COLLISION_GROUPS) return
        this.world.contactPair(collider, other, (manifold) => {
          for (let index = 0; index < manifold.numSolverContacts(); index += 1) {
            if (manifold.solverContactDist(index) > ARC_CONTACT_DISTANCE_TOLERANCE) continue
            const point = manifold.solverContactPoint(index)
            minimumLeverArm = Math.min(minimumLeverArm, point.x - center.x)
            maximumLeverArm = Math.max(maximumLeverArm, point.x - center.x)
          }
        })
      })
    }
    return minimumLeverArm < -1e-4 && maximumLeverArm > 1e-4
  }

  private booleanGroundConstrainedExternalAcceleration(record: DynamicBodyRecord): Vec2 {
    const acceleration = this.externalAcceleration(record)
    const groundNormal = this.booleanGroundSupportNormal(record)
    if (!groundNormal) return acceleration
    const intoGroundAcceleration = dotVectors(acceleration, groundNormal)
    return intoGroundAcceleration < 0
      ? {
          x: acceleration.x - groundNormal.x * intoGroundAcceleration,
          y: acceleration.y - groundNormal.y * intoGroundAcceleration,
        }
      : acceleration
  }

  private supportedBooleanCircleReducedState(
    circle: DynamicBodyRecord,
    boundary: DynamicBodyRecord,
    pathIndex: number,
    distanceM: number,
    emptySide: 1 | -1,
    radiusM: number,
    groundNormal: Vec2,
  ): { frame: BooleanBoundaryPathFrame; reducedMass: number; reducedForce: number } | null {
    const frame = this.booleanBoundaryFrameWithEmptySide(
      boundary,
      pathIndex,
      distanceM,
      emptySide,
      radiusM,
    )
    if (!frame) return null
    const groundTangent = { x: -groundNormal.y, y: groundNormal.x }
    // 以小球圆心的真实路径弧长作为广义坐标。若继续使用物块表面的弧长，
    // 平面进入圆弧时 centerDistanceScale 会突变，并错误地改变切向速度。
    const relativeDerivative = frame.tangent
    const circleMass = circle.entity.massKg
    const boundaryMass = boundary.entity.massKg
    const totalMass = circleMass + boundaryMass
    const coupling = circleMass * dotVectors(relativeDerivative, groundTangent)
    const reducedMass =
      circleMass * dotVectors(relativeDerivative, relativeDerivative) -
      (coupling * coupling) / totalMass
    if (reducedMass <= Number.EPSILON) return null
    const circleAcceleration = this.externalAcceleration(circle)
    const boundaryAcceleration = this.booleanGroundConstrainedExternalAcceleration(boundary)
    const totalGroundTangentForce =
      circleMass * dotVectors(circleAcceleration, groundTangent) +
      boundaryMass * dotVectors(boundaryAcceleration, groundTangent)
    const reducedForce =
      circleMass * dotVectors(relativeDerivative, circleAcceleration) -
      (coupling / totalMass) * totalGroundTangentForce
    return { frame, reducedMass, reducedForce }
  }

  private advanceSupportedBooleanCircleContact(
    circle: DynamicBodyRecord,
    boundary: DynamicBodyRecord,
    contact: BooleanCirclePathContact,
    radiusM: number,
    groundNormal: Vec2,
  ): {
    distanceM: number
    unwrappedDistanceM: number
    surfaceTravelM: number
    reducedMomentum: number
    speedMps: number
  } | null {
    if (boundary.entity.rotationEnabled && !this.booleanGroundSupportConstrainsRotation(boundary)) {
      return null
    }
    const path = boundary.booleanBoundaryPaths[contact.pathIndex]
    if (!path) return null
    const stateAt = (distanceM: number) =>
      this.supportedBooleanCircleReducedState(
        circle,
        boundary,
        contact.pathIndex,
        normalizedBoundaryDistance(path, distanceM),
        contact.emptySide,
        radiusM,
        groundNormal,
      )
    const initial = stateAt(contact.distanceM)
    if (!initial) return null
    const derivativeStepM = Math.min(1e-3, Math.max(1e-5, path.lengthM * 1e-6))
    const massDerivativeAt = (distanceM: number): number => {
      const before = stateAt(distanceM - derivativeStepM)
      const center = stateAt(distanceM)
      const after = stateAt(distanceM + derivativeStepM)
      return before && center && after
        ? (after.reducedMass - before.reducedMass) /
            (2 * derivativeStepM * center.frame.centerDistanceScale)
        : 0
    }
    const initialDistance = contact.distanceM
    const initialMomentum = initial.reducedMass * contact.speedMps
    let distanceAfter =
      initialDistance +
      ((initialMomentum / initial.reducedMass) * this.currentTimeStep) /
        initial.frame.centerDistanceScale
    let momentumAfter =
      initialMomentum +
      (initial.reducedForce +
        (0.5 * initialMomentum ** 2 * massDerivativeAt(initialDistance)) /
          initial.reducedMass ** 2) *
        this.currentTimeStep
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const middleDistance = (initialDistance + distanceAfter) / 2
      const middleMomentum = (initialMomentum + momentumAfter) / 2
      const middle = stateAt(middleDistance)
      if (!middle) return null
      const middleMassDerivative = massDerivativeAt(middleDistance)
      distanceAfter =
        initialDistance +
        ((middleMomentum / middle.reducedMass) * this.currentTimeStep) /
          middle.frame.centerDistanceScale
      momentumAfter =
        initialMomentum +
        (middle.reducedForce +
          (0.5 * middleMomentum ** 2 * middleMassDerivative) / middle.reducedMass ** 2) *
          this.currentTimeStep
    }
    if (!path.closed && (distanceAfter < 0 || distanceAfter > path.lengthM)) return null
    const unwrappedDistanceM = distanceAfter
    const surfaceTravelM = Math.abs(unwrappedDistanceM - initialDistance)
    distanceAfter = normalizedBoundaryDistance(path, unwrappedDistanceM)
    const final = stateAt(distanceAfter)
    if (!final) return null
    return {
      distanceM: distanceAfter,
      unwrappedDistanceM,
      surfaceTravelM,
      reducedMomentum: momentumAfter,
      speedMps: momentumAfter / final.reducedMass,
    }
  }

  private booleanCircleTerminalEndpoint(
    path: BooleanBoundaryPath,
    contact: BooleanCirclePathContact,
    unwrappedDistanceM: number,
  ): number | null {
    const analyticCircle = path.analyticCircleSegments.find(
      (segment) =>
        contact.distanceM >= segment.startM - 1e-9 && contact.distanceM <= segment.endM + 1e-9,
    )
    if (!analyticCircle) return null
    const circleClosureToleranceM = Math.max(1e-8, path.lengthM * 1e-8)
    if (
      path.closed &&
      analyticCircle.startM <= circleClosureToleranceM &&
      analyticCircle.endM >= path.lengthM - circleClosureToleranceM
    ) {
      return null
    }
    if (contact.speedMps < -Number.EPSILON && unwrappedDistanceM <= analyticCircle.startM) {
      return analyticCircle.startM
    }
    if (contact.speedMps > Number.EPSILON && unwrappedDistanceM >= analyticCircle.endM) {
      return analyticCircle.endM
    }
    return null
  }

  private booleanCirclePairKey(circleId: EntityId, booleanId: EntityId): string {
    return `${circleId}\u0000${booleanId}`
  }

  private markReleasedBooleanCircleContact(circleId: EntityId, booleanId: EntityId): void {
    this.releasedBooleanCircleContacts.set(this.booleanCirclePairKey(circleId, booleanId), {
      circleId,
      booleanId,
    })
  }

  private refreshReleasedBooleanCircleContacts(): void {
    for (const [pairKey, released] of this.releasedBooleanCircleContacts) {
      const circle = this.dynamicBodies.get(released.circleId)
      const boundary = this.dynamicBodies.get(released.booleanId)
      const radiusM = circle ? collisionRadius(circle.entity) : null
      if (!circle || !boundary?.booleanResult || radiusM === null) {
        this.releasedBooleanCircleContacts.delete(pairKey)
        continue
      }
      const candidate = this.closestBooleanBoundaryContact(
        boundary,
        circle.rigidBody.translation(),
        radiusM,
      )
      if (!candidate || candidate.gapM > BOOLEAN_BOUNDARY_RELEASE_CLEARANCE_M) {
        this.releasedBooleanCircleContacts.delete(pairKey)
      }
    }
  }

  private booleanCircleCenterPathIsContinuous(
    before: BooleanBoundaryPathFrame,
    after: BooleanBoundaryPathFrame,
    surfaceTravelM: number,
  ): boolean {
    const centerTravelM = Math.hypot(
      after.position.x - before.position.x,
      after.position.y - before.position.y,
    )
    const maximumContinuousTravelM =
      surfaceTravelM * Math.max(before.centerDistanceScale, after.centerDistanceScale) +
      BOOLEAN_BOUNDARY_RELEASE_CLEARANCE_M
    return centerTravelM <= maximumContinuousTravelM
  }

  private projectBooleanCircleContact(
    circle: DynamicBodyRecord,
    boundary: DynamicBodyRecord,
    frame: BooleanBoundaryPathFrame,
    radiusM: number,
    targetTangentialSpeedMps: number,
    removeInelasticSolverSeparation = false,
  ): number {
    const boundaryGroundNormal = this.booleanGroundSupportNormal(boundary)
    const boundaryGroundConstrainsRotation =
      boundaryGroundNormal !== null && this.booleanGroundSupportConstrainsRotation(boundary)
    const boundaryDirection = (direction: Vec2): Vec2 => {
      if (!boundaryGroundNormal) return direction
      const groundComponent = dotVectors(direction, boundaryGroundNormal)
      return {
        x: direction.x - boundaryGroundNormal.x * groundComponent,
        y: direction.y - boundaryGroundNormal.y * groundComponent,
      }
    }
    const constraintDirections = [frame.normal, frame.tangent] as const
    const solveConstraintMultipliers = (errors: readonly [number, number]): [number, number] => {
      const point = circle.rigidBody.translation()
      const boundaryPoint = boundaryGroundConstrainsRotation
        ? boundary.rigidBody.translation()
        : point
      const circleResponseDirections = constraintDirections
      const boundaryResponseDirections = constraintDirections.map(boundaryDirection)
      const matrix = constraintDirections.map((measuredDirection) =>
        constraintDirections.map(
          (_, responseIndex) =>
            this.bodyCrossInverseMassAtPoint(
              circle,
              point,
              circleResponseDirections[responseIndex]!,
              measuredDirection,
            ) +
            this.bodyCrossInverseMassAtPoint(
              boundary,
              boundaryPoint,
              boundaryResponseDirections[responseIndex]!,
              measuredDirection,
            ),
        ),
      )
      const determinant = matrix[0]![0]! * matrix[1]![1]! - matrix[0]![1]! * matrix[1]![0]!
      if (Math.abs(determinant) <= Number.EPSILON) return [0, 0]
      return [
        (-errors[0] * matrix[1]![1]! + errors[1] * matrix[0]![1]!) / determinant,
        (-matrix[0]![0]! * errors[1] + matrix[1]![0]! * errors[0]) / determinant,
      ]
    }
    const circlePoint = circle.rigidBody.translation()
    const positionError = {
      x: circlePoint.x - frame.position.x,
      y: circlePoint.y - frame.position.y,
    }
    const positionMultipliers = solveConstraintMultipliers([
      dotVectors(positionError, frame.normal),
      dotVectors(positionError, frame.tangent),
    ])
    for (let index = 0; index < constraintDirections.length; index += 1) {
      const direction = constraintDirections[index]!
      const multiplier = positionMultipliers[index]!
      if (Math.abs(multiplier) <= Number.EPSILON) continue
      this.applyBodyPositionMultiplier(circle, circlePoint, direction, multiplier)
      this.applyBodyPositionMultiplier(
        boundary,
        boundaryGroundConstrainsRotation ? boundary.rigidBody.translation() : frame.position,
        scaleVector(boundaryDirection(direction), -1),
        multiplier,
      )
    }

    const constraintPoint = circle.rigidBody.translation()
    const circleVelocity = circle.rigidBody.linvel()
    const boundaryVelocity = this.booleanBoundarySurfaceVelocity(boundary, constraintPoint)
    const relativeVelocity = {
      x: circleVelocity.x - boundaryVelocity.x,
      y: circleVelocity.y - boundaryVelocity.y,
    }
    const relativeNormalSpeed = dotVectors(relativeVelocity, frame.normal)
    const shouldConstrainNormal =
      relativeNormalSpeed < 0 ||
      removeInelasticSolverSeparation ||
      Math.abs(relativeNormalSpeed) <= PATH_ENTRY_SEPARATION_SPEED_TOLERANCE
    const velocityMultipliers = solveConstraintMultipliers([
      shouldConstrainNormal ? relativeNormalSpeed : 0,
      dotVectors(relativeVelocity, frame.tangent) - targetTangentialSpeedMps,
    ])
    for (let index = 0; index < constraintDirections.length; index += 1) {
      const multiplier = velocityMultipliers[index]!
      if (Math.abs(multiplier) <= Number.EPSILON) continue
      const direction = constraintDirections[index]!
      circle.rigidBody.applyImpulseAtPoint(
        scaleVector(direction, multiplier),
        constraintPoint,
        true,
      )
      boundary.rigidBody.applyImpulseAtPoint(
        scaleVector(boundaryDirection(direction), -multiplier),
        boundaryGroundConstrainsRotation ? boundary.rigidBody.translation() : constraintPoint,
        true,
      )
    }
    const normalImpulseMagnitude = Math.max(0, velocityMultipliers[0])

    const friction = combinedPathFriction(circle.entity.material, frame.material)
    if (friction <= Number.EPSILON || normalImpulseMagnitude <= Number.EPSILON) {
      return normalImpulseMagnitude
    }
    const circleCenter = circle.rigidBody.translation()
    const contactPoint = {
      x: circleCenter.x - frame.normal.x * radiusM,
      y: circleCenter.y - frame.normal.y * radiusM,
    }
    const circleSurfaceVelocity = this.booleanBoundarySurfaceVelocity(circle, contactPoint)
    const boundarySurfaceVelocity = this.booleanBoundarySurfaceVelocity(boundary, contactPoint)
    const slipSpeedMps = dotVectors(
      {
        x: circleSurfaceVelocity.x - boundarySurfaceVelocity.x,
        y: circleSurfaceVelocity.y - boundarySurfaceVelocity.y,
      },
      frame.tangent,
    )
    const tangentInverseMass =
      this.bodyDirectionalInverseMassAtPoint(circle, contactPoint, frame.tangent) +
      this.bodyCrossInverseMassAtPoint(
        boundary,
        boundaryGroundConstrainsRotation ? boundary.rigidBody.translation() : contactPoint,
        boundaryDirection(frame.tangent),
        frame.tangent,
      )
    if (tangentInverseMass <= Number.EPSILON) return normalImpulseMagnitude
    const frictionImpulseMagnitude = Math.max(
      -friction * normalImpulseMagnitude,
      Math.min(friction * normalImpulseMagnitude, -slipSpeedMps / tangentInverseMass),
    )
    if (Math.abs(frictionImpulseMagnitude) <= Number.EPSILON) return normalImpulseMagnitude
    const frictionImpulse = scaleVector(frame.tangent, frictionImpulseMagnitude)
    circle.rigidBody.applyImpulseAtPoint(frictionImpulse, contactPoint, true)
    boundary.rigidBody.applyImpulseAtPoint(
      scaleVector(boundaryDirection(frame.tangent), -frictionImpulseMagnitude),
      boundaryGroundConstrainsRotation ? boundary.rigidBody.translation() : contactPoint,
      true,
    )
    return normalImpulseMagnitude
  }

  private preparePersistentBooleanCircleContacts(): void {
    for (const [circleId, contact] of this.persistentBooleanCircleContacts) {
      const circle = this.dynamicBodies.get(circleId)
      const boundary = this.dynamicBodies.get(contact.booleanId)
      if (!circle?.collider || !boundary?.booleanResult) continue
      for (const circleCollider of this.activeBodyColliders(circle)) {
        for (const collider of boundary.circleBoundaryColliders) {
          this.suppressedContactPairs.add(colliderPairKey(circleCollider.handle, collider.handle))
        }
      }
    }
  }

  private advancePersistentBooleanCircleContacts(
    previousBodyStates: Map<EntityId, PreviousBodyState>,
  ): void {
    for (const [circleId, stored] of [...this.persistentBooleanCircleContacts]) {
      const circle = this.dynamicBodies.get(circleId)
      const boundary = this.dynamicBodies.get(stored.booleanId)
      const radiusM = circle ? collisionRadius(circle.entity) : null
      const previousCircle = previousBodyStates.get(circleId)
      if (!circle || !boundary?.booleanResult || radiusM === null || !previousCircle) {
        this.persistentBooleanCircleContacts.delete(circleId)
        continue
      }
      const previousBoundary = previousBodyStates.get(stored.booleanId)
      const currentBoundaryPosition = boundary.rigidBody.translation()
      const currentBoundaryAngle = boundary.rigidBody.rotation()
      const boundaryAcceleration = this.booleanGroundConstrainedExternalAcceleration(boundary)
      if (previousBoundary) {
        boundary.rigidBody.setTranslation(previousBoundary.position, false)
        boundary.rigidBody.setRotation(previousBoundary.angleRad, false)
      }
      const beforeFrame = this.booleanBoundaryFrameWithEmptySide(
        boundary,
        stored.pathIndex,
        stored.distanceM,
        stored.emptySide,
        radiusM,
      )
      if (!beforeFrame) {
        this.persistentBooleanCircleContacts.delete(circleId)
        continue
      }
      const previousBoundaryVelocity = previousBoundary
        ? {
            x:
              previousBoundary.linearVelocity.x -
              previousBoundary.angularVelocityRad *
                (beforeFrame.position.y - previousBoundary.position.y),
            y:
              previousBoundary.linearVelocity.y +
              previousBoundary.angularVelocityRad *
                (beforeFrame.position.x - previousBoundary.position.x),
          }
        : this.booleanBoundarySurfaceVelocity(boundary, beforeFrame.position)
      const previousRelativeNormalSpeed = dotVectors(
        {
          x: previousCircle.linearVelocity.x - previousBoundaryVelocity.x,
          y: previousCircle.linearVelocity.y - previousBoundaryVelocity.y,
        },
        beforeFrame.normal,
      )
      boundary.rigidBody.setTranslation(currentBoundaryPosition, false)
      boundary.rigidBody.setRotation(currentBoundaryAngle, false)
      const currentBeforeFrame = this.booleanBoundaryFrameWithEmptySide(
        boundary,
        stored.pathIndex,
        stored.distanceM,
        stored.emptySide,
        radiusM,
      )
      if (!currentBeforeFrame) {
        this.persistentBooleanCircleContacts.delete(circleId)
        continue
      }
      const circleAcceleration = this.externalAcceleration(circle)
      const relativeAcceleration = {
        x: circleAcceleration.x - boundaryAcceleration.x,
        y: circleAcceleration.y - boundaryAcceleration.y,
      }
      const currentCircleVelocity = circle.rigidBody.linvel()
      const currentBoundarySurfaceVelocity = this.booleanBoundarySurfaceVelocity(
        boundary,
        currentBeforeFrame.position,
      )
      const currentRelativeNormalSpeed = dotVectors(
        {
          x: currentCircleVelocity.x - currentBoundarySurfaceVelocity.x,
          y: currentCircleVelocity.y - currentBoundarySurfaceVelocity.y,
        },
        currentBeforeFrame.normal,
      )
      const nonExternalSeparatingSpeed =
        currentRelativeNormalSpeed -
        previousRelativeNormalSpeed -
        dotVectors(relativeAcceleration, beforeFrame.normal) * this.currentTimeStep
      if (
        previousRelativeNormalSpeed > PATH_ENTRY_SEPARATION_SPEED_TOLERANCE ||
        nonExternalSeparatingSpeed > PATH_ENTRY_SEPARATION_SPEED_TOLERANCE
      ) {
        this.persistentBooleanCircleContacts.delete(circleId)
        continue
      }
      const tangentialAccelerationBefore = dotVectors(relativeAcceleration, beforeFrame.tangent)
      const path = boundary.booleanBoundaryPaths[stored.pathIndex]!
      const groundNormal = this.booleanGroundSupportNormal(boundary)
      const supportedAdvance = groundNormal
        ? this.advanceSupportedBooleanCircleContact(circle, boundary, stored, radiusM, groundNormal)
        : null
      const unwrappedDistanceAfter =
        stored.distanceM +
        (stored.speedMps * this.currentTimeStep +
          0.5 * tangentialAccelerationBefore * this.currentTimeStep ** 2) /
          beforeFrame.centerDistanceScale
      const candidateUnwrappedDistanceAfter =
        supportedAdvance?.unwrappedDistanceM ?? unwrappedDistanceAfter
      const terminalEndpointM = this.booleanCircleTerminalEndpoint(
        path,
        stored,
        candidateUnwrappedDistanceAfter,
      )
      let distanceAfter = terminalEndpointM ?? supportedAdvance?.distanceM ?? unwrappedDistanceAfter
      if (!path.closed && (distanceAfter < 0 || distanceAfter > path.lengthM)) {
        this.persistentBooleanCircleContacts.delete(circleId)
        continue
      }
      const surfaceTravelM =
        terminalEndpointM !== null
          ? Math.abs(terminalEndpointM - stored.distanceM)
          : (supportedAdvance?.surfaceTravelM ??
            Math.abs(unwrappedDistanceAfter - stored.distanceM))
      distanceAfter = normalizedBoundaryDistance(path, distanceAfter)
      const afterFrame = this.booleanBoundaryFrameWithEmptySide(
        boundary,
        stored.pathIndex,
        distanceAfter,
        stored.emptySide,
        radiusM,
      )
      if (!afterFrame) {
        this.persistentBooleanCircleContacts.delete(circleId)
        continue
      }
      if (
        !this.booleanCircleCenterPathIsContinuous(currentBeforeFrame, afterFrame, surfaceTravelM)
      ) {
        this.persistentBooleanCircleContacts.delete(circleId)
        continue
      }
      const tangentialAccelerationAfter = dotVectors(relativeAcceleration, afterFrame.tangent)
      const terminalReducedState =
        terminalEndpointM !== null && groundNormal
          ? this.supportedBooleanCircleReducedState(
              circle,
              boundary,
              stored.pathIndex,
              terminalEndpointM,
              stored.emptySide,
              radiusM,
              groundNormal,
            )
          : null
      const speedAfter =
        terminalReducedState && supportedAdvance
          ? supportedAdvance.reducedMomentum / terminalReducedState.reducedMass
          : (supportedAdvance?.speedMps ??
            stored.speedMps +
              0.5 *
                (tangentialAccelerationBefore + tangentialAccelerationAfter) *
                this.currentTimeStep)
      const requiredNormalAcceleration = speedAfter ** 2 * afterFrame.curvaturePerM
      const externalNormalAcceleration = dotVectors(relativeAcceleration, afterFrame.normal)
      if (requiredNormalAcceleration - externalNormalAcceleration < -1e-6) {
        this.persistentBooleanCircleContacts.delete(circleId)
        continue
      }
      this.projectBooleanCircleContact(
        circle,
        boundary,
        afterFrame,
        radiusM,
        speedAfter,
        terminalEndpointM !== null,
      )
      if (terminalEndpointM !== null) {
        this.persistentBooleanCircleContacts.delete(circleId)
        this.markReleasedBooleanCircleContact(circleId, stored.booleanId)
        continue
      }
      const correctedCircleVelocity = circle.rigidBody.linvel()
      const correctedBoundaryVelocity = this.booleanBoundarySurfaceVelocity(
        boundary,
        afterFrame.position,
      )
      const correctedRelativeSpeed = dotVectors(
        {
          x: correctedCircleVelocity.x - correctedBoundaryVelocity.x,
          y: correctedCircleVelocity.y - correctedBoundaryVelocity.y,
        },
        afterFrame.tangent,
      )
      this.persistentBooleanCircleContacts.set(circleId, {
        ...stored,
        distanceM: distanceAfter,
        speedMps: correctedRelativeSpeed,
      })
    }
  }

  private acquirePersistentBooleanCircleContacts(
    previousBodyStates: Map<EntityId, PreviousBodyState>,
  ): void {
    for (const [circleId, circle] of this.dynamicBodies) {
      const radiusM = collisionRadius(circle.entity)
      if (
        radiusM === null ||
        !circle.collider ||
        this.persistentBooleanCircleContacts.has(circleId)
      ) {
        continue
      }
      const previousCircle = previousBodyStates.get(circleId)
      if (!previousCircle) continue
      for (const [booleanId, boundary] of this.dynamicBodies) {
        if (booleanId === circleId || !boundary.booleanResult) continue
        if (
          this.releasedBooleanCircleContacts.has(this.booleanCirclePairKey(circleId, booleanId))
        ) {
          continue
        }
        const hasPhysicalContact = this.activeBodyColliders(circle).some((circleCollider) =>
          boundary.circleBoundaryColliders.some((boundaryCollider) =>
            this.hasValidSolverContact(circleCollider, boundaryCollider),
          ),
        )
        if (!hasPhysicalContact) continue
        const previousBoundary = previousBodyStates.get(booleanId)
        const candidate = this.closestBooleanBoundaryContact(
          boundary,
          circle.rigidBody.translation(),
          radiusM,
        )
        let previousCandidate: ReturnType<SimulationWorld['closestBooleanBoundaryContact']>
        if (previousBoundary) {
          const currentBoundaryPosition = boundary.rigidBody.translation()
          const currentBoundaryAngle = boundary.rigidBody.rotation()
          boundary.rigidBody.setTranslation(previousBoundary.position, false)
          boundary.rigidBody.setRotation(previousBoundary.angleRad, false)
          previousCandidate = this.closestBooleanBoundaryContact(
            boundary,
            previousCircle.position,
            radiusM,
          )
          boundary.rigidBody.setTranslation(currentBoundaryPosition, false)
          boundary.rigidBody.setRotation(currentBoundaryAngle, false)
        } else {
          previousCandidate = this.closestBooleanBoundaryContact(
            boundary,
            previousCircle.position,
            radiusM,
          )
        }
        if (!candidate || !previousCandidate) continue
        const previousBoundaryVelocity = previousBoundary
          ? {
              x:
                previousBoundary.linearVelocity.x -
                previousBoundary.angularVelocityRad *
                  (previousCandidate.frame.position.y - previousBoundary.position.y),
              y:
                previousBoundary.linearVelocity.y +
                previousBoundary.angularVelocityRad *
                  (previousCandidate.frame.position.x - previousBoundary.position.x),
            }
          : this.booleanBoundarySurfaceVelocity(boundary, previousCandidate.frame.position)
        const relativeVelocity = {
          x: previousCircle.linearVelocity.x - previousBoundaryVelocity.x,
          y: previousCircle.linearVelocity.y - previousBoundaryVelocity.y,
        }
        const contactCaptureClearanceM = Math.max(
          BOOLEAN_BOUNDARY_RELEASE_CLEARANCE_M,
          BOOLEAN_BOUNDARY_CONTACT_TOLERANCE_M +
            Math.hypot(relativeVelocity.x, relativeVelocity.y) * this.currentTimeStep,
        )
        if (
          Math.min(candidate.gapM, previousCandidate.gapM) > BOOLEAN_BOUNDARY_CONTACT_TOLERANCE_M ||
          Math.max(candidate.gapM, previousCandidate.gapM) > contactCaptureClearanceM
        ) {
          continue
        }
        const previousNormalSpeed = dotVectors(relativeVelocity, previousCandidate.frame.normal)
        const currentPathNormalSpeed = dotVectors(relativeVelocity, candidate.frame.normal)
        if (
          previousNormalSpeed > PATH_ENTRY_SEPARATION_SPEED_TOLERANCE &&
          currentPathNormalSpeed > PATH_ENTRY_SEPARATION_SPEED_TOLERANCE
        ) {
          continue
        }
        const currentBoundaryVelocity = this.booleanBoundarySurfaceVelocity(
          boundary,
          candidate.frame.position,
        )
        const currentCircleVelocity = circle.rigidBody.linvel()
        const currentRelativeVelocity = {
          x: currentCircleVelocity.x - currentBoundaryVelocity.x,
          y: currentCircleVelocity.y - currentBoundaryVelocity.y,
        }
        const circleAcceleration = this.externalAcceleration(circle)
        const boundaryAcceleration = this.booleanGroundConstrainedExternalAcceleration(boundary)
        const relativeAcceleration = {
          x: circleAcceleration.x - boundaryAcceleration.x,
          y: circleAcceleration.y - boundaryAcceleration.y,
        }
        // Rapier 的折线边界会在解析圆弧端点给出顶点法线，可能先污染切向速度。
        // 新持续接触从步前真实速度推进，保留无摩擦碰撞的切向分量，再由解析路径接管。
        const capturedTangentialSpeed =
          dotVectors(relativeVelocity, previousCandidate.frame.tangent) +
          0.5 *
            (dotVectors(relativeAcceleration, previousCandidate.frame.tangent) +
              dotVectors(relativeAcceleration, candidate.frame.tangent)) *
            this.currentTimeStep
        const requiredNormalAcceleration =
          capturedTangentialSpeed ** 2 * candidate.frame.curvaturePerM
        const externalNormalAcceleration = dotVectors(relativeAcceleration, candidate.frame.normal)
        const currentNormalSpeed = dotVectors(currentRelativeVelocity, candidate.frame.normal)
        const removeInelasticSolverSeparation =
          currentNormalSpeed > PATH_ENTRY_SEPARATION_SPEED_TOLERANCE &&
          combinedMaterialRestitution(circle.entity.material, candidate.frame.material) <=
            Number.EPSILON
        if (
          (currentNormalSpeed > PATH_ENTRY_SEPARATION_SPEED_TOLERANCE &&
            !removeInelasticSolverSeparation) ||
          requiredNormalAcceleration - externalNormalAcceleration < -1e-6
        ) {
          continue
        }
        this.projectBooleanCircleContact(
          circle,
          boundary,
          candidate.frame,
          radiusM,
          capturedTangentialSpeed,
          removeInelasticSolverSeparation,
        )
        const correctedCircleVelocity = circle.rigidBody.linvel()
        const correctedBoundaryVelocity = this.booleanBoundarySurfaceVelocity(
          boundary,
          candidate.frame.position,
        )
        const correctedTangentialSpeed = dotVectors(
          {
            x: correctedCircleVelocity.x - correctedBoundaryVelocity.x,
            y: correctedCircleVelocity.y - correctedBoundaryVelocity.y,
          },
          candidate.frame.tangent,
        )
        this.persistentBooleanCircleContacts.set(circleId, {
          booleanId,
          pathIndex: candidate.pathIndex,
          distanceM: candidate.distanceM,
          emptySide: candidate.emptySide,
          speedMps: correctedTangentialSpeed,
        })
        break
      }
    }
  }

  private constraintAcceleration(record: DynamicBodyRecord): Vec2 {
    return scaleVector(record.constraintForce, 1 / record.entity.massKg)
  }

  private bodyUsesMasslessRopeConstraint(entityId: EntityId): boolean {
    for (const record of this.connectorRuntimeRecords.values()) {
      if (record.entity.connector.type !== 'rope' || record.entity.massKg > Number.EPSILON) {
        continue
      }
      if (record.first.body?.entity.id === entityId || record.second.body?.entity.id === entityId) {
        return true
      }
    }
    return false
  }

  private shouldKeepNativeStraightGroundConstraint(
    entityId: EntityId,
    frame: GroundPathContactFrame,
  ): boolean {
    const sourceGround = frame.segment.sourceGroundId
      ? this.groundsById.get(frame.segment.sourceGroundId)?.entity
      : null
    return sourceGround?.geometry.type === 'line' && this.bodyUsesMasslessRopeConstraint(entityId)
  }

  private reversedPathContact(contact: PersistentGroundPathContact): PersistentGroundPathContact {
    return {
      ...contact,
      location: {
        ...contact.location,
        direction: contact.location.direction === 1 ? -1 : 1,
      },
      side: contact.side === 1 ? -1 : 1,
    }
  }

  private colliderRecordsForContactSuppression(
    contact: PersistentGroundPathContact,
  ): Set<GroundColliderRecord> {
    const frame = resolveGroundPathContactFrame(this.groundPathNetwork, contact)
    if (!frame) return new Set()
    const colliderRecords = new Set<GroundColliderRecord>()
    const appendSegmentColliders = (segment: GroundNetworkSegment | undefined): void => {
      for (const piece of segment?.collisionPieces ?? []) {
        const colliderRecord = this.groundCollidersByPieceId.get(piece.id)
        if (colliderRecord) colliderRecords.add(colliderRecord)
      }
    }
    appendSegmentColliders(frame.segment)

    const appendReachableSegments = (initialDirection: 1 | -1, centerDistanceM: number): void => {
      let segment = frame.segment
      let s = contact.location.s
      let direction = initialDirection
      let remainingSurfaceM = centerDistanceM / Math.max(frame.offsetScale, 0.08)
      const visited = new Set<string>([segment.id])
      for (let transition = 0; transition < 64 && remainingSurfaceM > 0; transition += 1) {
        const availableSurfaceM = direction === 1 ? segment.path.length - s : s
        if (remainingSurfaceM <= availableSurfaceM + Number.EPSILON) break
        remainingSurfaceM -= availableSurfaceM
        const endpoint = direction === 1 ? 'end' : 'start'
        const neighbor = segment.neighbors[endpoint]
        const next = neighbor
          ? this.groundPathNetwork.segmentById.get(neighbor.segmentId)
          : undefined
        if (!neighbor || !next || visited.has(next.id)) break
        appendSegmentColliders(next)
        visited.add(next.id)
        segment = next
        direction = neighbor.endpoint === 'start' ? 1 : -1
        s = direction === 1 ? 0 : segment.path.length
      }
    }

    const clearanceM = contact.radiusM + ARC_CONTACT_DISTANCE_TOLERANCE
    appendReachableSegments(
      contact.location.direction,
      clearanceM + contact.speedMps * this.fixedTimeStep,
    )
    appendReachableSegments(contact.location.direction === 1 ? -1 : 1, clearanceM)
    return colliderRecords
  }

  private markReleasedPair(
    record: DynamicBodyRecord,
    groundCollider: GroundColliderRecord,
    naturalSide?: 1 | -1,
  ): void {
    if (!record.collider) return
    const resolvedSide =
      naturalSide ??
      (groundCollider.piece.path.closestPoint(record.rigidBody.translation()).signedDistance >= 0
        ? 1
        : -1)
    this.releasedContactPairs.set(
      colliderPairKey(record.collider.handle, groundCollider.collider.handle),
      { naturalSide: resolvedSide },
    )
  }

  private releasePersistentGroundContact(
    entityId: EntityId,
    record: DynamicBodyRecord,
    contact: PersistentGroundPathContact,
  ): void {
    const frame = resolveGroundPathContactFrame(this.groundPathNetwork, contact)
    for (const groundCollider of this.colliderRecordsForContactSuppression(contact)) {
      let naturalSide: 1 | -1 | undefined
      if (frame) {
        const localClosest = groundCollider.piece.path.closestPoint(record.rigidBody.translation())
        const segmentS = groundCollider.piece.startS + localClosest.s
        const naturalNormal = groundCollider.segment.path.normalAt(segmentS)
        naturalSide = dotVectors(frame.contactNormal, naturalNormal) >= 0 ? 1 : -1
      }
      this.markReleasedPair(record, groundCollider, naturalSide)
    }
    this.persistentGroundContacts.delete(entityId)
  }

  private preparePersistentGroundContacts(): void {
    for (const [entityId, storedContact] of this.persistentGroundContacts) {
      const record = this.dynamicBodies.get(entityId)
      if (!record?.collider) {
        this.persistentGroundContacts.delete(entityId)
        continue
      }

      let contact = storedContact
      let frame = resolveGroundPathContactFrame(this.groundPathNetwork, contact)
      if (!frame) {
        this.releasePersistentGroundContact(entityId, record, contact)
        continue
      }

      const velocity = record.rigidBody.linvel()
      if (dotVectors(velocity, frame.tangent) < 0) {
        contact = this.reversedPathContact(contact)
        frame = resolveGroundPathContactFrame(this.groundPathNetwork, contact)
        if (!frame) {
          this.releasePersistentGroundContact(entityId, record, contact)
          continue
        }
      }

      const separatingSpeed = dotVectors(velocity, frame.contactNormal)
      const speedMps = Math.max(0, dotVectors(velocity, frame.tangent))
      contact = { ...contact, speedMps }
      const supportForceN = requiredGroundSupportForceN(
        frame,
        speedMps,
        this.constraintAcceleration(record),
        record.entity.massKg,
      )
      if (
        separatingSpeed > ARC_RADIAL_SEPARATION_SPEED_TOLERANCE ||
        supportForceN < -PATH_SUPPORT_FORCE_TOLERANCE_N
      ) {
        this.releasePersistentGroundContact(entityId, record, contact)
        continue
      }
      this.persistentGroundContacts.set(entityId, contact)
    }
  }

  private groundConveyorSpeedMps(
    frame: GroundPathContactFrame,
    contact: PersistentGroundPathContact,
  ): number {
    let sourceGroundId = frame.segment.sourceGroundId
    let segmentDirectionMatchesGround: 1 | -1 = 1
    if (!sourceGroundId && frame.segment.kind === 'transition') {
      const piece = frame.segment.collisionPieces.find(
        (candidate) =>
          contact.location.s >= candidate.startS - 1e-9 &&
          contact.location.s <= candidate.endS + 1e-9,
      )
      sourceGroundId = piece?.sourceGroundId ?? null
      const joint = frame.segment.jointId
        ? this.scene.entities.find(
            (entity): entity is GroundJointEntity =>
              entity.kind === 'groundJoint' && entity.id === frame.segment.jointId,
          )
        : null
      if (sourceGroundId && joint) {
        const reference = joint.a.groundId === sourceGroundId ? joint.a : joint.b
        segmentDirectionMatchesGround = reference.endpoint === 'end' ? 1 : -1
      }
    }
    if (!sourceGroundId) return 0
    const conveyor = this.groundsById.get(sourceGroundId)?.entity.conveyor
    if (!conveyor?.enabled) return 0
    const directionSign = conveyor.direction === 'forward' ? 1 : -1
    return (
      conveyor.speedMps * directionSign * segmentDirectionMatchesGround * contact.location.direction
    )
  }

  private advancePersistentGroundContacts(
    previousBodyStates: Map<EntityId, PreviousBodyState>,
  ): void {
    for (const [entityId, storedContact] of this.persistentGroundContacts) {
      const record = this.dynamicBodies.get(entityId)
      const previous = previousBodyStates.get(entityId)
      if (!record?.collider || !previous) {
        this.persistentGroundContacts.delete(entityId)
        continue
      }
      let contact = storedContact
      let beforeFrame = resolveGroundPathContactFrame(this.groundPathNetwork, contact)
      if (!beforeFrame) {
        this.releasePersistentGroundContact(entityId, record, contact)
        continue
      }
      const freeVelocity = record.rigidBody.linvel()
      const externalAcceleration = this.externalAcceleration(record)
      const previousSeparatingSpeed = dotVectors(previous.linearVelocity, beforeFrame.contactNormal)
      // Known external forces may point away from the path during this free Rapier step;
      // the path support is allowed to cancel that increment when its required force is positive.
      const nonPathSeparatingSpeed =
        dotVectors(freeVelocity, beforeFrame.contactNormal) -
        previousSeparatingSpeed -
        dotVectors(externalAcceleration, beforeFrame.contactNormal) * this.currentTimeStep
      if (
        previousSeparatingSpeed > ARC_RADIAL_SEPARATION_SPEED_TOLERANCE ||
        nonPathSeparatingSpeed > ARC_RADIAL_SEPARATION_SPEED_TOLERANCE
      ) {
        this.releasePersistentGroundContact(entityId, record, contact)
        continue
      }

      const constraintAcceleration = this.constraintAcceleration(record)
      const speedBefore = Math.max(0, dotVectors(previous.linearVelocity, beforeFrame.tangent))
      let accelerationBefore = dotVectors(externalAcceleration, beforeFrame.tangent)
      const freeTangentialSpeed = dotVectors(freeVelocity, beforeFrame.tangent)
      const nonPathImpulseSpeed =
        freeTangentialSpeed - (speedBefore + accelerationBefore * this.currentTimeStep)
      let instantaneousSpeed = speedBefore + nonPathImpulseSpeed
      let centerDistance =
        instantaneousSpeed * this.currentTimeStep +
        0.5 * accelerationBefore * this.currentTimeStep ** 2

      if (centerDistance < 0 || instantaneousSpeed < 0) {
        contact = this.reversedPathContact(contact)
        beforeFrame = resolveGroundPathContactFrame(this.groundPathNetwork, contact)
        if (!beforeFrame) {
          this.releasePersistentGroundContact(entityId, record, contact)
          continue
        }
        accelerationBefore = -accelerationBefore
        instantaneousSpeed = Math.abs(instantaneousSpeed)
        centerDistance = Math.abs(centerDistance)
      }

      const traversal = traverseGroundPathCenterDistance(
        this.groundPathNetwork,
        contact,
        centerDistance,
      )
      if (!traversal) {
        this.releasePersistentGroundContact(entityId, record, contact)
        continue
      }

      contact = traversal.contact
      let afterFrame = traversal.frame
      const accelerationAfter = dotVectors(externalAcceleration, afterFrame.tangent)
      if (traversal.stoppedAtOpenEnd) {
        const averageTangentialAcceleration = (accelerationBefore + accelerationAfter) / 2
        const timeToEndpoint = travelTimeForDistance(
          traversal.distanceTraveledCenterM,
          instantaneousSpeed,
          averageTangentialAcceleration,
          this.currentTimeStep,
        )
        const remainingTime = this.currentTimeStep - timeToEndpoint
        let endpointSpeed = instantaneousSpeed + averageTangentialAcceleration * timeToEndpoint
        const supportForceN = requiredGroundSupportForceN(
          afterFrame,
          Math.max(0, endpointSpeed),
          constraintAcceleration,
          record.entity.massKg,
        )
        if (endpointSpeed < 0 || supportForceN < -PATH_SUPPORT_FORCE_TOLERANCE_N) {
          this.releasePersistentGroundContact(entityId, record, contact)
          continue
        }
        const friction = applyCoulombPathFriction(
          endpointSpeed,
          record.entity.rotationEnabled ? record.rigidBody.angvel() : 0,
          contact.side,
          contact.radiusM,
          record.entity.massKg,
          record.entity.rotationEnabled ? record.rigidBody.effectiveAngularInertia() : 0,
          Math.max(0, supportForceN),
          combinedPathFriction(record.entity.material, afterFrame.material),
          timeToEndpoint,
          this.groundConveyorSpeedMps(afterFrame, contact),
        )
        endpointSpeed = friction.tangentialSpeedMps
        const postFrictionSupportForceN = requiredGroundSupportForceN(
          afterFrame,
          Math.abs(endpointSpeed),
          constraintAcceleration,
          record.entity.massKg,
        )
        if (postFrictionSupportForceN < -PATH_SUPPORT_FORCE_TOLERANCE_N) {
          this.releasePersistentGroundContact(entityId, record, contact)
          continue
        }
        const endpointVelocity = scaleVector(afterFrame.tangent, endpointSpeed)
        const acceleratedVelocity = {
          x: endpointVelocity.x + externalAcceleration.x * remainingTime,
          y: endpointVelocity.y + externalAcceleration.y * remainingTime,
        }
        const freeVelocity =
          record.magneticFieldTesla !== 0 && record.entity.chargeC !== 0
            ? rotateVelocityInMagneticField(
                acceleratedVelocity,
                record.entity.chargeC,
                record.magneticFieldTesla,
                record.entity.massKg,
                remainingTime,
              )
            : acceleratedVelocity
        const displacement =
          record.magneticFieldTesla !== 0 && record.entity.chargeC !== 0
            ? {
                x: ((endpointVelocity.x + freeVelocity.x) * remainingTime) / 2,
                y: ((endpointVelocity.y + freeVelocity.y) * remainingTime) / 2,
              }
            : {
                x:
                  endpointVelocity.x * remainingTime +
                  0.5 * externalAcceleration.x * remainingTime ** 2,
                y:
                  endpointVelocity.y * remainingTime +
                  0.5 * externalAcceleration.y * remainingTime ** 2,
              }
        record.rigidBody.setTranslation(
          {
            x: afterFrame.position.x + displacement.x,
            y: afterFrame.position.y + displacement.y,
          },
          true,
        )
        record.rigidBody.setLinvel(freeVelocity, true)
        this.setConstrainedAngularVelocity(record, friction.angularVelocityRad)
        this.releasePersistentGroundContact(entityId, record, contact)
        continue
      }

      let speedAfter =
        instantaneousSpeed + 0.5 * (accelerationBefore + accelerationAfter) * this.currentTimeStep
      if (speedAfter < 0) {
        contact = this.reversedPathContact(contact)
        afterFrame = resolveGroundPathContactFrame(this.groundPathNetwork, contact) ?? afterFrame
        speedAfter = Math.abs(speedAfter)
      }

      const supportForceN = requiredGroundSupportForceN(
        afterFrame,
        speedAfter,
        constraintAcceleration,
        record.entity.massKg,
      )
      if (supportForceN < -PATH_SUPPORT_FORCE_TOLERANCE_N) {
        this.releasePersistentGroundContact(entityId, record, contact)
        continue
      }

      const friction = applyCoulombPathFriction(
        speedAfter,
        record.entity.rotationEnabled ? record.rigidBody.angvel() : 0,
        contact.side,
        contact.radiusM,
        record.entity.massKg,
        record.entity.rotationEnabled ? record.rigidBody.effectiveAngularInertia() : 0,
        Math.max(0, supportForceN),
        combinedPathFriction(record.entity.material, afterFrame.material),
        this.currentTimeStep,
        this.groundConveyorSpeedMps(afterFrame, contact),
      )
      speedAfter = friction.tangentialSpeedMps
      if (speedAfter < 0) {
        contact = this.reversedPathContact(contact)
        afterFrame = resolveGroundPathContactFrame(this.groundPathNetwork, contact) ?? afterFrame
        speedAfter = Math.abs(speedAfter)
      }

      const postFrictionSupportForceN = requiredGroundSupportForceN(
        afterFrame,
        speedAfter,
        constraintAcceleration,
        record.entity.massKg,
      )
      if (postFrictionSupportForceN < -PATH_SUPPORT_FORCE_TOLERANCE_N) {
        this.releasePersistentGroundContact(entityId, record, contact)
        continue
      }

      record.rigidBody.setTranslation(afterFrame.position, true)
      record.rigidBody.setLinvel(scaleVector(afterFrame.tangent, speedAfter), true)
      this.setConstrainedAngularVelocity(record, friction.angularVelocityRad)
      this.persistentGroundContacts.set(entityId, { ...contact, speedMps: speedAfter })
    }
  }

  private refreshReleasedContactPairs(): void {
    for (const [pairKey, released] of this.releasedContactPairs) {
      const [firstText, secondText] = pairKey.split(':')
      const firstHandle = Number(firstText)
      const secondHandle = Number(secondText)
      const groundCollider =
        this.groundsByCollider.get(firstHandle) ?? this.groundsByCollider.get(secondHandle)
      const body = this.dynamicColliders.get(firstHandle) ?? this.dynamicColliders.get(secondHandle)
      const radius = body ? collisionRadius(body.entity) : null
      if (!groundCollider || !body || radius === null) {
        this.releasedContactPairs.delete(pairKey)
        continue
      }
      const position = body.rigidBody.translation()
      const closest = groundCollider.piece.path.closestPoint(position)
      const outwardClearance = released.naturalSide * closest.signedDistance - radius
      if (outwardClearance > PATH_RELEASE_CLEARANCE_M) {
        this.releasedContactPairs.delete(pairKey)
      }
    }
  }

  private groundContactProposal(
    record: DynamicBodyRecord,
    groundCollider: GroundColliderRecord,
    radiusM: number,
    previous: PreviousBodyState,
  ): GroundContactProposal | null {
    const position = record.rigidBody.translation()
    const candidate = findGroundPathContactCandidate(
      this.groundPathNetwork,
      groundCollider.piece.sourceGroundId,
      position,
      radiusM,
      groundCollider.piece.id,
    )
    if (!candidate) return null

    const previousCandidate = findGroundPathContactCandidate(
      this.groundPathNetwork,
      groundCollider.piece.sourceGroundId,
      previous.position,
      radiusM,
      groundCollider.piece.id,
    )
    if (!previousCandidate) return null
    if (Math.min(candidate.gapM, previousCandidate.gapM) > ARC_CONTACT_DISTANCE_TOLERANCE) {
      return null
    }
    const naturalTangent = groundCollider.segment.path.tangentAt(candidate.s)
    const velocity = record.rigidBody.linvel()
    const previousNaturalNormal = groundCollider.segment.path.normalAt(previousCandidate.s)
    const previousContactNormal = scaleVector(previousNaturalNormal, candidate.naturalSide)
    const preStepSeparatingSpeedMps = dotVectors(previous.linearVelocity, previousContactNormal)
    const mayProjectSolverSeparation =
      combinedMaterialRestitution(record.entity.material, groundCollider.piece.material) <=
        Number.EPSILON &&
      Math.abs(preStepSeparatingSpeedMps) <= ARC_RADIAL_SEPARATION_SPEED_TOLERANCE
    const mayRestorePreStepTangentialSpeed =
      mayProjectSolverSeparation &&
      combinedPathFriction(record.entity.material, groundCollider.piece.material) <= Number.EPSILON
    const previousNaturalTangent = groundCollider.segment.path.tangentAt(previousCandidate.s)
    const pathAcceleration = this.externalAcceleration(record)
    const naturalSpeed = mayRestorePreStepTangentialSpeed
      ? dotVectors(previous.linearVelocity, previousNaturalTangent) +
        0.5 *
          (dotVectors(pathAcceleration, previousNaturalTangent) +
            dotVectors(pathAcceleration, naturalTangent)) *
          this.currentTimeStep
      : dotVectors(velocity, naturalTangent)
    const direction: 1 | -1 = naturalSpeed < 0 ? -1 : 1
    const contact: PersistentGroundPathContact = {
      location: { segmentId: candidate.segmentId, s: candidate.s, direction },
      side: (candidate.naturalSide * direction) as 1 | -1,
      radiusM,
      speedMps: Math.abs(naturalSpeed),
    }
    const frame = resolveGroundPathContactFrame(this.groundPathNetwork, contact)
    if (!frame) return null
    return {
      colliderRecord: groundCollider,
      candidate,
      contact,
      frame,
      separatingSpeedMps: dotVectors(velocity, frame.contactNormal),
      preStepSeparatingSpeedMps,
      mayProjectSolverSeparation,
      supportForceN: requiredGroundSupportForceN(
        frame,
        contact.speedMps,
        this.constraintAcceleration(record),
        record.entity.massKg,
      ),
    }
  }

  private groundLocationsAreLocallyAdjacent(
    firstSegment: GroundNetworkSegment,
    firstS: number,
    secondSegment: GroundNetworkSegment,
    secondS: number,
    radiusM: number,
  ): boolean {
    const maximumEndpointDistance = radiusM + ARC_CONTACT_DISTANCE_TOLERANCE
    if (firstSegment.id === secondSegment.id) {
      const directDistance = Math.abs(firstS - secondS)
      const arcDistance = firstSegment.path.closed
        ? Math.min(directDistance, firstSegment.path.length - directDistance)
        : directDistance
      return arcDistance <= maximumEndpointDistance * 2
    }
    for (const endpoint of ['start', 'end'] as const) {
      const neighbor = firstSegment.neighbors[endpoint]
      if (!neighbor || neighbor.segmentId !== secondSegment.id) continue
      const firstDistance = endpoint === 'start' ? firstS : firstSegment.path.length - firstS
      const secondDistance =
        neighbor.endpoint === 'start' ? secondS : secondSegment.path.length - secondS
      if (firstDistance <= maximumEndpointDistance && secondDistance <= maximumEndpointDistance) {
        return true
      }
    }
    return false
  }

  private groundProposalsAreLocallyAdjacent(
    first: GroundContactProposal,
    second: GroundContactProposal,
    radiusM: number,
  ): boolean {
    return this.groundLocationsAreLocallyAdjacent(
      first.frame.segment,
      first.candidate.s,
      second.frame.segment,
      second.candidate.s,
      radiusM,
    )
  }

  private invalidGroundColliderIsLocalToProposals(
    groundCollider: GroundColliderRecord,
    proposals: readonly GroundContactProposal[],
    bodyPosition: Vec2,
    radiusM: number,
  ): boolean {
    const candidate = findGroundPathContactCandidate(
      this.groundPathNetwork,
      groundCollider.piece.sourceGroundId,
      bodyPosition,
      radiusM,
      groundCollider.piece.id,
    )
    if (!candidate) return false
    return proposals.some((proposal) =>
      this.groundLocationsAreLocallyAdjacent(
        groundCollider.segment,
        candidate.s,
        proposal.frame.segment,
        proposal.candidate.s,
        radiusM,
      ),
    )
  }

  private groundProposalsFormLocalContactGroup(
    proposals: readonly GroundContactProposal[],
    radiusM: number,
  ): boolean {
    if (proposals.length <= 1) return true
    const visited = new Set<number>([0])
    let changed = true
    while (changed) {
      changed = false
      for (let candidateIndex = 0; candidateIndex < proposals.length; candidateIndex += 1) {
        if (visited.has(candidateIndex)) continue
        for (const visitedIndex of visited) {
          if (
            this.groundProposalsAreLocallyAdjacent(
              proposals[visitedIndex]!,
              proposals[candidateIndex]!,
              radiusM,
            )
          ) {
            visited.add(candidateIndex)
            changed = true
            break
          }
        }
      }
    }
    return visited.size === proposals.length
  }

  private acquirePersistentGroundContacts(
    previousBodyStates: Map<EntityId, PreviousBodyState>,
  ): void {
    for (const [entityId, record] of this.dynamicBodies) {
      const radius = collisionRadius(record.entity)
      if (radius === null || !record.collider || this.persistentGroundContacts.has(entityId)) {
        continue
      }
      const previous = previousBodyStates.get(entityId)
      if (!previous) continue
      const contacts = this.validContactColliders(record.collider)
      if (contacts.length === 0) continue
      const groundColliders = contacts.map((contact) => this.groundsByCollider.get(contact.handle))
      if (groundColliders.some((groundCollider) => !groundCollider)) continue
      if (
        groundColliders.some((groundCollider) =>
          this.releasedContactPairs.has(
            colliderPairKey(record.collider!.handle, groundCollider!.collider.handle),
          ),
        )
      ) {
        continue
      }

      const proposals: GroundContactProposal[] = []
      const invalidGroundColliders: GroundColliderRecord[] = []
      for (const groundCollider of groundColliders) {
        const proposal = this.groundContactProposal(record, groundCollider!, radius, previous)
        if (!proposal) {
          invalidGroundColliders.push(groundCollider!)
          continue
        }
        proposals.push(proposal)
      }
      if (proposals.length === 0) continue
      const bodyPosition = record.rigidBody.translation()
      if (
        invalidGroundColliders.some(
          (groundCollider) =>
            !this.invalidGroundColliderIsLocalToProposals(
              groundCollider,
              proposals,
              bodyPosition,
              radius,
            ),
        ) ||
        !this.groundProposalsFormLocalContactGroup(proposals, radius)
      ) {
        continue
      }

      const qualified = proposals.filter((proposal) => {
        const accepted =
          (proposal.separatingSpeedMps <= PATH_ENTRY_SEPARATION_SPEED_TOLERANCE ||
            proposal.mayProjectSolverSeparation) &&
          proposal.preStepSeparatingSpeedMps <= ARC_RADIAL_SEPARATION_SPEED_TOLERANCE &&
          proposal.supportForceN >= -PATH_SUPPORT_FORCE_TOLERANCE_N
        if (!accepted) {
          this.markReleasedPair(record, proposal.colliderRecord, proposal.candidate.naturalSide)
        }
        return accepted
      })
      qualified.sort(
        (first, second) =>
          first.candidate.gapM - second.candidate.gapM ||
          first.separatingSpeedMps - second.separatingSpeedMps,
      )
      const selected = qualified[0]
      if (!selected) continue
      if (this.shouldKeepNativeStraightGroundConstraint(entityId, selected.frame)) continue

      record.rigidBody.setTranslation(selected.frame.position, true)
      record.rigidBody.setLinvel(
        scaleVector(selected.frame.tangent, selected.contact.speedMps),
        true,
      )
      this.persistentGroundContacts.set(entityId, selected.contact)
    }
  }
}
