import type { BodyEntity, ChartDefinition } from '../../scene/model/types'
import type { EvaluatedChart } from './chartSeries'

function escapeCsvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

function stableTimeKey(time: number): string {
  return time.toFixed(9)
}

function csv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(',')).join('\r\n')
}

function safeFileStem(name: string): string {
  return name.trim().replace(/[<>:"/\\|?*]/g, '-') || '未命名场景'
}

function downloadCsv(fileName: string, content: string): string {
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
  return fileName
}

export function buildChartCsv(
  chart: ChartDefinition,
  evaluated: EvaluatedChart,
  bodyNames: ReadonlyMap<string, string>,
): string {
  const timeValues = new Map<string, number>()
  const valuesBySeries = new Map<string, Map<string, { x: number | null; y: number | null }>>()
  for (const series of evaluated.series) {
    const values = new Map<string, { x: number | null; y: number | null }>()
    for (const point of series.points) {
      const key = stableTimeKey(point.time)
      timeValues.set(key, point.time)
      values.set(key, { x: point.x, y: point.y })
    }
    valuesBySeries.set(series.id, values)
  }

  const orderedTimes = [...timeValues.entries()].sort((first, second) => first[1] - second[1])
  const header = [
    '模拟时间 t (s)',
    ...chart.series.flatMap((series) => {
      const name = bodyNames.get(series.entityId) ?? '已删除物体'
      return [`${name} 横轴 (${evaluated.xUnit})`, `${name} 纵轴 (${evaluated.yUnit})`]
    }),
  ]
  const rows = orderedTimes.map(([key, time]) => [
    time.toPrecision(12),
    ...chart.series.flatMap((series) => {
      const value = valuesBySeries.get(series.id)?.get(key)
      return [
        value?.x === null || value?.x === undefined ? '' : value.x.toPrecision(12),
        value?.y === null || value?.y === undefined ? '' : value.y.toPrecision(12),
      ]
    }),
  ])
  return csv([header, ...rows])
}

export function buildAllChartsCsv(
  charts: readonly ChartDefinition[],
  evaluatedCharts: ReadonlyMap<string, EvaluatedChart>,
  bodies: readonly BodyEntity[],
): string {
  const bodyNames = new Map(bodies.map((body) => [body.id, body.name]))
  const rows: string[][] = [
    ['坐标系', '物体', '物体 ID', '模拟时间 t (s)', '横轴值', '横轴单位', '纵轴值', '纵轴单位'],
  ]
  for (const chart of charts) {
    const evaluated = evaluatedCharts.get(chart.id)
    if (!evaluated) continue
    for (const series of evaluated.series) {
      for (const point of series.points) {
        if (point.x === null || point.y === null) continue
        rows.push([
          chart.name,
          bodyNames.get(series.entityId) ?? '已删除物体',
          series.entityId,
          point.time.toPrecision(12),
          point.x.toPrecision(12),
          evaluated.xUnit,
          point.y.toPrecision(12),
          evaluated.yUnit,
        ])
      }
    }
  }
  return csv(rows)
}

export function downloadSingleChartCsv(
  sceneName: string,
  chart: ChartDefinition,
  evaluated: EvaluatedChart,
  bodyNames: ReadonlyMap<string, string>,
): string {
  return downloadCsv(
    `${safeFileStem(sceneName)}-${safeFileStem(chart.name)}.csv`,
    buildChartCsv(chart, evaluated, bodyNames),
  )
}

export function downloadAllChartsCsv(
  sceneName: string,
  charts: readonly ChartDefinition[],
  evaluatedCharts: ReadonlyMap<string, EvaluatedChart>,
  bodies: readonly BodyEntity[],
): string {
  return downloadCsv(
    `${safeFileStem(sceneName)}-全部坐标系.csv`,
    buildAllChartsCsv(charts, evaluatedCharts, bodies),
  )
}
