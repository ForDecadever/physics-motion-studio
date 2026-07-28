import type { FieldRegion, Vec2 } from '../../scene/model/types'
import { sampleClosedBezierPath } from '../../scene/model/bezierPath'

const EPSILON = 1e-9
const TAU = Math.PI * 2

function normalizePositiveAngle(angle: number): number {
  return ((angle % TAU) + TAU) % TAU
}

export function angleWithinSweep(angle: number, startRad: number, sweepRad: number): boolean {
  if (Math.abs(sweepRad) >= TAU - EPSILON) return true
  if (sweepRad >= 0) {
    return normalizePositiveAngle(angle - startRad) <= sweepRad + EPSILON
  }
  return normalizePositiveAngle(startRad - angle) <= -sweepRad + EPSILON
}

function pointOnSegment(point: Vec2, start: Vec2, end: Vec2): boolean {
  const cross = (point.y - start.y) * (end.x - start.x) - (point.x - start.x) * (end.y - start.y)
  if (Math.abs(cross) > EPSILON) return false
  const dot = (point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)
  if (dot < -EPSILON) return false
  const squaredLength = (end.x - start.x) ** 2 + (end.y - start.y) ** 2
  return dot <= squaredLength + EPSILON
}

function pointInPolygon(point: Vec2, points: Vec2[]): boolean {
  let inside = false
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index]
    const b = points[previous]
    if (!a || !b) continue
    if (pointOnSegment(point, a, b)) return true
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    if (intersects) inside = !inside
  }
  return inside
}

export function regionContainsPoint(region: FieldRegion, point: Vec2): boolean {
  if (region.type === 'infinite') return true
  if (region.type === 'circle') {
    const dx = point.x - region.center.x
    const dy = point.y - region.center.y
    return (
      Math.hypot(dx, dy) <= region.radius + EPSILON &&
      angleWithinSweep(Math.atan2(dy, dx), region.startRad, region.sweepRad)
    )
  }
  if (region.type === 'polygon') return pointInPolygon(point, region.points)
  if (region.type === 'bezierPath') {
    return pointInPolygon(point, sampleClosedBezierPath(region.nodes))
  }

  const cosine = Math.cos(-region.angleRad)
  const sine = Math.sin(-region.angleRad)
  const dx = point.x - region.center.x
  const dy = point.y - region.center.y
  const localX = dx * cosine - dy * sine
  const localY = dx * sine + dy * cosine
  return (
    Math.abs(localX) <= region.width / 2 + EPSILON &&
    Math.abs(localY) <= region.height / 2 + EPSILON
  )
}
