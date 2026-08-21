import { describe, expect, it } from 'vitest'

import { createSpringEndBar } from './connectorGeometry'

describe('弹簧自由端挡板几何', () => {
  it('横向弹簧绘制竖直挡板，宽度等于接触直径', () => {
    const bar = createSpringEndBar({ x: 0, y: 0 }, { x: 2, y: 0 }, 'end', 0.25)

    expect(bar.start).toEqual({ x: 2, y: -0.25 })
    expect(bar.end).toEqual({ x: 2, y: 0.25 })
  })

  it('竖向弹簧绘制水平挡板，并为重合端点使用确定性方向', () => {
    expect(createSpringEndBar({ x: 1, y: 1 }, { x: 1, y: 3 }, 'start', 0.5)).toEqual({
      start: { x: 1.5, y: 1 },
      end: { x: 0.5, y: 1 },
    })
    expect(createSpringEndBar({ x: 1, y: 1 }, { x: 1, y: 1 }, 'end', 0.5)).toEqual({
      start: { x: 1, y: 0.5 },
      end: { x: 1, y: 1.5 },
    })
  })
})
