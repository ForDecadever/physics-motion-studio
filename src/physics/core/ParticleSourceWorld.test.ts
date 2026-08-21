import { afterEach, describe, expect, it } from 'vitest'

import { createEmptyScene } from '../../scene/model/createEmptyScene'
import {
  createBall,
  createLineGround,
  createParticleSource,
} from '../../scene/model/entityFactories'
import type { FieldEntity, ParticleSourceEntity, SceneEntity, Vec2 } from '../../scene/model/types'
import { SimulationWorld } from './SimulationWorld'

const worlds: SimulationWorld[] = []

afterEach(() => {
  for (const world of worlds.splice(0)) world.dispose()
})

const DT = 1 / 120

function electricField(strength: Vec2): FieldEntity {
  return {
    id: crypto.randomUUID(),
    name: '电场',
    visible: true,
    locked: false,
    simulationEnabled: true,
    kind: 'field',
    region: { type: 'infinite' },
    field: { type: 'uniformElectric', strength },
  }
}

function magneticField(bzTesla: number): FieldEntity {
  return {
    id: crypto.randomUUID(),
    name: '磁场',
    visible: true,
    locked: false,
    simulationEnabled: true,
    kind: 'field',
    region: { type: 'infinite' },
    field: { type: 'uniformMagnetic', bzTesla },
  }
}

function buildWorld(entities: SceneEntity[]): SimulationWorld {
  const scene = createEmptyScene()
  scene.entities = entities
  scene.rootItems = entities.map((entity) => ({ kind: 'entity' as const, entityId: entity.id }))
  const world = new SimulationWorld(scene)
  worlds.push(world)
  return world
}

function singleIon(
  source: ParticleSourceEntity,
  overrides: Partial<ParticleSourceEntity> = {},
): ParticleSourceEntity {
  return { ...source, ...overrides }
}

describe('粒子源物理', () => {
  it('无场时离子做匀速直线运动', () => {
    const source = singleIon(
      createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 1),
      { speedMps: 2, chargeC: 0, directionRad: 0 },
    )
    const world = buildWorld([source])
    world.step(120)

    const ion = world.getParticleSourceStates()[0]!.ions[0]!
    expect(ion.position.x).toBeCloseTo(2 * DT * 120, 6)
    expect(ion.position.y).toBeCloseTo(0, 6)
  })

  it('电荷为零时电场不产生偏转', () => {
    const source = singleIon(
      createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 1),
      { speedMps: 2, chargeC: 0, directionRad: 0 },
    )
    const world = buildWorld([source, electricField({ x: 0, y: 100 })])
    world.step(60)

    const ion = world.getParticleSourceStates()[0]!.ions[0]!
    expect(ion.position.x).toBeCloseTo(2 * DT * 60, 6)
    expect(ion.position.y).toBeCloseTo(0, 6)
  })

  it('电场使离子匀加速（半隐式欧拉）', () => {
    const source = singleIon(
      createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 1),
      { speedMps: 0, chargeC: 1, massKg: 1 },
    )
    const world = buildWorld([source, electricField({ x: 1, y: 0 })])
    const steps = 120
    world.step(steps)

    const ion = world.getParticleSourceStates()[0]!.ions[0]!
    const expectedX = 1 * DT * DT * ((steps * (steps + 1)) / 2)
    expect(ion.position.x).toBeCloseTo(expectedX, 3)
  })

  it('磁场保持速率不变并改变运动方向', () => {
    const source = singleIon(
      createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 1),
      { speedMps: 1, chargeC: 1, massKg: 1, directionRad: 0 },
    )
    const world = buildWorld([source, magneticField(1)])
    world.step(300)

    const before = world.getParticleSourceStates()[0]!.ions[0]!.position
    world.step(1)
    const after = world.getParticleSourceStates()[0]!.ions[0]!.position
    const speed = Math.hypot(after.x - before.x, after.y - before.y) / DT
    expect(speed).toBeCloseTo(1, 6)
    expect(Math.hypot(after.x, after.y)).toBeLessThan(3)
  })

  it('离子受带电物体库仑力但物体不受反作用', () => {
    const body = createBall('', { x: 1, y: 0 }, 0.3, 1)
    body.chargeC = 1e-3
    const source = singleIon(
      createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 2),
      { speedMps: 0, chargeC: 1e-3, massKg: 1 },
    )
    const world = buildWorld([body, source])
    world.step(20)

    const ion = world.getParticleSourceStates()[0]!.ions[0]!
    const bodyState = world.getBodyStates()[0]!
    expect(ion.position.x).toBeLessThan(0)
    expect(bodyState.position.x).toBeCloseTo(1, 6)
    expect(bodyState.position.y).toBeCloseTo(0, 6)
  })

  it('库仑关闭时离子不受带电物体影响', () => {
    const body = createBall('', { x: 1, y: 0 }, 0.3, 1)
    body.chargeC = 1e-3
    const source = singleIon(
      createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 2),
      { speedMps: 0, chargeC: 1e-3, massKg: 1, coulombEnabled: false },
    )
    const world = buildWorld([body, source])
    world.step(20)

    const ion = world.getParticleSourceStates()[0]!.ions[0]!
    expect(ion.position.x).toBeCloseTo(0, 6)
    expect(ion.position.y).toBeCloseTo(0, 6)
  })

  it('离子无碰撞穿过地面', () => {
    const source = singleIon(
      createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 1),
      { speedMps: 1, chargeC: 0, directionRad: 0 },
    )
    const ground = createLineGround('', { x: 2, y: -1 }, { x: 2, y: 1 }, 1)
    const world = buildWorld([source, ground])
    world.step(300)

    const ion = world.getParticleSourceStates()[0]!.ions[0]!
    expect(ion.position.x).toBeCloseTo(300 * DT, 6)
  })

  it('线源离子数随长度变化', () => {
    const short = createParticleSource(
      '',
      { type: 'line', start: { x: 0, y: 0 }, end: { x: 0.1, y: 0 } },
      1,
    )
    const medium = createParticleSource(
      '',
      { type: 'line', start: { x: 0, y: 0 }, end: { x: 3, y: 0 } },
      2,
    )
    const long = createParticleSource(
      '',
      { type: 'line', start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
      3,
    )
    const world = buildWorld([short, medium, long])

    const states = world.getParticleSourceStates()
    expect(states[0]!.ions).toHaveLength(2)
    expect(states[1]!.ions).toHaveLength(60)
    expect(states[2]!.ions).toHaveLength(128)
  })

  it('线源离子沿法线方向发射且翻转生效', () => {
    const source = singleIon(
      createParticleSource('', { type: 'line', start: { x: 0, y: 0 }, end: { x: 2, y: 0 } }, 1),
      { speedMps: 1, chargeC: 0, flipEmission: false },
    )
    const world = buildWorld([source])
    world.step(60)

    const ion = world.getParticleSourceStates()[0]!.ions[0]!
    expect(ion.position.y).toBeCloseTo(60 * DT, 6)
  })
})
