import { describe, expect, it } from 'vitest'

import { compileScalarExpression, ScalarExpressionError } from './scalarExpression'

describe('安全标量表达式', () => {
  it('支持隐式乘法、白名单函数、全局变量与时间', () => {
    const compiled = compileScalarExpression('3a + 2(t + 1) + sin(pi / 2)', {
      allowTime: true,
      variableNames: new Set(['a']),
    })

    expect(compiled.referencedVariables).toEqual(['a'])
    expect(compiled.usesTime).toBe(true)
    expect(compiled.evaluate({ time: 4, variables: { a: 10 } })).toBe(41)
  })

  it('拒绝脚本字符、未知变量、动态指数和禁用的 t', () => {
    expect(() => compileScalarExpression('globalThis.x')).toThrow(ScalarExpressionError)
    expect(() => compileScalarExpression('missing + 1')).toThrow('未知全局变量')
    expect(() => compileScalarExpression('2^a', { variableNames: new Set(['a']) })).toThrow(
      '指数必须是常数',
    )
    expect(() => compileScalarExpression('t + 1')).toThrow('不允许使用时间变量')
  })

  it('运行时除零或非有限函数结果只返回空值', () => {
    expect(
      compileScalarExpression('1 / (t - 1)', { allowTime: true }).evaluate({
        time: 1,
        variables: {},
      }),
    ).toBeNull()
    expect(compileScalarExpression('sqrt(-1)').evaluate({ time: 0, variables: {} })).toBeNull()
  })
})
