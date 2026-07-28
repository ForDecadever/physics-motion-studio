import { describe, expect, it } from 'vitest'

import type { GroundEntity } from '../../scene/model/types'
import { appendGroundPath, type GroundPathWriter } from './groundPath'

type PathCommand = { type: string; values: number[] }

function createRecorder(commands: PathCommand[]): GroundPathWriter {
  return {
    moveTo: (x, y) => commands.push({ type: 'moveTo', values: [x, y] }),
    lineTo: (x, y) => commands.push({ type: 'lineTo', values: [x, y] }),
    arc: (centerX, centerY, radius, startRad, endRad) =>
      commands.push({ type: 'arc', values: [centerX, centerY, radius, startRad, endRad] }),
    bezierCurveTo: (control1X, control1Y, control2X, control2Y, endX, endY) =>
      commands.push({
        type: 'bezierCurveTo',
        values: [control1X, control1Y, control2X, control2Y, endX, endY],
      }),
  }
}

describe('appendGroundPath', () => {
  it('直线后绘制圆弧时先移动到圆弧起点，不产生实体间连接线', () => {
    const commands: PathCommand[] = []
    const path = createRecorder(commands)
    const line: GroundEntity['geometry'] = {
      type: 'line',
      start: { x: -4, y: 0 },
      end: { x: -2, y: 0 },
    }
    const arc: GroundEntity['geometry'] = {
      type: 'arc',
      center: { x: 3, y: 2 },
      radius: 2,
      startRad: Math.PI,
      endRad: Math.PI * 2,
    }

    appendGroundPath(path, line)
    appendGroundPath(path, arc)

    expect(commands.map((command) => command.type)).toEqual(['moveTo', 'lineTo', 'moveTo', 'arc'])
    expect(commands[2]?.values[0]).toBeCloseTo(1)
    expect(commands[2]?.values[1]).toBeCloseTo(2)
  })

  it('贝塞尔地面也从自己的起点建立独立子路径', () => {
    const commands: PathCommand[] = []
    const path = createRecorder(commands)

    appendGroundPath(path, {
      type: 'cubicBezier',
      p0: { x: 1, y: 2 },
      p1: { x: 2, y: 3 },
      p2: { x: 3, y: 3 },
      p3: { x: 4, y: 2 },
    })

    expect(commands[0]).toEqual({ type: 'moveTo', values: [1, 2] })
    expect(commands[1]?.type).toBe('bezierCurveTo')
  })
})
