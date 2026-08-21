import type { BezierPathNode, BodyEntity, Transform2D, Vec2 } from './types'

export const MAX_BEZIER_BODY_SAMPLED_VERTICES = 2_048

const MIN_FEATURE_TOLERANCE_M = 1e-6
const MAX_FEATURE_TOLERANCE_M = 5e-4
const FEATURE_TOLERANCE_RATIO = 1e-4
const MAX_SUBDIVISION_DEPTH = 16

export interface BezierBodyPathMetrics {
  area: number
  centroid: Vec2
  polarMomentAboutCentroid: number
}

export interface BezierBodyPathAnalysis {
  valid: boolean
  diagnostics: string[]
  sampledPoints: Vec2[]
  metrics: BezierBodyPathMetrics
  invalidSegmentIndices: number[]
}

function finitePoint(point: Vec2): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

function clonePoint(point: Vec2): Vec2 {
  return { x: point.x, y: point.y }
}

function distanceSquared(first: Vec2, second: Vec2): number {
  return (first.x - second.x) ** 2 + (first.y - second.y) ** 2
}

function pointLineDistance(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  if (length <= Number.EPSILON) return Math.hypot(point.x - start.x, point.y - start.y)
  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / length
}

function midpoint(first: Vec2, second: Vec2): Vec2 {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
}

function appendAdaptiveCubic(
  output: Vec2[],
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  tolerance: number,
  depth: number,
): void {
  if (output.length > MAX_BEZIER_BODY_SAMPLED_VERTICES) return
  const flatness = Math.max(pointLineDistance(p1, p0, p3), pointLineDistance(p2, p0, p3))
  if (flatness <= tolerance || depth >= MAX_SUBDIVISION_DEPTH) {
    output.push(clonePoint(p3))
    return
  }
  const p01 = midpoint(p0, p1)
  const p12 = midpoint(p1, p2)
  const p23 = midpoint(p2, p3)
  const p012 = midpoint(p01, p12)
  const p123 = midpoint(p12, p23)
  const p0123 = midpoint(p012, p123)
  appendAdaptiveCubic(output, p0, p01, p012, p0123, tolerance, depth + 1)
  appendAdaptiveCubic(output, p0123, p123, p23, p3, tolerance, depth + 1)
}

export function bezierPathFeatureTolerance(nodes: BezierPathNode[]): number {
  const points = nodes.flatMap((node) => [node.anchor, node.inHandle, node.outHandle])
  if (points.length === 0 || points.some((point) => !finitePoint(point))) {
    return MIN_FEATURE_TOLERANCE_M
  }
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const featureSize = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  return Math.min(
    MAX_FEATURE_TOLERANCE_M,
    Math.max(MIN_FEATURE_TOLERANCE_M, featureSize * FEATURE_TOLERANCE_RATIO),
  )
}

export function sampleAdaptiveClosedBezierPath(nodes: BezierPathNode[]): Vec2[] {
  if (nodes.length === 0) return []
  const tolerance = bezierPathFeatureTolerance(nodes)
  const sampled = [clonePoint(nodes[0]!.anchor)]
  for (let index = 0; index < nodes.length; index += 1) {
    const current = nodes[index]!
    const next = nodes[(index + 1) % nodes.length]!
    appendAdaptiveCubic(
      sampled,
      current.anchor,
      current.outHandle,
      next.inHandle,
      next.anchor,
      tolerance,
      0,
    )
    if (sampled.length > MAX_BEZIER_BODY_SAMPLED_VERTICES) break
  }
  if (
    sampled.length > 1 &&
    distanceSquared(sampled[0]!, sampled[sampled.length - 1]!) <= tolerance ** 2
  ) {
    sampled.pop()
  }
  return sampled
}

function polygonMetrics(points: Vec2[]): BezierBodyPathMetrics {
  let twiceArea = 0
  let centroidNumeratorX = 0
  let centroidNumeratorY = 0
  let polarMomentTimesTwelve = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    const cross = current.x * next.y - next.x * current.y
    twiceArea += cross
    centroidNumeratorX += (current.x + next.x) * cross
    centroidNumeratorY += (current.y + next.y) * cross
    polarMomentTimesTwelve +=
      cross *
      (current.x ** 2 +
        current.x * next.x +
        next.x ** 2 +
        current.y ** 2 +
        current.y * next.y +
        next.y ** 2)
  }
  if (Math.abs(twiceArea) <= 1e-14) {
    return { area: 0, centroid: { x: 0, y: 0 }, polarMomentAboutCentroid: 0 }
  }
  const signedArea = twiceArea / 2
  const centroid = {
    x: centroidNumeratorX / (3 * twiceArea),
    y: centroidNumeratorY / (3 * twiceArea),
  }
  const signedPolarMomentAboutOrigin = polarMomentTimesTwelve / 12
  const signedPolarMomentAboutCentroid =
    signedPolarMomentAboutOrigin - signedArea * (centroid.x ** 2 + centroid.y ** 2)
  return {
    area: Math.abs(signedArea),
    centroid,
    polarMomentAboutCentroid: Math.max(0, Math.abs(signedPolarMomentAboutCentroid)),
  }
}

function orientation(first: Vec2, second: Vec2, third: Vec2): number {
  return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x)
}

function pointOnSegment(point: Vec2, start: Vec2, end: Vec2, tolerance: number): boolean {
  return (
    Math.abs(orientation(start, end, point)) <= tolerance &&
    point.x >= Math.min(start.x, end.x) - tolerance &&
    point.x <= Math.max(start.x, end.x) + tolerance &&
    point.y >= Math.min(start.y, end.y) - tolerance &&
    point.y <= Math.max(start.y, end.y) + tolerance
  )
}

function segmentsIntersect(
  firstStart: Vec2,
  firstEnd: Vec2,
  secondStart: Vec2,
  secondEnd: Vec2,
  tolerance: number,
): boolean {
  const firstA = orientation(firstStart, firstEnd, secondStart)
  const firstB = orientation(firstStart, firstEnd, secondEnd)
  const secondA = orientation(secondStart, secondEnd, firstStart)
  const secondB = orientation(secondStart, secondEnd, firstEnd)
  if (
    ((firstA > tolerance && firstB < -tolerance) || (firstA < -tolerance && firstB > tolerance)) &&
    ((secondA > tolerance && secondB < -tolerance) || (secondA < -tolerance && secondB > tolerance))
  ) {
    return true
  }
  return (
    (Math.abs(firstA) <= tolerance &&
      pointOnSegment(secondStart, firstStart, firstEnd, tolerance)) ||
    (Math.abs(firstB) <= tolerance && pointOnSegment(secondEnd, firstStart, firstEnd, tolerance)) ||
    (Math.abs(secondA) <= tolerance &&
      pointOnSegment(firstStart, secondStart, secondEnd, tolerance)) ||
    (Math.abs(secondB) <= tolerance && pointOnSegment(firstEnd, secondStart, secondEnd, tolerance))
  )
}

function selfIntersectionSegments(points: Vec2[], tolerance: number): number[] {
  const invalid = new Set<number>()
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length
      if (first === second || firstNext === second || secondNext === first) continue
      if (
        segmentsIntersect(
          points[first]!,
          points[firstNext]!,
          points[second]!,
          points[secondNext]!,
          tolerance,
        )
      ) {
        invalid.add(first)
        invalid.add(second)
      }
    }
  }
  return [...invalid].sort((first, second) => first - second)
}

export function analyzeBezierBodyPath(nodes: BezierPathNode[]): BezierBodyPathAnalysis {
  const diagnostics: string[] = []
  if (nodes.length < 3) diagnostics.push('钢笔物块至少需要三个锚点。')
  if (
    nodes.some(
      (node) =>
        !finitePoint(node.anchor) || !finitePoint(node.inHandle) || !finitePoint(node.outHandle),
    )
  ) {
    diagnostics.push('钢笔物块包含无效坐标。')
  }
  const sampledPoints = diagnostics.length === 0 ? sampleAdaptiveClosedBezierPath(nodes) : []
  if (sampledPoints.length > MAX_BEZIER_BODY_SAMPLED_VERTICES) {
    diagnostics.push(`钢笔物块轮廓不能超过 ${MAX_BEZIER_BODY_SAMPLED_VERTICES} 个采样顶点。`)
  }
  const tolerance = bezierPathFeatureTolerance(nodes)
  const metrics = polygonMetrics(sampledPoints)
  const areaTolerance = Math.max(tolerance ** 2, metrics.area * 1e-10)
  if (sampledPoints.length < 3 || metrics.area <= areaTolerance) {
    diagnostics.push('钢笔物块轮廓面积过小或已经退化。')
  }
  const invalidSegmentIndices =
    sampledPoints.length >= 3 && sampledPoints.length <= MAX_BEZIER_BODY_SAMPLED_VERTICES
      ? selfIntersectionSegments(sampledPoints, tolerance ** 2)
      : []
  if (invalidSegmentIndices.length > 0) diagnostics.push('钢笔物块轮廓不能自相交。')
  return {
    valid: diagnostics.length === 0,
    diagnostics: [...new Set(diagnostics)],
    sampledPoints,
    metrics,
    invalidSegmentIndices,
  }
}

export function transformBezierPathNodes(
  nodes: BezierPathNode[],
  transform: Transform2D,
): BezierPathNode[] {
  const cosine = Math.cos(transform.angleRad)
  const sine = Math.sin(transform.angleRad)
  const transformPoint = (point: Vec2): Vec2 => ({
    x: transform.position.x + point.x * cosine - point.y * sine,
    y: transform.position.y + point.x * sine + point.y * cosine,
  })
  const transformOffset = (offset: Vec2): Vec2 => ({
    x: offset.x * cosine - offset.y * sine,
    y: offset.x * sine + offset.y * cosine,
  })
  return nodes.map((node) => ({
    anchor: transformPoint(node.anchor),
    inHandle: transformPoint(node.inHandle),
    outHandle: transformPoint(node.outHandle),
    ...(node.collapsedHandles
      ? {
          collapsedHandles: {
            inOffset: transformOffset(node.collapsedHandles.inOffset),
            outOffset: transformOffset(node.collapsedHandles.outOffset),
          },
        }
      : {}),
  }))
}

export function worldBezierPathNodes(body: BodyEntity): BezierPathNode[] {
  return body.shape.type === 'bezierPath'
    ? transformBezierPathNodes(body.shape.nodes, body.transform)
    : []
}

export function sampleBezierBodyWorldPoints(body: BodyEntity): Vec2[] {
  return sampleAdaptiveClosedBezierPath(worldBezierPathNodes(body))
}

export function centerBezierPathNodes(nodes: BezierPathNode[]): {
  nodes: BezierPathNode[]
  center: Vec2
  analysis: BezierBodyPathAnalysis
} {
  const analysis = analyzeBezierBodyPath(nodes)
  const center = analysis.metrics.centroid
  return {
    center,
    analysis,
    nodes: nodes.map((node) => ({
      anchor: { x: node.anchor.x - center.x, y: node.anchor.y - center.y },
      inHandle: { x: node.inHandle.x - center.x, y: node.inHandle.y - center.y },
      outHandle: { x: node.outHandle.x - center.x, y: node.outHandle.y - center.y },
      ...(node.collapsedHandles ? { collapsedHandles: node.collapsedHandles } : {}),
    })),
  }
}
