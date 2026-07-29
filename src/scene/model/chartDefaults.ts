import type { ChartDefinition } from './types'

export const MAX_CHARTS = 8
export const MAX_CHART_SERIES_PER_CHART = 12
export const MAX_CHART_SERIES = 32
export const MAX_RECORDED_CHART_BODIES = 20

export function createDefaultChart(
  id: string = crypto.randomUUID(),
  name = '坐标系 1',
): ChartDefinition {
  return {
    id,
    name,
    xAxis: { type: 'metric', metricId: 'time' },
    yAxis: { type: 'metric', metricId: 'positionY' },
    bindings: [],
    series: [],
  }
}
