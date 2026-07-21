import RAPIER from '@dimforge/rapier2d-compat'

import type {
  BodyEntity,
  ConnectorEntity,
  EntityId,
  FieldEntity,
  GroundEntity,
  Material2D,
  SceneDocument,
  Vec2,
} from '../../scene/model/types'
import type { RuntimeBodyState } from '../worker/messages'
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
import { flattenGroundPoints, sampleGroundGeometry } from './groundSampling'

await RAPIER.init()

const MIN_FIXED_TIME_STEP = 1 / 1000
const MAX_FIXED_TIME_STEP = 1 / 30
const ROD_POSITION_SOLVER_ITERATIONS = 4

interface DynamicBodyRecord {
  entity: BodyEntity
  rigidBody: RAPIER.RigidBody
  collider: RAPIER.Collider | null
  boundingRadius: number
  netForce: Vec2
}

interface ArcGroundRecord {
  entity: GroundEntity & { geometry: Extract<GroundEntity['geometry'], { type: 'arc' }> }
  collider: RAPIER.Collider
}

interface OneSidedGroundRecord {
  points: Vec2[]
  minX: number
  minY: number
  maxX: number
  maxY: number
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
  initialAngleDifference: number
}

interface SpringConnectorRecord extends ConnectorRecord {
  entity: ConnectorEntity & {
    connector: Extract<ConnectorEntity['connector'], { type: 'spring' }>
  }
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
  // Rapier 的 Multiply 规则作用于两个碰撞体。存入 sqrt(mu)，接触时便得到 sqrt(mu1 * mu2)。
  return desc
    .setFriction(Math.sqrt(Math.max(0, material.friction)))
    .setRestitution(Math.min(1, Math.max(0, material.restitution)))
    .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
}

function colliderForBody(entity: BodyEntity): RAPIER.ColliderDesc | null {
  const shape = entity.shape
  if (shape.type === 'particle') {
    return shape.collisionEnabled ? RAPIER.ColliderDesc.ball(shape.collisionRadius) : null
  }
  if (shape.type === 'circle') return RAPIER.ColliderDesc.ball(shape.radius)
  return RAPIER.ColliderDesc.cuboid(shape.width / 2, shape.height / 2)
}

function addVectors(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y }
}

function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y
}

function unwrapAngleWithinArc(angle: number, startRad: number, endRad: number): number | null {
  const lower = Math.min(startRad, endRad)
  const upper = Math.max(startRad, endRad)
  if (upper - lower >= Math.PI * 2 - 1e-8) return angle

  const midpoint = (startRad + endRad) / 2
  const unwrapped = angle + Math.round((midpoint - angle) / (Math.PI * 2)) * Math.PI * 2
  return unwrapped >= lower - 1e-8 && unwrapped <= upper + 1e-8 ? unwrapped : null
}

function collisionRadius(entity: BodyEntity): number | null {
  if (entity.shape.type === 'circle') return entity.shape.radius
  if (entity.shape.type === 'particle' && entity.shape.collisionEnabled) {
    return entity.shape.collisionRadius
  }
  return null
}

export function signedDistanceToPolyline(points: Vec2[], point: Vec2): number {
  let nearestDistanceSquared = Infinity
  let signedDistance = 0

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]
    const end = points[index]
    if (!start || !end) continue
    const dx = end.x - start.x
    const dy = end.y - start.y
    const lengthSquared = dx * dx + dy * dy
    if (lengthSquared <= Number.EPSILON) continue
    const projection = Math.min(
      1,
      Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
    )
    const closestX = start.x + projection * dx
    const closestY = start.y + projection * dy
    const distanceSquared = (point.x - closestX) ** 2 + (point.y - closestY) ** 2
    if (distanceSquared < nearestDistanceSquared) {
      nearestDistanceSquared = distanceSquared
      signedDistance =
        (dx * (point.y - start.y) - dy * (point.x - start.x)) / Math.sqrt(lengthSquared)
    }
  }

  return signedDistance
}

export function isOnPolylineNormalSide(points: Vec2[], point: Vec2): boolean {
  return signedDistanceToPolyline(points, point) >= -1e-5
}

function bodyBoundingRadius(entity: BodyEntity): number {
  if (entity.shape.type === 'circle') return entity.shape.radius
  if (entity.shape.type === 'particle') return entity.shape.collisionRadius
  return Math.hypot(entity.shape.width, entity.shape.height) / 2
}

export class SimulationWorld {
  readonly fixedTimeStep: number
  readonly warnings: SimulationWarning[] = []

  private world: RAPIER.World
  private readonly eventQueue = new RAPIER.EventQueue(true)
  private readonly dynamicBodies = new Map<EntityId, DynamicBodyRecord>()
  private readonly dynamicColliders = new Map<number, DynamicBodyRecord>()
  private readonly fields: FieldEntity[] = []
  private readonly rods: RodConnectorRecord[] = []
  private readonly springs: SpringConnectorRecord[] = []
  private readonly oneSidedGrounds = new Map<number, OneSidedGroundRecord>()
  private readonly arcGrounds = new Map<number, ArcGroundRecord>()
  private readonly allowedOneSidedPairs = new Set<string>()
  private readonly ignoredOneSidedPairs = new Set<string>()
  private readonly frictionlessArcContacts = new Set<string>()
  private simulationTimeValue = 0
  private readonly physicsHooks: RAPIER.PhysicsHooks = {
    filterContactPair: (collider1, collider2) => {
      if (!this.oneSidedGrounds.has(collider1) && !this.oneSidedGrounds.has(collider2)) {
        return RAPIER.SolverFlags.COMPUTE_IMPULSE
      }
      const groundHandle = this.oneSidedGrounds.has(collider1) ? collider1 : collider2
      const otherHandle = groundHandle === collider1 ? collider2 : collider1
      if (this.allowedOneSidedPairs.has(`${groundHandle}:${otherHandle}`)) {
        return RAPIER.SolverFlags.COMPUTE_IMPULSE
      }
      return null
    },
    filterIntersectionPair: () => true,
  }

  constructor(private readonly scene: SceneDocument) {
    this.fixedTimeStep = validatedTimeStep(scene.settings.fixedTimeStep)
    this.world = new RAPIER.World({ x: 0, y: 0 })
    this.world.timestep = this.fixedTimeStep
    this.buildScene()
    this.initializeFrictionlessArcContacts()
  }

  get simulationTime(): number {
    return this.simulationTimeValue
  }

  step(stepCount = 1): RuntimeBodyState[] {
    const count = Math.max(0, Math.floor(stepCount))
    for (let index = 0; index < count; index += 1) {
      const previousBodyStates = this.captureBodyStates()
      this.resetExternalForces()
      this.applyFieldForces()
      this.applyPairwiseElectrostatics()
      this.applySpringForces()
      this.updateOneSidedContactPairs()
      if (this.oneSidedGrounds.size > 0) {
        this.world.step(this.eventQueue, this.physicsHooks)
      } else {
        this.world.step()
      }
      this.stabilizeFrictionlessArcMotion(previousBodyStates)
      this.solveRodConstraints()
      this.updateNetForcesFromMomentum(previousBodyStates)
      this.simulationTimeValue += this.fixedTimeStep
    }
    return this.getBodyStates()
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
    this.oneSidedGrounds.clear()
    this.arcGrounds.clear()
    this.allowedOneSidedPairs.clear()
    this.ignoredOneSidedPairs.clear()
    this.frictionlessArcContacts.clear()
    this.world.free()
    this.eventQueue.free()
  }

  private buildScene(): void {
    const enabledEntities = this.scene.entities.filter((entity) => entity.simulationEnabled)

    const connectors: ConnectorEntity[] = []
    for (const entity of enabledEntities) {
      if (entity.kind === 'ground') {
        const points = sampleGroundGeometry(entity.geometry)
        if (entity.normalFlipped) points.reverse()
        if (points.length < 2) {
          this.warnings.push({ message: '地面长度为零，已忽略。', entityId: entity.id })
          continue
        }
        let collider = applyMaterial(
          RAPIER.ColliderDesc.polyline(flattenGroundPoints(points)),
          entity.material,
        )
        if (entity.collisionSide === 'normal') {
          collider = collider.setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS)
        }
        const createdCollider = this.world.createCollider(collider)
        if (entity.geometry.type === 'arc') {
          this.arcGrounds.set(createdCollider.handle, {
            entity: entity as ArcGroundRecord['entity'],
            collider: createdCollider,
          })
        }
        if (entity.collisionSide === 'normal') {
          this.oneSidedGrounds.set(createdCollider.handle, {
            points,
            minX: Math.min(...points.map((point) => point.x)),
            minY: Math.min(...points.map((point) => point.y)),
            maxX: Math.max(...points.map((point) => point.x)),
            maxY: Math.max(...points.map((point) => point.y)),
          })
        }
      } else if (entity.kind === 'body') {
        this.createBody(entity)
      } else if (entity.kind === 'field') {
        this.fields.push(entity)
      } else if (entity.kind === 'connector') {
        connectors.push(entity)
      }
    }

    for (const connector of connectors) this.createConnector(connector)
  }

  private createBody(entity: BodyEntity): void {
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(entity.transform.position.x, entity.transform.position.y)
      .setRotation(entity.transform.angleRad)
      .setLinvel(entity.initialVelocity.x, entity.initialVelocity.y)
      .setAngvel(entity.initialAngularVelocityRad)
      .setCcdEnabled(entity.continuousCollisionDetection)
    const rigidBody = this.world.createRigidBody(bodyDesc)
    const colliderDesc = colliderForBody(entity)
    const record: DynamicBodyRecord = {
      entity,
      rigidBody,
      collider: null,
      boundingRadius: bodyBoundingRadius(entity),
      netForce: { x: 0, y: 0 },
    }

    if (colliderDesc) {
      const collider = this.world.createCollider(
        applyMaterial(colliderDesc, entity.material).setMass(entity.massKg),
        rigidBody,
      )
      record.collider = collider
      this.dynamicColliders.set(collider.handle, record)
    } else {
      rigidBody.setAdditionalMass(entity.massKg, false)
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
      this.rods.push({
        entity: entity as RodConnectorRecord['entity'],
        first,
        second,
        initialAngleDifference: second.rigidBody.rotation() - first.rigidBody.rotation(),
      })
    } else {
      this.springs.push({
        entity: entity as SpringConnectorRecord['entity'],
        first,
        second,
      })
    }
  }

  private resetExternalForces(): void {
    for (const record of this.dynamicBodies.values()) {
      record.netForce = { x: 0, y: 0 }
      record.rigidBody.resetForces(false)
      record.rigidBody.resetTorques(false)
    }
  }

  private applyForceToBody(record: DynamicBodyRecord, force: Vec2, point?: Vec2): void {
    record.netForce = addForce(record.netForce, force)
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
        record.netForce = addForce(
          record.netForce,
          magneticForce(record.entity.chargeC, velocity, combinedMagneticField),
        )
        record.rigidBody.setLinvel(
          rotateVelocityInMagneticField(
            velocity,
            record.entity.chargeC,
            combinedMagneticField,
            record.entity.massKg,
            this.fixedTimeStep,
          ),
          true,
        )
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
  ): { position: Vec2; velocity: Vec2 } {
    const angle = record.rigidBody.rotation()
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    const offset = {
      x: cosine * localAnchor.x - sine * localAnchor.y,
      y: sine * localAnchor.x + cosine * localAnchor.y,
    }
    const translation = record.rigidBody.translation()
    const linearVelocity = record.rigidBody.linvel()
    const angularVelocity = record.rigidBody.angvel()
    return {
      position: { x: translation.x + offset.x, y: translation.y + offset.y },
      velocity: {
        x: linearVelocity.x - angularVelocity * offset.y,
        y: linearVelocity.y + angularVelocity * offset.x,
      },
    }
  }

  private applySpringForces(): void {
    for (const spring of this.springs) {
      const firstEndpoint = this.connectorEndpointState(spring.first, spring.entity.a.localAnchor)
      const secondEndpoint = this.connectorEndpointState(spring.second, spring.entity.b.localAnchor)
      const force = springForceOnFirst(
        firstEndpoint.position,
        firstEndpoint.velocity,
        secondEndpoint.position,
        secondEndpoint.velocity,
        spring.entity.connector.restLength,
        spring.entity.connector.stiffness,
        spring.entity.connector.damping,
      )
      this.applyForceToBody(spring.first, force, firstEndpoint.position)
      this.applyForceToBody(spring.second, scaleForce(force, -1), secondEndpoint.position)
    }
  }

  private solveRodConstraints(): void {
    for (let iteration = 0; iteration < ROD_POSITION_SOLVER_ITERATIONS; iteration += 1) {
      for (const rod of this.rods) {
        const firstEndpoint = this.connectorEndpointState(rod.first, rod.entity.a.localAnchor)
        const secondEndpoint = this.connectorEndpointState(rod.second, rod.entity.b.localAnchor)
        const delta = {
          x: secondEndpoint.position.x - firstEndpoint.position.x,
          y: secondEndpoint.position.y - firstEndpoint.position.y,
        }
        const distance = Math.hypot(delta.x, delta.y)
        if (distance <= Number.EPSILON) continue
        const direction = { x: delta.x / distance, y: delta.y / distance }
        const inverseMassFirst = 1 / rod.first.entity.massKg
        const inverseMassSecond = 1 / rod.second.entity.massKg
        const inverseMassSum = inverseMassFirst + inverseMassSecond
        const error = distance - rod.entity.connector.length
        const firstCorrection = (error * inverseMassFirst) / inverseMassSum
        const secondCorrection = (error * inverseMassSecond) / inverseMassSum
        const firstPosition = rod.first.rigidBody.translation()
        const secondPosition = rod.second.rigidBody.translation()
        rod.first.rigidBody.setTranslation(
          {
            x: firstPosition.x + direction.x * firstCorrection,
            y: firstPosition.y + direction.y * firstCorrection,
          },
          true,
        )
        rod.second.rigidBody.setTranslation(
          {
            x: secondPosition.x - direction.x * secondCorrection,
            y: secondPosition.y - direction.y * secondCorrection,
          },
          true,
        )
      }
    }

    for (const rod of this.rods) {
      const firstEndpoint = this.connectorEndpointState(rod.first, rod.entity.a.localAnchor)
      const secondEndpoint = this.connectorEndpointState(rod.second, rod.entity.b.localAnchor)
      const delta = {
        x: secondEndpoint.position.x - firstEndpoint.position.x,
        y: secondEndpoint.position.y - firstEndpoint.position.y,
      }
      const distance = Math.hypot(delta.x, delta.y)
      if (distance <= Number.EPSILON) continue
      const direction = { x: delta.x / distance, y: delta.y / distance }
      const inverseMassFirst = 1 / rod.first.entity.massKg
      const inverseMassSecond = 1 / rod.second.entity.massKg
      const inverseMassSum = inverseMassFirst + inverseMassSecond
      const relativeSpeed =
        (secondEndpoint.velocity.x - firstEndpoint.velocity.x) * direction.x +
        (secondEndpoint.velocity.y - firstEndpoint.velocity.y) * direction.y
      const firstVelocity = rod.first.rigidBody.linvel()
      const secondVelocity = rod.second.rigidBody.linvel()
      rod.first.rigidBody.setLinvel(
        {
          x: firstVelocity.x + direction.x * relativeSpeed * (inverseMassFirst / inverseMassSum),
          y: firstVelocity.y + direction.y * relativeSpeed * (inverseMassFirst / inverseMassSum),
        },
        true,
      )
      rod.second.rigidBody.setLinvel(
        {
          x: secondVelocity.x - direction.x * relativeSpeed * (inverseMassSecond / inverseMassSum),
          y: secondVelocity.y - direction.y * relativeSpeed * (inverseMassSecond / inverseMassSum),
        },
        true,
      )

      if (!rod.entity.connector.freeRotation) {
        const firstAngle = rod.first.rigidBody.rotation()
        const secondAngle = rod.second.rigidBody.rotation()
        const angleError = secondAngle - firstAngle - rod.initialAngleDifference
        rod.first.rigidBody.setRotation(
          firstAngle + angleError * (inverseMassFirst / inverseMassSum),
          true,
        )
        rod.second.rigidBody.setRotation(
          secondAngle - angleError * (inverseMassSecond / inverseMassSum),
          true,
        )
        const sharedAngularVelocity =
          (rod.first.rigidBody.angvel() * rod.first.entity.massKg +
            rod.second.rigidBody.angvel() * rod.second.entity.massKg) /
          (rod.first.entity.massKg + rod.second.entity.massKg)
        rod.first.rigidBody.setAngvel(sharedAngularVelocity, true)
        rod.second.rigidBody.setAngvel(sharedAngularVelocity, true)
      }
    }
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

  private accelerationAt(position: Vec2): Vec2 {
    let acceleration: Vec2 = { x: 0, y: 0 }
    for (const field of this.fields) {
      if (field.field.type !== 'uniformGravity') continue
      if (regionContainsPoint(field.region, position)) {
        acceleration = addVectors(acceleration, field.field.acceleration)
      }
    }
    return acceleration
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

  private arcPathAt(
    arc: ArcGroundRecord,
    body: BodyEntity,
    position: Vec2,
  ): { angle: number; inside: boolean; radius: number } | null {
    const bodyRadius = collisionRadius(body)
    if (bodyRadius === null) return null

    const geometry = arc.entity.geometry
    const relative = {
      x: position.x - geometry.center.x,
      y: position.y - geometry.center.y,
    }
    const distanceFromCenter = Math.hypot(relative.x, relative.y)
    if (distanceFromCenter <= Number.EPSILON) return null

    const followsCounterClockwise = geometry.endRad > geometry.startRad
    const normalSideIsInside = followsCounterClockwise !== arc.entity.normalFlipped
    const inside =
      arc.entity.collisionSide === 'normal'
        ? normalSideIsInside
        : distanceFromCenter <= geometry.radius
    const pathRadius = geometry.radius + (inside ? -bodyRadius : bodyRadius)
    if (pathRadius <= Number.EPSILON) return null

    const angle = unwrapAngleWithinArc(
      Math.atan2(relative.y, relative.x),
      geometry.startRad,
      geometry.endRad,
    )
    return angle === null ? null : { angle, inside, radius: pathRadius }
  }

  private initializeFrictionlessArcContacts(): void {
    for (const record of this.dynamicBodies.values()) {
      if (record.entity.material.friction > 1e-10 || !record.collider) continue
      const position = record.rigidBody.translation()
      const velocity = record.rigidBody.linvel()

      for (const arc of this.arcGrounds.values()) {
        if (arc.entity.material.friction > 1e-10) continue
        const path = this.arcPathAt(arc, record.entity, position)
        if (!path) continue

        const geometry = arc.entity.geometry
        const distanceFromCenter = Math.hypot(
          position.x - geometry.center.x,
          position.y - geometry.center.y,
        )
        const radial = { x: Math.cos(path.angle), y: Math.sin(path.angle) }
        const isExactlyTouching = Math.abs(distanceFromCenter - path.radius) <= 1e-4
        const hasNoImpactVelocity = Math.abs(dot(velocity, radial)) <= 1e-5
        if (isExactlyTouching && hasNoImpactVelocity) {
          this.frictionlessArcContacts.add(`${arc.collider.handle}:${record.collider.handle}`)
        }
      }
    }
  }

  private stabilizeFrictionlessArcMotion(
    previousBodyStates: Map<EntityId, PreviousBodyState>,
  ): void {
    const nextContacts = new Set<string>()

    for (const [entityId, record] of this.dynamicBodies) {
      if (record.entity.material.friction > 1e-10 || !record.collider) continue

      const contacts: RAPIER.Collider[] = []
      this.world.contactPairsWith(record.collider, (collider) => contacts.push(collider))
      if (contacts.length !== 1) continue

      const arc = this.arcGrounds.get(contacts[0]?.handle ?? -1)
      if (!arc || arc.entity.material.friction > 1e-10) continue

      const currentPosition = record.rigidBody.translation()
      const currentPath = this.arcPathAt(arc, record.entity, currentPosition)
      if (!currentPath) continue

      const contactKey = `${arc.collider.handle}:${record.collider.handle}`
      nextContacts.add(contactKey)
      if (!this.frictionlessArcContacts.has(contactKey)) continue

      const previous = previousBodyStates.get(entityId)
      if (!previous) continue
      const previousPath = this.arcPathAt(arc, record.entity, previous.position)
      if (!previousPath || previousPath.inside !== currentPath.inside) continue

      // Rapier 的折线圆弧会在相邻线段处产生微小非弹性法向冲量。
      // 持续接触期间改用解析圆弧和 velocity Verlet，避免凭空损失机械能。
      const geometry = arc.entity.geometry
      const tangentBefore = {
        x: -Math.sin(previousPath.angle),
        y: Math.cos(previousPath.angle),
      }
      const angularVelocity = dot(previous.linearVelocity, tangentBefore) / previousPath.radius
      const accelerationBefore = this.accelerationAt(previous.position)
      const angularAccelerationBefore = dot(accelerationBefore, tangentBefore) / previousPath.radius
      const nextAngleCandidate =
        previousPath.angle +
        angularVelocity * this.fixedTimeStep +
        0.5 * angularAccelerationBefore * this.fixedTimeStep ** 2
      const nextAngle = unwrapAngleWithinArc(nextAngleCandidate, geometry.startRad, geometry.endRad)
      if (nextAngle === null) {
        nextContacts.delete(contactKey)
        continue
      }

      const radial = { x: Math.cos(nextAngle), y: Math.sin(nextAngle) }
      const tangentAfter = { x: -radial.y, y: radial.x }
      const nextPosition = {
        x: geometry.center.x + previousPath.radius * radial.x,
        y: geometry.center.y + previousPath.radius * radial.y,
      }
      const accelerationAfter = this.accelerationAt(nextPosition)
      const angularAccelerationAfter = dot(accelerationAfter, tangentAfter) / previousPath.radius
      const nextAngularVelocity =
        angularVelocity +
        0.5 * (angularAccelerationBefore + angularAccelerationAfter) * this.fixedTimeStep
      const tangentialSpeed = nextAngularVelocity * previousPath.radius
      const outwardAcceleration = dot(accelerationAfter, radial)
      // 约束面只能推、不能拉；所需支持力为负时应让物体自然脱离圆弧。
      const reactionAcceleration = previousPath.inside
        ? tangentialSpeed ** 2 / previousPath.radius + outwardAcceleration
        : -(tangentialSpeed ** 2) / previousPath.radius - outwardAcceleration
      if (reactionAcceleration < -1e-6) {
        nextContacts.delete(contactKey)
        continue
      }

      record.rigidBody.setTranslation(nextPosition, true)
      record.rigidBody.setLinvel(
        {
          x: tangentAfter.x * tangentialSpeed,
          y: tangentAfter.y * tangentialSpeed,
        },
        true,
      )
    }

    this.frictionlessArcContacts.clear()
    for (const contact of nextContacts) this.frictionlessArcContacts.add(contact)
  }

  private updateOneSidedContactPairs(): void {
    this.allowedOneSidedPairs.clear()
    const ignoredColliderHandles = new Set<number>()
    const bodyStates = [...this.dynamicColliders].map(([colliderHandle, record]) => {
      const position = record.rigidBody.translation()
      const velocity = record.rigidBody.linvel()
      return {
        colliderHandle,
        record,
        position,
        margin:
          record.boundingRadius +
          Math.hypot(velocity.x, velocity.y) * this.fixedTimeStep * 2 +
          0.05,
      }
    })
    for (const [groundHandle, ground] of this.oneSidedGrounds) {
      for (const { colliderHandle, record, position, margin } of bodyStates) {
        if (
          position.x < ground.minX - margin ||
          position.x > ground.maxX + margin ||
          position.y < ground.minY - margin ||
          position.y > ground.maxY + margin
        ) {
          continue
        }
        const pairKey = `${groundHandle}:${colliderHandle}`
        const signedDistance = signedDistanceToPolyline(ground.points, position)
        if (this.ignoredOneSidedPairs.has(pairKey)) {
          if (signedDistance > record.boundingRadius + 0.001) {
            this.ignoredOneSidedPairs.delete(pairKey)
          }
        } else if (signedDistance < -0.001) {
          this.ignoredOneSidedPairs.add(pairKey)
        }
        if (this.ignoredOneSidedPairs.has(pairKey)) {
          ignoredColliderHandles.add(colliderHandle)
        } else {
          this.allowedOneSidedPairs.add(pairKey)
        }
      }
    }
    for (const { colliderHandle, record } of bodyStates) {
      record.rigidBody.enableCcd(
        record.entity.continuousCollisionDetection && !ignoredColliderHandles.has(colliderHandle),
      )
    }
  }
}
