import type {
  ChartAxisDefinition,
  ChartAxisMetricId,
  ChartDefinition,
} from '../../scene/model/types'
import {
  ChartExpressionError,
  compileChartExpression,
  type CompiledChartExpression,
} from './chartExpression'

export interface ChartAxisMetricDefinition {
  id: ChartAxisMetricId
  name: string
  symbol: string
  unit: string
  expression: string
}

export const chartAxisMetricDefinitions: readonly ChartAxisMetricDefinition[] = [
  { id: 'time', name: '时间', symbol: 't', unit: 's', expression: 't' },
  { id: 'positionX', name: '水平位置', symbol: 'x', unit: 'm', expression: 'x' },
  { id: 'positionY', name: '竖直位置', symbol: 'y', unit: 'm', expression: 'y' },
  { id: 'velocityX', name: '水平速度', symbol: 'vx', unit: 'm/s', expression: 'vx' },
  { id: 'velocityY', name: '竖直速度', symbol: 'vy', unit: 'm/s', expression: 'vy' },
  { id: 'speed', name: '速率', symbol: 'speed', unit: 'm/s', expression: 'speed' },
  { id: 'acceleration', name: '加速度', symbol: 'acc', unit: 'm/s²', expression: 'acc' },
  { id: 'angle', name: '角度', symbol: 'angle', unit: 'rad', expression: 'angle' },
  {
    id: 'angularVelocity',
    name: '角速度',
    symbol: 'omega',
    unit: 'rad/s',
    expression: 'omega',
  },
  { id: 'netForce', name: '合外力', symbol: 'force', unit: 'N', expression: 'force' },
  { id: 'kineticEnergy', name: '总动能', symbol: 'Ek', unit: 'J', expression: 'Ek' },
  {
    id: 'translationalKineticEnergy',
    name: '平动动能',
    symbol: 'Etrans',
    unit: 'J',
    expression: 'Etrans',
  },
  {
    id: 'rotationalKineticEnergy',
    name: '转动动能',
    symbol: 'Erot',
    unit: 'J',
    expression: 'Erot',
  },
]

export function getChartAxisMetric(metricId: ChartAxisMetricId): ChartAxisMetricDefinition {
  const metric = chartAxisMetricDefinitions.find((candidate) => candidate.id === metricId)
  if (!metric) throw new ChartExpressionError(`未知图表物理量“${metricId}”。`)
  return metric
}

export function axisSource(axis: ChartAxisDefinition): string {
  return axis.type === 'metric' ? getChartAxisMetric(axis.metricId).expression : axis.expression
}

export function compileChartAxis(
  chart: Pick<ChartDefinition, 'bindings'>,
  axis: ChartAxisDefinition,
): CompiledChartExpression {
  const compiled = compileChartExpression(axisSource(axis))
  const aliases = new Set(chart.bindings.map((binding) => binding.alias))
  const missing = compiled.referencedAliases.find((alias) => !aliases.has(alias))
  if (missing) throw new ChartExpressionError(`公式引用了尚未绑定的物体别名 @${missing}。`)
  return compiled
}

export function axisLabel(axis: ChartAxisDefinition, unit: string): string {
  if (axis.type === 'metric') {
    const metric = getChartAxisMetric(axis.metricId)
    return `${metric.symbol} / ${unit}`
  }
  return `${axis.expression} / ${unit}`
}
