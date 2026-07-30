import type { EntityId } from '../../scene/model/types'
import type { GifHistorySnapshot, GifHistoryStatus, RuntimeBodyState } from '../worker/messages'

export const GIF_RECORDING_SAMPLE_RATE = 30
export const GIF_RECORDING_DURATION_SECONDS = 300
export const GIF_RECORDING_MAX_BODIES = 200
export const GIF_BODY_CHANNEL_COUNT = 7

const X = 0
const Y = 1
const ANGLE = 2
const VELOCITY_X = 3
const VELOCITY_Y = 4
const FORCE_X = 5
const FORCE_Y = 6

export class GifTelemetryBuffer {
  readonly bodyIds: EntityId[]
  readonly capacity: number
  readonly status: GifHistoryStatus

  private readonly bodyIndex = new Map<EntityId, number>()
  private readonly times: Float32Array | null
  private readonly values: Float32Array | null
  private writeIndex = 0
  private sampleCount = 0

  constructor(bodyIds: readonly EntityId[]) {
    this.bodyIds = [...bodyIds]
    this.capacity = GIF_RECORDING_SAMPLE_RATE * GIF_RECORDING_DURATION_SECONDS

    if (bodyIds.length > GIF_RECORDING_MAX_BODIES) {
      this.times = null
      this.values = null
      this.status = {
        kind: 'blocked',
        reason: 'body-limit',
        bodyCount: bodyIds.length,
        maxBodies: GIF_RECORDING_MAX_BODIES,
      }
      return
    }

    for (const [index, entityId] of this.bodyIds.entries()) {
      this.bodyIndex.set(entityId, index)
    }
    this.times = new Float32Array(this.capacity)
    this.values = new Float32Array(this.capacity * this.bodyIds.length * GIF_BODY_CHANNEL_COUNT)
    this.status = {
      kind: 'ready',
      bodyCount: bodyIds.length,
      maxBodies: GIF_RECORDING_MAX_BODIES,
      sampleCount: 0,
      startTime: 0,
      endTime: 0,
    }
  }

  get length(): number {
    return this.sampleCount
  }

  clear(): void {
    this.writeIndex = 0
    this.sampleCount = 0
    this.times?.fill(0)
  }

  append(simulationTime: number, bodies: readonly RuntimeBodyState[]): boolean {
    if (!this.times || !this.values || !Number.isFinite(simulationTime)) return false

    const bodyStride = this.bodyIds.length * GIF_BODY_CHANNEL_COUNT
    const frameOffset = this.writeIndex * bodyStride
    this.values.fill(Number.NaN, frameOffset, frameOffset + bodyStride)

    for (const body of bodies) {
      const bodyIndex = this.bodyIndex.get(body.entityId)
      if (bodyIndex === undefined) continue
      const offset = frameOffset + bodyIndex * GIF_BODY_CHANNEL_COUNT
      this.values[offset + X] = body.position.x
      this.values[offset + Y] = body.position.y
      this.values[offset + ANGLE] = body.angleRad
      this.values[offset + VELOCITY_X] = body.linearVelocity.x
      this.values[offset + VELOCITY_Y] = body.linearVelocity.y
      this.values[offset + FORCE_X] = body.netForce.x
      this.values[offset + FORCE_Y] = body.netForce.y
    }

    this.times[this.writeIndex] = simulationTime
    this.writeIndex = (this.writeIndex + 1) % this.capacity
    this.sampleCount = Math.min(this.sampleCount + 1, this.capacity)
    return true
  }

  getStatus(): GifHistoryStatus {
    if (this.status.kind === 'blocked') return this.status
    const firstIndex =
      this.sampleCount < this.capacity ? 0 : (this.writeIndex + this.capacity) % this.capacity
    const lastIndex = (this.writeIndex - 1 + this.capacity) % this.capacity
    return {
      ...this.status,
      sampleCount: this.sampleCount,
      startTime: this.sampleCount > 0 && this.times ? this.times[firstIndex]! : 0,
      endTime: this.sampleCount > 0 && this.times ? this.times[lastIndex]! : 0,
    }
  }

  snapshot(requestId: number): GifHistorySnapshot {
    const status = this.getStatus()
    if (!this.times || !this.values || status.kind === 'blocked') {
      return {
        requestId,
        status,
        sampleRate: GIF_RECORDING_SAMPLE_RATE,
        bodyIds: [...this.bodyIds],
        times: new Float32Array(),
        values: new Float32Array(),
      }
    }

    const times = new Float32Array(this.sampleCount)
    const bodyStride = this.bodyIds.length * GIF_BODY_CHANNEL_COUNT
    const values = new Float32Array(this.sampleCount * bodyStride)
    const oldest = this.sampleCount < this.capacity ? 0 : this.writeIndex

    for (let targetIndex = 0; targetIndex < this.sampleCount; targetIndex += 1) {
      const sourceIndex = (oldest + targetIndex) % this.capacity
      times[targetIndex] = this.times[sourceIndex]!
      const sourceOffset = sourceIndex * bodyStride
      values.set(
        this.values.subarray(sourceOffset, sourceOffset + bodyStride),
        targetIndex * bodyStride,
      )
    }

    return {
      requestId,
      status,
      sampleRate: GIF_RECORDING_SAMPLE_RATE,
      bodyIds: [...this.bodyIds],
      times,
      values,
    }
  }
}
