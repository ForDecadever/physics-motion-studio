import type { BodyEntity, ChartMetricId } from '../../scene/model/types'
import type { RuntimeBodyState } from '../../physics/worker/messages'

export type { ChartMetricId } from '../../scene/model/types'

export interface ChartMetricDefinition {
  id: ChartMetricId
  name: string
  symbol: string
  unit: string
  read: (body: RuntimeBodyState) => number
}

export const chartMetricDefinitions: readonly ChartMetricDefinition[] = [
  { id: 'positionX', name: '水平位置', symbol: 'x', unit: 'm', read: (body) => body.position.x },
  { id: 'positionY', name: '竖直位置', symbol: 'y', unit: 'm', read: (body) => body.position.y },
  {
    id: 'velocityX',
    name: '水平速度',
    symbol: 'vₓ',
    unit: 'm/s',
    read: (body) => body.linearVelocity.x,
  },
  {
    id: 'velocityY',
    name: '竖直速度',
    symbol: 'vᵧ',
    unit: 'm/s',
    read: (body) => body.linearVelocity.y,
  },
  {
    id: 'speed',
    name: '速率',
    symbol: '|v|',
    unit: 'm/s',
    read: (body) => Math.hypot(body.linearVelocity.x, body.linearVelocity.y),
  },
  {
    id: 'acceleration',
    name: '加速度',
    symbol: '|a|',
    unit: 'm/s²',
    read: (body) => Math.hypot(body.acceleration.x, body.acceleration.y),
  },
  { id: 'angle', name: '角度', symbol: 'θ', unit: 'rad', read: (body) => body.angleRad },
  {
    id: 'angularVelocity',
    name: '角速度',
    symbol: 'ω',
    unit: 'rad/s',
    read: (body) => body.angularVelocityRad,
  },
  {
    id: 'netForce',
    name: '合外力',
    symbol: '|F|',
    unit: 'N',
    read: (body) => Math.hypot(body.netForce.x, body.netForce.y),
  },
  {
    id: 'kineticEnergy',
    name: '总动能',
    symbol: 'Eₖ',
    unit: 'J',
    read: (body) => body.kineticEnergyJ,
  },
  {
    id: 'translationalKineticEnergy',
    name: '平动动能',
    symbol: 'Eₖ,平',
    unit: 'J',
    read: (body) => body.translationalKineticEnergyJ,
  },
  {
    id: 'rotationalKineticEnergy',
    name: '转动动能',
    symbol: 'Eₖ,转',
    unit: 'J',
    read: (body) => body.rotationalKineticEnergyJ,
  },
]

export function getChartMetric(metricId: ChartMetricId): ChartMetricDefinition {
  const metric = chartMetricDefinitions.find((candidate) => candidate.id === metricId)
  if (!metric) throw new Error(`未知图表指标：${metricId}`)
  return metric
}

export function chartColorForBody(body: BodyEntity): string {
  if (body.shape.type === 'circle' && body.shape.collisionEnabled) return '#f06b78'
  return '#4e9eeb'
}
