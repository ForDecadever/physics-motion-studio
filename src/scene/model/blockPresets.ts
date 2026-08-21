import type { BezierPathNode, Vec2 } from './types'

export type CurvedBlockPreset = 'quarterRamp' | 'semicircleCutout' | 'quarterCircleCutout'

const CIRCLE_CUBIC_KAPPA = 0.552_284_749_830_793_6

function corner(anchor: Vec2): BezierPathNode {
  return { anchor, inHandle: { ...anchor }, outHandle: { ...anchor } }
}

export function createCurvedBlockPresetNodes(
  preset: CurvedBlockPreset,
  center: Vec2,
  width: number,
  height: number,
): BezierPathNode[] {
  const halfWidth = Math.max(0.025, Math.abs(width) / 2)
  const halfHeight = Math.max(0.025, Math.abs(height) / 2)
  const left = center.x - halfWidth
  const right = center.x + halfWidth
  const bottom = center.y - halfHeight
  const top = center.y + halfHeight
  const safeWidth = halfWidth * 2
  const safeHeight = halfHeight * 2

  if (preset === 'quarterRamp') {
    const radius = Math.min(0.45 * safeWidth, 0.8 * safeHeight)
    const join = corner({ x: right - radius, y: top - radius })
    const upperRight = corner({ x: right, y: top })
    upperRight.outHandle = { x: right, y: top - CIRCLE_CUBIC_KAPPA * radius }
    join.inHandle = {
      x: right - radius + CIRCLE_CUBIC_KAPPA * radius,
      y: top - radius,
    }
    return [
      corner({ x: left, y: bottom }),
      corner({ x: right, y: bottom }),
      upperRight,
      join,
      corner({ x: left, y: top - radius }),
    ]
  }

  if (preset === 'semicircleCutout') {
    const radius = Math.min(safeWidth / 3, (2 * safeHeight) / 3)
    const rightCut = corner({ x: center.x + radius, y: top })
    const bottomCut = corner({ x: center.x, y: top - radius })
    const leftCut = corner({ x: center.x - radius, y: top })
    rightCut.outHandle = {
      x: center.x + radius,
      y: top - CIRCLE_CUBIC_KAPPA * radius,
    }
    bottomCut.inHandle = {
      x: center.x + CIRCLE_CUBIC_KAPPA * radius,
      y: top - radius,
    }
    bottomCut.outHandle = {
      x: center.x - CIRCLE_CUBIC_KAPPA * radius,
      y: top - radius,
    }
    leftCut.inHandle = {
      x: center.x - radius,
      y: top - CIRCLE_CUBIC_KAPPA * radius,
    }
    return [
      corner({ x: left, y: bottom }),
      corner({ x: right, y: bottom }),
      corner({ x: right, y: top }),
      rightCut,
      bottomCut,
      leftCut,
      corner({ x: left, y: top }),
    ]
  }

  const radius = Math.min(safeWidth, safeHeight)
  const topCut = corner({ x: left + radius, y: top })
  const leftCut = corner({ x: left, y: top - radius })
  topCut.outHandle = { x: left + radius, y: top - CIRCLE_CUBIC_KAPPA * radius }
  leftCut.inHandle = { x: left + CIRCLE_CUBIC_KAPPA * radius, y: top - radius }
  const nodes = [corner({ x: left, y: bottom }), corner({ x: right, y: bottom })]
  if (Math.hypot(right - topCut.anchor.x, top - topCut.anchor.y) > 1e-12) {
    nodes.push(corner({ x: right, y: top }))
  }
  nodes.push(topCut, leftCut)
  if (Math.hypot(leftCut.anchor.x - left, leftCut.anchor.y - bottom) <= 1e-12) {
    nodes.shift()
  }
  return nodes
}

export function createTriangleBlockNodes(
  baseStart: Vec2,
  baseLength: number,
  angleDeg: number,
  riseDirection: 1 | -1,
): BezierPathNode[] {
  const length = Math.max(0.05, Math.abs(baseLength))
  const horizontalDirection = baseLength < 0 ? -1 : 1
  const baseEnd = { x: baseStart.x + horizontalDirection * length, y: baseStart.y }
  const height = Math.tan((Math.min(85, Math.max(5, angleDeg)) * Math.PI) / 180) * length
  return [
    corner(baseStart),
    corner(baseEnd),
    corner({ x: baseStart.x, y: baseStart.y + riseDirection * height }),
  ]
}
