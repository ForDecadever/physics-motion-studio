import type { BezierPathNode, Vec2 } from './types'

export type BezierPathPointKey = 'anchor' | 'inHandle' | 'outHandle'

export function createSmoothBezierPathNodes(points: Vec2[]): BezierPathNode[] {
  if (points.length < 3) {
    return points.map((anchor) => ({ anchor, inHandle: anchor, outHandle: anchor }))
  }

  return points.map((anchor, index) => {
    const previous = points[(index - 1 + points.length) % points.length] ?? anchor
    const next = points[(index + 1) % points.length] ?? anchor
    const tangent = { x: (next.x - previous.x) / 6, y: (next.y - previous.y) / 6 }
    return {
      anchor,
      inHandle: { x: anchor.x - tangent.x, y: anchor.y - tangent.y },
      outHandle: { x: anchor.x + tangent.x, y: anchor.y + tangent.y },
    }
  })
}

export function sampleClosedBezierPath(nodes: BezierPathNode[], segmentsPerCurve = 18): Vec2[] {
  if (nodes.length < 2) return nodes.map((node) => node.anchor)
  const points: Vec2[] = []

  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const current = nodes[nodeIndex]
    const next = nodes[(nodeIndex + 1) % nodes.length]
    if (!current || !next) continue
    for (let segment = 0; segment < segmentsPerCurve; segment += 1) {
      const t = segment / segmentsPerCurve
      const inverse = 1 - t
      points.push({
        x:
          inverse ** 3 * current.anchor.x +
          3 * inverse ** 2 * t * current.outHandle.x +
          3 * inverse * t ** 2 * next.inHandle.x +
          t ** 3 * next.anchor.x,
        y:
          inverse ** 3 * current.anchor.y +
          3 * inverse ** 2 * t * current.outHandle.y +
          3 * inverse * t ** 2 * next.inHandle.y +
          t ** 3 * next.anchor.y,
      })
    }
  }
  return points
}

export function moveBezierPathPoint(
  nodes: BezierPathNode[],
  nodeIndex: number,
  pointKey: BezierPathPointKey,
  point: Vec2,
  controlMode: 'mirrored' | 'independent' = 'mirrored',
): BezierPathNode[] {
  return nodes.map((node, index) => {
    if (index !== nodeIndex) return node
    if (pointKey === 'anchor') {
      const delta = { x: point.x - node.anchor.x, y: point.y - node.anchor.y }
      return {
        ...node,
        anchor: point,
        inHandle: { x: node.inHandle.x + delta.x, y: node.inHandle.y + delta.y },
        outHandle: { x: node.outHandle.x + delta.x, y: node.outHandle.y + delta.y },
      }
    }
    const expandedNode: BezierPathNode = { ...node }
    delete expandedNode.collapsedHandles
    if (controlMode === 'independent') return { ...expandedNode, [pointKey]: point }
    const oppositeKey = pointKey === 'inHandle' ? 'outHandle' : 'inHandle'
    return {
      ...expandedNode,
      [pointKey]: point,
      [oppositeKey]: {
        x: node.anchor.x * 2 - point.x,
        y: node.anchor.y * 2 - point.y,
      },
    }
  })
}

export function toggleBezierPathNodeMode(
  nodes: BezierPathNode[],
  nodeIndex: number,
): BezierPathNode[] {
  return nodes.map((node, index) => {
    if (index !== nodeIndex) return node
    if (node.collapsedHandles) {
      const { collapsedHandles, ...expandedNode } = node
      return {
        ...expandedNode,
        inHandle: {
          x: node.anchor.x + collapsedHandles.inOffset.x,
          y: node.anchor.y + collapsedHandles.inOffset.y,
        },
        outHandle: {
          x: node.anchor.x + collapsedHandles.outOffset.x,
          y: node.anchor.y + collapsedHandles.outOffset.y,
        },
      }
    }
    return {
      ...node,
      inHandle: { ...node.anchor },
      outHandle: { ...node.anchor },
      collapsedHandles: {
        inOffset: {
          x: node.inHandle.x - node.anchor.x,
          y: node.inHandle.y - node.anchor.y,
        },
        outOffset: {
          x: node.outHandle.x - node.anchor.x,
          y: node.outHandle.y - node.anchor.y,
        },
      },
    }
  })
}
