import { describe, expect, it } from 'vitest'

import type { RuntimeBodyState } from '../../physics/worker/messages'
import { ChartExpressionError, compileChartExpression } from './chartExpression'

const body: RuntimeBodyState = {
  entityId: 'body',
  position: { x: 3, y: 6 },
  angleRad: Math.PI / 2,
  linearVelocity: { x: 4, y: 3 },
  angularVelocityRad: 2,
  netForce: { x: 6, y: 8 },
  acceleration: { x: 0, y: -9.8 },
  translationalKineticEnergyJ: 12,
  rotationalKineticEnergyJ: 3,
  kineticEnergyJ: 15,
}

const context = { time: 2, self: body, bindings: { A: body } }

describe('图表安全公式', () => {
  it('计算同物体公式并推导单位', () => {
    const compiled = compileChartExpression('x/3+y')
    expect(compiled.unit).toBe('m')
    expect(compiled.evaluate(context)).toBe(7)
    expect(compileChartExpression('x*y').unit).toBe('m²')
  })

  it('严格拒绝不同量纲之间的加减', () => {
    expect(() => compileChartExpression('x/3+y*x')).toThrowError(
      new ChartExpressionError('无法相加：m 与 m² 的单位不同。'),
    )
    expect(() => compileChartExpression('x+vx')).toThrow(/单位不同/)
  })

  it('支持单位常量、常用函数和跨物体别名', () => {
    expect(compileChartExpression('x+3*m').evaluate(context)).toBe(6)
    expect(compileChartExpression('sqrt(x*x+y*y)').unit).toBe('m')
    expect(compileChartExpression('sin(angle)').evaluate(context)).toBeCloseTo(1)
    const crossBody = compileChartExpression('@A.x-y')
    expect(crossBody.referencedAliases).toEqual(['A'])
    expect(crossBody.evaluate(context)).toBe(-3)
  })

  it('不会执行 JavaScript，运行时非法值只产生断点', () => {
    expect(() => compileChartExpression('window.alert(1)')).toThrow()
    expect(() => compileChartExpression('constructor')).toThrow()
    expect(compileChartExpression('x/0').evaluate(context)).toBeNull()
    expect(compileChartExpression('sqrt(-x)').evaluate(context)).toBeNull()
    expect(
      compileChartExpression('@A.x').evaluate({ time: 0, self: body, bindings: {} }),
    ).toBeNull()
  })
})
