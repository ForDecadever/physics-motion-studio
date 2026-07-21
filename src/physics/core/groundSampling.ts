import type { GroundGeometry, Vec2 } from '../../scene/model/types'

export interface GroundSamplingOptions {
  maxError: number
  maxSegmentLength: number
  maxSegments: number
}

const defaultOptions: GroundSamplingOptions = {
  maxError: 0.002,
  maxSegmentLength: 0.1,
  maxSegments: 2048,
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function pointToLineDistance(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const denominator = Math.hypot(dx, dy)
  if (denominator < Number.EPSILON) return distance(point, start)
  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / denominator
}

function midpoint(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function sampleArc(
  geometry: Extract<GroundGeometry, { type: 'arc' }>,
  options: GroundSamplingOptions,
): Vec2[] {
  const span = geometry.endRad - geometry.startRad
  if (Math.abs(span) < Number.EPSILON || geometry.radius <= 0) return []

  const errorLimitedStep =
    options.maxError >= geometry.radius
      ? Math.PI
      : 2 * Math.acos(Math.max(-1, 1 - options.maxError / geometry.radius))
  const lengthLimitedStep = options.maxSegmentLength / geometry.radius
  const step = Math.max(1e-6, Math.min(errorLimitedStep, lengthLimitedStep))
  const segmentCount = Math.min(options.maxSegments, Math.max(1, Math.ceil(Math.abs(span) / step)))

  return Array.from({ length: segmentCount + 1 }, (_, index) => {
    const angle = geometry.startRad + (span * index) / segmentCount
    return {
      x: geometry.center.x + geometry.radius * Math.cos(angle),
      y: geometry.center.y + geometry.radius * Math.sin(angle),
    }
  })
}

function sampleCubicBezier(
  geometry: Extract<GroundGeometry, { type: 'cubicBezier' }>,
  options: GroundSamplingOptions,
): Vec2[] {
  const result: Vec2[] = [geometry.p0]

  const subdivide = (p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, depth: number) => {
    if (result.length >= options.maxSegments) {
      result.push(p3)
      return
    }

    const flatness = Math.max(pointToLineDistance(p1, p0, p3), pointToLineDistance(p2, p0, p3))
    const chordLength = distance(p0, p3)
    if ((flatness <= options.maxError && chordLength <= options.maxSegmentLength) || depth >= 18) {
      result.push(p3)
      return
    }

    const p01 = midpoint(p0, p1)
    const p12 = midpoint(p1, p2)
    const p23 = midpoint(p2, p3)
    const p012 = midpoint(p01, p12)
    const p123 = midpoint(p12, p23)
    const p0123 = midpoint(p012, p123)
    subdivide(p0, p01, p012, p0123, depth + 1)
    subdivide(p0123, p123, p23, p3, depth + 1)
  }

  subdivide(geometry.p0, geometry.p1, geometry.p2, geometry.p3, 0)
  return result
}

export function sampleGroundGeometry(
  geometry: GroundGeometry,
  overrides: Partial<GroundSamplingOptions> = {},
): Vec2[] {
  const options = { ...defaultOptions, ...overrides }
  if (geometry.type === 'line') {
    return distance(geometry.start, geometry.end) < Number.EPSILON
      ? []
      : [geometry.start, geometry.end]
  }
  if (geometry.type === 'arc') return sampleArc(geometry, options)
  return sampleCubicBezier(geometry, options)
}

export function flattenGroundPoints(points: Vec2[]): Float32Array {
  return new Float32Array(points.flatMap((point) => [point.x, point.y]))
}
