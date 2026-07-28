import { describe, expect, it } from 'vitest'

import { regionContainsPoint } from './fieldRegions'
import { createSmoothBezierPathNodes } from '../../scene/model/bezierPath'

describe('regionContainsPoint', () => {
  it('支持旋转矩形、圆形、多边形和边界点', () => {
    expect(
      regionContainsPoint(
        { type: 'rectangle', center: { x: 0, y: 0 }, width: 4, height: 2, angleRad: Math.PI / 2 },
        { x: 0, y: 1.9 },
      ),
    ).toBe(true)
    expect(
      regionContainsPoint(
        { type: 'rectangle', center: { x: 0, y: 0 }, width: 4, height: 2, angleRad: Math.PI / 2 },
        { x: 1.1, y: 0 },
      ),
    ).toBe(false)
    expect(
      regionContainsPoint(
        {
          type: 'circle',
          center: { x: 2, y: 1 },
          radius: 1,
          startRad: 0,
          sweepRad: Math.PI * 2,
        },
        { x: 3, y: 1 },
      ),
    ).toBe(true)
    expect(
      regionContainsPoint(
        {
          type: 'polygon',
          points: [
            { x: 0, y: 0 },
            { x: 2, y: 0 },
            { x: 1, y: 2 },
          ],
        },
        { x: 1, y: 0 },
      ),
    ).toBe(true)
  })

  it('圆形范围可按圆心角裁成扇形，并支持顺时针角度', () => {
    const counterclockwise = {
      type: 'circle' as const,
      center: { x: 0, y: 0 },
      radius: 2,
      startRad: 0,
      sweepRad: Math.PI / 2,
    }
    expect(regionContainsPoint(counterclockwise, { x: 1, y: 1 })).toBe(true)
    expect(regionContainsPoint(counterclockwise, { x: -1, y: 1 })).toBe(false)

    const clockwise = { ...counterclockwise, sweepRad: -Math.PI / 2 }
    expect(regionContainsPoint(clockwise, { x: 1, y: -1 })).toBe(true)
    expect(regionContainsPoint(clockwise, { x: 1, y: 1 })).toBe(false)
  })

  it('闭合贝塞尔自由场使用采样后的曲线边界判断', () => {
    const region = {
      type: 'bezierPath' as const,
      nodes: createSmoothBezierPathNodes([
        { x: -2, y: -1 },
        { x: 2, y: -1 },
        { x: 0, y: 2 },
      ]),
    }
    expect(regionContainsPoint(region, { x: 0, y: 0 })).toBe(true)
    expect(regionContainsPoint(region, { x: 4, y: 4 })).toBe(false)
  })
})
