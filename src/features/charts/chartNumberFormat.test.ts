import { describe, expect, it } from 'vitest'

import { formatChartNumber, resolveConstantChartAxisRange } from './chartNumberFormat'

describe('图表数字格式', () => {
  it('最多保留六位有效数字并去除无意义尾零', () => {
    expect(formatChartNumber(1 / 3)).toBe('0.333333')
    expect(formatChartNumber(123.456789)).toBe('123.457')
    expect(formatChartNumber(12.34)).toBe('12.34')
    expect(formatChartNumber(1000)).toBe('1000')
  })

  it('把负零显示为零，并安全处理非有限值', () => {
    expect(formatChartNumber(0)).toBe('0')
    expect(formatChartNumber(-0)).toBe('0')
    expect(formatChartNumber(Number.NaN)).toBe('—')
    expect(formatChartNumber(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('对极大和极小数使用规范化科学计数法', () => {
    expect(formatChartNumber(1_000_000)).toBe('1e6')
    expect(formatChartNumber(123_456_789)).toBe('1.23457e8')
    expect(formatChartNumber(0.0001)).toBe('0.0001')
    expect(formatChartNumber(-0.0000001234567)).toBe('-1.23457e-7')
  })

  it('为常量或浮点噪声范围提供稳定且非零的坐标轴区间', () => {
    expect(resolveConstantChartAxisRange(0, 0)).toEqual({ min: -0.001, max: 0.001 })
    expect(resolveConstantChartAxisRange(10, 10)).toEqual({ min: 9.5, max: 10.5 })
    expect(resolveConstantChartAxisRange(10, 10.000001)).toEqual({ min: 9.5, max: 10.5 })
  })

  it('保留真实变化范围并安全忽略无效边界', () => {
    expect(resolveConstantChartAxisRange(0, 1)).toBeNull()
    expect(resolveConstantChartAxisRange(Number.NaN, 1)).toBeNull()
    expect(resolveConstantChartAxisRange(2, 1)).toBeNull()
  })
})
