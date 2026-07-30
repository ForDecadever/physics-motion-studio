import { describe, expect, it } from 'vitest'

import type { RuntimeBodyState } from '../worker/messages'
import {
  GIF_BODY_CHANNEL_COUNT,
  GIF_RECORDING_MAX_BODIES,
  GifTelemetryBuffer,
} from './gifTelemetry'

function runtimeBody(entityId: string, value: number): RuntimeBodyState {
  return {
    entityId,
    position: { x: value, y: value + 1 },
    angleRad: value + 2,
    linearVelocity: { x: value + 3, y: value + 4 },
    angularVelocityRad: 0,
    netForce: { x: value + 5, y: value + 6 },
    acceleration: { x: 0, y: 0 },
    translationalKineticEnergyJ: 0,
    rotationalKineticEnergyJ: 0,
    kineticEnergyJ: 0,
  }
}

describe('GifTelemetryBuffer', () => {
  it('stores compact chronological body samples', () => {
    const buffer = new GifTelemetryBuffer(['a', 'b'])
    buffer.append(0, [runtimeBody('a', 1), runtimeBody('b', 10)])
    buffer.append(1 / 30, [runtimeBody('a', 2), runtimeBody('b', 20)])

    const snapshot = buffer.snapshot(4)
    expect(snapshot.requestId).toBe(4)
    expect(snapshot.status).toMatchObject({ kind: 'ready', sampleCount: 2 })
    expect([...snapshot.times]).toEqual([0, expect.closeTo(1 / 30)])
    expect(snapshot.values).toHaveLength(2 * 2 * GIF_BODY_CHANNEL_COUNT)
    expect([...snapshot.values.slice(0, 7)]).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect([...snapshot.values.slice(21, 28)]).toEqual([20, 21, 22, 23, 24, 25, 26])
  })

  it('marks a missing body as a discontinuity', () => {
    const buffer = new GifTelemetryBuffer(['a', 'b'])
    buffer.append(0, [runtimeBody('a', 1)])

    const snapshot = buffer.snapshot(1)
    expect(Number.isNaN(snapshot.values[GIF_BODY_CHANNEL_COUNT])).toBe(true)
  })

  it('keeps only the newest 300 seconds in chronological order', () => {
    const buffer = new GifTelemetryBuffer([])
    for (let index = 0; index <= buffer.capacity; index += 1) {
      buffer.append(index / 30, [])
    }

    const snapshot = buffer.snapshot(2)
    expect(snapshot.times).toHaveLength(buffer.capacity)
    expect(snapshot.times[0]).toBeCloseTo(1 / 30)
    expect(snapshot.times.at(-1)).toBeCloseTo(buffer.capacity / 30)
  })

  it('blocks recording instead of silently dropping bodies above the limit', () => {
    const ids = Array.from({ length: GIF_RECORDING_MAX_BODIES + 1 }, (_, index) => `b-${index}`)
    const buffer = new GifTelemetryBuffer(ids)
    expect(buffer.append(0, [])).toBe(false)
    expect(buffer.getStatus()).toEqual({
      kind: 'blocked',
      reason: 'body-limit',
      bodyCount: GIF_RECORDING_MAX_BODIES + 1,
      maxBodies: GIF_RECORDING_MAX_BODIES,
    })
  })

  it('clears old samples and can immediately start a new history', () => {
    const buffer = new GifTelemetryBuffer(['a'])
    buffer.append(0, [runtimeBody('a', 1)])
    buffer.append(1 / 30, [runtimeBody('a', 2)])

    buffer.clear()
    expect(buffer.getStatus()).toMatchObject({ kind: 'ready', sampleCount: 0 })

    buffer.append(5, [runtimeBody('a', 3)])
    const snapshot = buffer.snapshot(3)
    expect([...snapshot.times]).toEqual([5])
    expect(snapshot.values[0]).toBe(3)
  })
})
