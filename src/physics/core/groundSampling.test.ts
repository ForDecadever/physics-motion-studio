import { describe, expect, it } from 'vitest'

import { sampleGroundGeometry } from './groundSampling'
import { isOnPolylineNormalSide } from './SimulationWorld'

describe('sampleGroundGeometry', () => {
  it('保留圆弧端点，并把弦高误差限制在给定范围内', () => {
    const radius = 3
    const points = sampleGroundGeometry(
      { type: 'arc', center: { x: 1, y: 2 }, radius, startRad: Math.PI, endRad: 2 * Math.PI },
      { maxError: 0.001, maxSegmentLength: 0.2 },
    )

    expect(points[0]?.x).toBeCloseTo(-2, 10)
    expect(points[0]?.y).toBeCloseTo(2, 10)
    expect(points.at(-1)?.x).toBeCloseTo(4, 10)
    expect(points.at(-1)?.y).toBeCloseTo(2, 10)

    for (let index = 1; index < points.length; index += 1) {
      const first = points[index - 1]
      const second = points[index]
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      if (!first || !second) continue
      const chordLength = Math.hypot(second.x - first.x, second.y - first.y)
      const sagitta = radius - Math.sqrt(Math.max(0, radius ** 2 - (chordLength / 2) ** 2))
      expect(sagitta).toBeLessThanOrEqual(0.00101)
    }
  })

  it('自适应细分贝塞尔曲线，并精确保留两个端点', () => {
    const geometry = {
      type: 'cubicBezier' as const,
      p0: { x: -2, y: 1 },
      p1: { x: -1, y: -2 },
      p2: { x: 1, y: -2 },
      p3: { x: 2, y: 1 },
    }
    const points = sampleGroundGeometry(geometry, { maxError: 0.002, maxSegmentLength: 0.1 })

    expect(points.length).toBeGreaterThan(40)
    expect(points[0]).toEqual(geometry.p0)
    expect(points.at(-1)).toEqual(geometry.p3)
    for (let index = 1; index < points.length; index += 1) {
      const first = points[index - 1]
      const second = points[index]
      if (!first || !second) continue
      expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeLessThanOrEqual(0.101)
    }
  })

  it('按曲线绘制方向区分地面的法线侧和背面', () => {
    const points = [
      { x: -2, y: 0 },
      { x: 0, y: -1 },
      { x: 2, y: 0 },
    ]
    expect(isOnPolylineNormalSide(points, { x: 0, y: 0 })).toBe(true)
    expect(isOnPolylineNormalSide(points, { x: 0, y: -2 })).toBe(false)
    expect(isOnPolylineNormalSide([...points].reverse(), { x: 0, y: 0 })).toBe(false)
  })
})
