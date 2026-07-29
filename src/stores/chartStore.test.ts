import { beforeEach, describe, expect, it } from 'vitest'

import { evaluateChart } from '../features/charts/chartSeries'
import type { RuntimeBodyState, RuntimeSample } from '../physics/worker/messages'
import type { ChartDefinition } from '../scene/model/types'
import { getChartTelemetryBuffer, useChartStore } from './chartStore'

const bodyId = '00000000-0000-4000-8000-000000000001'

function runtimeBody(
  entityId = bodyId,
  overrides: Partial<RuntimeBodyState> = {},
): RuntimeBodyState {
  return {
    entityId,
    position: { x: 1, y: 2 },
    angleRad: 0,
    linearVelocity: { x: 3, y: 4 },
    angularVelocityRad: 0,
    netForce: { x: 0, y: -19.6133 },
    acceleration: { x: 0, y: -9.80665 },
    translationalKineticEnergyJ: 25,
    rotationalKineticEnergyJ: 0,
    kineticEnergyJ: 25,
    ...overrides,
  }
}

function chart(yExpression = 'y'): ChartDefinition {
  return {
    id: 'chart',
    name: '测试坐标系',
    xAxis: { type: 'metric', metricId: 'time' },
    yAxis: { type: 'expression', expression: yExpression },
    bindings: [],
    series: [
      {
        id: 'series',
        entityId: bodyId,
        visible: true,
        color: '#58a6ff',
        lineStyle: 'solid',
        lineWidth: 2,
      },
    ],
  }
}

beforeEach(() => {
  useChartStore.getState().configureLimit(60, 300)
  useChartStore.getState().clearHistory()
})

describe('图表共享运行记录', () => {
  it('保存一次原始状态，并可用新公式立即重算旧记录', () => {
    const samples: RuntimeSample[] = [
      { simulationTime: 0, bodies: [runtimeBody()] },
      {
        simulationTime: 1 / 60,
        bodies: [runtimeBody(bodyId, { position: { x: 2, y: 3 } })],
      },
    ]
    useChartStore.getState().appendSamples(samples)

    const position = evaluateChart(chart('y'), getChartTelemetryBuffer())
    const combination = evaluateChart(chart('x+y'), getChartTelemetryBuffer())
    expect(position.series[0]?.points.map((point) => point.y)).toEqual([2, 3])
    expect(combination.series[0]?.points.map((point) => point.y)).toEqual([3, 5])
  })

  it('模拟时间回到零时开始一段新记录', () => {
    useChartStore.getState().appendSamples([{ simulationTime: 2, bodies: [runtimeBody()] }])
    useChartStore.getState().appendSamples([
      {
        simulationTime: 0,
        bodies: [runtimeBody(bodyId, { position: { x: 0, y: 5 } })],
      },
    ])
    const evaluated = evaluateChart(chart(), getChartTelemetryBuffer())
    expect(evaluated.series[0]?.points).toEqual([{ time: 0, x: 0, y: 5 }])
  })

  it('达到时长上限后只保留最新采样', () => {
    useChartStore.getState().configureLimit(2, 1)
    useChartStore.getState().appendSamples([
      { simulationTime: 0, bodies: [runtimeBody()] },
      { simulationTime: 0.5, bodies: [runtimeBody()] },
      { simulationTime: 1, bodies: [runtimeBody()] },
    ])
    expect(getChartTelemetryBuffer().length).toBe(2)
    expect(getChartTelemetryBuffer().reachedLimit).toBe(true)
  })

  it('后来加入的跨物体引用只从加入时刻产生有效值', () => {
    const referenceId = '00000000-0000-4000-8000-000000000002'
    useChartStore.getState().appendSamples([
      { simulationTime: 0, bodies: [runtimeBody()] },
      {
        simulationTime: 1,
        bodies: [runtimeBody(), runtimeBody(referenceId, { position: { x: 10, y: 0 } })],
      },
    ])
    const crossChart: ChartDefinition = {
      ...chart(),
      yAxis: { type: 'expression', expression: '@A.x-x' },
      bindings: [{ alias: 'A', entityId: referenceId }],
    }
    expect(evaluateChart(crossChart, getChartTelemetryBuffer()).series[0]?.points).toEqual([
      { time: 0, x: null, y: null },
      { time: 1, x: 1, y: 9 },
    ])
  })

  it('20 个物体的 300 秒紧凑缓冲区低于 50 MB', () => {
    useChartStore.getState().configureLimit(60, 300)
    useChartStore.getState().appendSamples([
      {
        simulationTime: 0,
        bodies: Array.from({ length: 20 }, (_, index) =>
          runtimeBody(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
        ),
      },
    ])
    expect(getChartTelemetryBuffer().allocatedBytes).toBeLessThan(50 * 1024 * 1024)
  })
})
