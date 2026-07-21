import { describe, expect, it } from 'vitest'

import { regionContainsPoint } from './fieldRegions'

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
      regionContainsPoint({ type: 'circle', center: { x: 2, y: 1 }, radius: 1 }, { x: 3, y: 1 }),
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
})
