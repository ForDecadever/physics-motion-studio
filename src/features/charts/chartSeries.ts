import type { ChartDefinition } from '../../scene/model/types'
import { compileChartAxis } from './chartAxis'
import type { ChartTelemetryBuffer, ChartTelemetrySample } from './chartTelemetry'

export interface EvaluatedChartPoint {
  time: number
  x: number | null
  y: number | null
}

export interface EvaluatedChartSeries {
  id: string
  entityId: string
  points: EvaluatedChartPoint[]
}

export interface EvaluatedChart {
  xUnit: string
  yUnit: string
  series: EvaluatedChartSeries[]
}

export function evaluateChart(
  chart: ChartDefinition,
  telemetry: ChartTelemetryBuffer,
  maximumSamples = Number.POSITIVE_INFINITY,
): EvaluatedChart {
  const xAxis = compileChartAxis(chart, chart.xAxis)
  const yAxis = compileChartAxis(chart, chart.yAxis)
  const aliases = new Set([...xAxis.referencedAliases, ...yAxis.referencedAliases])
  const bindingIds = new Map(
    chart.bindings
      .filter((binding) => aliases.has(binding.alias))
      .map((binding) => [binding.alias, binding.entityId]),
  )
  const evaluated = new Map(
    chart.series.map((series) => [
      series.id,
      { id: series.id, entityId: series.entityId, points: [] as EvaluatedChartPoint[] },
    ]),
  )

  const visit = (sample: ChartTelemetrySample) => {
    const bindings = Object.fromEntries(
      [...bindingIds].map(([alias, entityId]) => [alias, sample.body(entityId)]),
    )
    for (const series of chart.series) {
      const target = evaluated.get(series.id)!
      const self = sample.body(series.entityId)
      const context = { time: sample.time, self, bindings }
      const x = xAxis.evaluate(context)
      const y = yAxis.evaluate(context)
      if (x === null || y === null) {
        if (target.points.at(-1)?.x !== null) {
          target.points.push({ time: sample.time, x: null, y: null })
        }
      } else {
        target.points.push({ time: sample.time, x, y })
      }
    }
  }

  if (Number.isFinite(maximumSamples)) telemetry.forEachSelected(maximumSamples, visit)
  else telemetry.forEach(visit)

  return {
    xUnit: xAxis.unit,
    yUnit: yAxis.unit,
    series: [...evaluated.values()],
  }
}
