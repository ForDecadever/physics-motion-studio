import RAPIER from '@dimforge/rapier2d-compat'

import type {
  BodyEntity,
  EntityId,
  FieldEntity,
  GroundEntity,
  Material2D,
  SceneDocument,
  Vec2,
} from '../../scene/model/types'
import type { RuntimeBodyState } from '../worker/messages'
import { regionContainsPoint } from './fieldRegions'
import { flattenGroundPoints, sampleGroundGeometry } from './groundSampling'

await RAPIER.init()

const MIN_FIXED_TIME_STEP = 1 / 1000
const MAX_FIXED_TIME_STEP = 1 / 30

interface DynamicBodyRecord {
  entity: BodyEntity
  rigidBody: RAPIER.RigidBody
  collider: RAPIER.Collider | null
  boundingRadius: number
}

interface ArcGroundRecord {
  entity: GroundEntity & { geometry: Extract<GroundEntity['geometry'], { type: 'arc' }> }
  collider: RAPIER.Collider
}

interface PreviousBodyState {
  position: Vec2
  linearVelocity: Vec2
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
  private readonly gravityFields: FieldEntity[] = []
  private readonly oneSidedGrounds = new Map<number, Vec2[]>()
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
      this.applyGravityFields()
      this.updateOneSidedContactPairs()
      if (this.oneSidedGrounds.size > 0) {
        this.world.step(this.eventQueue, this.physicsHooks)
      } else {
        this.world.step()
      }
      this.stabilizeFrictionlessArcMotion(previousBodyStates)
      this.simulationTimeValue += this.fixedTimeStep
    }
    return this.getBodyStates()
  }

  getBodyStates(): RuntimeBodyState[] {
    return [...this.dynamicBodies.entries()].map(([entityId, record]) => {
      const position = record.rigidBody.translation()
      const linearVelocity = record.rigidBody.linvel()
      return {
        entityId,
        position: { x: position.x, y: position.y },
        angleRad: record.rigidBody.rotation(),
        linearVelocity: { x: linearVelocity.x, y: linearVelocity.y },
        angularVelocityRad: record.rigidBody.angvel(),
      }
    })
  }

  dispose(): void {
    this.dynamicBodies.clear()
    this.dynamicColliders.clear()
    this.gravityFields.length = 0
    this.oneSidedGrounds.clear()
    this.arcGrounds.clear()
    this.allowedOneSidedPairs.clear()
    this.ignoredOneSidedPairs.clear()
    this.frictionlessArcContacts.clear()
    this.world.free()
    this.eventQueue.free()
  }

  private buildScene(): void {
    const visibleLayers = new Set(
      this.scene.layers.filter((layer) => layer.visible).map((layer) => layer.id),
    )
    const enabledEntities = this.scene.entities.filter(
      (entity) => entity.visible && entity.simulationEnabled && visibleLayers.has(entity.layerId),
    )

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
          this.oneSidedGrounds.set(createdCollider.handle, points)
        }
      } else if (entity.kind === 'body') {
        this.createBody(entity)
      } else if (entity.kind === 'field' && entity.field.type === 'uniformGravity') {
        this.gravityFields.push(entity)
      } else if (entity.kind === 'field') {
        this.warnings.push({ message: '阶段 2 暂不计算电场与磁场。', entityId: entity.id })
      } else {
        this.warnings.push({ message: '连接器动力学将在阶段 3 接入。', entityId: entity.id })
      }
    }
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

  private applyGravityFields(): void {
    for (const record of this.dynamicBodies.values()) {
      const rigidBody = record.rigidBody
      const position = rigidBody.translation()
      const acceleration = this.accelerationAt(position)

      rigidBody.resetForces(false)
      rigidBody.addForce(
        { x: acceleration.x * record.entity.massKg, y: acceleration.y * record.entity.massKg },
        false,
      )
    }
  }

  private accelerationAt(position: Vec2): Vec2 {
    let acceleration: Vec2 = { x: 0, y: 0 }
    for (const field of this.gravityFields) {
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
    for (const [groundHandle, points] of this.oneSidedGrounds) {
      for (const [colliderHandle, record] of this.dynamicColliders) {
        const pairKey = `${groundHandle}:${colliderHandle}`
        const signedDistance = signedDistanceToPolyline(points, record.rigidBody.translation())
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
    for (const [colliderHandle, record] of this.dynamicColliders) {
      record.rigidBody.enableCcd(
        record.entity.continuousCollisionDetection && !ignoredColliderHandles.has(colliderHandle),
      )
    }
  }
}
