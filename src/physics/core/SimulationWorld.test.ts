import { afterEach, describe, expect, it } from 'vitest'

import { createEmptyScene } from '../../scene/model/createEmptyScene'
import type {
  BodyEntity,
  ConnectorEntity,
  ConnectorDefinition,
  FieldDefinition,
  FieldEntity,
  GroundEntity,
  SceneDocument,
  Vec2,
} from '../../scene/model/types'
import { SimulationWorld } from './SimulationWorld'

const worlds: SimulationWorld[] = []

afterEach(() => {
  for (const world of worlds.splice(0)) world.dispose()
})

function baseScene(): SceneDocument {
  return createEmptyScene('物理验证', new Date('2026-01-01T00:00:00.000Z'))
}

function makeBody(
  scene: SceneDocument,
  id: string,
  position: Vec2,
  velocity: Vec2 = { x: 0, y: 0 },
  overrides: Partial<BodyEntity> = {},
): BodyEntity {
  const layerId = scene.layers[0]?.id
  if (!layerId) throw new Error('测试场景缺少图层')
  return {
    id,
    name: id,
    layerId,
    visible: true,
    locked: false,
    simulationEnabled: true,
    kind: 'body',
    preset: 'ball',
    shape: { type: 'circle', radius: 0.5 },
    transform: { position, angleRad: 0 },
    massKg: 1,
    chargeC: 0,
    material: { friction: 0, restitution: 0 },
    initialVelocity: velocity,
    initialAngularVelocityRad: 0,
    continuousCollisionDetection: true,
    ...overrides,
  }
}

function makeGravity(scene: SceneDocument, acceleration: Vec2): FieldEntity {
  return makeField(scene, 'gravity', { type: 'uniformGravity', acceleration })
}

function makeField(
  scene: SceneDocument,
  id: string,
  field: FieldDefinition,
  region: FieldEntity['region'] = { type: 'infinite' },
): FieldEntity {
  const layerId = scene.layers[0]?.id
  if (!layerId) throw new Error('测试场景缺少图层')
  return {
    id,
    name: id,
    layerId,
    visible: true,
    locked: false,
    simulationEnabled: true,
    kind: 'field',
    region,
    field,
  }
}

function makeConnector(
  scene: SceneDocument,
  id: string,
  firstBodyId: string,
  secondBodyId: string,
  connector: ConnectorDefinition,
): ConnectorEntity {
  const layerId = scene.layers[0]?.id
  if (!layerId) throw new Error('测试场景缺少图层')
  return {
    id,
    name: id,
    layerId,
    visible: true,
    locked: false,
    simulationEnabled: true,
    kind: 'connector',
    a: { bodyId: firstBodyId, localAnchor: { x: 0, y: 0 } },
    b: { bodyId: secondBodyId, localAnchor: { x: 0, y: 0 } },
    connector,
  }
}

function makeGround(
  scene: SceneDocument,
  geometry: GroundEntity['geometry'],
  material = { friction: 0.5, restitution: 0 },
): GroundEntity {
  const layerId = scene.layers[0]?.id
  if (!layerId) throw new Error('测试场景缺少图层')
  return {
    id: 'ground',
    name: '地面',
    layerId,
    visible: true,
    locked: false,
    simulationEnabled: true,
    kind: 'ground',
    geometry,
    material,
    collisionSide: 'both',
    normalFlipped: false,
  }
}

function createWorld(scene: SceneDocument): SimulationWorld {
  const world = new SimulationWorld(scene)
  worlds.push(world)
  return world
}

function stateOf(world: SimulationWorld, id: string) {
  const state = world.getBodyStates().find((body) => body.entityId === id)
  if (!state) throw new Error(`找不到物体 ${id}`)
  return state
}

describe('SimulationWorld 物理规律验证', () => {
  it('运行快照直接给出实际加速度、合外力和动能', () => {
    const scene = baseScene()
    scene.entities = [
      makeBody(
        scene,
        'measured',
        { x: 0, y: 5 },
        { x: 3, y: 4 },
        { massKg: 2, initialAngularVelocityRad: 2 },
      ),
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const world = createWorld(scene)
    world.step()
    const state = stateOf(world, 'measured')

    expect(state.acceleration.y).toBeCloseTo(-9.80665, 4)
    expect(state.netForce.y).toBeCloseTo(-19.6133, 3)
    expect(state.translationalKineticEnergyJ).toBeGreaterThan(24)
    expect(state.rotationalKineticEnergyJ).toBeCloseTo(0.5, 5)
    expect(state.kineticEnergyJ).toBeCloseTo(
      state.translationalKineticEnergyJ + state.rotationalKineticEnergyJ,
      10,
    )
  })

  it('使用固定 1/120 秒步长，且自由落体符合解析解', () => {
    const scene = baseScene()
    const gravity = -9.80665
    scene.entities = [
      makeBody(scene, 'ball', { x: 0, y: 10 }),
      makeGravity(scene, { x: 0, y: gravity }),
    ]
    const world = createWorld(scene)

    world.step(120)
    const state = stateOf(world, 'ball')
    expect(world.simulationTime).toBeCloseTo(1, 12)
    expect(state.linearVelocity.y).toBeCloseTo(gravity, 3)
    expect(state.position.y).toBeCloseTo(10 + 0.5 * gravity, 1)
  })

  it('斜抛运动的水平匀速和竖直匀加速同时成立', () => {
    const scene = baseScene()
    const gravity = -9.80665
    scene.entities = [
      makeBody(scene, 'projectile', { x: 0, y: 0 }, { x: 3, y: 4 }),
      makeGravity(scene, { x: 0, y: gravity }),
    ]
    const world = createWorld(scene)

    world.step(60)
    const state = stateOf(world, 'projectile')
    const time = 0.5
    expect(state.position.x).toBeCloseTo(3 * time, 3)
    expect(state.linearVelocity.x).toBeCloseTo(3, 4)
    expect(state.position.y).toBeCloseTo(4 * time + 0.5 * gravity * time ** 2, 1)
    expect(state.linearVelocity.y).toBeCloseTo(4 + gravity * time, 3)
  })

  it('等质量完全弹性正碰交换速度，并守恒动量与动能', () => {
    const scene = baseScene()
    const first = makeBody(
      scene,
      'left',
      { x: -1.5, y: 0 },
      { x: 1, y: 0 },
      { material: { friction: 0, restitution: 1 } },
    )
    const second = makeBody(
      scene,
      'right',
      { x: 1.5, y: 0 },
      { x: -1, y: 0 },
      { material: { friction: 0, restitution: 0 } },
    )
    scene.entities = [first, second]
    const world = createWorld(scene)

    world.step(180)
    const left = stateOf(world, 'left')
    const right = stateOf(world, 'right')
    const momentum = first.massKg * left.linearVelocity.x + second.massKg * right.linearVelocity.x
    const kineticEnergy =
      0.5 * first.massKg * left.linearVelocity.x ** 2 +
      0.5 * second.massKg * right.linearVelocity.x ** 2

    expect(left.linearVelocity.x).toBeCloseTo(-1, 2)
    expect(right.linearVelocity.x).toBeCloseTo(1, 2)
    expect(momentum).toBeCloseTo(0, 5)
    expect(kineticEnergy).toBeCloseTo(1, 2)
  })

  it('小球能在直线地面保持稳定静止接触', () => {
    const scene = baseScene()
    scene.entities = [
      makeGround(scene, { type: 'line', start: { x: -5, y: 0 }, end: { x: 5, y: 0 } }),
      makeBody(scene, 'ball', { x: 0, y: 2 }),
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const world = createWorld(scene)

    world.step(480)
    const state = stateOf(world, 'ball')
    expect(state.position.y).toBeCloseTo(0.5, 2)
    expect(Math.abs(state.linearVelocity.y)).toBeLessThan(0.01)
  })

  it('重力加速度与物体质量无关', () => {
    const scene = baseScene()
    scene.entities = [
      makeBody(scene, 'light', { x: -1, y: 5 }, { x: 0, y: 0 }, { massKg: 0.5 }),
      makeBody(scene, 'heavy', { x: 1, y: 5 }, { x: 0, y: 0 }, { massKg: 8 }),
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const world = createWorld(scene)
    world.step(120)

    expect(stateOf(world, 'light').position.y).toBeCloseTo(stateOf(world, 'heavy').position.y, 6)
    expect(stateOf(world, 'light').linearVelocity.y).toBeCloseTo(
      stateOf(world, 'heavy').linearVelocity.y,
      6,
    )
  })

  it('隐藏或锁定图层只影响编辑显示，不会关闭物理模拟', () => {
    const scene = baseScene()
    const layer = scene.layers[0]
    if (!layer) throw new Error('测试场景缺少图层')
    scene.layers = [{ ...layer, visible: false, locked: true }]
    scene.entities = [
      makeBody(scene, 'hidden-ball', { x: 0, y: 5 }),
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const world = createWorld(scene)
    world.step(120)

    expect(stateOf(world, 'hidden-ball').linearVelocity.y).toBeCloseTo(-9.80665, 3)
  })

  it('滑动摩擦产生约为 μg 的减速度', () => {
    const scene = baseScene()
    const friction = 0.25
    scene.entities = [
      makeGround(
        scene,
        { type: 'line', start: { x: -10, y: 0 }, end: { x: 10, y: 0 } },
        { friction, restitution: 0 },
      ),
      makeBody(
        scene,
        'block',
        { x: 0, y: 0.5 },
        { x: 4, y: 0 },
        {
          preset: 'block',
          shape: { type: 'box', width: 1, height: 1 },
          material: { friction, restitution: 0 },
        },
      ),
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const world = createWorld(scene)
    const time = 0.5
    world.step(60)

    expect(stateOf(world, 'block').linearVelocity.x).toBeCloseTo(4 - friction * 9.80665 * time, 1)
  })

  it('开启 CCD 后，高速小球不会穿过零厚度地面', () => {
    const scene = baseScene()
    scene.entities = [
      makeGround(
        scene,
        { type: 'line', start: { x: -5, y: 0 }, end: { x: 5, y: 0 } },
        { friction: 0, restitution: 1 },
      ),
      makeBody(
        scene,
        'fast',
        { x: 0, y: 2 },
        { x: 0, y: -100 },
        {
          shape: { type: 'circle', radius: 0.1 },
          material: { friction: 0, restitution: 1 },
          continuousCollisionDetection: true,
        },
      ),
    ]
    const world = createWorld(scene)
    world.step(6)
    const state = stateOf(world, 'fast')

    expect(state.position.y).toBeGreaterThan(0)
    expect(state.linearVelocity.y).toBeGreaterThan(0)
  })

  it('单面地面只阻挡法线一侧，双面地面会阻挡两侧', () => {
    const runFromBelow = (collisionSide: GroundEntity['collisionSide']) => {
      const scene = baseScene()
      const ground = makeGround(
        scene,
        { type: 'line', start: { x: -5, y: 0 }, end: { x: 5, y: 0 } },
        { friction: 0, restitution: 1 },
      )
      ground.collisionSide = collisionSide
      scene.entities = [
        ground,
        makeBody(
          scene,
          'ball',
          { x: 0, y: -2 },
          { x: 0, y: 5 },
          {
            material: { friction: 0, restitution: 1 },
            continuousCollisionDetection: true,
          },
        ),
      ]
      const world = createWorld(scene)
      world.step(120)
      return stateOf(world, 'ball')
    }

    const throughNormalGround = runFromBelow('normal')
    const bouncedByBothGround = runFromBelow('both')
    expect(throughNormalGround.position.y).toBeGreaterThan(2)
    expect(throughNormalGround.linearVelocity.y).toBeGreaterThan(0)
    expect(bouncedByBothGround.position.y).toBeLessThan(-2)
    expect(bouncedByBothGround.linearVelocity.y).toBeLessThan(0)
  })

  it('小球在圆弧和贝塞尔曲面最低点不会下沉或穿透', () => {
    const geometries: GroundEntity['geometry'][] = [
      { type: 'arc', center: { x: 0, y: 2 }, radius: 3, startRad: Math.PI, endRad: 2 * Math.PI },
      {
        type: 'cubicBezier',
        p0: { x: -3, y: 1 },
        p1: { x: -1, y: -1 },
        p2: { x: 1, y: -1 },
        p3: { x: 3, y: 1 },
      },
    ]

    for (const geometry of geometries) {
      const scene = baseScene()
      const groundY = geometry.type === 'arc' ? -1 : -0.5
      scene.entities = [
        makeGround(scene, geometry),
        makeBody(scene, 'ball', { x: 0, y: groundY + 0.5 }),
        makeGravity(scene, { x: 0, y: -9.80665 }),
      ]
      const world = createWorld(scene)
      world.step(360)
      const state = stateOf(world, 'ball')
      expect(Number.isFinite(state.position.y)).toBe(true)
      expect(state.position.y).toBeGreaterThan(groundY + 0.47)
      expect(Math.abs(state.linearVelocity.y)).toBeLessThan(0.02)
    }
  })

  it('无摩擦小球沿圆弧运动时机械能守恒', () => {
    const scene = baseScene()
    const gravity = 9.80665
    const arcRadius = 3
    const ballRadius = 0.5
    const pathRadius = arcRadius - ballRadius
    const startAngle = (4 * Math.PI) / 3
    const startPosition = {
      x: pathRadius * Math.cos(startAngle),
      y: 2 + pathRadius * Math.sin(startAngle),
    }
    scene.entities = [
      makeGround(
        scene,
        {
          type: 'arc',
          center: { x: 0, y: 2 },
          radius: arcRadius,
          startRad: Math.PI,
          endRad: 2 * Math.PI,
        },
        { friction: 0, restitution: 0 },
      ),
      makeBody(
        scene,
        'ball',
        startPosition,
        { x: 0, y: 0 },
        {
          shape: { type: 'circle', radius: ballRadius },
          material: { friction: 0, restitution: 0 },
        },
      ),
      makeGravity(scene, { x: 0, y: -gravity }),
    ]
    const world = createWorld(scene)
    const energyAt = () => {
      const state = stateOf(world, 'ball')
      return (
        0.5 * (state.linearVelocity.x ** 2 + state.linearVelocity.y ** 2) +
        gravity * state.position.y
      )
    }
    const initialEnergy = energyAt()
    const bottomPositionY = 2 - pathRadius
    const availableEnergy = gravity * (startPosition.y - bottomPositionY)
    let maximumRelativeDrift = 0

    for (let step = 0; step < 120 * 12; step += 1) {
      world.step()
      maximumRelativeDrift = Math.max(
        maximumRelativeDrift,
        Math.abs(energyAt() - initialEnergy) / availableEnergy,
      )
    }

    expect(maximumRelativeDrift).toBeLessThan(0.005)
  })

  it('匀强电场产生 qE/m 的加速度', () => {
    const scene = baseScene()
    scene.entities = [
      makeBody(scene, 'charge', { x: 0, y: 0 }, { x: 0, y: 0 }, { massKg: 4, chargeC: 2 }),
      makeField(scene, 'electric', {
        type: 'uniformElectric',
        strength: { x: 6, y: -2 },
      }),
    ]
    const world = createWorld(scene)

    world.step(120)
    const state = stateOf(world, 'charge')
    expect(state.linearVelocity.x).toBeCloseTo(3, 4)
    expect(state.linearVelocity.y).toBeCloseTo(-1, 4)
    expect(state.netForce.x).toBeCloseTo(12, 3)
    expect(state.netForce.y).toBeCloseTo(-4, 3)
  })

  it('匀强磁场保持速率，并产生符合理论半径的圆周运动', () => {
    const scene = baseScene()
    scene.entities = [
      makeBody(scene, 'charge', { x: 0, y: 0 }, { x: 2, y: 0 }, { massKg: 1, chargeC: 1 }),
      makeField(scene, 'magnetic', { type: 'uniformMagnetic', bzTesla: 1 }),
    ]
    const world = createWorld(scene)

    world.step(Math.round((Math.PI / 2) * 120))
    const state = stateOf(world, 'charge')
    expect(Math.hypot(state.linearVelocity.x, state.linearVelocity.y)).toBeCloseTo(2, 8)
    expect(state.position.x).toBeCloseTo(2, 1)
    expect(state.position.y).toBeCloseTo(-2, 1)
  })

  it('点电荷间作用力大小相等、方向相反', () => {
    const scene = baseScene()
    scene.entities = [
      makeBody(scene, 'left-charge', { x: -1, y: 0 }, { x: 0, y: 0 }, { chargeC: 1e-6 }),
      makeBody(scene, 'right-charge', { x: 1, y: 0 }, { x: 0, y: 0 }, { chargeC: 1e-6 }),
    ]
    const world = createWorld(scene)

    world.step()
    const left = stateOf(world, 'left-charge')
    const right = stateOf(world, 'right-charge')
    expect(left.netForce.x).toBeLessThan(0)
    expect(right.netForce.x).toBeCloseTo(-left.netForce.x, 12)
    expect(left.netForce.y).toBeCloseTo(0, 12)
    expect(right.linearVelocity.x).toBeCloseTo(-left.linearVelocity.x, 12)
  })

  it('绳只限制最大长度，不会把松弛的端点推开', () => {
    const scene = baseScene()
    scene.entities = [
      makeBody(scene, 'first', { x: -1, y: 0 }, { x: -2, y: 0 }),
      makeBody(scene, 'second', { x: 1, y: 0 }, { x: 2, y: 0 }),
      makeConnector(scene, 'rope', 'first', 'second', { type: 'rope', maxLength: 2 }),
    ]
    const world = createWorld(scene)

    world.step(240)
    const first = stateOf(world, 'first')
    const second = stateOf(world, 'second')
    expect(
      Math.hypot(second.position.x - first.position.x, second.position.y - first.position.y),
    ).toBeLessThan(2.01)
  })

  it('小角度单摆周期接近 2π√(L/g)', () => {
    const scene = baseScene()
    const length = 2
    const gravity = 9.80665
    const startAngle = 0.1
    const initialBobPosition = {
      x: length * Math.sin(startAngle),
      y: -length * Math.cos(startAngle),
    }
    scene.entities = [
      makeBody(scene, 'anchor', { x: 0, y: 0 }, { x: 0, y: 0 }, { massKg: 1e9 }),
      makeBody(scene, 'bob', initialBobPosition),
      makeField(
        scene,
        'gravity',
        { type: 'uniformGravity', acceleration: { x: 0, y: -gravity } },
        {
          type: 'rectangle',
          center: { x: 0, y: -2 },
          width: 10,
          height: 3,
          angleRad: 0,
        },
      ),
      makeConnector(scene, 'rope', 'anchor', 'bob', { type: 'rope', maxLength: length }),
    ]
    const world = createWorld(scene)
    const theoreticalPeriod = 2 * Math.PI * Math.sqrt(length / gravity)

    world.step(Math.round(theoreticalPeriod * 120))
    const anchor = stateOf(world, 'anchor')
    const bob = stateOf(world, 'bob')
    expect(bob.position.x).toBeCloseTo(initialBobPosition.x, 1)
    expect(
      Math.hypot(bob.position.x - anchor.position.x, bob.position.y - anchor.position.y),
    ).toBeLessThan(length + 0.01)
  })

  it('杆在受拉和受压时都保持固定长度', () => {
    const scene = baseScene()
    scene.entities = [
      makeBody(scene, 'first', { x: -1, y: 0 }, { x: -1, y: 0 }),
      makeBody(scene, 'second', { x: 1, y: 0 }, { x: 1, y: 0 }),
      makeConnector(scene, 'rod', 'first', 'second', {
        type: 'rod',
        length: 2,
        freeRotation: true,
      }),
    ]
    const world = createWorld(scene)

    world.step(240)
    const first = stateOf(world, 'first')
    const second = stateOf(world, 'second')
    expect(
      Math.hypot(second.position.x - first.position.x, second.position.y - first.position.y),
    ).toBeCloseTo(2, 6)
    expect(first.linearVelocity.x + second.linearVelocity.x).toBeCloseTo(0, 10)
  })

  it('无阻尼弹簧振子的周期符合双质量解析解', () => {
    const scene = baseScene()
    const particle = {
      preset: 'particle' as const,
      shape: { type: 'particle' as const, collisionRadius: 0.1, collisionEnabled: false },
    }
    scene.entities = [
      makeBody(scene, 'first', { x: -1.5, y: 0 }, { x: 0, y: 0 }, particle),
      makeBody(scene, 'second', { x: 1.5, y: 0 }, { x: 0, y: 0 }, particle),
      makeConnector(scene, 'spring', 'first', 'second', {
        type: 'spring',
        restLength: 2,
        stiffness: 8,
        damping: 0,
      }),
    ]
    const world = createWorld(scene)
    const theoreticalPeriod = 2 * Math.PI * Math.sqrt(1 / (2 * 8))

    world.step(Math.round(theoreticalPeriod * 120))
    const first = stateOf(world, 'first')
    const second = stateOf(world, 'second')
    expect(second.position.x - first.position.x).toBeCloseTo(3, 1)
  })

  it('相同初始条件和步数会得到可复现结果', () => {
    const scene = baseScene()
    scene.entities = [
      makeBody(scene, 'ball', { x: 1, y: 4 }, { x: 2, y: 0 }),
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const first = createWorld(scene)
    const second = createWorld(scene)
    first.step(240)
    second.step(240)

    expect(stateOf(first, 'ball')).toEqual(stateOf(second, 'ball'))
  })
})
