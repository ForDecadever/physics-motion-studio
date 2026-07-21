import type { Vec2 } from '../../scene/model/types'

export const COULOMB_CONSTANT = 8.9875517923e9

export function addForce(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y }
}

export function scaleForce(vector: Vec2, scalar: number): Vec2 {
  return { x: vector.x * scalar, y: vector.y * scalar }
}

export function electricForce(chargeC: number, strength: Vec2): Vec2 {
  return scaleForce(strength, chargeC)
}

export function magneticForce(chargeC: number, velocity: Vec2, bzTesla: number): Vec2 {
  return {
    x: chargeC * velocity.y * bzTesla,
    y: -chargeC * velocity.x * bzTesla,
  }
}

export function rotateVelocityInMagneticField(
  velocity: Vec2,
  chargeC: number,
  bzTesla: number,
  massKg: number,
  timeStep: number,
): Vec2 {
  if (chargeC === 0 || bzTesla === 0) return velocity
  const angle = (-chargeC * bzTesla * timeStep) / massKg
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return {
    x: cosine * velocity.x - sine * velocity.y,
    y: sine * velocity.x + cosine * velocity.y,
  }
}

export function coulombForceOnFirst(
  firstChargeC: number,
  secondChargeC: number,
  firstPosition: Vec2,
  secondPosition: Vec2,
  minimumDistance: number,
): Vec2 {
  const delta = {
    x: firstPosition.x - secondPosition.x,
    y: firstPosition.y - secondPosition.y,
  }
  const distance = Math.hypot(delta.x, delta.y)
  if (distance <= Number.EPSILON) return { x: 0, y: 0 }

  const effectiveDistance = Math.max(distance, minimumDistance)
  const magnitude = (COULOMB_CONSTANT * firstChargeC * secondChargeC) / effectiveDistance ** 2
  return scaleForce(delta, magnitude / distance)
}

export function springForceOnFirst(
  firstPosition: Vec2,
  firstVelocity: Vec2,
  secondPosition: Vec2,
  secondVelocity: Vec2,
  restLength: number,
  stiffness: number,
  damping: number,
): Vec2 {
  const delta = {
    x: secondPosition.x - firstPosition.x,
    y: secondPosition.y - firstPosition.y,
  }
  const length = Math.hypot(delta.x, delta.y)
  if (length <= Number.EPSILON) return { x: 0, y: 0 }

  const direction = { x: delta.x / length, y: delta.y / length }
  const relativeSpeed =
    (secondVelocity.x - firstVelocity.x) * direction.x +
    (secondVelocity.y - firstVelocity.y) * direction.y
  const magnitude = stiffness * (length - restLength) + damping * relativeSpeed
  return scaleForce(direction, magnitude)
}
