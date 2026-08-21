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
export const GIF_RECORDING_MAX_PARTICLE_IONS = 512
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
  readonly connectorIds: EntityId[]
  readonly capacity: number
  readonly status: GifHistoryStatus

  private readonly bodyIndex = new Map<EntityId, number>()
  private readonly connectorIndex = new Map<EntityId, number>()
  private readonly connectorPointOffsets: Uint32Array
  private readonly times: Float32Array | null
  private readonly values: Float32Array | null
  private readonly connectorValues: Float32Array | null
  private readonly particleIonCount: number
  private readonly particleIonTs: Float32Array | null
  private readonly particleValues: Float32Array | null
  private writeIndex = 0
  private sampleCount = 0

  constructor(
    bodyIds: readonly EntityId[],
    connectors: readonly RuntimeConnectorState[] = [],
    particleSources: readonly RuntimeParticleSourceState[] = [],
  ) {
    this.bodyIds = [...bodyIds]
    this.connectorIds = connectors.map((connector) => connector.entityId)
    this.capacity = GIF_RECORDING_SAMPLE_RATE * GIF_RECORDING_DURATION_SECONDS
    this.connectorPointOffsets = new Uint32Array(connectors.length + 1)
    for (const [index, connector] of connectors.entries()) {
      this.connectorIndex.set(connector.entityId, index)
      this.connectorPointOffsets[index + 1] =
        this.connectorPointOffsets[index]! + connector.points.length
    }
    const connectorPointCount =
      this.connectorPointOffsets[this.connectorPointOffsets.length - 1] ?? 0

    const particleIons = particleSources.flatMap((source) => source.ions)
    this.particleIonCount = particleIons.length
    this.particleIonTs = new Float32Array(particleIons.map((ion) => ion.t))

    if (bodyIds.length > GIF_RECORDING_MAX_BODIES) {
      this.times = null
      this.values = null
      this.connectorValues = null
      this.particleValues = null
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
      this.particleValues = null
      this.status = {
        kind: 'blocked',
        reason: 'connector-point-limit',
        pointCount: connectorPointCount,
        maxPoints: GIF_RECORDING_MAX_CONNECTOR_POINTS,
      }
      return
    }

    if (this.particleIonCount > GIF_RECORDING_MAX_PARTICLE_IONS) {
      this.times = null
      this.values = null
      this.connectorValues = null
      this.particleValues = null
      this.status = {
        kind: 'blocked',
        reason: 'particle-ion-limit',
        ionCount: this.particleIonCount,
        maxIons: GIF_RECORDING_MAX_PARTICLE_IONS,
      }
      return
    }

    for (const [index, entityId] of this.bodyIds.entries()) {
      this.bodyIndex.set(entityId, index)
    }
    this.times = new Float32Array(this.capacity)
    this.values = new Float32Array(this.capacity * this.bodyIds.length * GIF_BODY_CHANNEL_COUNT)
    this.connectorValues = new Float32Array(this.capacity * connectorPointCount * 2)
    this.particleValues = new Float32Array(this.capacity * this.particleIonCount * 2)
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

  append(
    simulationTime: number,
    bodies: readonly RuntimeBodyState[],
    connectors: readonly RuntimeConnectorState[] = [],
    particleSources: readonly RuntimeParticleSourceState[] = [],
  ): boolean {
    if (
      !this.times ||
      !this.values ||
      !this.connectorValues ||
      !this.particleValues ||
      !Number.isFinite(simulationTime)
    ) {
      return false
    }

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

    const connectorPointCount =
      this.connectorPointOffsets[this.connectorPointOffsets.length - 1] ?? 0
    const connectorStride = connectorPointCount * 2
    const connectorFrameOffset = this.writeIndex * connectorStride
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

    const particleStride = this.particleIonCount * 2
    const particleFrameOffset = this.writeIndex * particleStride
    this.particleValues.fill(Number.NaN, particleFrameOffset, particleFrameOffset + particleStride)
    let particleIonIndex = 0
    for (const source of particleSources) {
      for (const ion of source.ions) {
        const offset = particleFrameOffset + particleIonIndex * 2
        this.particleValues[offset] = ion.position.x
        this.particleValues[offset + 1] = ion.position.y
        particleIonIndex += 1
      }
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
    if (
      !this.times ||
      !this.values ||
      !this.connectorValues ||
      !this.particleValues ||
      status.kind === 'blocked'
    ) {
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
        particleIonCount: this.particleIonCount,
        particleIonTs: (this.particleIonTs ?? new Float32Array()).slice(),
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
    const particleStride = this.particleIonCount * 2
    const particleValues = new Float32Array(this.sampleCount * particleStride)
    const oldest = this.sampleCount < this.capacity ? 0 : this.writeIndex

    for (let targetIndex = 0; targetIndex < this.sampleCount; targetIndex += 1) {
      const sourceIndex = (oldest + targetIndex) % this.capacity
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
      const particleSourceOffset = sourceIndex * particleStride
      particleValues.set(
        this.particleValues.subarray(particleSourceOffset, particleSourceOffset + particleStride),
        targetIndex * particleStride,
      )
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
      particleIonCount: this.particleIonCount,
      particleIonTs: this.particleIonTs!.slice(),
      particleValues,
    }
  }
}
