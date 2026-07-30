import { bench } from 'vitest'

import type { RuntimeBodyState } from '../worker/messages'
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
const buffer = new GifTelemetryBuffer(bodyIds)

bench(
  'GIF 记录追加 200 个动态物体的一个 30 Hz 采样',
  () => {
    buffer.append(buffer.length / 30, bodies)
  },
  { time: 1000, warmupTime: 200 },
)
