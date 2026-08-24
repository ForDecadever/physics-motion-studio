import type { EntityId } from '../../scene/model/types'
import type {
  GifHistorySnapshot,
  GifHistoryStatus,
  RuntimeBodyState,
  RuntimeConnectorState,
  RuntimeParticleSourceState,
} from '../worker/messages'

export const GIF_RECORDING_SAMPLE_RATE = 30
export const GIF_RECORDING_DURATION_SECONDS = 300
export const GIF_RECORDING_MAX_BODIES = 200
export const GIF_RECORDING_MAX_CONNECTOR_POINTS = 512
export const GIF_RECORDING_TELEMETRY_BUDGET_BYTES = 512 * 1024 * 1024
export const GIF_BODY_CHANNEL_COUNT = 7

const X = 0
const Y = 1
const ANGLE = 2
const VELOCITY_X = 3
const VELOCITY_Y = 4
const FORCE_X = 5
const FORCE_Y = 6

interface ParticleTelemetryFrame {
  sourceIndexes: Uint32Array
  ionIds: Uint32Array
  ts: Float32Array
  bornTimes: Float32Array
  continuous: Uint8Array
  values: Float32Array
  byteLength: number
}

function particleFrame(
  sources: readonly RuntimeParticleSourceState[],
  sourceIndex: ReadonlyMap<EntityId, number>,
): ParticleTelemetryFrame {
  let count = 0
  for (const source of sources) count += source.ions.length
  const sourceIndexes = new Uint32Array(count)
  const ionIds = new Uint32Array(count)
  const ts = new Float32Array(count)
  const bornTimes = new Float32Array(count)
  const continuous = new Uint8Array(count)
  const values = new Float32Array(count * 2)
  let index = 0
  for (const source of sources) {
    const runtimeSourceIndex = sourceIndex.get(source.entityId) ?? 0
    for (const ion of source.ions) {
      sourceIndexes[index] = runtimeSourceIndex
      ionIds[index] = ion.id
      ts[index] = ion.t
      bornTimes[index] = ion.bornAt
      continuous[index] = ion.continuous ? 1 : 0
      values[index * 2] = ion.position.x
      values[index * 2 + 1] = ion.position.y
      index += 1
    }
  }
  return {
    sourceIndexes,
    ionIds,
    ts,
    bornTimes,
    continuous,
    values,
    byteLength:
      sourceIndexes.byteLength +
      ionIds.byteLength +
      ts.byteLength +
      bornTimes.byteLength +
      continuous.byteLength +
      values.byteLength,
  }
}

export class GifTelemetryBuffer {
  readonly bodyIds: EntityId[]
  readonly connectorIds: EntityId[]
  readonly particleSourceIds: EntityId[]
  readonly capacity: number
  readonly status: GifHistoryStatus

  private readonly bodyIndex = new Map<EntityId, number>()
  private readonly connectorIndex = new Map<EntityId, number>()
  private readonly particleSourceIndex = new Map<EntityId, number>()
  private readonly connectorPointOffsets: Uint32Array
  private readonly times: Float32Array | null
  private readonly values: Float32Array | null
  private readonly connectorValues: Float32Array | null
  private readonly particleFrames: Array<ParticleTelemetryFrame | null>
  private startIndex = 0
  private sampleCount = 0
  private particleAllocatedBytes = 0
  private historyTruncated = false

  constructor(
    bodyIds: readonly EntityId[],
    connectors: readonly RuntimeConnectorState[] = [],
    particleSources: readonly RuntimeParticleSourceState[] = [],
    private readonly telemetryBudgetBytes = GIF_RECORDING_TELEMETRY_BUDGET_BYTES,
  ) {
    this.bodyIds = [...bodyIds]
    this.connectorIds = connectors.map((connector) => connector.entityId)
    this.particleSourceIds = particleSources.map((source) => source.entityId)
    this.capacity = GIF_RECORDING_SAMPLE_RATE * GIF_RECORDING_DURATION_SECONDS
    this.particleFrames = Array.from({ length: this.capacity }, () => null)
    this.connectorPointOffsets = new Uint32Array(connectors.length + 1)
    for (const [index, connector] of connectors.entries()) {
      this.connectorIndex.set(connector.entityId, index)
      this.connectorPointOffsets[index + 1] =
        this.connectorPointOffsets[index]! + connector.points.length
    }
    for (const [index, entityId] of this.particleSourceIds.entries()) {
      this.particleSourceIndex.set(entityId, index)
    }
    const connectorPointCount =
      this.connectorPointOffsets[this.connectorPointOffsets.length - 1] ?? 0

    if (bodyIds.length > GIF_RECORDING_MAX_BODIES) {
      this.times = null
      this.values = null
      this.connectorValues = null
      this.status = {
        kind: 'blocked',
        reason: 'body-limit',
        bodyCount: bodyIds.length,
        maxBodies: GIF_RECORDING_MAX_BODIES,
      }
      return
    }
    if (connectorPointCount > GIF_RECORDING_MAX_CONNECTOR_POINTS) {
      this.times = null
      this.values = null
      this.connectorValues = null
      this.status = {
        kind: 'blocked',
        reason: 'connector-point-limit',
        pointCount: connectorPointCount,
        maxPoints: GIF_RECORDING_MAX_CONNECTOR_POINTS,
      }
      return
    }

    for (const [index, entityId] of this.bodyIds.entries()) this.bodyIndex.set(entityId, index)
    this.times = new Float32Array(this.capacity)
    this.values = new Float32Array(this.capacity * this.bodyIds.length * GIF_BODY_CHANNEL_COUNT)
    this.connectorValues = new Float32Array(this.capacity * connectorPointCount * 2)
    this.status = {
      kind: 'ready',
      bodyCount: bodyIds.length,
      maxBodies: GIF_RECORDING_MAX_BODIES,
      sampleCount: 0,
      startTime: 0,
      endTime: 0,
      telemetryBudgetBytes: this.telemetryBudgetBytes,
      allocatedBytes: this.allocatedBytes,
      historyTruncated: false,
    }
  }

  get length(): number {
    return this.sampleCount
  }

  private get fixedAllocatedBytes(): number {
    return (
      this.connectorPointOffsets.byteLength +
      (this.times?.byteLength ?? 0) +
      (this.values?.byteLength ?? 0) +
      (this.connectorValues?.byteLength ?? 0)
    )
  }

  get allocatedBytes(): number {
    return this.fixedAllocatedBytes + this.particleAllocatedBytes
  }

  clear(): void {
    this.startIndex = 0
    this.sampleCount = 0
    this.particleAllocatedBytes = 0
    this.historyTruncated = false
    this.times?.fill(0)
    this.particleFrames.fill(null)
  }

  private evictOldest(markTruncated: boolean): void {
    if (this.sampleCount === 0) return
    const frame = this.particleFrames[this.startIndex]
    if (frame) this.particleAllocatedBytes -= frame.byteLength
    this.particleFrames[this.startIndex] = null
    this.startIndex = (this.startIndex + 1) % this.capacity
    this.sampleCount -= 1
    if (markTruncated) this.historyTruncated = true
  }

  append(
    simulationTime: number,
    bodies: readonly RuntimeBodyState[],
    connectors: readonly RuntimeConnectorState[] = [],
    particleSources: readonly RuntimeParticleSourceState[] = [],
  ): boolean {
    if (!this.times || !this.values || !this.connectorValues || !Number.isFinite(simulationTime)) {
      return false
    }

    const particles = particleFrame(particleSources, this.particleSourceIndex)
    if (this.sampleCount === this.capacity) this.evictOldest(false)
    while (
      this.sampleCount > 0 &&
      this.allocatedBytes + particles.byteLength > this.telemetryBudgetBytes
    ) {
      this.evictOldest(true)
    }

    const writeIndex = (this.startIndex + this.sampleCount) % this.capacity
    const bodyStride = this.bodyIds.length * GIF_BODY_CHANNEL_COUNT
    const frameOffset = writeIndex * bodyStride
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

    const connectorPointCount =
      this.connectorPointOffsets[this.connectorPointOffsets.length - 1] ?? 0
    const connectorStride = connectorPointCount * 2
    const connectorFrameOffset = writeIndex * connectorStride
    this.connectorValues.fill(
      Number.NaN,
      connectorFrameOffset,
      connectorFrameOffset + connectorStride,
    )
    for (const connector of connectors) {
      const connectorIndex = this.connectorIndex.get(connector.entityId)
      if (connectorIndex === undefined) continue
      const firstPoint = this.connectorPointOffsets[connectorIndex]!
      const expectedPointCount = this.connectorPointOffsets[connectorIndex + 1]! - firstPoint
      if (connector.points.length !== expectedPointCount) continue
      for (const [pointIndex, point] of connector.points.entries()) {
        const offset = connectorFrameOffset + (firstPoint + pointIndex) * 2
        this.connectorValues[offset] = point.x
        this.connectorValues[offset + 1] = point.y
      }
    }

    this.particleFrames[writeIndex] = particles
    this.particleAllocatedBytes += particles.byteLength
    this.times[writeIndex] = simulationTime
    this.sampleCount += 1
    return true
  }

  getStatus(): GifHistoryStatus {
    if (this.status.kind === 'blocked') return this.status
    const lastIndex = (this.startIndex + this.sampleCount - 1 + this.capacity) % this.capacity
    return {
      ...this.status,
      sampleCount: this.sampleCount,
      startTime: this.sampleCount > 0 && this.times ? this.times[this.startIndex]! : 0,
      endTime: this.sampleCount > 0 && this.times ? this.times[lastIndex]! : 0,
      allocatedBytes: this.allocatedBytes,
      historyTruncated: this.historyTruncated,
    }
  }

  snapshot(requestId: number): GifHistorySnapshot {
    const status = this.getStatus()
    if (!this.times || !this.values || !this.connectorValues || status.kind === 'blocked') {
      return {
        requestId,
        status,
        sampleRate: GIF_RECORDING_SAMPLE_RATE,
        bodyIds: [...this.bodyIds],
        times: new Float32Array(),
        values: new Float32Array(),
        connectorIds: [...this.connectorIds],
        connectorPointOffsets: this.connectorPointOffsets.slice(),
        connectorValues: new Float32Array(),
        particleSourceIds: [...this.particleSourceIds],
        particleFrameOffsets: new Uint32Array([0]),
        particleSourceIndexes: new Uint32Array(),
        particleIonIds: new Uint32Array(),
        particleIonTs: new Float32Array(),
        particleIonBornTimes: new Float32Array(),
        particleIonContinuous: new Uint8Array(),
        particleValues: new Float32Array(),
      }
    }

    const times = new Float32Array(this.sampleCount)
    const bodyStride = this.bodyIds.length * GIF_BODY_CHANNEL_COUNT
    const values = new Float32Array(this.sampleCount * bodyStride)
    const connectorPointCount =
      this.connectorPointOffsets[this.connectorPointOffsets.length - 1] ?? 0
    const connectorStride = connectorPointCount * 2
    const connectorValues = new Float32Array(this.sampleCount * connectorStride)
    const particleFrameOffsets = new Uint32Array(this.sampleCount + 1)
    for (let targetIndex = 0; targetIndex < this.sampleCount; targetIndex += 1) {
      const sourceIndex = (this.startIndex + targetIndex) % this.capacity
      const frame = this.particleFrames[sourceIndex]
      particleFrameOffsets[targetIndex + 1] =
        particleFrameOffsets[targetIndex]! + (frame?.ionIds.length ?? 0)
    }
    const particleCount = particleFrameOffsets[this.sampleCount] ?? 0
    const particleSourceIndexes = new Uint32Array(particleCount)
    const particleIonIds = new Uint32Array(particleCount)
    const particleIonTs = new Float32Array(particleCount)
    const particleIonBornTimes = new Float32Array(particleCount)
    const particleIonContinuous = new Uint8Array(particleCount)
    const particleValues = new Float32Array(particleCount * 2)

    for (let targetIndex = 0; targetIndex < this.sampleCount; targetIndex += 1) {
      const sourceIndex = (this.startIndex + targetIndex) % this.capacity
      times[targetIndex] = this.times[sourceIndex]!
      const sourceOffset = sourceIndex * bodyStride
      values.set(
        this.values.subarray(sourceOffset, sourceOffset + bodyStride),
        targetIndex * bodyStride,
      )
      const connectorSourceOffset = sourceIndex * connectorStride
      connectorValues.set(
        this.connectorValues.subarray(
          connectorSourceOffset,
          connectorSourceOffset + connectorStride,
        ),
        targetIndex * connectorStride,
      )
      const particleOffset = particleFrameOffsets[targetIndex]!
      const frame = this.particleFrames[sourceIndex]
      if (!frame) continue
      particleSourceIndexes.set(frame.sourceIndexes, particleOffset)
      particleIonIds.set(frame.ionIds, particleOffset)
      particleIonTs.set(frame.ts, particleOffset)
      particleIonBornTimes.set(frame.bornTimes, particleOffset)
      particleIonContinuous.set(frame.continuous, particleOffset)
      particleValues.set(frame.values, particleOffset * 2)
    }

    return {
      requestId,
      status,
      sampleRate: GIF_RECORDING_SAMPLE_RATE,
      bodyIds: [...this.bodyIds],
      times,
      values,
      connectorIds: [...this.connectorIds],
      connectorPointOffsets: this.connectorPointOffsets.slice(),
      connectorValues,
      particleSourceIds: [...this.particleSourceIds],
      particleFrameOffsets,
      particleSourceIndexes,
      particleIonIds,
      particleIonTs,
      particleIonBornTimes,
      particleIonContinuous,
      particleValues,
    }
  }
}
