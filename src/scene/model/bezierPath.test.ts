import { describe, expect, it } from 'vitest'

import {
  createSmoothBezierPathNodes,
  moveBezierPathPoint,
  sampleClosedBezierPath,
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
})
