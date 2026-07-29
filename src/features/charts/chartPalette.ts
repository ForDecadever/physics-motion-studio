import type { ChartDefinition } from '../../scene/model/types'

export const CHART_COLOR_PALETTE = [
  '#58a6ff',
  '#ff7b72',
  '#7ee787',
  '#d2a8ff',
  '#ffa657',
  '#79c0ff',
  '#f2cc60',
  '#a5d6ff',
  '#ff9bce',
  '#56d4dd',
  '#c9d1d9',
  '#db6d28',
  '#bc8cff',
  '#3fb950',
  '#f85149',
  '#39c5cf',
  '#e3b341',
  '#8b949e',
  '#ffb86c',
  '#8be9fd',
] as const

export function defaultChartColor(charts: readonly ChartDefinition[], entityId: string): string {
  for (const chart of charts) {
    const existing = chart.series.find((series) => series.entityId === entityId)
    if (existing) return existing.color
  }
  const usedByOtherBodies = new Set(
    charts.flatMap((chart) =>
      chart.series
        .filter((series) => series.entityId !== entityId)
        .map((series) => series.color.toLowerCase()),
    ),
  )
  return (
    CHART_COLOR_PALETTE.find((color) => !usedByOtherBodies.has(color.toLowerCase())) ??
    CHART_COLOR_PALETTE[0]
  )
}
