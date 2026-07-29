import type { RuntimeBodyState, RuntimeSample } from '../../physics/worker/messages'
import { MAX_RECORDED_CHART_BODIES } from '../../scene/model/chartDefaults'

const BODY_VALUE_COUNT = 13

interface BodyChannel {
  present: Uint8Array
  values: Float64Array
}

export interface ChartTelemetrySample {
  time: number
  body: (entityId: string) => RuntimeBodyState | undefined
}

export class ChartTelemetryBuffer {
  private times: Float64Array
  private channels = new Map<string, BodyChannel>()
  private start = 0
  private size = 0
  private limitReached = false

  constructor(private capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity))
    this.times = new Float64Array(this.capacity)
  }

  get length(): number {
    return this.size
  }

  get reachedLimit(): boolean {
    return this.limitReached
  }

  get allocatedBytes(): number {
    return (
      this.times.byteLength +
      [...this.channels.values()].reduce(
        (total, channel) => total + channel.present.byteLength + channel.values.byteLength,
        0,
      )
    )
  }

  clear(): void {
    this.start = 0
    this.size = 0
    this.limitReached = false
    this.channels.clear()
  }

  append(samples: readonly RuntimeSample[]): void {
    for (const sample of samples) this.appendOne(sample)
  }

  forEach(callback: (sample: ChartTelemetrySample, logicalIndex: number) => void): void {
    this.forEachSelected(this.size, callback)
  }

  forEachSelected(
    maximumSamples: number,
    callback: (sample: ChartTelemetrySample, logicalIndex: number) => void,
  ): void {
    if (this.size === 0) return
    const target = Math.max(2, Math.floor(maximumSamples))
    const step = this.size > target ? (this.size - 1) / (target - 1) : 1
    let previousLogicalIndex = -1
    const visits = this.size > target ? target : this.size
    for (let visit = 0; visit < visits; visit += 1) {
      const logicalIndex =
        visit === visits - 1 ? this.size - 1 : Math.min(this.size - 1, Math.round(visit * step))
      if (logicalIndex === previousLogicalIndex) continue
      previousLogicalIndex = logicalIndex
      const physicalIndex = (this.start + logicalIndex) % this.capacity
      callback(
        {
          time: this.times[physicalIndex]!,
          body: (entityId) => this.readBody(entityId, physicalIndex),
        },
        logicalIndex,
      )
    }
  }

  private appendOne(sample: RuntimeSample): void {
    const lastIndex = this.size > 0 ? (this.start + this.size - 1) % this.capacity : -1
    const lastTime = lastIndex >= 0 ? this.times[lastIndex]! : -Infinity
    if (sample.simulationTime < lastTime - 1e-9) this.clear()

    const duplicateIndex =
      this.size > 0 && Math.abs(sample.simulationTime - lastTime) <= 1e-9 ? lastIndex : -1
    let physicalIndex: number
    if (duplicateIndex >= 0) {
      physicalIndex = duplicateIndex
    } else if (this.size < this.capacity) {
      physicalIndex = (this.start + this.size) % this.capacity
      this.size += 1
    } else {
      physicalIndex = this.start
      this.start = (this.start + 1) % this.capacity
      this.limitReached = true
    }

    this.times[physicalIndex] = sample.simulationTime
    for (const channel of this.channels.values()) channel.present[physicalIndex] = 0
    for (const body of sample.bodies) {
      const channel = this.channelFor(body.entityId)
      if (!channel) continue
      channel.present[physicalIndex] = 1
      writeBody(channel.values, physicalIndex * BODY_VALUE_COUNT, body)
    }
  }

  private channelFor(entityId: string): BodyChannel | undefined {
    const existing = this.channels.get(entityId)
    if (existing) return existing
    if (this.channels.size >= MAX_RECORDED_CHART_BODIES) return undefined
    const channel = {
      present: new Uint8Array(this.capacity),
      values: new Float64Array(this.capacity * BODY_VALUE_COUNT),
    }
    this.channels.set(entityId, channel)
    return channel
  }

  private readBody(entityId: string, physicalIndex: number): RuntimeBodyState | undefined {
    const channel = this.channels.get(entityId)
    if (!channel || channel.present[physicalIndex] === 0) return undefined
    const offset = physicalIndex * BODY_VALUE_COUNT
    const values = channel.values
    return {
      entityId,
      position: { x: values[offset]!, y: values[offset + 1]! },
      angleRad: values[offset + 2]!,
      linearVelocity: { x: values[offset + 3]!, y: values[offset + 4]! },
      angularVelocityRad: values[offset + 5]!,
      netForce: { x: values[offset + 6]!, y: values[offset + 7]! },
      acceleration: { x: values[offset + 8]!, y: values[offset + 9]! },
      translationalKineticEnergyJ: values[offset + 10]!,
      rotationalKineticEnergyJ: values[offset + 11]!,
      kineticEnergyJ: values[offset + 12]!,
    }
  }
}

function writeBody(values: Float64Array, offset: number, body: RuntimeBodyState): void {
  values[offset] = body.position.x
  values[offset + 1] = body.position.y
  values[offset + 2] = body.angleRad
  values[offset + 3] = body.linearVelocity.x
  values[offset + 4] = body.linearVelocity.y
  values[offset + 5] = body.angularVelocityRad
  values[offset + 6] = body.netForce.x
  values[offset + 7] = body.netForce.y
  values[offset + 8] = body.acceleration.x
  values[offset + 9] = body.acceleration.y
  values[offset + 10] = body.translationalKineticEnergyJ
  values[offset + 11] = body.rotationalKineticEnergyJ
  values[offset + 12] = body.kineticEnergyJ
}
