import {
  traverseGroundPath,
  type GroundNetworkSegment,
  type GroundPathLocation,
  type GroundPathNetwork,
} from '../../scene/model/groundPath'
import type { EntityId, Material2D, Vec2 } from '../../scene/model/types'

const OFFSET_SCALE_EPSILON = 1e-6
const CENTER_TRAVERSAL_MAX_SURFACE_STEP_M = 0.025
const CENTER_TRAVERSAL_MAX_ITERATIONS = 4096

export type GroundPathContactSide = 1 | -1

export interface PersistentGroundPathContact {
  location: GroundPathLocation
  side: GroundPathContactSide
  radiusM: number
  speedMps: number
}

export interface GroundPathContactFrame {
  segment: GroundNetworkSegment
  surfacePosition: Vec2
  position: Vec2
  tangent: Vec2
  normal: Vec2
  contactNormal: Vec2
  surfaceCurvaturePerM: number
  centerCurvaturePerM: number
  offsetScale: number
  material: Material2D
}

export interface GroundPathContactCandidate {
  segmentId: string
  collisionPieceId: string
  s: number
  naturalSide: GroundPathContactSide
  gapM: number
  sourceGroundId: EntityId
}

export interface GroundPathCenterTraversal {
  contact: PersistentGroundPathContact
  frame: GroundPathContactFrame
  stoppedAtOpenEnd: boolean
  distanceTraveledCenterM: number
  distanceRemainingCenterM: number
  transitions: number
}

export interface PathFrictionResult {
  tangentialSpeedMps: number
  angularVelocityRad: number
  impulseNs: number
}

function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y }
}

function subtract(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y }
}

function scale(vector: Vec2, factor: number): Vec2 {
  return { x: vector.x * factor, y: vector.y * factor }
}

export function dotVectors(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y
}

function leftNormal(tangent: Vec2): Vec2 {
  return { x: -tangent.y, y: tangent.x }
}

function clamped(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function resolveGroundPathContactFrame(
  network: GroundPathNetwork,
  contact: PersistentGroundPathContact,
): GroundPathContactFrame | null {
  const segment = network.segmentById.get(contact.location.segmentId)
  if (!segment) return null

  const naturalTangent = segment.path.tangentAt(contact.location.s)
  const tangent = scale(naturalTangent, contact.location.direction)
  const normal = leftNormal(tangent)
  const surfaceCurvaturePerM =
    contact.location.direction * segment.path.curvatureAt(contact.location.s)
  const offsetScale = 1 - contact.side * contact.radiusM * surfaceCurvaturePerM
  if (!Number.isFinite(offsetScale) || offsetScale <= OFFSET_SCALE_EPSILON) return null

  const surfacePosition = segment.path.pointAt(contact.location.s)
  const contactNormal = scale(normal, contact.side)
  return {
    segment,
    surfacePosition,
    position: add(surfacePosition, scale(contactNormal, contact.radiusM)),
    tangent,
    normal,
    contactNormal,
    surfaceCurvaturePerM,
    centerCurvaturePerM: surfaceCurvaturePerM / offsetScale,
    offsetScale,
    material: segment.materialAt(contact.location.s),
  }
}

export function traverseGroundPathCenterDistance(
  network: GroundPathNetwork,
  contact: PersistentGroundPathContact,
  centerDistanceM: number,
): GroundPathCenterTraversal | null {
  const initialFrame = resolveGroundPathContactFrame(network, contact)
  if (!initialFrame || !Number.isFinite(centerDistanceM) || centerDistanceM < 0) return null

  let currentContact = contact
  let currentFrame = initialFrame
  let remainingCenterM = centerDistanceM
  let traveledCenterM = 0
  let transitions = 0

  for (let iteration = 0; iteration < CENTER_TRAVERSAL_MAX_ITERATIONS; iteration += 1) {
    if (remainingCenterM <= 1e-10) break
    const maximumSurfaceStep = Math.min(
      CENTER_TRAVERSAL_MAX_SURFACE_STEP_M,
      remainingCenterM / currentFrame.offsetScale,
    )
    if (!Number.isFinite(maximumSurfaceStep) || maximumSurfaceStep <= 0) return null

    const evaluateStep = (surfaceDistanceM: number) => {
      const traversal = traverseGroundPath(network, currentContact.location, surfaceDistanceM)
      const nextContact = { ...currentContact, location: traversal.location }
      const nextFrame = resolveGroundPathContactFrame(network, nextContact)
      if (!nextFrame) return null
      const traveledSurfaceM = surfaceDistanceM - traversal.distanceRemainingM
      const centerStepM =
        traveledSurfaceM * (currentFrame.offsetScale + nextFrame.offsetScale) * 0.5
      return { traversal, nextContact, nextFrame, centerStepM }
    }

    let resolved = evaluateStep(maximumSurfaceStep)
    if (!resolved) return null
    if (resolved.centerStepM > remainingCenterM + 1e-10) {
      let lower = 0
      let upper = maximumSurfaceStep
      for (let search = 0; search < 32; search += 1) {
        const middle = (lower + upper) / 2
        const candidate = evaluateStep(middle)
        if (!candidate) return null
        if (candidate.centerStepM < remainingCenterM) lower = middle
        else upper = middle
      }
      resolved = evaluateStep((lower + upper) / 2)
      if (!resolved) return null
    }

    currentContact = resolved.nextContact
    currentFrame = resolved.nextFrame
    transitions += resolved.traversal.transitions
    const consumedCenterM = Math.min(remainingCenterM, resolved.centerStepM)
    traveledCenterM += consumedCenterM
    remainingCenterM -= consumedCenterM

    if (resolved.traversal.stoppedAtOpenEnd) {
      return {
        contact: currentContact,
        frame: currentFrame,
        stoppedAtOpenEnd: true,
        distanceTraveledCenterM: traveledCenterM,
        distanceRemainingCenterM: Math.max(0, remainingCenterM),
        transitions,
      }
    }
  }

  if (remainingCenterM > 1e-8) return null
  return {
    contact: currentContact,
    frame: currentFrame,
    stoppedAtOpenEnd: false,
    distanceTraveledCenterM: clamped(traveledCenterM, 0, centerDistanceM),
    distanceRemainingCenterM: Math.max(0, centerDistanceM - traveledCenterM),
    transitions,
  }
}

export function findGroundPathContactCandidate(
  network: GroundPathNetwork,
  sourceGroundId: EntityId,
  bodyPosition: Vec2,
  bodyRadiusM: number,
  collisionPieceId?: string,
): GroundPathContactCandidate | null {
  let best: GroundPathContactCandidate | null = null
  for (const segment of network.segments) {
    for (const piece of segment.collisionPieces) {
      if (piece.sourceGroundId !== sourceGroundId) continue
      if (collisionPieceId !== undefined && piece.id !== collisionPieceId) continue
      const closest = piece.path.closestPoint(bodyPosition)
      const s = clamped(piece.startS + closest.s, piece.startS, piece.endS)
      const surfacePosition = segment.path.pointAt(s)
      const naturalNormal = segment.path.normalAt(s)
      const separation = subtract(bodyPosition, surfacePosition)
      const distance = Math.hypot(separation.x, separation.y)
      const signedDistance = dotVectors(separation, naturalNormal)
      const candidate: GroundPathContactCandidate = {
        segmentId: segment.id,
        collisionPieceId: piece.id,
        s,
        naturalSide: signedDistance >= 0 ? 1 : -1,
        gapM: Math.abs(distance - bodyRadiusM),
        sourceGroundId,
      }
      if (!best || candidate.gapM < best.gapM) best = candidate
    }
  }
  return best
}

export function requiredGroundSupportForceN(
  frame: GroundPathContactFrame,
  speedMps: number,
  externalAcceleration: Vec2,
  massKg: number,
): number {
  const requiredNormalAcceleration =
    frame.centerCurvaturePerM * speedMps ** 2 * dotVectors(frame.normal, frame.contactNormal)
  const externalNormalAcceleration = dotVectors(externalAcceleration, frame.contactNormal)
  return massKg * (requiredNormalAcceleration - externalNormalAcceleration)
}

export function combinedPathFriction(bodyMaterial: Material2D, groundMaterial: Material2D): number {
  return Math.sqrt(Math.max(0, bodyMaterial.friction) * Math.max(0, groundMaterial.friction))
}

export function combinedMaterialRestitution(
  firstMaterial: Material2D,
  secondMaterial: Material2D,
): number {
  return Math.sqrt(
    Math.min(1, Math.max(0, firstMaterial.restitution)) *
      Math.min(1, Math.max(0, secondMaterial.restitution)),
  )
}

export function applyCoulombPathFriction(
  speedMps: number,
  angularVelocityRad: number,
  side: GroundPathContactSide,
  radiusM: number,
  massKg: number,
  angularInertiaKgM2: number,
  supportForceN: number,
  frictionCoefficient: number,
  timeStep: number,
  surfaceSpeedMps = 0,
): PathFrictionResult {
  const inverseMass = massKg > 0 ? 1 / massKg : 0
  const inverseInertia =
    Number.isFinite(angularInertiaKgM2) && angularInertiaKgM2 > 0 ? 1 / angularInertiaKgM2 : 0
  const inverseEffectiveMass = inverseMass + radiusM ** 2 * inverseInertia
  if (
    inverseEffectiveMass <= 0 ||
    supportForceN <= 0 ||
    frictionCoefficient <= 0 ||
    timeStep <= 0
  ) {
    return { tangentialSpeedMps: speedMps, angularVelocityRad, impulseNs: 0 }
  }

  const slipSpeed = speedMps + side * angularVelocityRad * radiusM - surfaceSpeedMps
  const stoppingImpulse = -slipSpeed / inverseEffectiveMass
  const maximumImpulse = frictionCoefficient * supportForceN * timeStep
  const impulseNs = clamped(stoppingImpulse, -maximumImpulse, maximumImpulse)
  return {
    tangentialSpeedMps: speedMps + impulseNs * inverseMass,
    angularVelocityRad: angularVelocityRad + side * radiusM * impulseNs * inverseInertia,
    impulseNs,
  }
}
