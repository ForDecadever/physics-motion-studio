import { beforeEach, describe, expect, it } from 'vitest'

import type { RuntimeBodyState, RuntimeSample } from '../physics/worker/messages'
import type { BodyEntity } from '../scene/model/types'
import { MAX_CHART_CURVES, useChartStore } from './chartStore'

const body: BodyEntity = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '测试小球',
  layerId: '00000000-0000-4000-8000-000000000002',
  visible: true,
  locked: false,
  simulationEnabled: true,
  kind: 'body',
  preset: 'ball',
  shape: { type: 'circle', radius: 0.5, collisionEnabled: true },
  transform: { position: { x: 0, y: 2 }, angleRad: 0 },
  massKg: 2,
  chargeC: 0,
  material: { friction: 0, restitution: 0 },
  initialVelocity: { x: 0, y: 0 },
  initialAngularVelocityRad: 0,
  rotationEnabled: true,
  continuousCollisionDetection: false,
}

function runtimeBody(overrides: Partial<RuntimeBodyState> = {}): RuntimeBodyState {
  return {
    entityId: body.id,
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

beforeEach(() => {
  useChartStore.getState().clearCurves()
})

describe('图表运行记录', () => {
  it('从同一个物理快照记录多项指标', () => {
    const store = useChartStore.getState()
    expect(store.addCurve(body, 'positionY')).toBe(true)
    expect(store.addCurve(body, 'kineticEnergy')).toBe(true)
    expect(store.addCurve(body, 'positionY')).toBe(false)

    const samples: RuntimeSample[] = [{ simulationTime: 1 / 60, bodies: [runtimeBody()] }]
    useChartStore.getState().appendSamples(samples)

    const next = useChartStore.getState()
    expect(next.series[`${body.id}:positionY`]).toEqual([{ time: 1 / 60, value: 2 }])
    expect(next.series[`${body.id}:kineticEnergy`]).toEqual([{ time: 1 / 60, value: 25 }])
  })

  it('最多允许十条曲线，并在时间回到零时开始新记录', () => {
    const metrics = [
      'positionX',
      'positionY',
      'velocityX',
      'velocityY',
      'speed',
      'acceleration',
      'angle',
      'angularVelocity',
      'netForce',
      'kineticEnergy',
      'translationalKineticEnergy',
    ] as const
    for (const metric of metrics) useChartStore.getState().addCurve(body, metric)
    expect(useChartStore.getState().curves).toHaveLength(MAX_CHART_CURVES)

    useChartStore
      .getState()
      .appendSamples([{ simulationTime: 2, bodies: [runtimeBody({ position: { x: 0, y: 1 } })] }])
    useChartStore
      .getState()
      .appendSamples([{ simulationTime: 0, bodies: [runtimeBody({ position: { x: 0, y: 2 } })] }])
    expect(useChartStore.getState().series[`${body.id}:positionY`]).toEqual([{ time: 0, value: 2 }])
  })
})
