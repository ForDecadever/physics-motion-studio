import type { ChartCurve, ChartPoint } from '../../stores/chartStore'

function escapeCsvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

function stableTimeKey(time: number): string {
  return time.toFixed(9)
}

export function buildChartCsv(
  curves: readonly ChartCurve[],
  series: Readonly<Record<string, readonly ChartPoint[]>>,
): string {
  const timeValues = new Map<string, number>()
  const valuesByCurve = new Map<string, Map<string, number>>()

  for (const curve of curves) {
    const curveValues = new Map<string, number>()
    for (const point of series[curve.id] ?? []) {
      const key = stableTimeKey(point.time)
      timeValues.set(key, point.time)
      curveValues.set(key, point.value)
    }
    valuesByCurve.set(curve.id, curveValues)
  }

  const orderedTimes = [...timeValues.entries()].sort((first, second) => first[1] - second[1])
  const header = [
    '模拟时间 t (s)',
    ...curves.map((curve) => `${curve.displayName} (${curve.unit})`),
  ]
  const rows = orderedTimes.map(([key, time]) => [
    time.toPrecision(12),
    ...curves.map((curve) => {
      const value = valuesByCurve.get(curve.id)?.get(key)
      return value === undefined ? '' : value.toPrecision(12)
    }),
  ])

  return [header, ...rows]
    .map((row) => row.map((cell) => escapeCsvCell(cell)).join(','))
    .join('\r\n')
}

export function downloadChartCsv(
  sceneName: string,
  curves: readonly ChartCurve[],
  series: Readonly<Record<string, readonly ChartPoint[]>>,
): string {
  const safeName = sceneName.trim().replace(/[<>:"/\\|?*]/g, '-') || '未命名场景'
  const fileName = `${safeName}-运行记录.csv`
  const blob = new Blob([`\uFEFF${buildChartCsv(curves, series)}`], {
    type: 'text/csv;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
  return fileName
}
