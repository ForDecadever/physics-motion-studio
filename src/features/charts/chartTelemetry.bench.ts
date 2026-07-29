import { bench } from 'vitest'

import type { RuntimeBodyState, RuntimeSample } from '../../physics/worker/messages'
import type { ChartDefinition } from '../../scene/model/types'
import { evaluateChart } from './chartSeries'
import { ChartTelemetryBuffer } from './chartTelemetry'

const bodyIds = Array.from(
  { length: 20 },
  (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
)

function body(entityId: string, time: number): RuntimeBodyState {
  return {
    entityId,
    position: { x: Math.sin(time), y: Math.cos(time) },
    angleRad: time,
    linearVelocity: { x: Math.cos(time), y: -Math.sin(time) },
    angularVelocityRad: 1,
    netForce: { x: 0, y: -9.80665 },
    acceleration: { x: 0, y: -9.80665 },
    translationalKineticEnergyJ: 0.5,
    rotationalKineticEnergyJ: 0.1,
    kineticEnergyJ: 0.6,
  }
}

function sample(time: number): RuntimeSample {
  return { simulationTime: time, bodies: bodyIds.map((entityId) => body(entityId, time)) }
}

const telemetry = new ChartTelemetryBuffer(60 * 300)
telemetry.append(Array.from({ length: 2000 }, (_, index) => sample(index / 60)))

const chart: ChartDefinition = {
  id: 'benchmark-chart',
  name: '图表性能基准',
  xAxis: { type: 'metric', metricId: 'time' },
  yAxis: { type: 'expression', expression: 'sqrt(x*x+y*y)+@A.x' },
  bindings: [{ alias: 'A', entityId: bodyIds[19]! }],
  series: bodyIds.slice(0, 12).map((entityId, index) => ({
    id: `series-${index}`,
    entityId,
    visible: true,
    color: '#58a6ff',
    lineStyle: 'solid',
    lineWidth: 2,
  })),
}

bench(
  '共享缓冲区追加 20 个物体的一个采样批次',
  () => {
    telemetry.append([sample(40)])
  },
  { time: 1000, warmupTime: 200 },
)

bench(
  '单个坐标系重算 12 条公式曲线 × 2000 显示采样',
  () => {
    evaluateChart(chart, telemetry, 2000)
  },
  { time: 1000, warmupTime: 200 },
)
