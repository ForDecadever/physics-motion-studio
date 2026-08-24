import { describe, expect, it } from 'vitest'

import { evaluateFieldDefinition } from './fieldExpressions'
import type { FieldDefinition } from './types'

describe('电场分量表达式', () => {
  it('X/Y 分量分别使用时间和全局变量求值', () => {
    const field: FieldDefinition = {
      type: 'uniformElectric',
      strength: { x: 1, y: 2 },
      componentExpressions: {
        x: { expression: 'a+t', fallbackValue: 1 },
        y: { expression: 'a-2*t', fallbackValue: 2 },
      },
    }

    expect(evaluateFieldDefinition(field, 3, { a: 10 })).toMatchObject({
      strength: { x: 13, y: 4 },
    })
  })

  it('任一分量在当前时刻非有限时跳过整个场', () => {
    const field: FieldDefinition = {
      type: 'uniformElectric',
      strength: { x: 1, y: 2 },
      componentExpressions: {
        x: { expression: '1/t', fallbackValue: 1 },
      },
    }

    expect(evaluateFieldDefinition(field, 0, {})).toBeNull()
    expect(evaluateFieldDefinition(field, 2, {})).toMatchObject({
      strength: { x: 0.5, y: 2 },
    })
  })
})
