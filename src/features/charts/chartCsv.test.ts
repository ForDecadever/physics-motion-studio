import { describe, expect, it } from 'vitest'

import type { ChartCurve } from '../../stores/chartStore'
import { buildChartCsv } from './chartCsv'

const curves: ChartCurve[] = [
  {
    id: 'ball:positionY',
    entityId: 'ball',
    metricId: 'positionY',
    displayName: '小球 1 · y',
    color: '#4e9eeb',
    unit: 'm',
    visible: true,
  },
  {
    id: 'block:netForce',
    entityId: 'block',
    metricId: 'netForce',
    displayName: '物块 1 · |F|',
    color: '#4e9eeb',
    unit: 'N',
    visible: true,
  },
]

describe('图表 CSV', () => {
  it('导出带指标和单位的表头，并对齐不同曲线的采样时刻', () => {
    const csv = buildChartCsv(curves, {
      'ball:positionY': [
        { time: 0, value: 2 },
        { time: 1 / 60, value: 1.99 },
      ],
      'block:netForce': [{ time: 1 / 60, value: 9.80665 }],
    })

    const [header, firstRow, secondRow] = csv.split('\r\n')
    expect(header).toBe('模拟时间 t (s),小球 1 · y (m),物块 1 · |F| (N)')
    expect(firstRow).toBe('0.00000000000,2.00000000000,')
    expect(secondRow).toContain('1.99000000000,9.80665000000')
  })
})
