import { sampleAdaptiveClosedBezierPath } from './bodyPath'
import type { BodyEntity, Vec2 } from './types'

function subtract(first: Vec2, second: Vec2): Vec2 {
  return { x: first.x - second.x, y: first.y - second.y }
}

function dot(first: Vec2, second: Vec2): number {
  return first.x * second.x + first.y * second.y
}

function distance(first: Vec2, second: Vec2): number {
  return Math.hypot(first.x - second.x, first.y - second.y)
}

function closestPointOnSegment(point: Vec2, start: Vec2, end: Vec2): Vec2 {
  const segment = subtract(end, start)
  const lengthSquared = dot(segment, segment)
  if (lengthSquared <= Number.EPSILON) return start
  const ratio = Math.max(0, Math.min(1, dot(subtract(point, start), segment) / lengthSquared))
  return { x: start.x + segment.x * ratio, y: start.y + segment.y * ratio }
}

function pointInPolygon(point: Vec2, polygon: readonly Vec2[]): boolean {
  let inside = false
  for (
    let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current++
  ) {
    const first = polygon[current]
    const second = polygon[previous]
    if (!first || !second) continue
    if (
      first.y > point.y !== second.y > point.y &&
      point.x < ((second.x - first.x) * (point.y - first.y)) / (second.y - first.y) + first.x
    ) {
      inside = !inside
    }
  }
  return inside
}

export function bodyLocalAnchorIsInside(body: BodyEntity, localAnchor: Vec2): boolean {
  if (body.shape.type === 'circle') {
    return Math.hypot(localAnchor.x, localAnchor.y) <= body.shape.radius + 1e-9
  }
  if (body.shape.type === 'box') {
    return (
      Math.abs(localAnchor.x) <= body.shape.width / 2 + 1e-9 &&
      Math.abs(localAnchor.y) <= body.shape.height / 2 + 1e-9
    )
  }
  const points = sampleAdaptiveClosedBezierPath(body.shape.nodes)
  if (pointInPolygon(localAnchor, points)) return true
  return points.some(
    (point, index) =>
      distance(
        localAnchor,
        closestPointOnSegment(localAnchor, point, points[(index + 1) % points.length]!),
      ) <= 1e-9,
  )
}

export function clampBodyLocalAnchor(body: BodyEntity, localAnchor: Vec2): Vec2 {
  if (body.shape.type === 'circle') {
    const length = Math.hypot(localAnchor.x, localAnchor.y)
    if (length <= body.shape.radius || length <= Number.EPSILON) return localAnchor
    const scale = body.shape.radius / length
    return { x: localAnchor.x * scale, y: localAnchor.y * scale }
  }
  if (body.shape.type === 'box') {
    return {
      x: Math.min(body.shape.width / 2, Math.max(-body.shape.width / 2, localAnchor.x)),
      y: Math.min(body.shape.height / 2, Math.max(-body.shape.height / 2, localAnchor.y)),
    }
  }
  const points = sampleAdaptiveClosedBezierPath(body.shape.nodes)
  let closest = localAnchor
  let closestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < points.length; index += 1) {
    const candidate = closestPointOnSegment(
      localAnchor,
      points[index]!,
      points[(index + 1) % points.length]!,
    )
    const candidateDistance = distance(localAnchor, candidate)
    if (candidateDistance < closestDistance) {
      closest = candidate
      closestDistance = candidateDistance
    }
  }
  return closest
}
