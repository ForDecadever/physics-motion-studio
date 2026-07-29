import { describe, expect, it } from 'vitest'

import type { ChartDefinition } from '../../scene/model/types'
import { buildAllChartsCsv, buildChartCsv } from './chartCsv'
import type { EvaluatedChart } from './chartSeries'

const chart: ChartDefinition = {
  id: 'chart',
  name: '位移图',
  xAxis: { type: 'metric', metricId: 'time' },
  yAxis: { type: 'metric', metricId: 'positionY' },
  bindings: [],
  series: [
    {
      id: 'ball-series',
      entityId: '00000000-0000-4000-8000-000000000001',
      visible: true,
      color: '#58a6ff',
      lineStyle: 'solid',
      lineWidth: 2,
    },
  ],
}

const evaluated: EvaluatedChart = {
  xUnit: 's',
  yUnit: 'm',
  series: [
    {
      id: 'ball-series',
      entityId: chart.series[0]!.entityId,
      points: [
        { time: 0, x: 0, y: 2 },
        { time: 1 / 60, x: 1 / 60, y: 1.99 },
      ],
    },
  ],
}

describe('多坐标系 CSV', () => {
  it('单图宽表包含每个物体的横纵轴值与单位', () => {
    const csv = buildChartCsv(chart, evaluated, new Map([[chart.series[0]!.entityId, '小球 1']]))
    const [header, firstRow] = csv.split('\r\n')
    expect(header).toBe('模拟时间 t (s),小球 1 横轴 (s),小球 1 纵轴 (m)')
    expect(firstRow).toBe('0.00000000000,0.00000000000,2.00000000000')
  })

  it('全部坐标系使用适合后续分析的长表格式', () => {
    const csv = buildAllChartsCsv([chart], new Map([[chart.id, evaluated]]), [])
    expect(csv).toContain('坐标系,物体,物体 ID,模拟时间 t (s)')
    expect(csv).toContain('位移图,已删除物体')
    expect(csv).toContain(',s,2.00000000000,m')
  })
})
