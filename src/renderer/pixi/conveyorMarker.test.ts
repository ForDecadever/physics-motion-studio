import { describe, expect, it } from 'vitest'

import { conveyorMarkerDistance } from './conveyorMarker'

describe('传送带运行标记点', () => {
  it('按速度和方向沿闭合弧长循环', () => {
    expect(conveyorMarkerDistance(10, 2, 'forward', 3)).toBeCloseTo(6)
    expect(conveyorMarkerDistance(10, 2, 'forward', 8)).toBeCloseTo(6)
    expect(conveyorMarkerDistance(10, 2, 'reverse', 3)).toBeCloseTo(4)
  })

  it('反向时以路径末端为起点，正向时以路径起点为起点', () => {
    expect(conveyorMarkerDistance(10, 2, 'forward', 0)).toBe(0)
    expect(conveyorMarkerDistance(10, 2, 'reverse', 0)).toBe(10)
    expect(conveyorMarkerDistance(10, 0, 'forward', 5)).toBe(0)
    expect(conveyorMarkerDistance(10, 0, 'reverse', 5)).toBe(10)
  })

  it('退化路径仍停在唯一端点', () => {
    expect(conveyorMarkerDistance(0, 2, 'forward', 5)).toBe(0)
    expect(conveyorMarkerDistance(0, 2, 'reverse', 5)).toBe(0)
  })
})
