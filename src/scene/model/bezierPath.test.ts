import { describe, expect, it } from 'vitest'

import {
  createSmoothBezierPathNodes,
  moveBezierPathPoint,
  sampleClosedBezierPath,
  toggleBezierPathNodeMode,
} from './bezierPath'

describe('闭合贝塞尔钢笔路径', () => {
  const anchors = [
    { x: -2, y: -1 },
    { x: 2, y: -1 },
    { x: 0, y: 2 },
  ]

  it('为节点生成平滑控制棒并采样闭合边界', () => {
    const nodes = createSmoothBezierPathNodes(anchors)
    const sampled = sampleClosedBezierPath(nodes, 10)

    expect(nodes).toHaveLength(3)
    expect(sampled).toHaveLength(30)
    expect(sampled[0]).toEqual(anchors[0])
    expect(nodes[0]?.inHandle).not.toEqual(nodes[0]?.anchor)
  })

  it('拖动控制柄时镜像另一侧，拖动节点时控制棒一起平移', () => {
    const nodes = createSmoothBezierPathNodes(anchors)
    const movedHandle = moveBezierPathPoint(nodes, 0, 'outHandle', { x: 1, y: 1 })
    expect(movedHandle[0]?.inHandle).toEqual({ x: -5, y: -3 })

    const before = movedHandle[0]!
    const movedAnchor = moveBezierPathPoint(movedHandle, 0, 'anchor', { x: -1, y: 0 })[0]!
    expect(movedAnchor.inHandle.x - before.inHandle.x).toBe(1)
    expect(movedAnchor.outHandle.y - before.outHandle.y).toBe(1)
  })

  it('independent mode only moves the active handle', () => {
    const nodes = createSmoothBezierPathNodes(anchors)
    const originalOpposite = nodes[0]!.inHandle
    const moved = moveBezierPathPoint(nodes, 0, 'outHandle', { x: 2, y: 0 }, 'independent')

    expect(moved[0]!.outHandle).toEqual({ x: 2, y: 0 })
    expect(moved[0]!.inHandle).toEqual(originalOpposite)
  })

  it('折叠锚点控制棒后可以精确恢复，并在移动锚点时保留偏移', () => {
    const nodes = createSmoothBezierPathNodes(anchors)
    const original = nodes[0]!
    const collapsed = toggleBezierPathNodeMode(nodes, 0)
    expect(collapsed[0]!.inHandle).toEqual(collapsed[0]!.anchor)
    expect(collapsed[0]!.outHandle).toEqual(collapsed[0]!.anchor)

    const moved = moveBezierPathPoint(collapsed, 0, 'anchor', { x: 2, y: -1 })
    const restored = toggleBezierPathNodeMode(moved, 0)[0]!
    expect(restored.inHandle.x - restored.anchor.x).toBeCloseTo(
      original.inHandle.x - original.anchor.x,
      12,
    )
    expect(restored.inHandle.y - restored.anchor.y).toBeCloseTo(
      original.inHandle.y - original.anchor.y,
      12,
    )
    expect(restored.outHandle.x - restored.anchor.x).toBeCloseTo(
      original.outHandle.x - original.anchor.x,
      12,
    )
    expect(restored.outHandle.y - restored.anchor.y).toBeCloseTo(
      original.outHandle.y - original.anchor.y,
      12,
    )
    expect(restored.collapsedHandles).toBeUndefined()
  })

  it('从折叠节点拖出控制棒会退出折叠模式', () => {
    const collapsed = toggleBezierPathNodeMode(createSmoothBezierPathNodes(anchors), 0)
    const moved = moveBezierPathPoint(collapsed, 0, 'outHandle', { x: 1, y: 0 })[0]!
    expect(moved.collapsedHandles).toBeUndefined()
    expect(moved.inHandle).toEqual({ x: -5, y: -2 })
  })
})
