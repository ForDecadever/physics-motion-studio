import type { EntityId, Vec2 } from '../../scene/model/types'
import type { RuntimeBodyState, RuntimeParticleSourceState } from '../worker/messages'

const DEFAULT_CHUNK_SIZE = 64

export const MAX_BODY_TRAJECTORY_POINTS = 1800
export const MAX_PARTICLE_TRAJECTORY_POINTS = 512
export const MIN_PARTICLE_TRAJECTORY_POINTS = 2
export const MAX_PARTICLE_TRAJECTORY_TOTAL_POINTS = 65_536
export const MAX_TRACKED_PARTICLE_IONS = Math.floor(
  MAX_PARTICLE_TRAJECTORY_TOTAL_POINTS / MIN_PARTICLE_TRAJECTORY_POINTS,
)
export const TRAJECTORY_SIMPLIFICATION_ERROR_M = 0.00025

interface TrajectoryChunk {
  x: Float64Array
  y: Float64Array
}

export interface ReadonlyTrajectory {
  readonly length: number
  readonly capacity: number
  readonly allocatedBytes: number
  xAt(index: number): number | undefined
  yAt(index: number): number | undefined
}

export interface RuntimeParticleTrajectory {
  t: number
  points: ReadonlyTrajectory
}

/**
 * A fixed-capacity, chunked circular path. Appending never copies older points.
 * Nearly straight samples replace the newest point while keeping the measured
 * world-space deviation below the configured tolerance.
 */
export class BoundedTrajectoryBuffer implements ReadonlyTrajectory {
  readonly capacity: number
  readonly allocatedBytes: number

  private readonly chunks: TrajectoryChunk[]
  private start = 0
  private size = 0

  constructor(
    capacity: number,
    private readonly simplificationErrorM = TRAJECTORY_SIMPLIFICATION_ERROR_M,
    private readonly chunkSize = DEFAULT_CHUNK_SIZE,
  ) {
    this.capacity = Math.max(2, Math.floor(capacity))
    const chunkCount = Math.ceil(this.capacity / this.chunkSize)
    this.chunks = Array.from({ length: chunkCount }, () => ({
      x: new Float64Array(this.chunkSize),
      y: new Float64Array(this.chunkSize),
    }))
    this.allocatedBytes = chunkCount * this.chunkSize * Float64Array.BYTES_PER_ELEMENT * 2
  }

  get length(): number {
    return this.size
  }

  clear(): void {
    this.start = 0
    this.size = 0
  }

  append(point: Vec2): boolean {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false

    const lastX = this.xAt(this.size - 1)
    const lastY = this.yAt(this.size - 1)
    if (lastX === point.x && lastY === point.y) return false

    if (this.size >= 2 && this.canReplaceNewest(point)) {
      this.writeLogical(this.size - 1, point)
      return true
    }

    if (this.size < this.capacity) {
      this.writeLogical(this.size, point)
      this.size += 1
    } else {
      this.start = (this.start + 1) % this.capacity
      this.writeLogical(this.size - 1, point)
    }
    return true
  }

  xAt(index: number): number | undefined {
    return this.read(index, 'x')
  }

  yAt(index: number): number | undefined {
    return this.read(index, 'y')
  }

  private canReplaceNewest(point: Vec2): boolean {
    const ax = this.xAt(this.size - 2)!
    const ay = this.yAt(this.size - 2)!
    const bx = this.xAt(this.size - 1)!
    const by = this.yAt(this.size - 1)!
    const dx = point.x - ax
    const dy = point.y - ay
    const lengthSquared = dx * dx + dy * dy
    if (lengthSquared <= Number.EPSILON) return false

    const projection = ((bx - ax) * dx + (by - ay) * dy) / lengthSquared
    if (projection < 0 || projection > 1) return false
    const forward = (bx - ax) * (point.x - bx) + (by - ay) * (point.y - by)
    if (forward < 0) return false
    const distance = Math.abs(dx * (ay - by) - (ax - bx) * dy) / Math.sqrt(lengthSquared)
    return distance <= this.simplificationErrorM
  }

  private read(index: number, axis: keyof TrajectoryChunk): number | undefined {
    if (index < 0 || index >= this.size) return undefined
    const physical = (this.start + index) % this.capacity
    const chunk = this.chunks[Math.floor(physical / this.chunkSize)]!
    return chunk[axis][physical % this.chunkSize]
  }

  private writeLogical(index: number, point: Vec2): void {
    const physical = (this.start + index) % this.capacity
    const chunk = this.chunks[Math.floor(physical / this.chunkSize)]!
    const offset = physical % this.chunkSize
    chunk.x[offset] = point.x
    chunk.y[offset] = point.y
  }
}

interface ParticleTrajectoryRecord {
  t: number
  points: BoundedTrajectoryBuffer
  view: RuntimeParticleTrajectory
}

export class RuntimeTrajectoryHistory {
  private readonly bodies = new Map<EntityId, BoundedTrajectoryBuffer>()
  private readonly particles = new Map<string, ParticleTrajectoryRecord>()
  private lastSimulationTime = -Infinity
  private particleCapacity = 0

  clear(): void {
    this.bodies.clear()
    this.particles.clear()
    this.lastSimulationTime = -Infinity
    this.particleCapacity = 0
  }

  append(
    simulationTime: number,
    bodies: readonly RuntimeBodyState[],
    particleSources: readonly RuntimeParticleSourceState[],
  ): {
    bodies: Record<EntityId, ReadonlyTrajectory>
    particles: RuntimeParticleTrajectory[]
  } {
    if (simulationTime < this.lastSimulationTime - Number.EPSILON) this.clear()
    this.lastSimulationTime = simulationTime

    const currentBodyIds = new Set(bodies.map((body) => body.entityId))
    for (const entityId of this.bodies.keys()) {
      if (!currentBodyIds.has(entityId)) this.bodies.delete(entityId)
    }
    for (const body of bodies) {
      let trajectory = this.bodies.get(body.entityId)
      if (!trajectory) {
        trajectory = new BoundedTrajectoryBuffer(MAX_BODY_TRAJECTORY_POINTS)
        this.bodies.set(body.entityId, trajectory)
      }
      trajectory.append(body.position)
    }

    const allIons = particleSources.flatMap((source) =>
      source.continuousEmission
        ? []
        : source.ions.map((ion) => ({ key: `${source.entityId}\u0000${ion.id}`, ion })),
    )
    const selectionStride = Math.max(1, Math.ceil(allIons.length / MAX_TRACKED_PARTICLE_IONS))
    const ions = allIons
      .filter((_, index) => index % selectionStride === 0)
      .slice(0, MAX_TRACKED_PARTICLE_IONS)
    const nextParticleCapacity = particleCapacityFor(ions.length)
    if (nextParticleCapacity !== this.particleCapacity) {
      this.particles.clear()
      this.particleCapacity = nextParticleCapacity
    }
    const currentParticleKeys = new Set(ions.map(({ key }) => key))
    for (const key of this.particles.keys()) {
      if (!currentParticleKeys.has(key)) this.particles.delete(key)
    }
    const particleViews = ions.map(({ key, ion }) => {
      let record = this.particles.get(key)
      if (!record) {
        const points = new BoundedTrajectoryBuffer(this.particleCapacity)
        record = { t: ion.t, points, view: { t: ion.t, points } }
        this.particles.set(key, record)
      }
      record.t = ion.t
      record.view.t = ion.t
      record.points.append(ion.position)
      return record.view
    })

    return {
      bodies: Object.fromEntries(this.bodies),
      particles: particleViews,
    }
  }

  get allocatedBytes(): number {
    let total = 0
    for (const trajectory of this.bodies.values()) total += trajectory.allocatedBytes
    for (const trajectory of this.particles.values()) total += trajectory.points.allocatedBytes
    return total
  }

  get pointCount(): number {
    let total = 0
    for (const trajectory of this.bodies.values()) total += trajectory.length
    for (const trajectory of this.particles.values()) total += trajectory.points.length
    return total
  }

  get pointCapacity(): number {
    let total = 0
    for (const trajectory of this.bodies.values()) total += trajectory.capacity
    for (const trajectory of this.particles.values()) total += trajectory.points.capacity
    return total
  }

  get particlePointCapacity(): number {
    let total = 0
    for (const trajectory of this.particles.values()) total += trajectory.points.capacity
    return total
  }
}

function particleCapacityFor(ionCount: number): number {
  if (ionCount === 0) return 0
  return Math.max(
    MIN_PARTICLE_TRAJECTORY_POINTS,
    Math.min(
      MAX_PARTICLE_TRAJECTORY_POINTS,
      Math.floor(MAX_PARTICLE_TRAJECTORY_TOTAL_POINTS / ionCount),
    ),
  )
}
