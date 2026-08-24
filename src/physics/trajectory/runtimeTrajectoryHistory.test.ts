import { describe, expect, it } from 'vitest'

import type { RuntimeBodyState, RuntimeParticleSourceState } from '../worker/messages'
import {
  BoundedTrajectoryBuffer,
  MAX_PARTICLE_TRAJECTORY_TOTAL_POINTS,
  RuntimeTrajectoryHistory,
} from './runtimeTrajectoryHistory'

function body(entityId: string, x: number, y: number): RuntimeBodyState {
  return {
    entityId,
    position: { x, y },
    angleRad: 0,
    linearVelocity: { x: 0, y: 0 },
    angularVelocityRad: 0,
    netForce: { x: 0, y: 0 },
    acceleration: { x: 0, y: 0 },
    translationalKineticEnergyJ: 0,
    rotationalKineticEnergyJ: 0,
    kineticEnergyJ: 0,
  }
}

function particleSource(count: number, x: number): RuntimeParticleSourceState {
  return {
    entityId: 'source',
    continuousEmission: false,
    ions: Array.from({ length: count }, (_, index) => ({
      id: index,
      t: count === 1 ? 0.5 : index / (count - 1),
      bornAt: 0,
      continuous: false,
      position: { x, y: index },
    })),
  }
}

describe('BoundedTrajectoryBuffer', () => {
  it('compresses a straight run without copying or losing its endpoints', () => {
    const trajectory = new BoundedTrajectoryBuffer(32, 1e-6)
    for (let index = 0; index < 10_000; index += 1) {
      trajectory.append({ x: index / 10, y: 2 })
    }

    expect(trajectory.length).toBe(2)
    expect(trajectory.xAt(0)).toBe(0)
    expect(trajectory.xAt(1)).toBeCloseTo(999.9)
  })

  it('keeps corners and retains only the newest points at capacity', () => {
    const trajectory = new BoundedTrajectoryBuffer(4, 0)
    for (let index = 0; index < 7; index += 1) {
      trajectory.append({ x: index, y: index % 2 })
    }

    expect(trajectory.length).toBe(4)
    expect(Array.from({ length: trajectory.length }, (_, index) => trajectory.xAt(index))).toEqual([
      3, 4, 5, 6,
    ])
  })
})

describe('RuntimeTrajectoryHistory', () => {
  it('uses a shared fixed point budget for a full-circle 1080-ion source', () => {
    const history = new RuntimeTrajectoryHistory()
    for (let frame = 0; frame < 200; frame += 1) {
      history.append(frame / 60, [], [particleSource(1080, frame / 60)])
    }

    expect(history.particlePointCapacity).toBeLessThanOrEqual(MAX_PARTICLE_TRAJECTORY_TOTAL_POINTS)
    expect(history.pointCount).toBeLessThanOrEqual(history.pointCapacity)
    expect(history.allocatedBytes).toBeLessThan(2 * 1024 * 1024)
  })

  it('clears old body and ion paths when simulation time moves backwards', () => {
    const history = new RuntimeTrajectoryHistory()
    history.append(5, [body('ball', 5, 0)], [particleSource(1, 5)])
    history.append(6, [body('ball', 6, 0)], [particleSource(1, 6)])
    const reset = history.append(0, [body('ball', 0, 0)], [particleSource(1, 0)])

    expect(reset.bodies.ball?.length).toBe(1)
    expect(reset.particles[0]?.points.length).toBe(1)
  })

  it('does not retain trajectories for continuous particle sources', () => {
    const history = new RuntimeTrajectoryHistory()
    const source = particleSource(10, 0)
    source.continuousEmission = true
    source.ions = source.ions.map((ion) => ({ ...ion, continuous: true }))

    const result = history.append(1, [], [source])

    expect(result.particles).toEqual([])
    expect(history.pointCount).toBe(0)
  })
})
