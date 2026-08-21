import { describe, expect, it } from 'vitest'

import { analyzeBezierBodyPath } from './bodyPath'
import { createCurvedBlockPresetNodes, createTriangleBlockNodes } from './blockPresets'

describe('物块曲面预设', () => {
  it.each(['quarterRamp', 'semicircleCutout', 'quarterCircleCutout'] as const)(
    '%s 生成有效、确定性的单轮廓钢笔物块',
    (preset) => {
      const first = createCurvedBlockPresetNodes(preset, { x: 2, y: 3 }, 8, 5)
      const second = createCurvedBlockPresetNodes(preset, { x: 2, y: 3 }, 8, 5)
      const analysis = analyzeBezierBodyPath(first)

      expect(first).toEqual(second)
      expect(analysis.valid, analysis.diagnostics.join('；')).toBe(true)
      expect(analysis.metrics.area).toBeGreaterThan(0)
      expect(analysis.metrics.polarMomentAboutCentroid).toBeGreaterThan(0)
    },
  )

  it('半圆槽使用宽高共同限制的半径', () => {
    const nodes = createCurvedBlockPresetNodes('semicircleCutout', { x: 0, y: 0 }, 12, 3)
    const top = 1.5
    const expectedRadius = 2
    expect(nodes[3]!.anchor).toEqual({ x: expectedRadius, y: top })
    expect(nodes[4]!.anchor).toEqual({ x: 0, y: top - expectedRadius })
  })

  it('三角斜面限制角度并服从水平和竖直拖动方向', () => {
    const upward = createTriangleBlockNodes({ x: 1, y: 2 }, -3, 30, 1)
    const downward = createTriangleBlockNodes({ x: 1, y: 2 }, 3, 90, -1)

    expect(upward[1]!.anchor).toEqual({ x: -2, y: 2 })
    expect(upward[2]!.anchor.y).toBeCloseTo(2 + 3 * Math.tan(Math.PI / 6), 12)
    expect(downward[2]!.anchor.y).toBeCloseTo(2 - 3 * Math.tan((85 * Math.PI) / 180), 12)
    expect(analyzeBezierBodyPath(upward).valid).toBe(true)
    expect(analyzeBezierBodyPath(downward).valid).toBe(true)
  })
})
