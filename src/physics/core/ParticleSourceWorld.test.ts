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

function pointToSegmentDistance(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  const ratio =
    lengthSquared <= Number.EPSILON
      ? 0
      : Math.min(
          1,
          Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
        )
  return Math.hypot(point.x - (start.x + dx * ratio), point.y - (start.y + dy * ratio))
}

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
  it('点源按角范围每度约三个离子均匀发射且整圆不重复首尾', () => {
    const counts = [
      { spreadDeg: 0, expected: 1 },
      { spreadDeg: 1, expected: 3 },
      { spreadDeg: 10, expected: 30 },
      { spreadDeg: 360, expected: 1080 },
    ]
    const sources = counts.map(({ spreadDeg }, index) =>
      singleIon(createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, index + 1), {
        directionRad: Math.PI / 2,
        spreadRad: (spreadDeg * Math.PI) / 180,
        speedMps: 1,
        chargeC: 0,
      }),
    )
    const world = buildWorld(sources)
    world.step(1)
    const states = world.getParticleSourceStates()

    for (const [index, testCase] of counts.entries()) {
      expect(states[index]!.ions).toHaveLength(testCase.expected)
    }

    const tenDegreeIons = states[2]!.ions
    const firstAngle = Math.atan2(tenDegreeIons[0]!.position.y, tenDegreeIons[0]!.position.x)
    const middleAngles = [14, 15].map((index) =>
      Math.atan2(tenDegreeIons[index]!.position.y, tenDegreeIons[index]!.position.x),
    )
    const lastAngle = Math.atan2(
      tenDegreeIons[tenDegreeIons.length - 1]!.position.y,
      tenDegreeIons[tenDegreeIons.length - 1]!.position.x,
    )
    expect(firstAngle).toBeCloseTo(Math.PI / 2 - (5 * Math.PI) / 180, 12)
    expect((middleAngles[0]! + middleAngles[1]!) / 2).toBeCloseTo(Math.PI / 2, 12)
    expect(lastAngle).toBeCloseTo(Math.PI / 2 + (5 * Math.PI) / 180, 12)

    const uniqueFullCircleDirections = new Set(
      states[3]!.ions.map((ion) => Math.atan2(ion.position.y, ion.position.x).toFixed(12)),
    )
    expect(uniqueFullCircleDirections.size).toBe(1080)
  })

  it('点源密度同时作用于静态和连续发射样本', () => {
    const source = singleIon(
      createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 1),
      {
        spreadRad: (10 * Math.PI) / 180,
        densityPerDegree: 2,
        speedMps: 0,
        continuousEmission: {
          enabled: false,
          simultaneous: false,
          intervalSeconds: 1,
          lifetimeSeconds: 60,
        },
      },
    )
    const staticWorld = buildWorld([source])
    expect(staticWorld.getParticleSourceStates()[0]!.ions).toHaveLength(20)

    const continuousWorld = buildWorld([
      {
        ...source,
        id: crypto.randomUUID(),
        continuousEmission: {
          enabled: true,
          simultaneous: false,
          intervalSeconds: 1,
          lifetimeSeconds: 60,
        },
      },
    ])
    continuousWorld.step(120 * 20)
    const state = continuousWorld.getParticleSourceStates()[0]!
    expect(state.ions).toHaveLength(21)
    expect(state.ions.slice(0, 20).map((ion) => ion.t)).toEqual(
      staticWorld.getParticleSourceStates()[0]!.ions.map((ion) => ion.t),
    )
  })

  it('连续发射从 t=0 首发、按绝对计划时间循环并在寿命到达时移除', () => {
    const source = singleIon(
      createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 1),
      {
        speedMps: 0,
        continuousEmission: {
          enabled: true,
          simultaneous: false,
          intervalSeconds: 1,
          lifetimeSeconds: 3,
        },
      },
    )
    const world = buildWorld([source])
    expect(world.getParticleSourceStates()[0]!.ions).toMatchObject([{ id: 0, bornAt: 0 }])

    world.step(120)
    expect(world.getParticleSourceStates()[0]!.ions).toMatchObject([
      { id: 0, bornAt: 0 },
      { id: 1, bornAt: 1 },
    ])
    world.step(240)
    expect(world.getParticleSourceStates()[0]!.ions).toMatchObject([
      { id: 1, bornAt: 1 },
      { id: 2, bornAt: 2 },
      { id: 3, bornAt: 3 },
    ])
  })

  it('连续发射长时间运行无累计漂移且重建世界后完全一致', () => {
    const source = singleIon(
      createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 1),
      {
        speedMps: 0,
        continuousEmission: {
          enabled: true,
          simultaneous: false,
          intervalSeconds: 0.1,
          lifetimeSeconds: 0.35,
        },
      },
    )
    const first = buildWorld([source])
    const second = buildWorld([structuredClone(source)])
    first.step(12_000)
    second.step(12_000)

    const firstIons = first.getParticleSourceStates()[0]!.ions
    const secondIons = second.getParticleSourceStates()[0]!.ions
    expect(firstIons).toEqual(secondIons)
    expect(firstIons).toHaveLength(4)
    for (const ion of firstIons) {
      expect(ion.bornAt / 0.1).toBeCloseTo(Math.round(ion.bornAt / 0.1), 10)
    }
  })

  it('同时发射会在每个计划时间发出完整角度样本且寿命按批次清理', () => {
    const source = singleIon(
      createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 1),
      {
        spreadRad: Math.PI,
        densityPerDegree: 3,
        speedMps: 0,
        continuousEmission: {
          enabled: true,
          simultaneous: true,
          intervalSeconds: 1,
          lifetimeSeconds: 2,
        },
      },
    )
    const world = buildWorld([source])

    expect(world.getParticleSourceStates()[0]!.ions).toHaveLength(540)
    expect(new Set(world.getParticleSourceStates()[0]!.ions.map((ion) => ion.bornAt))).toEqual(
      new Set([0]),
    )

    world.step(120)
    let ions = world.getParticleSourceStates()[0]!.ions
    expect(ions).toHaveLength(1080)
    expect(ions.filter((ion) => ion.bornAt === 1)).toHaveLength(540)
    expect(new Set(ions.map((ion) => ion.id)).size).toBe(1080)

    world.step(240)
    ions = world.getParticleSourceStates()[0]!.ions
    expect(ions).toHaveLength(1080)
    expect(new Set(ions.map((ion) => ion.bornAt))).toEqual(new Set([2, 3]))
  })

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
    const exactArcChordSpeed = (2 * Math.sin(DT / 2)) / DT
    expect(speed).toBeCloseTo(exactArcChordSpeed, 9)
    expect(Math.hypot(after.x, after.y)).toBeLessThan(3)
  })

  it('回旋半径等于圆形磁场半径时平行离子轨迹汇聚于同一点', () => {
    const source = singleIon(
      createParticleSource(
        '',
        { type: 'line', start: { x: -1.2, y: -0.8 }, end: { x: -1.2, y: 0.8 } },
        1,
      ),
      { speedMps: 1, chargeC: 1, massKg: 1, flipEmission: true },
    )
    const field = magneticField(1)
    field.region = {
      type: 'circle',
      center: { x: 0, y: 0 },
      radius: 1,
      startRad: 0,
      sweepRad: Math.PI * 2,
    }
    const world = buildWorld([source, field])
    const ionCount = world.getParticleSourceStates()[0]!.ions.length
    const minimumFocusDistances = Array.from({ length: ionCount }, () => Number.POSITIVE_INFINITY)
    const focus = { x: 0, y: -1 }
    let previousPositions = world
      .getParticleSourceStates()[0]!
      .ions.map((ion) => ({ ...ion.position }))

    for (let step = 0; step < 720; step += 1) {
      world.step()
      const ions = world.getParticleSourceStates()[0]!.ions
      for (const [index, ion] of ions.entries()) {
        minimumFocusDistances[index] = Math.min(
          minimumFocusDistances[index]!,
          pointToSegmentDistance(focus, previousPositions[index]!, ion.position),
        )
      }
      previousPositions = ions.map((ion) => ({ ...ion.position }))
    }

    const maximumFocusError = Math.max(...minimumFocusDistances)
    expect(maximumFocusError, JSON.stringify(minimumFocusDistances)).toBeLessThan(0.002)
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
