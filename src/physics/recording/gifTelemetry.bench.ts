import { bench } from 'vitest'

import type { RuntimeBodyState, RuntimeConnectorState } from '../worker/messages'
import { GifTelemetryBuffer } from './gifTelemetry'

const bodyIds = Array.from({ length: 200 }, (_, index) => `gif-body-${index}`)
const bodies: RuntimeBodyState[] = bodyIds.map((entityId, index) => ({
  entityId,
  position: { x: index, y: index * 0.5 },
  angleRad: index * 0.01,
  linearVelocity: { x: 1, y: -1 },
  angularVelocityRad: 0,
  netForce: { x: 0, y: -9.80665 },
  acceleration: { x: 0, y: -9.80665 },
  translationalKineticEnergyJ: 1,
  rotationalKineticEnergyJ: 0,
  kineticEnergyJ: 1,
}))
const connectors: RuntimeConnectorState[] = Array.from({ length: 8 }, (_, connectorIndex) => ({
  entityId: `gif-connector-${connectorIndex}`,
  points: Array.from({ length: 64 }, (_, pointIndex) => ({
    x: connectorIndex * 2 + pointIndex * 0.05,
    y: Math.sin(pointIndex * 0.1),
  })),
}))
const buffer = new GifTelemetryBuffer(bodyIds, connectors)

bench(
  'GIF 记录追加 200 个动态物体和 512 个连接器节点的一个 30 Hz 采样',
  () => {
    buffer.append(buffer.length / 30, bodies, connectors)
  },
  { time: 1000, warmupTime: 200 },
)
