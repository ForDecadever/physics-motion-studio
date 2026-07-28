import { afterEach, describe, expect, it } from 'vitest'

import { createEmptyScene } from '../../scene/model/createEmptyScene'
import { buildGroundPathNetwork } from '../../scene/model/groundPath'
import type {
  BodyEntity,
  ConnectorEntity,
  ConnectorDefinition,
  FieldDefinition,
  FieldEntity,
  GroundEntity,
  GroundJointEntity,
  SceneDocument,
  Vec2,
} from '../../scene/model/types'
import { combinedMaterialRestitution } from './groundPathMotion'
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
    shape: { type: 'circle', radius: 0.5, collisionEnabled: true },
    transform: { position, angleRad: 0 },
    massKg: 1,
    chargeC: 0,
    material: { friction: 0, restitution: 0 },
    initialVelocity: velocity,
    initialAngularVelocityRad: 0,
    rotationEnabled: true,
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

function makeGroundJoint(
  scene: SceneDocument,
  id: string,
  firstGroundId: string,
  firstEndpoint: 'start' | 'end',
  secondGroundId: string,
  secondEndpoint: 'start' | 'end',
): GroundJointEntity {
  const layerId = scene.layers[0]?.id
  if (!layerId) throw new Error('测试场景缺少图层')
  return {
    id,
    name: id,
    layerId,
    visible: true,
    locked: false,
    simulationEnabled: true,
    kind: 'groundJoint',
    a: { groundId: firstGroundId, endpoint: firstEndpoint },
    b: { groundId: secondGroundId, endpoint: secondEndpoint },
    transition: { mode: 'auto', directionFlipped: false },
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

function springSystemEnergy(
  world: SimulationWorld,
  bodyIds: readonly string[],
  springs: readonly ConnectorEntity[],
): number {
  const states = new Map(bodyIds.map((id) => [id, stateOf(world, id)]))
  const kineticEnergy = [...states.values()].reduce((sum, state) => sum + state.kineticEnergyJ, 0)
  const springPotentialEnergy = springs.reduce((sum, spring) => {
    if (spring.connector.type !== 'spring') return sum
    const first = states.get(spring.a.bodyId)
    const second = states.get(spring.b.bodyId)
    if (!first || !second) throw new Error('弹簧能量测试缺少端点物体')
    const anchorPosition = (state: typeof first, localAnchor: Vec2): Vec2 => {
      const cosine = Math.cos(state.angleRad)
      const sine = Math.sin(state.angleRad)
      return {
        x: state.position.x + cosine * localAnchor.x - sine * localAnchor.y,
        y: state.position.y + sine * localAnchor.x + cosine * localAnchor.y,
      }
    }
    const firstAnchor = anchorPosition(first, spring.a.localAnchor)
    const secondAnchor = anchorPosition(second, spring.b.localAnchor)
    const extension =
      Math.hypot(secondAnchor.x - firstAnchor.x, secondAnchor.y - firstAnchor.y) -
      spring.connector.restLength
    return sum + 0.5 * spring.connector.stiffness * extension ** 2
  }, 0)
  return kineticEnergy + springPotentialEnergy
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
      { material: { friction: 0, restitution: 1 } },
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

  it('弹性系数按几何平均合成，并让零弹性接触面占主导', () => {
    const firstMaterial = { friction: 0, restitution: 0.25 }
    const secondMaterial = { friction: 0, restitution: 1 }
    expect(combinedMaterialRestitution(firstMaterial, secondMaterial)).toBeCloseTo(0.5, 12)
    expect(combinedMaterialRestitution({ friction: 0, restitution: 0 }, secondMaterial)).toBe(0)

    const scene = baseScene()
    scene.entities = [
      makeBody(
        scene,
        'left',
        { x: -1.5, y: 0 },
        { x: 1, y: 0 },
        {
          material: firstMaterial,
        },
      ),
      makeBody(
        scene,
        'right',
        { x: 1.5, y: 0 },
        { x: -1, y: 0 },
        {
          material: secondMaterial,
        },
      ),
    ]
    const world = createWorld(scene)

    world.step(180)
    const left = stateOf(world, 'left')
    const right = stateOf(world, 'right')

    expect(left.linearVelocity.x).toBeCloseTo(-0.5, 2)
    expect(right.linearVelocity.x).toBeCloseTo(0.5, 2)
    expect(left.linearVelocity.x + right.linearVelocity.x).toBeCloseTo(0, 6)

    const groundScene = baseScene()
    groundScene.entities = [
      makeGround(
        groundScene,
        { type: 'line', start: { x: -5, y: 0 }, end: { x: 5, y: 0 } },
        secondMaterial,
      ),
      makeBody(
        groundScene,
        'falling',
        { x: 0, y: 2 },
        { x: 0, y: -2 },
        {
          material: firstMaterial,
        },
      ),
    ]
    const groundWorld = createWorld(groundScene)

    groundWorld.step(100)
    const falling = stateOf(groundWorld, 'falling')
    expect(falling.position.y).toBeGreaterThan(0.5)
    expect(falling.linearVelocity.y).toBeCloseTo(1, 1)
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

  it('小球处于持续地面路径时仍会响应第三物体的真实碰撞冲量', () => {
    const scene = baseScene()
    scene.entities = [
      makeGround(
        scene,
        { type: 'line', start: { x: -10, y: 0 }, end: { x: 10, y: 0 } },
        { friction: 0, restitution: 0 },
      ),
      makeBody(
        scene,
        'path-target',
        { x: 0, y: 0.5 },
        { x: 0, y: 0 },
        {
          material: { friction: 0, restitution: 1 },
        },
      ),
      makeBody(
        scene,
        'path-projectile',
        { x: -3, y: 0.5 },
        { x: 5, y: 0 },
        {
          material: { friction: 0, restitution: 1 },
        },
      ),
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const world = createWorld(scene)

    world.step(30)
    expect(Math.abs(stateOf(world, 'path-target').linearVelocity.x)).toBeLessThan(0.01)
    world.step(60)
    const target = stateOf(world, 'path-target')
    const projectile = stateOf(world, 'path-projectile')

    expect(target.linearVelocity.x).toBeGreaterThan(4)
    expect(Math.abs(projectile.linearVelocity.x)).toBeLessThan(1)
    expect(target.linearVelocity.x + projectile.linearVelocity.x).toBeCloseTo(5, 1)
  })

  it('第三物体把持续路径小球压向地面时保留碰撞冲量但不穿透或反弹离地', () => {
    const scene = baseScene()
    const targetId = 'pressed-path-target'
    scene.entities = [
      makeGround(
        scene,
        { type: 'line', start: { x: -5, y: 0 }, end: { x: 5, y: 0 } },
        { friction: 0, restitution: 0 },
      ),
      makeBody(scene, targetId, { x: 0, y: 0.5 }),
      makeBody(scene, 'vertical-projectile', { x: 0, y: 3 }, { x: 0, y: -5 }),
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const world = createWorld(scene)
    let minimumHeight = Number.POSITIVE_INFINITY
    let maximumUpwardSpeed = 0

    for (let step = 0; step < 90; step += 1) {
      world.step()
      const target = stateOf(world, targetId)
      minimumHeight = Math.min(minimumHeight, target.position.y)
      maximumUpwardSpeed = Math.max(maximumUpwardSpeed, target.linearVelocity.y)
    }
    const target = stateOf(world, targetId)

    expect(minimumHeight).toBeGreaterThan(0.495)
    expect(target.position.y).toBeCloseTo(0.5, 2)
    expect(maximumUpwardSpeed).toBeLessThan(0.05)
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

  it('圆形物体的库仑摩擦按转动惯量从滑动过渡到纯滚动', () => {
    const scene = baseScene()
    const radius = 0.5
    const initialSpeed = 3
    scene.entities = [
      makeGround(
        scene,
        { type: 'line', start: { x: -10, y: 0 }, end: { x: 10, y: 0 } },
        { friction: 1, restitution: 0 },
      ),
      makeBody(
        scene,
        'rolling-ball',
        { x: 0, y: radius },
        { x: initialSpeed, y: 0 },
        {
          shape: { type: 'circle', radius, collisionEnabled: true },
          material: { friction: 1, restitution: 0 },
        },
      ),
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const world = createWorld(scene)

    world.step(120)
    const state = stateOf(world, 'rolling-ball')
    const contactSlipSpeed = state.linearVelocity.x + state.angularVelocityRad * radius

    expect(contactSlipSpeed).toBeCloseTo(0, 3)
    expect(state.linearVelocity.x).toBeCloseTo((2 * initialSpeed) / 3, 2)
    expect(state.angularVelocityRad).toBeCloseTo(-state.linearVelocity.x / radius, 2)
  })

  it('0° 连接被拒绝后，小球仍可按普通接触跨越相邻地面', () => {
    const radius = 0.5
    const run = (withJoint: boolean, bodyId: string) => {
      const scene = baseScene()
      const groundMaterial = { friction: 1, restitution: 0 }
      const grounds: GroundEntity[] = []
      if (withJoint) {
        const left = makeGround(
          scene,
          { type: 'line', start: { x: -10, y: 0 }, end: { x: 0, y: 0 } },
          groundMaterial,
        )
        left.id = `${bodyId}-left`
        const right = makeGround(
          scene,
          { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
          groundMaterial,
        )
        right.id = `${bodyId}-right`
        grounds.push(left, right)
        scene.entities = [
          ...grounds,
          makeGroundJoint(scene, `${bodyId}-joint`, left.id, 'end', right.id, 'start'),
        ]
      } else {
        grounds.push(
          makeGround(
            scene,
            { type: 'line', start: { x: -10, y: 0 }, end: { x: 10, y: 0 } },
            groundMaterial,
          ),
        )
        scene.entities = [...grounds]
      }
      scene.entities.push(
        makeBody(
          scene,
          bodyId,
          { x: -0.15, y: radius },
          { x: 3, y: 0 },
          {
            shape: { type: 'circle', radius, collisionEnabled: true },
            material: { friction: 1, restitution: 0 },
          },
        ),
        makeGravity(scene, { x: 0, y: -9.80665 }),
      )
      const world = createWorld(scene)
      world.step(120)
      return { state: stateOf(world, bodyId), warnings: world.warnings }
    }

    const joinedResult = run(true, 'joined-rolling-ball')
    const controlResult = run(false, 'control-rolling-ball')
    const joined = joinedResult.state
    const control = controlResult.state
    const joinedSlip = joined.linearVelocity.x + joined.angularVelocityRad * radius

    expect(
      joinedResult.warnings.some((warning) => warning.entityId === 'joined-rolling-ball-joint'),
    ).toBe(true)
    expect(joined.position.x).toBeGreaterThan(1)
    expect(joinedSlip).toBeCloseTo(0, 3)
    expect(
      Math.abs(joined.linearVelocity.x - control.linearVelocity.x) / control.linearVelocity.x,
    ).toBeLessThan(0.006)
    expect(Math.abs(joined.angularVelocityRad - control.angularVelocityRad)).toBeLessThan(0.03)
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
          shape: { type: 'circle', radius: 0.1, collisionEnabled: true },
          material: { friction: 0, restitution: 1 },
          initialAngularVelocityRad: 7,
          rotationEnabled: false,
          continuousCollisionDetection: true,
        },
      ),
    ]
    const world = createWorld(scene)
    world.step(6)
    const state = stateOf(world, 'fast')

    expect(state.position.y).toBeGreaterThan(0)
    expect(state.linearVelocity.y).toBeGreaterThan(0)
    expect(state.angularVelocityRad).toBe(0)
    expect(Math.abs(state.angleRad)).toBeLessThan(1e-6)
  })

  it('直线、圆弧和贝塞尔地面都从正反两侧阻挡小球', () => {
    const geometries: GroundEntity['geometry'][] = [
      { type: 'line', start: { x: -5, y: 0 }, end: { x: 5, y: 0 } },
      {
        type: 'arc',
        center: { x: 0, y: 2 },
        radius: 2,
        startRad: Math.PI,
        endRad: 2 * Math.PI,
      },
      {
        type: 'cubicBezier',
        p0: { x: -5, y: 0 },
        p1: { x: -2, y: 0 },
        p2: { x: 2, y: 0 },
        p3: { x: 5, y: 0 },
      },
    ]

    for (const [geometryIndex, geometry] of geometries.entries()) {
      for (const side of [-1, 1] as const) {
        const scene = baseScene()
        const ground = makeGround(scene, geometry, { friction: 0, restitution: 1 })
        ground.id = `ground-${geometryIndex}-${side}`
        const ballId = `ball-${geometryIndex}-${side}`
        scene.entities = [
          ground,
          makeBody(
            scene,
            ballId,
            { x: 0, y: 2 * side },
            { x: 0, y: -5 * side },
            {
              material: { friction: 0, restitution: 1 },
              continuousCollisionDetection: true,
            },
          ),
        ]
        const world = createWorld(scene)
        world.step(120)
        const state = stateOf(world, ballId)

        expect(state.position.y * side).toBeGreaterThan(2)
        expect(state.linearVelocity.y * side).toBeGreaterThan(0)
      }
    }
  })

  it('0° 无摩擦连接失效后，两块相邻地面仍保持普通碰撞', () => {
    for (const direction of [-1, 1] as const) {
      const scene = baseScene()
      const left = makeGround(
        scene,
        { type: 'line', start: { x: -4, y: 0 }, end: { x: 0, y: 0 } },
        { friction: 0, restitution: 0 },
      )
      left.id = `left-${direction}`
      const right = makeGround(
        scene,
        { type: 'line', start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
        { friction: 0, restitution: 0 },
      )
      right.id = `right-${direction}`
      const ballId = `seam-ball-${direction}`
      scene.entities = [
        left,
        right,
        makeGroundJoint(scene, `joint-${direction}`, left.id, 'end', right.id, 'start'),
        makeBody(scene, ballId, { x: -1.5 * direction, y: 0.5 }, { x: 4 * direction, y: 0 }),
        makeGravity(scene, { x: 0, y: -9.80665 }),
      ]
      const world = createWorld(scene)
      const initialEnergy = 0.5 * 4 ** 2 + 9.80665 * 0.5

      world.step(70)
      const state = stateOf(world, ballId)
      const finalEnergy =
        0.5 * (state.linearVelocity.x ** 2 + state.linearVelocity.y ** 2) +
        9.80665 * state.position.y

      expect(world.warnings.some((warning) => warning.entityId === `joint-${direction}`)).toBe(true)
      expect(state.position.x * direction).toBeGreaterThan(0.5)
      expect(state.linearVelocity.x * direction).toBeGreaterThan(3.97)
      expect(Math.abs(finalEnergy - initialEnergy) / initialEnergy).toBeLessThan(0.008)
    }
  })

  it('无摩擦小球能从支持侧双向通过 90° 与 150° 平滑转弯', () => {
    const groundLength = 10
    const radius = 0.2
    const speed = 4

    for (const angleDeg of [90, 150]) {
      const angle = (angleDeg * Math.PI) / 180
      const secondDirection = { x: Math.cos(angle), y: Math.sin(angle) }
      const secondNormal = { x: -secondDirection.y, y: secondDirection.x }
      const trimM = angleDeg === 150 ? 5 : 3
      const startDistanceM = trimM + 0.8

      for (const travelDirection of [1, -1] as const) {
        const scene = baseScene()
        const first = makeGround(
          scene,
          {
            type: 'line',
            start: { x: -groundLength, y: 0 },
            end: { x: 0, y: 0 },
          },
          { friction: 0, restitution: 0 },
        )
        first.id = `turn-first-${angleDeg}-${travelDirection}`
        const second = makeGround(
          scene,
          {
            type: 'line',
            start: { x: 0, y: 0 },
            end: {
              x: secondDirection.x * groundLength,
              y: secondDirection.y * groundLength,
            },
          },
          { friction: 0, restitution: 0 },
        )
        second.id = `turn-second-${angleDeg}-${travelDirection}`
        const bodyId = `turn-ball-${angleDeg}-${travelDirection}`
        const startsOnFirst = travelDirection === 1
        const initialPosition = startsOnFirst
          ? { x: -startDistanceM, y: radius }
          : {
              x: secondDirection.x * startDistanceM + secondNormal.x * radius,
              y: secondDirection.y * startDistanceM + secondNormal.y * radius,
            }
        const initialVelocity = startsOnFirst
          ? { x: speed, y: 0 }
          : { x: -secondDirection.x * speed, y: -secondDirection.y * speed }
        const joint = makeGroundJoint(
          scene,
          `turn-joint-${angleDeg}-${travelDirection}`,
          first.id,
          'end',
          second.id,
          'start',
        )
        joint.transition = { mode: 'manual', lengthM: trimM, directionFlipped: false }
        scene.entities = [
          first,
          second,
          joint,
          makeBody(scene, bodyId, initialPosition, initialVelocity, {
            shape: { type: 'circle', radius, collisionEnabled: true },
            material: { friction: 0, restitution: 0 },
          }),
        ]
        const world = createWorld(scene)
        let maximumRelativeSpeedError = 0
        let passedTransition = false
        let finalPosition = initialPosition
        let finalVelocity = initialVelocity

        for (let step = 0; step < 360; step += 1) {
          world.step()
          const state = stateOf(world, bodyId)
          finalPosition = state.position
          finalVelocity = state.linearVelocity
          const actualSpeed = Math.hypot(state.linearVelocity.x, state.linearVelocity.y)
          maximumRelativeSpeedError = Math.max(
            maximumRelativeSpeedError,
            Math.abs(actualSpeed - speed) / speed,
          )
          if (startsOnFirst) {
            const distanceAlongSecond =
              state.position.x * secondDirection.x + state.position.y * secondDirection.y
            const signedOffset =
              state.position.x * secondNormal.x + state.position.y * secondNormal.y
            passedTransition =
              distanceAlongSecond > trimM + 0.35 && Math.abs(signedOffset - radius) < 0.03
          } else {
            passedTransition =
              state.position.x < -trimM - 0.35 && Math.abs(state.position.y - radius) < 0.03
          }
          if (passedTransition) break
        }

        const caseLabel = `${angleDeg}° / ${travelDirection === 1 ? '正向' : '反向'} / p=(${finalPosition.x.toFixed(3)}, ${finalPosition.y.toFixed(3)}) / v=(${finalVelocity.x.toFixed(3)}, ${finalVelocity.y.toFixed(3)}) / drift=${maximumRelativeSpeedError.toFixed(4)}`
        expect(passedTransition, caseLabel).toBe(true)
        expect(maximumRelativeSpeedError, caseLabel).toBeLessThan(0.005)
      }
    }
  })

  it('180° 分离端点只建立直线连接且不生成发卡碰撞路径', () => {
    const scene = baseScene()
    const first = makeGround(
      scene,
      { type: 'line', start: { x: -6, y: 0 }, end: { x: 0, y: 0 } },
      { friction: 0, restitution: 0 },
    )
    first.id = 'linear-reverse-first'
    const second = makeGround(
      scene,
      { type: 'line', start: { x: 4, y: 3 }, end: { x: -2, y: 3 } },
      { friction: 0, restitution: 0 },
    )
    second.id = 'linear-reverse-second'
    const joint = makeGroundJoint(
      scene,
      'linear-reverse-joint',
      first.id,
      'end',
      second.id,
      'start',
    )
    scene.entities = [first, second, joint]
    const network = buildGroundPathNetwork(scene.entities)
    const resolved = network.jointPaths.get(joint.id)
    const world = createWorld(scene)

    expect(resolved).toMatchObject({ issue: null, kind: 'linear', trimA: 0, trimB: 0 })
    expect(resolved?.path?.length).toBeCloseTo(5)
    expect(resolved?.path?.pointAt(resolved.path.length / 2)).toMatchObject({
      x: expect.closeTo(2),
      y: expect.closeTo(1.5),
    })
    expect(world.warnings.some((warning) => warning.entityId === joint.id)).toBe(false)
  })

  it('小球首次碰到过渡曲线中点的双碰撞片时能直接进入持续路径', () => {
    const scene = baseScene()
    const first = makeGround(
      scene,
      { type: 'line', start: { x: -6, y: 0 }, end: { x: 0, y: 0 } },
      { friction: 0, restitution: 0 },
    )
    first.id = 'direct-transition-first'
    const second = makeGround(
      scene,
      { type: 'line', start: { x: 0, y: 0 }, end: { x: 0, y: 6 } },
      { friction: 0, restitution: 0 },
    )
    second.id = 'direct-transition-second'
    const joint = makeGroundJoint(
      scene,
      'direct-transition-joint',
      first.id,
      'end',
      second.id,
      'start',
    )
    scene.entities = [first, second, joint]
    const network = buildGroundPathNetwork(scene.entities)
    const transitionPath = network.jointPaths.get(joint.id)?.path
    if (!transitionPath) throw new Error('测试场景未生成过渡曲线')
    const startS = transitionPath.length / 2
    const surfacePosition = transitionPath.pointAt(startS)
    const tangent = transitionPath.tangentAt(startS)
    const naturalNormal = transitionPath.normalAt(startS)
    const side = transitionPath.curvatureAt(startS) < 0 ? -1 : 1
    const radius = 0.05
    const speed = 3
    const bodyId = 'direct-transition-ball'
    scene.entities.push(
      makeBody(
        scene,
        bodyId,
        {
          x: surfacePosition.x + naturalNormal.x * side * radius,
          y: surfacePosition.y + naturalNormal.y * side * radius,
        },
        { x: tangent.x * speed, y: tangent.y * speed },
        {
          shape: { type: 'circle', radius, collisionEnabled: true },
          material: { friction: 0, restitution: 0 },
        },
      ),
    )
    const world = createWorld(scene)

    world.step(12)
    const state = stateOf(world, bodyId)
    const closest = transitionPath.closestPoint(state.position)

    expect(Math.abs(closest.distance - radius)).toBeLessThan(0.003)
    expect(
      Math.abs(Math.hypot(state.linearVelocity.x, state.linearVelocity.y) - speed) / speed,
    ).toBeLessThan(0.01)
  })

  it('0° 圆弧或贝塞尔连接失效后仍保持有限的普通碰撞结果', () => {
    const radius = 0.5
    const surfaceRadius = 3
    const centerRadius = surfaceRadius - radius
    const speed = 4
    const startAngle = (4 * Math.PI) / 3
    const circleBezierFactor = 0.5522847498307936

    for (const targetKind of ['arc', 'bezier'] as const) {
      const scene = baseScene()
      const source = makeGround(
        scene,
        {
          type: 'arc',
          center: { x: 0, y: 0 },
          radius: surfaceRadius,
          startRad: Math.PI,
          endRad: (3 * Math.PI) / 2,
        },
        { friction: 0, restitution: 0 },
      )
      source.id = `${targetKind}-source-arc`
      const target = makeGround(
        scene,
        targetKind === 'arc'
          ? {
              type: 'arc',
              center: { x: 0, y: 0 },
              radius: surfaceRadius,
              startRad: (3 * Math.PI) / 2,
              endRad: 2 * Math.PI,
            }
          : {
              type: 'cubicBezier',
              p0: { x: 0, y: -surfaceRadius },
              p1: { x: circleBezierFactor * surfaceRadius, y: -surfaceRadius },
              p2: { x: surfaceRadius, y: -circleBezierFactor * surfaceRadius },
              p3: { x: surfaceRadius, y: 0 },
            },
        { friction: 0, restitution: 0 },
      )
      target.id = `${targetKind}-target-ground`
      const joint = makeGroundJoint(
        scene,
        `${targetKind}-joint`,
        source.id,
        'end',
        target.id,
        'start',
      )
      const bodyId = `${targetKind}-handoff-ball`
      scene.entities = [
        source,
        target,
        joint,
        makeBody(
          scene,
          bodyId,
          {
            x: centerRadius * Math.cos(startAngle),
            y: centerRadius * Math.sin(startAngle),
          },
          {
            x: -Math.sin(startAngle) * speed + Math.cos(startAngle) * 0.5,
            y: Math.cos(startAngle) * speed + Math.sin(startAngle) * 0.5,
          },
          {
            shape: { type: 'circle', radius, collisionEnabled: true },
            material: { friction: 0, restitution: 0 },
          },
        ),
      ]
      const targetPath = buildGroundPathNetwork(scene.entities).groundPaths.get(target.id)?.path
      if (!targetPath) throw new Error('测试场景缺少目标地面路径')
      const world = createWorld(scene)
      expect(world.warnings.some((warning) => warning.entityId === joint.id)).toBe(true)
      world.step(30)
      const referenceSpeed = Math.hypot(
        stateOf(world, bodyId).linearVelocity.x,
        stateOf(world, bodyId).linearVelocity.y,
      )
      let maximumRelativeSpeedJump = 0
      let maximumJumpStep = 0

      for (let step = 0; step < 90; step += 1) {
        world.step()
        const state = stateOf(world, bodyId)
        const currentSpeed = Math.hypot(state.linearVelocity.x, state.linearVelocity.y)
        const relativeSpeedJump = Math.abs(currentSpeed - referenceSpeed) / referenceSpeed
        if (relativeSpeedJump > maximumRelativeSpeedJump) {
          maximumRelativeSpeedJump = relativeSpeedJump
          maximumJumpStep = step
        }
      }
      const finalState = stateOf(world, bodyId)
      const finalSpeed = Math.hypot(finalState.linearVelocity.x, finalState.linearVelocity.y)

      expect(Math.abs(targetPath.closestPoint(finalState.position).distance - radius)).toBeLessThan(
        0.003,
      )
      expect(
        maximumRelativeSpeedJump,
        `${targetKind} / step=${maximumJumpStep} / reference=${referenceSpeed.toFixed(4)} / final=${finalSpeed.toFixed(4)}`,
      ).toBeLessThan(0.03)
      expect(
        Math.abs(finalSpeed ** 2 - referenceSpeed ** 2) / referenceSpeed ** 2,
        targetKind,
      ).toBeLessThan(0.05)
    }
  })

  it('0° 直线—圆弧连接失效后按普通相切碰撞处理', () => {
    const scene = baseScene()
    const line = makeGround(
      scene,
      { type: 'line', start: { x: -4, y: 0 }, end: { x: 0, y: 0 } },
      { friction: 0, restitution: 0 },
    )
    line.id = 'line-before-arc'
    const arc = makeGround(
      scene,
      {
        type: 'arc',
        center: { x: 0, y: 3 },
        radius: 3,
        startRad: -Math.PI / 2,
        endRad: 0,
      },
      { friction: 0, restitution: 0 },
    )
    arc.id = 'arc-after-line'
    scene.entities = [
      line,
      arc,
      makeGroundJoint(scene, 'line-arc-joint', line.id, 'end', arc.id, 'start'),
      makeBody(scene, 'line-arc-ball', { x: -1.5, y: 0.5 }, { x: 5, y: 0 }),
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const world = createWorld(scene)
    expect(world.warnings.some((warning) => warning.entityId === 'line-arc-joint')).toBe(true)
    const initialEnergy = 0.5 * 5 ** 2 + 9.80665 * 0.5

    world.step(55)
    const state = stateOf(world, 'line-arc-ball')
    const finalEnergy =
      0.5 * (state.linearVelocity.x ** 2 + state.linearVelocity.y ** 2) + 9.80665 * state.position.y

    expect(state.position.x).toBeGreaterThan(0.5)
    expect(Math.hypot(state.position.x, state.position.y - 3)).toBeCloseTo(2.5, 2)
    expect(Math.abs(finalEnergy - initialEnergy) / initialEnergy).toBeLessThan(0.02)
  })

  it('0° 圆弧—直线反向连接失效后按普通相切碰撞处理', () => {
    const scene = baseScene()
    const line = makeGround(
      scene,
      { type: 'line', start: { x: -4, y: 0 }, end: { x: 0, y: 0 } },
      { friction: 0, restitution: 0 },
    )
    line.id = 'line-after-arc'
    const arc = makeGround(
      scene,
      {
        type: 'arc',
        center: { x: 0, y: 3 },
        radius: 3,
        startRad: -Math.PI / 2,
        endRad: 0,
      },
      { friction: 0, restitution: 0 },
    )
    arc.id = 'arc-before-line'
    const startAngle = -1.25
    const pathRadius = 2.5
    const speed = 4
    scene.entities = [
      line,
      arc,
      makeGroundJoint(scene, 'arc-line-joint', arc.id, 'start', line.id, 'end'),
      makeBody(
        scene,
        'arc-line-ball',
        {
          x: pathRadius * Math.cos(startAngle),
          y: 3 + pathRadius * Math.sin(startAngle),
        },
        {
          x: speed * Math.sin(startAngle),
          y: -speed * Math.cos(startAngle),
        },
      ),
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const world = createWorld(scene)
    expect(world.warnings.some((warning) => warning.entityId === 'arc-line-joint')).toBe(true)
    const initialPosition = stateOf(world, 'arc-line-ball').position
    const initialEnergy = 0.5 * speed ** 2 + 9.80665 * initialPosition.y

    world.step(50)
    const state = stateOf(world, 'arc-line-ball')
    const finalEnergy =
      0.5 * (state.linearVelocity.x ** 2 + state.linearVelocity.y ** 2) + 9.80665 * state.position.y

    expect(state.position.x).toBeLessThan(-0.5)
    expect(state.position.y).toBeCloseTo(0.5, 2)
    expect(state.linearVelocity.x).toBeLessThan(-3.9)
    expect(Math.abs(finalEnergy - initialEnergy) / initialEnergy).toBeLessThan(0.02)
  })

  it('0° 直线—贝塞尔连接失效后仍可跨越普通相切碰撞', () => {
    const scene = baseScene()
    const line = makeGround(
      scene,
      { type: 'line', start: { x: -4, y: 0 }, end: { x: 0, y: 0 } },
      { friction: 0, restitution: 0 },
    )
    line.id = 'line-before-bezier'
    const bezier = makeGround(
      scene,
      {
        type: 'cubicBezier',
        p0: { x: 0, y: 0 },
        p1: { x: 1, y: 0 },
        p2: { x: 3, y: 0 },
        p3: { x: 4, y: 0 },
      },
      { friction: 0, restitution: 0 },
    )
    bezier.id = 'bezier-after-line'
    scene.entities = [
      line,
      bezier,
      makeGroundJoint(scene, 'line-bezier-joint', line.id, 'end', bezier.id, 'start'),
      makeBody(scene, 'line-bezier-ball', { x: -1.5, y: 0.5 }, { x: 4, y: 0 }),
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const world = createWorld(scene)
    expect(world.warnings.some((warning) => warning.entityId === 'line-bezier-joint')).toBe(true)
    const stepsToCrossJoint = Math.ceil(1.5 / 4 / scene.settings.fixedTimeStep)

    // 只前进到跨缝后的两帧，把连接点冲量与后续贝塞尔折线顶点误差分开验证。
    world.step(stepsToCrossJoint + 2)
    const state = stateOf(world, 'line-bezier-ball')

    expect(state.position.x).toBeGreaterThan(0)
    expect(state.position.y).toBeCloseTo(0.5, 2)
    expect(state.linearVelocity.x).toBeGreaterThan(3.97)
  })

  it('目标圆弧所需支持力为负时连接点不会把小球强制转入圆弧', () => {
    const scene = baseScene()
    const line = makeGround(
      scene,
      { type: 'line', start: { x: -4, y: 3 }, end: { x: 0, y: 3 } },
      { friction: 0, restitution: 0 },
    )
    line.id = 'release-line'
    const arc = makeGround(
      scene,
      {
        type: 'arc',
        center: { x: 0, y: 0 },
        radius: 3,
        startRad: Math.PI / 2,
        endRad: 0,
      },
      { friction: 0, restitution: 0 },
    )
    arc.id = 'release-arc'
    scene.entities = [
      line,
      arc,
      makeGroundJoint(scene, 'release-joint', line.id, 'end', arc.id, 'start'),
      makeBody(scene, 'release-ball', { x: -1.5, y: 3.5 }, { x: 8, y: 0 }),
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const world = createWorld(scene)

    world.step(45)
    const state = stateOf(world, 'release-ball')

    expect(state.position.x).toBeGreaterThan(1)
    expect(Math.hypot(state.position.x, state.position.y)).toBeGreaterThan(3.57)
  })

  it('自由落体正撞地面连接点时仍按普通碰撞处理，不会被沿地面传送', () => {
    const scene = baseScene()
    const left = makeGround(
      scene,
      { type: 'line', start: { x: -4, y: 0 }, end: { x: 0, y: 0 } },
      { friction: 0, restitution: 1 },
    )
    left.id = 'impact-left'
    const right = makeGround(
      scene,
      { type: 'line', start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
      { friction: 0, restitution: 1 },
    )
    right.id = 'impact-right'
    scene.entities = [
      left,
      right,
      makeGroundJoint(scene, 'impact-joint', left.id, 'end', right.id, 'start'),
      makeBody(
        scene,
        'impact-ball',
        { x: 0, y: 2 },
        { x: 0, y: -5 },
        { material: { friction: 0, restitution: 1 } },
      ),
    ]
    const world = createWorld(scene)

    world.step(60)
    const state = stateOf(world, 'impact-ball')

    expect(Math.abs(state.position.x)).toBeLessThan(0.01)
    expect(state.position.y).toBeGreaterThan(1)
    expect(state.linearVelocity.y).toBeGreaterThan(0)
  })

  it('无效地面连接点发出警告并退化为普通独立碰撞', () => {
    const scene = baseScene()
    const left = makeGround(scene, {
      type: 'line',
      start: { x: -4, y: 0 },
      end: { x: 0, y: 0 },
    })
    left.id = 'invalid-left'
    const right = makeGround(scene, {
      type: 'line',
      start: { x: 0.1, y: 0 },
      end: { x: 4, y: 0 },
    })
    right.id = 'invalid-right'
    scene.entities = [
      left,
      right,
      makeGroundJoint(scene, 'invalid-joint', left.id, 'end', right.id, 'start'),
      makeBody(scene, 'invalid-ball', { x: -1, y: 0.5 }, { x: 3, y: 0 }),
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const world = createWorld(scene)

    world.step(80)
    const state = stateOf(world, 'invalid-ball')

    expect(world.warnings.some((warning) => warning.entityId === 'invalid-joint')).toBe(true)
    expect(Number.isFinite(state.position.x)).toBe(true)
    expect(Number.isFinite(state.linearVelocity.x)).toBe(true)
  })

  it('紧曲率源圆弧仍建立有限过渡，并把可跟随性留给具体小球半径判断', () => {
    const scene = baseScene()
    const line = makeGround(scene, {
      type: 'line',
      start: { x: -2, y: 0 },
      end: { x: 0, y: 0 },
    })
    line.id = 'unsafe-transition-line'
    const arc = makeGround(scene, {
      type: 'arc',
      center: { x: -0.25, y: 0 },
      radius: 0.25,
      startRad: 0,
      endRad: Math.PI / 2,
    })
    arc.id = 'unsafe-transition-arc'
    const joint = makeGroundJoint(scene, 'unsafe-transition-joint', line.id, 'end', arc.id, 'start')
    scene.entities = [line, arc, joint]
    const network = buildGroundPathNetwork(scene.entities)
    const world = createWorld(scene)

    const transition = network.jointPaths.get(joint.id)
    expect(transition?.issue).toBeNull()
    expect(transition?.path).not.toBeNull()
    expect(Number.isFinite(transition?.path?.length)).toBe(true)
    expect(network.groundPaths.get(line.id)?.path.length).toBeLessThan(2)
    expect(network.groundPaths.get(arc.id)?.path.length).toBeLessThan((Math.PI * 0.25) / 2)
    expect(world.warnings.some((warning) => warning.entityId === joint.id)).toBe(false)
  })

  it('地面连接点引用缺失或端点冲突时分别发出警告', () => {
    const scene = baseScene()
    const left = makeGround(scene, {
      type: 'line',
      start: { x: -4, y: 0 },
      end: { x: 0, y: 0 },
    })
    left.id = 'warning-left'
    const right = makeGround(scene, {
      type: 'line',
      start: { x: 0, y: 0 },
      end: { x: 4, y: 0 },
    })
    right.id = 'warning-right'
    const fartherRight = makeGround(scene, {
      type: 'line',
      start: { x: 0, y: 0 },
      end: { x: 5, y: 0 },
    })
    fartherRight.id = 'warning-farther-right'
    scene.entities = [
      left,
      right,
      fartherRight,
      makeGroundJoint(scene, 'conflict-first', left.id, 'end', right.id, 'start'),
      makeGroundJoint(scene, 'conflict-second', left.id, 'end', fartherRight.id, 'start'),
      makeGroundJoint(scene, 'missing-joint', 'missing-ground', 'end', right.id, 'end'),
    ]
    const world = createWorld(scene)
    const warningIds = new Set(world.warnings.map((warning) => warning.entityId))

    expect(warningIds.has('conflict-first')).toBe(true)
    expect(warningIds.has('conflict-second')).toBe(true)
    expect(warningIds.has('missing-joint')).toBe(true)
  })

  it('相连地面在远离连接点处再次相交时仍保留真实的第二接触', () => {
    const scene = baseScene()
    const arc = makeGround(
      scene,
      {
        type: 'arc',
        center: { x: 0, y: 0 },
        radius: 3,
        startRad: 0,
        endRad: 2 * Math.PI,
      },
      { friction: 0, restitution: 0 },
    )
    arc.id = 'remote-crossing-arc'
    const crossingBezier = makeGround(
      scene,
      {
        type: 'cubicBezier',
        p0: { x: 3, y: 0 },
        p1: { x: 3, y: 3 },
        p2: { x: -3, y: 5 },
        p3: { x: -3, y: 0 },
      },
      { friction: 0, restitution: 0 },
    )
    crossingBezier.id = 'remote-crossing-bezier'
    scene.entities = [
      arc,
      crossingBezier,
      makeGroundJoint(scene, 'remote-crossing-joint', arc.id, 'end', crossingBezier.id, 'start'),
      makeBody(scene, 'remote-crossing-ball', { x: 0, y: 2.5 }, { x: -4, y: 0 }),
    ]
    const world = createWorld(scene)

    world.step()
    const state = stateOf(world, 'remote-crossing-ball')
    const radialVelocity =
      state.position.x * state.linearVelocity.x + state.position.y * state.linearVelocity.y

    const controlScene = baseScene()
    const controlArc = makeGround(
      controlScene,
      {
        type: 'arc',
        center: { x: 0, y: 0 },
        radius: 3,
        startRad: 0,
        endRad: 2 * Math.PI,
      },
      { friction: 0, restitution: 0 },
    )
    controlArc.id = 'remote-crossing-control-arc'
    controlScene.entities = [
      controlArc,
      makeBody(controlScene, 'remote-crossing-control-ball', { x: 0, y: 2.5 }, { x: -4, y: 0 }),
    ]
    const controlWorld = createWorld(controlScene)
    controlWorld.step()
    const controlState = stateOf(controlWorld, 'remote-crossing-control-ball')
    const controlRadialVelocity =
      controlState.position.x * controlState.linearVelocity.x +
      controlState.position.y * controlState.linearVelocity.y

    expect(Math.abs(controlRadialVelocity)).toBeLessThan(1e-5)
    expect(Math.abs(radialVelocity)).toBeGreaterThan(0.01)
  })

  it('相互分离的直线与圆弧之间不存在额外碰撞线', () => {
    const scene = baseScene()
    const line = makeGround(
      scene,
      { type: 'line', start: { x: -4, y: 4 }, end: { x: -2, y: 4 } },
      { friction: 0, restitution: 0 },
    )
    line.id = 'line-ground'
    const arc = makeGround(
      scene,
      {
        type: 'arc',
        center: { x: 2, y: 0 },
        radius: 1,
        startRad: 0,
        endRad: Math.PI / 2,
      },
      { friction: 0, restitution: 0 },
    )
    arc.id = 'arc-ground'
    scene.entities = [
      line,
      arc,
      makeBody(
        scene,
        'ball',
        { x: 0.5, y: 3 },
        { x: 0, y: 0 },
        {
          shape: { type: 'circle', radius: 0.2, collisionEnabled: true },
        },
      ),
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const world = createWorld(scene)

    world.step(90)
    const state = stateOf(world, 'ball')

    expect(state.position.y).toBeLessThan(1)
    expect(state.linearVelocity.y).toBeLessThan(-7)
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
          shape: { type: 'circle', radius: ballRadius, collisionEnabled: true },
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

  it('高速小球连续绕完整圆轨道时速度和向心力没有接缝尖峰', () => {
    const scene = baseScene()
    const arcRadius = 3
    const ballRadius = 0.5
    const pathRadius = arcRadius - ballRadius
    const speed = 8
    scene.entities = [
      makeGround(
        scene,
        {
          type: 'arc',
          center: { x: 0, y: 0 },
          radius: arcRadius,
          startRad: 0,
          endRad: 2 * Math.PI,
        },
        { friction: 0, restitution: 0 },
      ),
      makeBody(
        scene,
        'fast-orbit-ball',
        { x: 0, y: pathRadius },
        { x: speed, y: 0 },
        {
          shape: { type: 'circle', radius: ballRadius, collisionEnabled: true },
          material: { friction: 0, restitution: 0 },
        },
      ),
    ]
    const world = createWorld(scene)
    const expectedCentripetalForce = speed ** 2 / pathRadius
    const stepCount = Math.ceil(
      (6 * Math.PI * 2 * pathRadius) / speed / scene.settings.fixedTimeStep,
    )
    let maximumSpeedError = 0
    let maximumForceError = 0

    for (let step = 0; step < stepCount; step += 1) {
      world.step()
      if (step < 10) continue
      const state = stateOf(world, 'fast-orbit-ball')
      const actualSpeed = Math.hypot(state.linearVelocity.x, state.linearVelocity.y)
      const actualForce = Math.hypot(state.netForce.x, state.netForce.y)
      maximumSpeedError = Math.max(maximumSpeedError, Math.abs(actualSpeed - speed) / speed)
      maximumForceError = Math.max(
        maximumForceError,
        Math.abs(actualForce - expectedCentripetalForce) / expectedCentripetalForce,
      )
    }

    expect(maximumSpeedError).toBeLessThan(0.01)
    expect(maximumForceError).toBeLessThan(0.01)
  })

  it('带电小球沿持续圆轨道运动时磁场不做功且不会重复积分', () => {
    const scene = baseScene()
    const arcRadius = 3
    const ballRadius = 0.5
    const pathRadius = arcRadius - ballRadius
    const speed = 8
    scene.entities = [
      makeGround(
        scene,
        {
          type: 'arc',
          center: { x: 0, y: 0 },
          radius: arcRadius,
          startRad: 0,
          endRad: 2 * Math.PI,
        },
        { friction: 0, restitution: 0 },
      ),
      makeBody(
        scene,
        'magnetic-orbit-ball',
        { x: 0, y: pathRadius },
        { x: speed, y: 0 },
        {
          chargeC: 1,
          shape: { type: 'circle', radius: ballRadius, collisionEnabled: true },
          material: { friction: 0, restitution: 0 },
        },
      ),
      makeField(scene, 'orbit-magnetic-field', { type: 'uniformMagnetic', bzTesla: 1 }),
    ]
    const world = createWorld(scene)
    world.step(10)
    const reference = stateOf(world, 'magnetic-orbit-ball')
    const referenceSpeed = Math.hypot(reference.linearVelocity.x, reference.linearVelocity.y)
    let maximumRelativeSpeedDrift = 0

    for (let step = 0; step < 3990; step += 1) {
      world.step()
      const state = stateOf(world, 'magnetic-orbit-ball')
      const currentSpeed = Math.hypot(state.linearVelocity.x, state.linearVelocity.y)
      maximumRelativeSpeedDrift = Math.max(
        maximumRelativeSpeedDrift,
        Math.abs(currentSpeed - referenceSpeed) / referenceSpeed,
      )
    }
    const finalState = stateOf(world, 'magnetic-orbit-ball')

    expect(maximumRelativeSpeedDrift).toBeLessThan(0.005)
    expect(Math.hypot(finalState.position.x, finalState.position.y)).toBeCloseTo(pathRadius, 2)
  })

  it('完整圆轨道顶部支持力不足时小球脱轨且不会被重新吸回', () => {
    const scene = baseScene()
    const gravity = 9.80665
    const arcRadius = 3
    const ballRadius = 0.5
    const pathRadius = arcRadius - ballRadius
    const initialSpeed = 2
    expect(initialSpeed).toBeLessThan(Math.sqrt(gravity * pathRadius))

    scene.entities = [
      makeGround(
        scene,
        {
          type: 'arc',
          center: { x: 0, y: 0 },
          radius: arcRadius,
          startRad: 0,
          endRad: 2 * Math.PI,
        },
        { friction: 0, restitution: 0 },
      ),
      makeBody(
        scene,
        'ball',
        { x: 0, y: pathRadius },
        { x: initialSpeed, y: 0 },
        {
          shape: { type: 'circle', radius: ballRadius, collisionEnabled: true },
          material: { friction: 0, restitution: 0 },
        },
      ),
      makeGravity(scene, { x: 0, y: -gravity }),
    ]
    const world = createWorld(scene)

    world.step(60)
    const state = stateOf(world, 'ball')
    const distanceFromCenter = Math.hypot(state.position.x, state.position.y)

    expect(distanceFromCenter).toBeLessThan(pathRadius - 0.25)
    expect(state.position.y).toBeLessThan(pathRadius - 0.75)
  })

  it('已有圆弧接触出现径向分离速度时立即解除约束', () => {
    const scene = baseScene()
    const pathRadius = 2.5
    scene.entities = [
      makeGround(
        scene,
        {
          type: 'arc',
          center: { x: 0, y: 0 },
          radius: 3,
          startRad: 0,
          endRad: 2 * Math.PI,
        },
        { friction: 0, restitution: 0 },
      ),
      makeBody(scene, 'ball', { x: 0, y: pathRadius }, { x: 0, y: -0.1 }),
    ]
    const world = createWorld(scene)

    world.step(60)
    const state = stateOf(world, 'ball')

    expect(Math.hypot(state.position.x, state.position.y)).toBeLessThan(pathRadius - 0.04)
    expect(state.linearVelocity.y).toBeCloseTo(-0.1, 4)
  })

  it('首次求解前已有径向离轨速度时首步不会被 Rapier 修正后立即吸回', () => {
    const scene = baseScene()
    const pathRadius = 2.5
    const bodyId = 'pre-solver-separating-ball'
    scene.entities = [
      makeGround(
        scene,
        {
          type: 'arc',
          center: { x: 0, y: 0 },
          radius: 3,
          startRad: 0,
          endRad: 2 * Math.PI,
        },
        { friction: 0, restitution: 0 },
      ),
      makeBody(scene, bodyId, { x: 0, y: pathRadius }, { x: 8, y: -0.1 }),
    ]
    const world = createWorld(scene)
    const persistentContacts = (
      world as unknown as { persistentGroundContacts: Map<string, unknown> }
    ).persistentGroundContacts

    world.step()
    expect(persistentContacts.has(bodyId)).toBe(false)
    world.step(29)
    expect(persistentContacts.has(bodyId)).toBe(true)
  })

  it('小球越过圆弧端点后保持自由运动', () => {
    const scene = baseScene()
    const pathRadius = 2.5
    const startAngle = 2 * Math.PI - 0.01
    const tangent = { x: -Math.sin(startAngle), y: Math.cos(startAngle) }
    scene.entities = [
      makeGround(
        scene,
        {
          type: 'arc',
          center: { x: 0, y: 0 },
          radius: 3,
          startRad: Math.PI,
          endRad: 2 * Math.PI,
        },
        { friction: 0, restitution: 0 },
      ),
      makeBody(
        scene,
        'ball',
        { x: pathRadius * Math.cos(startAngle), y: pathRadius * Math.sin(startAngle) },
        { x: 2 * tangent.x, y: 2 * tangent.y },
      ),
    ]
    const world = createWorld(scene)

    world.step(30)
    const state = stateOf(world, 'ball')

    expect(state.position.y).toBeGreaterThan(0.4)
    expect(Math.abs(state.linearVelocity.y - 2 * tangent.y)).toBeLessThan(0.001)
  })

  it('高速小球在步中越过开放圆弧端点时从端点切线继续自由推进', () => {
    const scene = baseScene()
    const pathRadius = 2.5
    const speed = 12
    scene.entities = [
      makeGround(
        scene,
        {
          type: 'arc',
          center: { x: 0, y: 0 },
          radius: 3,
          startRad: 0,
          endRad: Math.PI / 2,
        },
        { friction: 0, restitution: 0 },
      ),
      makeBody(scene, 'fast-endpoint-ball', { x: pathRadius, y: 0 }, { x: 0, y: speed }),
    ]
    const world = createWorld(scene)
    world.step(10)
    const referenceState = stateOf(world, 'fast-endpoint-ball')
    const referenceSpeed = Math.hypot(
      referenceState.linearVelocity.x,
      referenceState.linearVelocity.y,
    )
    let exitState = referenceState

    for (let step = 0; step < 90; step += 1) {
      world.step()
      exitState = stateOf(world, 'fast-endpoint-ball')
      if (exitState.position.x < 0) break
    }

    expect(exitState.position.x).toBeLessThan(0)
    expect(exitState.position.x).toBeGreaterThan(-speed * scene.settings.fixedTimeStep)
    expect(exitState.position.y).toBeCloseTo(pathRadius, 4)
    expect(exitState.linearVelocity.x).toBeCloseTo(-referenceSpeed, 3)
    expect(Math.abs(exitState.linearVelocity.y) / referenceSpeed).toBeLessThan(0.002)
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
    scene.settings.pairwiseElectrostatics = true
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

  it('关闭旋转后忽略初角速度并承受偏心弹簧冲量而不漂移角度', () => {
    const scene = baseScene()
    const spring = makeConnector(scene, 'offset-lock-spring', 'first', 'second', {
      type: 'spring',
      restLength: 1.5,
      stiffness: 20,
      damping: 0,
    })
    spring.a.localAnchor = { x: 0, y: 0.25 }
    spring.b.localAnchor = { x: 0, y: -0.25 }
    scene.entities = [
      makeBody(
        scene,
        'first',
        { x: -1, y: 0 },
        { x: 0.5, y: 0 },
        {
          initialAngularVelocityRad: 4,
          rotationEnabled: false,
        },
      ),
      makeBody(
        scene,
        'second',
        { x: 1, y: 0 },
        { x: -0.5, y: 0 },
        {
          preset: 'block',
          shape: { type: 'box', width: 0.8, height: 0.5 },
          initialAngularVelocityRad: -3,
          rotationEnabled: false,
        },
      ),
      spring,
    ]
    const world = createWorld(scene)
    const initialStates = [stateOf(world, 'first'), stateOf(world, 'second')]

    world.step(1200)
    const finalStates = [stateOf(world, 'first'), stateOf(world, 'second')]

    for (let index = 0; index < finalStates.length; index += 1) {
      const initial = initialStates[index]!
      const final = finalStates[index]!
      expect(Math.abs(final.angleRad - initial.angleRad)).toBeLessThan(1e-6)
      expect(final.angularVelocityRad).toBe(0)
      expect(final.rotationalKineticEnergyJ).toBe(0)
    }
  })

  it('锁转小球在有摩擦地面上只改变平动速度而不会进入滚动', () => {
    const scene = baseScene()
    scene.entities = [
      makeGround(
        scene,
        { type: 'line', start: { x: -10, y: 0 }, end: { x: 10, y: 0 } },
        { friction: 1, restitution: 0 },
      ),
      makeBody(
        scene,
        'locked-ball',
        { x: 0, y: 0.5 },
        { x: 4, y: 0 },
        {
          rotationEnabled: false,
          initialAngularVelocityRad: 5,
          material: { friction: 1, restitution: 0 },
        },
      ),
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const world = createWorld(scene)

    world.step(60)
    const state = stateOf(world, 'locked-ball')

    expect(state.linearVelocity.x).toBeLessThan(4)
    expect(state.angularVelocityRad).toBe(0)
    expect(Math.abs(state.angleRad)).toBeLessThan(1e-6)
  })

  it('自由端杆长期转动时保持长度、机械能、质心速度和总角动量', () => {
    const scene = baseScene()
    const first = makeBody(scene, 'first', { x: -1, y: 0 }, { x: 0, y: -1 })
    const second = makeBody(scene, 'second', { x: 1, y: 0 }, { x: 0, y: 1 })
    const rod = makeConnector(scene, 'free-rod', first.id, second.id, {
      type: 'rod',
      length: 2,
      freeRotation: true,
    })
    if (rod.connector.type !== 'rod') throw new Error('长期杆测试需要自由端杆')
    scene.entities = [first, second, rod]
    const world = createWorld(scene)
    const initialEnergy =
      stateOf(world, first.id).kineticEnergyJ + stateOf(world, second.id).kineticEnergyJ
    const initialAngularMomentum = 2
    let maximumLengthError = 0
    let maximumEnergyError = 0

    for (let secondIndex = 0; secondIndex < 300; secondIndex += 1) {
      world.step(120)
      const firstState = stateOf(world, first.id)
      const secondState = stateOf(world, second.id)
      const length = Math.hypot(
        secondState.position.x - firstState.position.x,
        secondState.position.y - firstState.position.y,
      )
      const energy = firstState.kineticEnergyJ + secondState.kineticEnergyJ
      const angularMomentum =
        first.massKg *
          (firstState.position.x * firstState.linearVelocity.y -
            firstState.position.y * firstState.linearVelocity.x) +
        0.5 *
          first.massKg *
          (first.shape.type === 'circle' ? first.shape.radius ** 2 : 0) *
          firstState.angularVelocityRad +
        second.massKg *
          (secondState.position.x * secondState.linearVelocity.y -
            secondState.position.y * secondState.linearVelocity.x) +
        0.5 *
          second.massKg *
          (second.shape.type === 'circle' ? second.shape.radius ** 2 : 0) *
          secondState.angularVelocityRad
      maximumLengthError = Math.max(maximumLengthError, Math.abs(length - rod.connector.length))
      maximumEnergyError = Math.max(
        maximumEnergyError,
        Math.abs(energy - initialEnergy) / initialEnergy,
      )

      expect(firstState.linearVelocity.x + secondState.linearVelocity.x).toBeCloseTo(0, 8)
      expect(firstState.linearVelocity.y + secondState.linearVelocity.y).toBeCloseTo(0, 8)
      expect(angularMomentum).toBeCloseTo(initialAngularMomentum, 3)
    }

    expect(maximumLengthError).toBeLessThan(1e-5)
    expect(maximumEnergyError).toBeLessThan(0.005)
  })

  it('自由端杆对不同质量和非中心锚点施加真实力矩', () => {
    const scene = baseScene()
    const first = makeBody(
      scene,
      'first',
      { x: -1, y: 0 },
      { x: -0.2, y: -1 },
      {
        massKg: 1,
      },
    )
    const second = makeBody(
      scene,
      'second',
      { x: 1, y: 0 },
      { x: 0.1, y: 0.5 },
      {
        massKg: 2,
      },
    )
    const rod = makeConnector(scene, 'offset-rod', first.id, second.id, {
      type: 'rod',
      length: Math.hypot(2, -0.4),
      freeRotation: true,
    })
    if (rod.connector.type !== 'rod') throw new Error('偏心锚点测试需要自由端杆')
    rod.a.localAnchor = { x: 0, y: 0.2 }
    rod.b.localAnchor = { x: 0, y: -0.2 }
    scene.entities = [first, second, rod]
    const world = createWorld(scene)

    world.step(600)
    const firstState = stateOf(world, first.id)
    const secondState = stateOf(world, second.id)
    const anchorPosition = (state: ReturnType<typeof stateOf>, localAnchor: Vec2): Vec2 => ({
      x:
        state.position.x +
        Math.cos(state.angleRad) * localAnchor.x -
        Math.sin(state.angleRad) * localAnchor.y,
      y:
        state.position.y +
        Math.sin(state.angleRad) * localAnchor.x +
        Math.cos(state.angleRad) * localAnchor.y,
    })
    const firstAnchor = anchorPosition(firstState, rod.a.localAnchor)
    const secondAnchor = anchorPosition(secondState, rod.b.localAnchor)

    expect(Math.hypot(secondAnchor.x - firstAnchor.x, secondAnchor.y - firstAnchor.y)).toBeCloseTo(
      rod.connector.length,
      5,
    )
    expect(firstState.linearVelocity.x + 2 * secondState.linearVelocity.x).toBeCloseTo(0, 7)
    expect(firstState.linearVelocity.y + 2 * secondState.linearVelocity.y).toBeCloseTo(0, 7)
    expect(
      Math.abs(firstState.angularVelocityRad) + Math.abs(secondState.angularVelocityRad),
    ).toBeGreaterThan(0.01)
  })

  it('固定端杆把分离锚点校正到配置长度并保持初始相对角度', () => {
    const scene = baseScene()
    const first = makeBody(
      scene,
      'first',
      { x: -1.5, y: 0 },
      { x: 0, y: 0 },
      {
        transform: { position: { x: -1.5, y: 0 }, angleRad: 0.35 },
      },
    )
    const second = makeBody(
      scene,
      'second',
      { x: 1.5, y: 0 },
      { x: 0, y: 0 },
      {
        transform: { position: { x: 1.5, y: 0 }, angleRad: -0.4 },
      },
    )
    const rod = makeConnector(scene, 'fixed-spacer', first.id, second.id, {
      type: 'rod',
      length: 2,
      freeRotation: false,
    })
    scene.entities = [first, second, rod]
    const world = createWorld(scene)

    world.step(240)
    const firstState = stateOf(world, first.id)
    const secondState = stateOf(world, second.id)

    expect(
      Math.hypot(
        secondState.position.x - firstState.position.x,
        secondState.position.y - firstState.position.y,
      ),
    ).toBeCloseTo(2, 4)
    expect(secondState.angleRad - firstState.angleRad).toBeCloseTo(-0.75, 4)
  })

  it('固定端杆保持有限长度和完整相对位姿，并允许双自由物体整体旋转', () => {
    const scene = baseScene()
    const first = makeBody(
      scene,
      'first',
      { x: -1, y: 0 },
      { x: 0, y: -1 },
      {
        initialAngularVelocityRad: 1,
      },
    )
    const second = makeBody(
      scene,
      'second',
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      {
        initialAngularVelocityRad: 1,
      },
    )
    const rod = makeConnector(scene, 'fixed-rod', first.id, second.id, {
      type: 'rod',
      length: 2,
      freeRotation: false,
    })
    scene.entities = [first, second, rod]
    const world = createWorld(scene)

    world.step(120)
    const firstState = stateOf(world, first.id)
    const secondState = stateOf(world, second.id)
    const connectorAngle = Math.atan2(
      secondState.position.y - firstState.position.y,
      secondState.position.x - firstState.position.x,
    )

    expect(
      Math.hypot(
        secondState.position.x - firstState.position.x,
        secondState.position.y - firstState.position.y,
      ),
    ).toBeCloseTo(2, 4)
    expect(secondState.angleRad - firstState.angleRad).toBeCloseTo(0, 4)
    expect(Math.abs(connectorAngle)).toBeGreaterThan(0.5)
  })

  it('固定端杆连接到锁转物体时阻止刚性组合整体旋转', () => {
    const scene = baseScene()
    const first = makeBody(
      scene,
      'first',
      { x: -1, y: 0 },
      { x: 0, y: -1 },
      {
        initialAngularVelocityRad: 1,
        rotationEnabled: false,
      },
    )
    const second = makeBody(
      scene,
      'second',
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      {
        initialAngularVelocityRad: 1,
      },
    )
    const rod = makeConnector(scene, 'fixed-locked-rod', first.id, second.id, {
      type: 'rod',
      length: 2,
      freeRotation: false,
    })
    scene.entities = [first, second, rod]
    const world = createWorld(scene)

    world.step(240)
    const firstState = stateOf(world, first.id)
    const secondState = stateOf(world, second.id)

    expect(Math.abs(firstState.angleRad)).toBeLessThan(1e-6)
    expect(Math.abs(secondState.angleRad)).toBeLessThan(1e-4)
    expect(Math.abs(secondState.position.y - firstState.position.y)).toBeLessThan(1e-4)
    expect(
      Math.hypot(
        secondState.position.x - firstState.position.x,
        secondState.position.y - firstState.position.y,
      ),
    ).toBeCloseTo(2, 4)
  })

  it('自由端杆支持共享物体、链和闭环而不累积杆长误差', () => {
    const scene = baseScene()
    const height = Math.sqrt(3)
    const first = makeBody(scene, 'first', { x: -1, y: 0 }, { x: 0, y: -0.5 })
    const second = makeBody(scene, 'second', { x: 1, y: 0 }, { x: 0.433, y: 0.25 })
    const third = makeBody(scene, 'third', { x: 0, y: height }, { x: -0.433, y: 0.25 })
    const rods = [
      makeConnector(scene, 'rod-a', first.id, second.id, {
        type: 'rod',
        length: 2,
        freeRotation: true,
      }),
      makeConnector(scene, 'rod-b', second.id, third.id, {
        type: 'rod',
        length: 2,
        freeRotation: true,
      }),
      makeConnector(scene, 'rod-c', third.id, first.id, {
        type: 'rod',
        length: 2,
        freeRotation: true,
      }),
    ]
    scene.entities = [first, second, third, ...rods]
    const world = createWorld(scene)

    world.step(1200)
    const states = new Map([first.id, second.id, third.id].map((id) => [id, stateOf(world, id)]))
    for (const rod of rods) {
      const firstState = states.get(rod.a.bodyId)
      const secondState = states.get(rod.b.bodyId)
      if (!firstState || !secondState || rod.connector.type !== 'rod') {
        throw new Error('闭环杆测试缺少有效端点')
      }
      expect(
        Math.hypot(
          secondState.position.x - firstState.position.x,
          secondState.position.y - firstState.position.y,
        ),
      ).toBeCloseTo(rod.connector.length, 5)
    }
  })

  it('自由端杆在单端或双端锁转时仍通过锚点约束距离', () => {
    for (const lockSecond of [false, true]) {
      const scene = baseScene()
      const first = makeBody(
        scene,
        'first',
        { x: -1, y: 0 },
        { x: 0, y: -1 },
        {
          rotationEnabled: false,
        },
      )
      const second = makeBody(
        scene,
        'second',
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        {
          rotationEnabled: !lockSecond,
        },
      )
      const rod = makeConnector(scene, 'locked-free-rod', first.id, second.id, {
        type: 'rod',
        length: 2,
        freeRotation: true,
      })
      rod.a.localAnchor = { x: 0, y: 0.2 }
      rod.b.localAnchor = { x: 0, y: 0.2 }
      scene.entities = [first, second, rod]
      const world = createWorld(scene)

      world.step(600)
      const firstState = stateOf(world, first.id)
      const secondState = stateOf(world, second.id)
      const firstAnchor = {
        x: firstState.position.x - Math.sin(firstState.angleRad) * rod.a.localAnchor.y,
        y: firstState.position.y + Math.cos(firstState.angleRad) * rod.a.localAnchor.y,
      }
      const secondAnchor = {
        x: secondState.position.x - Math.sin(secondState.angleRad) * rod.b.localAnchor.y,
        y: secondState.position.y + Math.cos(secondState.angleRad) * rod.b.localAnchor.y,
      }

      expect(Math.abs(firstState.angleRad)).toBeLessThan(1e-6)
      if (lockSecond) expect(Math.abs(secondState.angleRad)).toBeLessThan(1e-6)
      expect(
        Math.hypot(secondAnchor.x - firstAnchor.x, secondAnchor.y - firstAnchor.y),
      ).toBeCloseTo(2, 5)
    }
  })

  it('自由端杆端点重合时使用确定方向展开且不会产生 NaN', () => {
    const scene = baseScene()
    const collisionless = {
      shape: { type: 'circle' as const, radius: 0.1, collisionEnabled: false },
    }
    scene.entities = [
      makeBody(scene, 'first', { x: 0, y: 0 }, { x: 0, y: 0 }, collisionless),
      makeBody(scene, 'second', { x: 0, y: 0 }, { x: 0, y: 0 }, collisionless),
      makeConnector(scene, 'coincident-rod', 'first', 'second', {
        type: 'rod',
        length: 2,
        freeRotation: true,
      }),
    ]
    const world = createWorld(scene)

    world.step()
    const firstState = stateOf(world, 'first')
    const secondState = stateOf(world, 'second')

    expect(firstState.position.x).toBeCloseTo(-1, 6)
    expect(secondState.position.x).toBeCloseTo(1, 6)
    expect(
      [
        firstState.position.x,
        firstState.position.y,
        secondState.position.x,
        secondState.position.y,
      ].every(Number.isFinite),
    ).toBe(true)
  })

  it('无阻尼弹簧振子的周期符合双质量解析解', () => {
    const scene = baseScene()
    const collisionlessBall = {
      preset: 'ball' as const,
      shape: { type: 'circle' as const, radius: 0.1, collisionEnabled: false },
    }
    scene.entities = [
      makeBody(scene, 'first', { x: -1.5, y: 0 }, { x: 0, y: 0 }, collisionlessBall),
      makeBody(scene, 'second', { x: 1.5, y: 0 }, { x: 0, y: 0 }, collisionlessBall),
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

  it('无阻尼弹簧运行 300 秒时总机械能和速度振幅保持有界', () => {
    const scene = baseScene()
    const collisionlessBall = {
      preset: 'ball' as const,
      shape: { type: 'circle' as const, radius: 0.1, collisionEnabled: false },
    }
    const spring = makeConnector(scene, 'long-spring', 'first', 'second', {
      type: 'spring',
      restLength: 2,
      stiffness: 20,
      damping: 0,
    })
    scene.entities = [
      makeBody(scene, 'first', { x: -1.5, y: 0 }, { x: 0, y: 0 }, collisionlessBall),
      makeBody(scene, 'second', { x: 1.5, y: 0 }, { x: 0, y: 0 }, collisionlessBall),
      spring,
    ]
    const world = createWorld(scene)
    const initialEnergy = springSystemEnergy(world, ['first', 'second'], [spring])
    let maximumRelativeEnergyError = 0
    let firstHalfPeakSpeed = 0
    let secondHalfPeakSpeed = 0

    for (let step = 0; step < 300 * 120; step += 1) {
      world.step()
      const energy = springSystemEnergy(world, ['first', 'second'], [spring])
      maximumRelativeEnergyError = Math.max(
        maximumRelativeEnergyError,
        Math.abs(energy - initialEnergy) / initialEnergy,
      )
      const speed = Math.hypot(
        stateOf(world, 'first').linearVelocity.x,
        stateOf(world, 'first').linearVelocity.y,
      )
      if (step < 150 * 120) firstHalfPeakSpeed = Math.max(firstHalfPeakSpeed, speed)
      else secondHalfPeakSpeed = Math.max(secondHalfPeakSpeed, speed)
    }

    const first = stateOf(world, 'first')
    const second = stateOf(world, 'second')
    expect(maximumRelativeEnergyError).toBeLessThan(0.005)
    expect(Math.abs(secondHalfPeakSpeed - firstHalfPeakSpeed) / firstHalfPeakSpeed).toBeLessThan(
      0.005,
    )
    expect(first.linearVelocity.x + second.linearVelocity.x).toBeCloseTo(0, 6)
    expect(first.linearVelocity.y + second.linearVelocity.y).toBeCloseTo(0, 6)
  })

  it('非零弹簧阻尼只消耗机械能，不会注入能量', () => {
    const scene = baseScene()
    const collisionlessBall = {
      preset: 'ball' as const,
      shape: { type: 'circle' as const, radius: 0.1, collisionEnabled: false },
    }
    const spring = makeConnector(scene, 'damped-spring', 'first', 'second', {
      type: 'spring',
      restLength: 2,
      stiffness: 20,
      damping: 0.5,
    })
    scene.entities = [
      makeBody(scene, 'first', { x: -1.5, y: 0 }, { x: 0, y: 0 }, collisionlessBall),
      makeBody(scene, 'second', { x: 1.5, y: 0 }, { x: 0, y: 0 }, collisionlessBall),
      spring,
    ]
    const world = createWorld(scene)
    const initialEnergy = springSystemEnergy(world, ['first', 'second'], [spring])
    let maximumEnergy = initialEnergy

    for (let step = 0; step < 30 * 120; step += 1) {
      world.step()
      maximumEnergy = Math.max(
        maximumEnergy,
        springSystemEnergy(world, ['first', 'second'], [spring]),
      )
    }

    expect(maximumEnergy).toBeLessThan(initialEnergy * 1.001)
    expect(springSystemEnergy(world, ['first', 'second'], [spring])).toBeLessThan(
      initialEnergy * 0.01,
    )
  })

  it('高刚度弹簧自动使用内部子步并保持有限能量', () => {
    const scene = baseScene()
    const collisionlessBall = {
      preset: 'ball' as const,
      shape: { type: 'circle' as const, radius: 0.1, collisionEnabled: false },
    }
    const spring = makeConnector(scene, 'stiff-spring', 'first', 'second', {
      type: 'spring',
      restLength: 2,
      stiffness: 10_000,
      damping: 0,
    })
    scene.entities = [
      makeBody(scene, 'first', { x: -1.5, y: 0 }, { x: 0, y: 0 }, collisionlessBall),
      makeBody(scene, 'second', { x: 1.5, y: 0 }, { x: 0, y: 0 }, collisionlessBall),
      spring,
    ]
    const world = createWorld(scene)
    const initialEnergy = springSystemEnergy(world, ['first', 'second'], [spring])
    let maximumRelativeEnergyError = 0

    for (let step = 0; step < 10 * 120; step += 1) {
      world.step()
      const energy = springSystemEnergy(world, ['first', 'second'], [spring])
      expect(Number.isFinite(energy)).toBe(true)
      maximumRelativeEnergyError = Math.max(
        maximumRelativeEnergyError,
        Math.abs(energy - initialEnergy) / initialEnergy,
      )
    }

    expect(maximumRelativeEnergyError).toBeLessThan(0.005)
    expect(world.warnings.some((warning) => warning.entityId === spring.id)).toBe(false)
  })

  it('超过 32 子步范围的弹簧限制有效刚度并给出警告', () => {
    const scene = baseScene()
    const collisionlessBall = {
      preset: 'ball' as const,
      shape: { type: 'circle' as const, radius: 0.1, collisionEnabled: false },
    }
    const spring = makeConnector(scene, 'extreme-spring', 'first', 'second', {
      type: 'spring',
      restLength: 2,
      stiffness: 1e12,
      damping: 0,
    })
    scene.entities = [
      makeBody(scene, 'first', { x: -1.5, y: 0 }, { x: 0, y: 0 }, collisionlessBall),
      makeBody(scene, 'second', { x: 1.5, y: 0 }, { x: 0, y: 0 }, collisionlessBall),
      spring,
    ]
    const world = createWorld(scene)

    world.step(120)
    for (const id of ['first', 'second']) {
      const state = stateOf(world, id)
      expect(Number.isFinite(state.position.x)).toBe(true)
      expect(Number.isFinite(state.linearVelocity.x)).toBe(true)
    }
    expect(
      world.warnings.some(
        (warning) => warning.entityId === spring.id && warning.message.includes('32 个内部子步'),
      ),
    ).toBe(true)
  })

  it('不同质量和非零质心速度下仍守恒总动量并保持弹簧能量有界', () => {
    const scene = baseScene()
    const collisionlessBall = {
      preset: 'ball' as const,
      shape: { type: 'circle' as const, radius: 0.1, collisionEnabled: false },
    }
    const spring = makeConnector(scene, 'unequal-spring', 'first', 'second', {
      type: 'spring',
      restLength: 2,
      stiffness: 20,
      damping: 0,
    })
    scene.entities = [
      makeBody(
        scene,
        'first',
        { x: -1.5, y: 0 },
        { x: 1.25, y: 0.2 },
        {
          ...collisionlessBall,
          massKg: 1,
        },
      ),
      makeBody(
        scene,
        'second',
        { x: 1.5, y: 0 },
        { x: 0.25, y: 0.2 },
        {
          ...collisionlessBall,
          massKg: 3,
        },
      ),
      spring,
    ]
    const world = createWorld(scene)
    const initialEnergy = springSystemEnergy(world, ['first', 'second'], [spring])
    const initialMomentum = { x: 2, y: 0.8 }
    let maximumRelativeEnergyError = 0

    for (let step = 0; step < 60 * 120; step += 1) {
      world.step()
      maximumRelativeEnergyError = Math.max(
        maximumRelativeEnergyError,
        Math.abs(springSystemEnergy(world, ['first', 'second'], [spring]) - initialEnergy) /
          initialEnergy,
      )
    }

    const first = stateOf(world, 'first')
    const second = stateOf(world, 'second')
    expect(maximumRelativeEnergyError).toBeLessThan(0.005)
    expect(first.linearVelocity.x + second.linearVelocity.x * 3).toBeCloseTo(initialMomentum.x, 4)
    expect(first.linearVelocity.y + second.linearVelocity.y * 3).toBeCloseTo(initialMomentum.y, 4)
    expect((first.linearVelocity.x + second.linearVelocity.x * 3) / 4).toBeCloseTo(0.5, 4)
  })

  it('非中心弹簧锚点通过力矩交换平动与转动能量且不会持续增能', () => {
    const scene = baseScene()
    const spring = makeConnector(scene, 'offset-spring', 'first', 'second', {
      type: 'spring',
      restLength: 2,
      stiffness: 20,
      damping: 0,
    })
    spring.a.localAnchor = { x: 0, y: 0.2 }
    spring.b.localAnchor = { x: 0, y: -0.2 }
    scene.entities = [
      makeBody(
        scene,
        'first',
        { x: -1.5, y: 0 },
        { x: 0.1, y: 0 },
        {
          shape: { type: 'circle', radius: 0.25, collisionEnabled: true },
        },
      ),
      makeBody(
        scene,
        'second',
        { x: 1.5, y: 0 },
        { x: -0.1, y: 0 },
        {
          shape: { type: 'circle', radius: 0.25, collisionEnabled: true },
        },
      ),
      spring,
    ]
    const world = createWorld(scene)
    const initialEnergy = springSystemEnergy(world, ['first', 'second'], [spring])
    let maximumRelativeEnergyError = 0
    let maximumAngularSpeed = 0

    for (let step = 0; step < 60 * 120; step += 1) {
      world.step()
      maximumRelativeEnergyError = Math.max(
        maximumRelativeEnergyError,
        Math.abs(springSystemEnergy(world, ['first', 'second'], [spring]) - initialEnergy) /
          initialEnergy,
      )
      maximumAngularSpeed = Math.max(
        maximumAngularSpeed,
        Math.abs(stateOf(world, 'first').angularVelocityRad),
        Math.abs(stateOf(world, 'second').angularVelocityRad),
      )
    }

    expect(maximumRelativeEnergyError).toBeLessThan(0.005)
    expect(maximumAngularSpeed).toBeGreaterThan(0.1)
  })

  it('多个无阻尼弹簧共享同一物体时总能量和质心速度保持有界', () => {
    const scene = baseScene()
    const collisionlessBall = {
      preset: 'ball' as const,
      shape: { type: 'circle' as const, radius: 0.1, collisionEnabled: false },
    }
    const firstSpring = makeConnector(scene, 'shared-spring-a', 'first', 'middle', {
      type: 'spring',
      restLength: 2,
      stiffness: 20,
      damping: 0,
    })
    const secondSpring = makeConnector(scene, 'shared-spring-b', 'middle', 'last', {
      type: 'spring',
      restLength: 2,
      stiffness: 20,
      damping: 0,
    })
    scene.entities = [
      makeBody(scene, 'first', { x: -3, y: 0 }, { x: 0.5, y: 0.1 }, collisionlessBall),
      makeBody(scene, 'middle', { x: 0, y: 0 }, { x: 0.2, y: 0.1 }, collisionlessBall),
      makeBody(scene, 'last', { x: 3, y: 0 }, { x: 0.2, y: 0.1 }, collisionlessBall),
      firstSpring,
      secondSpring,
    ]
    const world = createWorld(scene)
    const initialEnergy = springSystemEnergy(
      world,
      ['first', 'middle', 'last'],
      [firstSpring, secondSpring],
    )
    let maximumRelativeEnergyError = 0

    for (let step = 0; step < 60 * 120; step += 1) {
      world.step()
      maximumRelativeEnergyError = Math.max(
        maximumRelativeEnergyError,
        Math.abs(
          springSystemEnergy(world, ['first', 'middle', 'last'], [firstSpring, secondSpring]) -
            initialEnergy,
        ) / initialEnergy,
      )
    }

    const states = ['first', 'middle', 'last'].map((id) => stateOf(world, id))
    expect(maximumRelativeEnergyError).toBeLessThan(0.005)
    expect(states.reduce((sum, state) => sum + state.linearVelocity.x, 0) / 3).toBeCloseTo(0.3, 4)
    expect(states.reduce((sum, state) => sum + state.linearVelocity.y, 0) / 3).toBeCloseTo(0.1, 4)
  })

  it('弹簧沿地面切向拉动持续接触小球时不会穿透或重复施力', () => {
    const scene = baseScene()
    const spring = makeConnector(scene, 'path-spring', 'ground-ball', 'free-ball', {
      type: 'spring',
      restLength: 3,
      stiffness: 20,
      damping: 0,
    })
    scene.entities = [
      makeGround(scene, {
        type: 'line',
        start: { x: -20, y: 0 },
        end: { x: 20, y: 0 },
      }),
      makeBody(scene, 'ground-ball', { x: -1, y: 0.5 }),
      makeBody(
        scene,
        'free-ball',
        { x: 3, y: 0.5 },
        { x: 0, y: 0 },
        {
          shape: { type: 'circle', radius: 0.1, collisionEnabled: false },
        },
      ),
      spring,
    ]
    const world = createWorld(scene)

    world.step(600)
    const grounded = stateOf(world, 'ground-ball')
    expect(Number.isFinite(grounded.linearVelocity.x)).toBe(true)
    expect(grounded.position.y).toBeCloseTo(0.5, 3)
    expect(Math.abs(grounded.linearVelocity.y)).toBeLessThan(0.01)
  })

  it('弹簧连接物体参与弹性碰撞后状态保持有限且总动量守恒', () => {
    const scene = baseScene()
    const spring = makeConnector(scene, 'collision-spring', 'first', 'second', {
      type: 'spring',
      restLength: 3,
      stiffness: 20,
      damping: 0,
    })
    const elasticBall = {
      shape: { type: 'circle' as const, radius: 0.5, collisionEnabled: true },
      material: { friction: 0, restitution: 1 },
    }
    scene.entities = [
      makeBody(scene, 'striker', { x: -4, y: 0 }, { x: 4, y: 0 }, elasticBall),
      makeBody(scene, 'first', { x: -1.5, y: 0 }, { x: 0, y: 0 }, elasticBall),
      makeBody(scene, 'second', { x: 1.5, y: 0 }, { x: 0, y: 0 }, elasticBall),
      spring,
    ]
    const world = createWorld(scene)

    world.step(360)
    const states = ['striker', 'first', 'second'].map((id) => stateOf(world, id))
    expect(states.every((state) => Number.isFinite(state.linearVelocity.x))).toBe(true)
    expect(states.reduce((sum, state) => sum + state.linearVelocity.x, 0)).toBeCloseTo(4, 3)
    expect(Math.abs(stateOf(world, 'second').linearVelocity.x)).toBeGreaterThan(0.1)
  })

  it('物块通过无摩擦地面连接时不产生接缝加速度尖峰', () => {
    for (const direction of [1, -1] as const) {
      const scene = baseScene()
      const first = makeGround(
        scene,
        { type: 'line', start: { x: -10, y: 0 }, end: { x: 0, y: 0 } },
        { friction: 0, restitution: 0 },
      )
      first.id = `block-joint-first-${direction}`
      const second = makeGround(
        scene,
        { type: 'line', start: { x: 0, y: 0 }, end: { x: 0, y: 10 } },
        { friction: 0, restitution: 0 },
      )
      second.id = `block-joint-second-${direction}`
      const joint = makeGroundJoint(
        scene,
        `block-joint-${direction}`,
        first.id,
        'end',
        second.id,
        'start',
      )
      joint.transition = { mode: 'manual', lengthM: 3, directionFlipped: false }
      const bodyId = `block-on-joint-${direction}`
      scene.entities = [
        first,
        second,
        joint,
        makeBody(
          scene,
          bodyId,
          direction === 1 ? { x: -4, y: 0.2 } : { x: -0.2, y: 4 },
          direction === 1 ? { x: 4, y: 0 } : { x: 0, y: -4 },
          {
            preset: 'block',
            shape: { type: 'box', width: 0.4, height: 0.4 },
            material: { friction: 0, restitution: 0 },
            continuousCollisionDetection: false,
          },
        ),
      ]
      const world = createWorld(scene)
      let maximumAcceleration = 0
      let minimumSpeed = 4

      for (let step = 0; step < 180; step += 1) {
        world.step()
        const state = stateOf(world, bodyId)
        maximumAcceleration = Math.max(
          maximumAcceleration,
          Math.hypot(state.acceleration.x, state.acceleration.y),
        )
        minimumSpeed = Math.min(
          minimumSpeed,
          Math.hypot(state.linearVelocity.x, state.linearVelocity.y),
        )
      }

      const label = direction === 1 ? '正向' : '反向'
      expect(maximumAcceleration, label).toBeLessThan(100)
      expect(minimumSpeed, label).toBeGreaterThan(3.5)
    }
  })

  it('相同初始条件和步数会得到可复现结果', () => {
    const scene = baseScene()
    const spring = makeConnector(scene, 'deterministic-spring', 'first', 'second', {
      type: 'spring',
      restLength: 2,
      stiffness: 20,
      damping: 0,
    })
    scene.entities = [
      makeBody(
        scene,
        'first',
        { x: -1.5, y: 4 },
        { x: 2, y: 0 },
        {
          shape: { type: 'circle', radius: 0.1, collisionEnabled: false },
        },
      ),
      makeBody(
        scene,
        'second',
        { x: 1.5, y: 4 },
        { x: 0, y: 0 },
        {
          shape: { type: 'circle', radius: 0.1, collisionEnabled: false },
        },
      ),
      spring,
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const first = createWorld(scene)
    const second = createWorld(scene)
    first.step(240)
    second.step(240)

    expect(first.getBodyStates()).toEqual(second.getBodyStates())
  })
})
