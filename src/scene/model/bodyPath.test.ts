import { describe, expect, it } from 'vitest'

import { createSmoothBezierPathNodes } from './bezierPath'
import {
  analyzeBezierBodyPath,
  centerBezierPathNodes,
  sampleBezierBodyWorldPoints,
} from './bodyPath'
import { createBezierBlock } from './entityFactories'

describe('bezier path bodies', () => {
  it('accepts concave outlines and centers local nodes on the area centroid', () => {
    const concave = createSmoothBezierPathNodes([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 2, y: 2 },
      { x: 0, y: 4 },
    ])
    const analysis = analyzeBezierBodyPath(concave)
    const centered = centerBezierPathNodes(concave)

    expect(analysis.valid).toBe(true)
    expect(analysis.metrics.area).toBeGreaterThan(0)
    expect(analyzeBezierBodyPath(centered.nodes).metrics.centroid.x).toBeCloseTo(0, 6)
    expect(analyzeBezierBodyPath(centered.nodes).metrics.centroid.y).toBeCloseTo(0, 6)
  })

  it('rejects self intersections, zero area, and non-finite coordinates', () => {
    const selfIntersecting = createSmoothBezierPathNodes([
      { x: 0, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
      { x: 2, y: 0 },
    ])
    const line = createSmoothBezierPathNodes([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ])
    const nonFinite = createSmoothBezierPathNodes([
      { x: 0, y: 0 },
      { x: Number.NaN, y: 1 },
      { x: 1, y: 0 },
    ])

    expect(analyzeBezierBodyPath(selfIntersecting).invalidSegmentIndices.length).toBeGreaterThan(0)
    expect(analyzeBezierBodyPath(line).valid).toBe(false)
    expect(analyzeBezierBodyPath(nonFinite).valid).toBe(false)
  })

  it('rejects sampled outlines beyond the 2048 vertex limit without doing quadratic validation', () => {
    const nodes = Array.from({ length: 2_049 }, (_, index) => {
      const angle = (index / 2_049) * Math.PI * 2
      const anchor = { x: Math.cos(angle), y: Math.sin(angle) }
      return { anchor, inHandle: anchor, outHandle: anchor }
    })

    const analysis = analyzeBezierBodyPath(nodes)

    expect(analysis.valid).toBe(false)
    expect(analysis.sampledPoints.length).toBe(2_049)
    expect(analysis.diagnostics).toContain('钢笔物块轮廓不能超过 2048 个采样顶点。')
  })

  it('creates a block preset while preserving the sampled world outline', () => {
    const nodes = createSmoothBezierPathNodes([
      { x: 3, y: 2 },
      { x: 6, y: 2 },
      { x: 5, y: 5 },
      { x: 3, y: 4 },
    ])
    const entity = createBezierBlock('', nodes, 1)

    expect(entity).not.toBeNull()
    expect(entity?.preset).toBe('block')
    expect(entity?.shape.type).toBe('bezierPath')
    expect(sampleBezierBodyWorldPoints(entity!)).toHaveLength(
      analyzeBezierBodyPath(nodes).sampledPoints.length,
    )
  })
})
