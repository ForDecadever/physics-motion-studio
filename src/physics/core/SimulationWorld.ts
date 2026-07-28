import RAPIER from '@dimforge/rapier2d-compat'

import type {
  BodyEntity,
  ConnectorEntity,
  EntityId,
  FieldEntity,
  GroundEntity,
  GroundJointEntity,
  Material2D,
  SceneDocument,
  Vec2,
} from '../../scene/model/types'
import { resolveGroundJoint } from '../../scene/model/groundEndpoints'
import type { RuntimeBodyState } from '../worker/messages'
import {
  buildGroundPathNetwork,
  type GroundCollisionPathPiece,
  type GroundNetworkSegment,
  type GroundPathNetwork,
} from '../../scene/model/groundPath'
import { regionContainsPoint } from './fieldRegions'
import {
  addForce,
  coulombForceOnFirst,
  electricForce,
  magneticForce,
  rotateVelocityInMagneticField,
  scaleForce,
  springForceOnFirst,
} from './forces'
import { flattenGroundPoints } from './groundSampling'
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

await RAPIER.init()

const MIN_FIXED_TIME_STEP = 1 / 1000
const MAX_FIXED_TIME_STEP = 1 / 30
const ROD_SOLVER_ITERATIONS = 8
const ROD_POSITION_TOLERANCE_M = 1e-6
const ROD_VELOCITY_TOLERANCE_MPS = 1e-6
const ARC_CONTACT_DISTANCE_TOLERANCE = 0.003
const ARC_RADIAL_SEPARATION_SPEED_TOLERANCE = 0.001
const PATH_ENTRY_SEPARATION_SPEED_TOLERANCE = 0.005
const PATH_RELEASE_CLEARANCE_M = ARC_CONTACT_DISTANCE_TOLERANCE * 2
const PATH_SUPPORT_FORCE_TOLERANCE_N = 1e-6
const BLOCK_GROUND_HALF_THICKNESS_M = 0.0005
const BLOCK_GROUND_CAP_CLEARANCE_M = 0.002
const MAX_SPRING_PHASE_STEP = 0.1
const MAX_SPRING_INTERNAL_SUBSTEPS = 32
const MIN_SPRING_IMPULSE_NS = 1e-12
const DYNAMIC_BODY_GROUP = 0x0001
const CIRCLE_GROUND_GROUP = 0x0002
const BOX_GROUND_GROUP = 0x0004

function interactionGroups(membership: number, filter: number): number {
  return (membership << 16) | filter
}

const CIRCLE_BODY_COLLISION_GROUPS = interactionGroups(
  DYNAMIC_BODY_GROUP,
  DYNAMIC_BODY_GROUP | CIRCLE_GROUND_GROUP,
)
const BOX_BODY_COLLISION_GROUPS = interactionGroups(
  DYNAMIC_BODY_GROUP,
  DYNAMIC_BODY_GROUP | BOX_GROUND_GROUP,
)
const CIRCLE_GROUND_COLLISION_GROUPS = interactionGroups(CIRCLE_GROUND_GROUP, DYNAMIC_BODY_GROUP)
const BOX_GROUND_COLLISION_GROUPS = interactionGroups(BOX_GROUND_GROUP, DYNAMIC_BODY_GROUP)

interface DynamicBodyRecord {
  entity: BodyEntity
  rigidBody: RAPIER.RigidBody
  collider: RAPIER.Collider | null
  boundingRadius: number
  netForce: Vec2
  pathForce: Vec2
  constraintForce: Vec2
  magneticFieldTesla: number
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
}

interface BlockGroundColliderRecord {
  colliderHandle: number
  start: Vec2
  end: Vec2
  collisionStart: Vec2
  collisionEnd: Vec2
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

interface ReleasedGroundContact {
  naturalSide: 1 | -1
}

interface PreviousBodyState {
  position: Vec2
  linearVelocity: Vec2
}

interface ConnectorRecord {
  entity: ConnectorEntity
  first: DynamicBodyRecord
  second: DynamicBodyRecord
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

function colliderForBody(entity: BodyEntity): RAPIER.ColliderDesc | null {
  const shape = entity.shape
  if (shape.type === 'circle') {
    return shape.collisionEnabled ? RAPIER.ColliderDesc.ball(shape.radius) : null
  }
  return RAPIER.ColliderDesc.cuboid(shape.width / 2, shape.height / 2)
}

function scaleVector(vector: Vec2, factor: number): Vec2 {
  return { x: vector.x * factor, y: vector.y * factor }
}

function colliderPairKey(firstHandle: number, secondHandle: number): string {
  return firstHandle < secondHandle
    ? `${firstHandle}:${secondHandle}`
    : `${secondHandle}:${firstHandle}`
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

function bodyBoundingRadius(entity: BodyEntity): number {
  if (entity.shape.type === 'circle') return entity.shape.radius
  return Math.hypot(entity.shape.width, entity.shape.height) / 2
}

export class SimulationWorld {
  readonly fixedTimeStep: number
  readonly warnings: SimulationWarning[] = []

  private world: RAPIER.World
  private currentTimeStep: number
  private springSubstepCount = 1
  private readonly eventQueue = new RAPIER.EventQueue(true)
  private readonly suppressedContactPairs = new Set<string>()
  private readonly physicsHooks: RAPIER.PhysicsHooks = {
    filterContactPair: (collider1, collider2) =>
      this.suppressedContactPairs.has(colliderPairKey(collider1, collider2))
        ? RAPIER.SolverFlags.EMPTY
        : RAPIER.SolverFlags.COMPUTE_IMPULSE,
    filterIntersectionPair: () => true,
  }
  private readonly dynamicBodies = new Map<EntityId, DynamicBodyRecord>()
  private readonly dynamicColliders = new Map<number, DynamicBodyRecord>()
  private readonly fields: FieldEntity[] = []
  private readonly rods: RodConnectorRecord[] = []
  private readonly springs: SpringConnectorRecord[] = []
  private readonly groundsById = new Map<EntityId, GroundRecord>()
  private readonly groundsByCollider = new Map<number, GroundColliderRecord>()
  private readonly groundCollidersByPieceId = new Map<string, GroundColliderRecord>()
  private readonly blockGroundColliderChains: BlockGroundColliderChain[] = []
  private groundPathNetwork!: GroundPathNetwork
  private readonly persistentGroundContacts = new Map<EntityId, PersistentGroundPathContact>()
  private readonly releasedContactPairs = new Map<string, ReleasedGroundContact>()
  private simulationTimeValue = 0

  constructor(private readonly scene: SceneDocument) {
    this.fixedTimeStep = validatedTimeStep(scene.settings.fixedTimeStep)
    this.currentTimeStep = this.fixedTimeStep
    this.world = new RAPIER.World({ x: 0, y: 0 })
    this.world.timestep = this.fixedTimeStep
    this.buildScene()
  }

  get simulationTime(): number {
    return this.simulationTimeValue
  }

  private refreshSuppressedContactPairs(): void {
    this.suppressedContactPairs.clear()
    for (const [entityId, contact] of this.persistentGroundContacts) {
      const record = this.dynamicBodies.get(entityId)
      if (!record?.collider) continue
      for (const groundCollider of this.colliderRecordsForContactSuppression(contact)) {
        this.suppressedContactPairs.add(
          colliderPairKey(groundCollider.collider.handle, record.collider.handle),
        )
      }
    }
    for (const record of this.dynamicBodies.values()) {
      if (record.entity.shape.type !== 'box' || !record.collider) continue
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
          this.suppressedContactPairs.add(
            colliderPairKey(record.collider.handle, ground.colliderHandle),
          )
        }
      }
    }
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

  step(stepCount = 1): void {
    const count = Math.max(0, Math.floor(stepCount))
    if (count === 0) return
    this.currentTimeStep = this.fixedTimeStep / this.springSubstepCount
    this.world.timestep = this.currentTimeStep

    try {
      for (let index = 0; index < count; index += 1) {
        const logicalPreviousBodyStates = this.captureBodyStates()
        for (let substep = 0; substep < this.springSubstepCount; substep += 1) {
          const previousBodyStates = this.captureBodyStates()
          this.resetExternalForces()
          this.applyFieldForces()
          this.applyPairwiseElectrostatics()
          this.recordSpringConstraintForces()
          this.applySpringDampingImpulse(this.currentTimeStep / 2)
          this.applySpringElasticImpulse(this.currentTimeStep / 2)
          this.preparePersistentGroundContacts()
          this.refreshSuppressedContactPairs()
          this.world.step(this.eventQueue, this.physicsHooks)
          this.applySpringElasticImpulse(this.currentTimeStep / 2)
          this.applySpringDampingImpulse(this.currentTimeStep / 2)
          this.advancePersistentGroundContacts(previousBodyStates)
          this.refreshReleasedContactPairs()
          this.acquirePersistentGroundContacts(previousBodyStates)
          this.solveRodConstraints()
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
      }
    })
  }

  dispose(): void {
    this.dynamicBodies.clear()
    this.dynamicColliders.clear()
    this.fields.length = 0
    this.rods.length = 0
    this.springs.length = 0
    this.groundsById.clear()
    this.groundsByCollider.clear()
    this.groundCollidersByPieceId.clear()
    this.blockGroundColliderChains.length = 0
    this.persistentGroundContacts.clear()
    this.releasedContactPairs.clear()
    this.suppressedContactPairs.clear()
    this.eventQueue.free()
    this.world.free()
  }

  private buildScene(): void {
    const enabledEntities = this.scene.entities.filter((entity) => entity.simulationEnabled)
    this.groundPathNetwork = buildGroundPathNetwork(enabledEntities)
    const hasCircleColliders = enabledEntities.some(
      (entity) =>
        entity.kind === 'body' && entity.shape.type === 'circle' && entity.shape.collisionEnabled,
    )
    const hasBoxColliders = enabledEntities.some(
      (entity) => entity.kind === 'body' && entity.shape.type === 'box',
    )
    const maximumBoxRadius = enabledEntities.reduce(
      (maximum, entity) =>
        entity.kind === 'body' && entity.shape.type === 'box'
          ? Math.max(maximum, Math.hypot(entity.shape.width, entity.shape.height) / 2)
          : maximum,
      0,
    )

    const connectors: ConnectorEntity[] = []
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
              piece.material,
            ).setCollisionGroups(CIRCLE_GROUND_COLLISION_GROUPS),
          )
          const colliderRecord: GroundColliderRecord = { ground, collider, segment, piece }
          ground.colliders.push(colliderRecord)
          this.groundsByCollider.set(collider.handle, colliderRecord)
          this.groundCollidersByPieceId.set(piece.id, colliderRecord)
        }
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
              chain.material,
            ).setCollisionGroups(BOX_GROUND_COLLISION_GROUPS),
          )
          chainColliders.push({
            colliderHandle: collider.handle,
            start,
            end,
            collisionStart: extendedStart,
            collisionEnd: extendedEnd,
          })
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

    for (const ground of this.groundsById.values()) {
      if (!this.groundPathNetwork.groundPaths.has(ground.entity.id)) {
        this.warnings.push({ message: '地面长度为零，已忽略。', entityId: ground.entity.id })
      }
    }

    for (const entity of enabledEntities) {
      if (entity.kind === 'groundJoint') {
        groundJoints.push(entity)
      } else if (entity.kind === 'body') {
        this.createBody(entity)
      } else if (entity.kind === 'field') {
        this.fields.push(entity)
      } else if (entity.kind === 'connector') {
        connectors.push(entity)
      }
    }

    for (const connector of connectors) this.createConnector(connector)
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
      boundingRadius: bodyBoundingRadius(entity),
      netForce: { x: 0, y: 0 },
      pathForce: { x: 0, y: 0 },
      constraintForce: { x: 0, y: 0 },
      magneticFieldTesla: 0,
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

  private createConnector(entity: ConnectorEntity): void {
    const first = this.dynamicBodies.get(entity.a.bodyId)
    const second = this.dynamicBodies.get(entity.b.bodyId)
    if (!first || !second || first === second) {
      this.warnings.push({ message: '连接器端点无效，已忽略。', entityId: entity.id })
      return
    }

    if (entity.connector.type === 'rope') {
      const joint = RAPIER.JointData.rope(
        entity.connector.maxLength,
        entity.a.localAnchor,
        entity.b.localAnchor,
      )
      this.world.createImpulseJoint(joint, first.rigidBody, second.rigidBody, true)
    } else if (entity.connector.type === 'rod') {
      const rod = {
        entity: entity as RodConnectorRecord['entity'],
        first,
        second,
      }
      if (entity.connector.freeRotation) {
        this.rods.push(rod)
      } else {
        this.createFixedRodJoint(rod)
      }
    } else {
      this.springs.push({
        entity: entity as SpringConnectorRecord['entity'],
        first,
        second,
        effectiveStiffness: entity.connector.stiffness,
        effectiveInverseMassUpperBound: 0,
      })
    }
  }

  private createFixedRodJoint(rod: RodConnectorRecord): void {
    const firstEndpoint = this.connectorEndpointState(rod.first, rod.entity.a.localAnchor)
    const secondEndpoint = this.connectorEndpointState(rod.second, rod.entity.b.localAnchor)
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
      x: rod.entity.b.localAnchor.x - desiredOffsetLocalToSecond.x,
      y: rod.entity.b.localAnchor.y - desiredOffsetLocalToSecond.y,
    }
    const fixed = RAPIER.JointData.fixed(
      rod.entity.a.localAnchor,
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

  private configureSpringIntegration(): void {
    let requiredSubsteps = 1
    for (const spring of this.springs) {
      const firstInverseMass = spring.first.rigidBody.effectiveInvMass()
      const secondInverseMass = spring.second.rigidBody.effectiveInvMass()
      const firstInertia = spring.first.rigidBody.effectiveAngularInertia()
      const secondInertia = spring.second.rigidBody.effectiveAngularInertia()
      const firstAnchorRadiusSquared =
        spring.entity.a.localAnchor.x ** 2 + spring.entity.a.localAnchor.y ** 2
      const secondAnchorRadiusSquared =
        spring.entity.b.localAnchor.x ** 2 + spring.entity.b.localAnchor.y ** 2
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
  }

  private applyForceToBody(record: DynamicBodyRecord, force: Vec2, point?: Vec2): void {
    record.netForce = addForce(record.netForce, force)
    record.pathForce = addForce(record.pathForce, force)
    record.constraintForce = addForce(record.constraintForce, force)
    if (point) record.rigidBody.addForceAtPoint(force, point, false)
    else record.rigidBody.addForce(force, false)
  }

  private applyFieldForces(): void {
    for (const record of this.dynamicBodies.values()) {
      const position = record.rigidBody.translation()
      const velocity = record.rigidBody.linvel()
      let combinedMagneticField = 0

      for (const field of this.fields) {
        if (!regionContainsPoint(field.region, position)) continue
        if (field.field.type === 'uniformGravity') {
          this.applyForceToBody(record, scaleForce(field.field.acceleration, record.entity.massKg))
        } else if (field.field.type === 'uniformElectric') {
          this.applyForceToBody(record, electricForce(record.entity.chargeC, field.field.strength))
        } else {
          combinedMagneticField += field.field.bzTesla
        }
      }

      if (combinedMagneticField !== 0 && record.entity.chargeC !== 0) {
        record.magneticFieldTesla = combinedMagneticField
        const force = magneticForce(record.entity.chargeC, velocity, combinedMagneticField)
        record.netForce = addForce(record.netForce, force)
        record.constraintForce = addForce(record.constraintForce, force)
        if (!this.persistentGroundContacts.has(record.entity.id)) {
          record.rigidBody.setLinvel(
            rotateVelocityInMagneticField(
              velocity,
              record.entity.chargeC,
              combinedMagneticField,
              record.entity.massKg,
              this.currentTimeStep,
            ),
            true,
          )
        }
      }
    }
  }

  private applyPairwiseElectrostatics(): void {
    if (!this.scene.settings.pairwiseElectrostatics) return
    const chargedBodies = [...this.dynamicBodies.values()].filter(
      (record) => record.entity.chargeC !== 0,
    )

    for (let firstIndex = 0; firstIndex < chargedBodies.length; firstIndex += 1) {
      const first = chargedBodies[firstIndex]
      if (!first) continue
      for (let secondIndex = firstIndex + 1; secondIndex < chargedBodies.length; secondIndex += 1) {
        const second = chargedBodies[secondIndex]
        if (!second) continue
        const force = coulombForceOnFirst(
          first.entity.chargeC,
          second.entity.chargeC,
          first.rigidBody.translation(),
          second.rigidBody.translation(),
          first.boundingRadius + second.boundingRadius,
        )
        this.applyForceToBody(first, force)
        this.applyForceToBody(second, scaleForce(force, -1))
      }
    }
  }

  private connectorEndpointState(
    record: DynamicBodyRecord,
    localAnchor: Vec2,
  ): ConnectorEndpointState {
    const angle = record.rigidBody.rotation()
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    const offset = {
      x: cosine * localAnchor.x - sine * localAnchor.y,
      y: sine * localAnchor.x + cosine * localAnchor.y,
    }
    const translation = record.rigidBody.translation()
    const linearVelocity = record.rigidBody.linvel()
    const angularVelocity = record.entity.rotationEnabled ? record.rigidBody.angvel() : 0
    return {
      position: { x: translation.x + offset.x, y: translation.y + offset.y },
      velocity: {
        x: linearVelocity.x - angularVelocity * offset.y,
        y: linearVelocity.y + angularVelocity * offset.x,
      },
      offset,
    }
  }

  private directionalInverseMassAtPoint(
    record: DynamicBodyRecord,
    point: Vec2,
    direction: Vec2,
  ): number {
    const inverseMass = record.rigidBody.effectiveInvMass()
    const translational = direction.x ** 2 * inverseMass.x + direction.y ** 2 * inverseMass.y
    const center = record.rigidBody.translation()
    const offset = { x: point.x - center.x, y: point.y - center.y }
    const leverArm = offset.x * direction.y - offset.y * direction.x
    const inertia = record.rigidBody.effectiveAngularInertia()
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
    const firstEndpoint = this.connectorEndpointState(rod.first, rod.entity.a.localAnchor)
    const secondEndpoint = this.connectorEndpointState(rod.second, rod.entity.b.localAnchor)
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
    record: DynamicBodyRecord,
    endpoint: ConnectorEndpointState,
    direction: Vec2,
    jacobianSign: -1 | 1,
    impulseMagnitude: number,
  ): void {
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
    const leverArm = endpoint.offset.x * direction.y - endpoint.offset.y * direction.x
    record.rigidBody.setRotation(
      record.rigidBody.rotation() + (signedImpulse * leverArm) / inertia,
      true,
    )
  }

  private rodBodyComponents(): DynamicBodyRecord[][] {
    const neighbors = new Map<DynamicBodyRecord, Set<DynamicBodyRecord>>()
    for (const rod of this.rods) {
      const firstNeighbors = neighbors.get(rod.first) ?? new Set<DynamicBodyRecord>()
      const secondNeighbors = neighbors.get(rod.second) ?? new Set<DynamicBodyRecord>()
      firstNeighbors.add(rod.second)
      secondNeighbors.add(rod.first)
      neighbors.set(rod.first, firstNeighbors)
      neighbors.set(rod.second, secondNeighbors)
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
          if (!componentRecords.has(rod.first) || !componentRecords.has(rod.second)) continue
          const frame = this.rodFrame(rod)
          const firstMode = correctionMode.get(rod.first)
          const secondMode = correctionMode.get(rod.second)
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
          const firstInverseMass = rod.first.rigidBody.effectiveInvMass()
          const secondInverseMass = rod.second.rigidBody.effectiveInvMass()
          firstMode.linearVelocity.x -= frame.direction.x * impulseMagnitude * firstInverseMass.x
          firstMode.linearVelocity.y -= frame.direction.y * impulseMagnitude * firstInverseMass.y
          secondMode.linearVelocity.x += frame.direction.x * impulseMagnitude * secondInverseMass.x
          secondMode.linearVelocity.y += frame.direction.y * impulseMagnitude * secondInverseMass.y

          const firstInertia = rod.first.rigidBody.effectiveAngularInertia()
          const secondInertia = rod.second.rigidBody.effectiveAngularInertia()
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
    const firstEndpoint = this.connectorEndpointState(spring.first, spring.entity.a.localAnchor)
    const secondEndpoint = this.connectorEndpointState(spring.second, spring.entity.b.localAnchor)
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
    spring.first.rigidBody.applyImpulseAtPoint(impulse, frame.firstEndpoint.position, true)
    spring.second.rigidBody.applyImpulseAtPoint(
      scaleForce(impulse, -1),
      frame.secondEndpoint.position,
      true,
    )
  }

  private recordSpringConstraintForces(): void {
    for (const spring of this.springs) {
      const firstEndpoint = this.connectorEndpointState(spring.first, spring.entity.a.localAnchor)
      const secondEndpoint = this.connectorEndpointState(spring.second, spring.entity.b.localAnchor)
      const force = springForceOnFirst(
        firstEndpoint.position,
        firstEndpoint.velocity,
        secondEndpoint.position,
        secondEndpoint.velocity,
        spring.entity.connector.restLength,
        spring.effectiveStiffness,
        spring.entity.connector.damping,
      )
      spring.first.constraintForce = addForce(spring.first.constraintForce, force)
      spring.second.constraintForce = addForce(spring.second.constraintForce, scaleForce(force, -1))
    }
  }

  private applySpringElasticImpulse(durationSeconds: number): void {
    for (const spring of this.springs) {
      if (spring.effectiveStiffness === 0) continue
      const frame = this.springFrame(spring)
      if (!frame) continue
      const forceMagnitude =
        spring.effectiveStiffness * (frame.length - spring.entity.connector.restLength)
      this.applySpringImpulse(spring, forceMagnitude * durationSeconds, frame)
    }
  }

  private applySpringDampingImpulse(durationSeconds: number): void {
    for (const spring of this.springs) {
      const damping = spring.entity.connector.damping
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
        rod.first.rigidBody.applyImpulseAtPoint(
          scaleForce(impulse, -1),
          frame.firstEndpoint.position,
          true,
        )
        rod.second.rigidBody.applyImpulseAtPoint(impulse, frame.secondEndpoint.position, true)
        if (!rod.first.entity.rotationEnabled) {
          this.setConstrainedAngularVelocity(rod.first, 0)
        }
        if (!rod.second.entity.rotationEnabled) {
          this.setConstrainedAngularVelocity(rod.second, 0)
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

  private externalAcceleration(record: DynamicBodyRecord): Vec2 {
    return scaleVector(record.pathForce, 1 / record.entity.massKg)
  }

  private constraintAcceleration(record: DynamicBodyRecord): Vec2 {
    return scaleVector(record.constraintForce, 1 / record.entity.massKg)
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

    for (const endpoint of ['start', 'end'] as const) {
      const distanceToEndpoint =
        endpoint === 'start' ? contact.location.s : frame.segment.path.length - contact.location.s
      const isForwardEndpoint =
        (contact.location.direction === 1 && endpoint === 'end') ||
        (contact.location.direction === -1 && endpoint === 'start')
      const suppressionDistance =
        contact.radiusM +
        ARC_CONTACT_DISTANCE_TOLERANCE +
        (isForwardEndpoint ? (contact.speedMps * this.currentTimeStep) / frame.offsetScale : 0)
      if (distanceToEndpoint > suppressionDistance) continue
      const neighbor = frame.segment.neighbors[endpoint]
      const neighborSegment = neighbor
        ? this.groundPathNetwork.segmentById.get(neighbor.segmentId)
        : null
      appendSegmentColliders(neighborSegment ?? undefined)
    }
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
      if (
        dotVectors(freeVelocity, beforeFrame.contactNormal) > ARC_RADIAL_SEPARATION_SPEED_TOLERANCE
      ) {
        this.releasePersistentGroundContact(entityId, record, contact)
        continue
      }

      const externalAcceleration = this.externalAcceleration(record)
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

      record.rigidBody.setTranslation(selected.frame.position, true)
      record.rigidBody.setLinvel(
        scaleVector(selected.frame.tangent, selected.contact.speedMps),
        true,
      )
      this.persistentGroundContacts.set(entityId, selected.contact)
    }
  }
}
