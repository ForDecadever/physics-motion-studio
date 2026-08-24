import { afterEach, describe, expect, it } from 'vitest'

import { distance, scaleEntitiesAroundPivot } from '../../editor/geometry/entityGeometry'
import { createEmptyScene } from '../../scene/model/createEmptyScene'
import { createBezierBlock } from '../../scene/model/entityFactories'
import { createSmoothBezierPathNodes } from '../../scene/model/bezierPath'
import { buildGroundPathNetwork, GROUND_PATH_MIN_OFFSET_SCALE } from '../../scene/model/groundPath'
import type {
  BodyEntity,
  BodyConnectorEndpoint,
  ConnectorEntity,
  ConnectorDefinition,
  FieldDefinition,
  FieldEntity,
  ForceEntity,
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

function pointSegmentDistanceSquared(point: Vec2, start: Vec2, end: Vec2): number {
  const delta = { x: end.x - start.x, y: end.y - start.y }
  const lengthSquared = delta.x ** 2 + delta.y ** 2
  const ratio =
    lengthSquared <= Number.EPSILON
      ? 0
      : Math.min(
          1,
          Math.max(
            0,
            ((point.x - start.x) * delta.x + (point.y - start.y) * delta.y) / lengthSquared,
          ),
        )
  const closest = { x: start.x + delta.x * ratio, y: start.y + delta.y * ratio }
  return (point.x - closest.x) ** 2 + (point.y - closest.y) ** 2
}

function segmentsIntersect(firstStart: Vec2, firstEnd: Vec2, secondStart: Vec2, secondEnd: Vec2) {
  const cross = (first: Vec2, second: Vec2) => first.x * second.y - first.y * second.x
  const firstDelta = { x: firstEnd.x - firstStart.x, y: firstEnd.y - firstStart.y }
  const secondDelta = { x: secondEnd.x - secondStart.x, y: secondEnd.y - secondStart.y }
  const denominator = cross(firstDelta, secondDelta)
  const offset = { x: secondStart.x - firstStart.x, y: secondStart.y - firstStart.y }
  if (Math.abs(denominator) <= Number.EPSILON) return false
  const firstRatio = cross(offset, secondDelta) / denominator
  const secondRatio = cross(offset, firstDelta) / denominator
  return firstRatio >= 0 && firstRatio <= 1 && secondRatio >= 0 && secondRatio <= 1
}

function segmentToAabbDistanceSquared(
  start: Vec2,
  end: Vec2,
  halfWidth: number,
  halfHeight: number,
) {
  const edges: Array<[Vec2, Vec2]> = [
    [
      { x: -halfWidth, y: -halfHeight },
      { x: halfWidth, y: -halfHeight },
    ],
    [
      { x: halfWidth, y: -halfHeight },
      { x: halfWidth, y: halfHeight },
    ],
    [
      { x: halfWidth, y: halfHeight },
      { x: -halfWidth, y: halfHeight },
    ],
    [
      { x: -halfWidth, y: halfHeight },
      { x: -halfWidth, y: -halfHeight },
    ],
  ]
  const inside = (point: Vec2) => Math.abs(point.x) <= halfWidth && Math.abs(point.y) <= halfHeight
  if (inside(start) || inside(end)) return 0
  let minimumDistanceSquared = Number.POSITIVE_INFINITY
  for (const [edgeStart, edgeEnd] of edges) {
    if (segmentsIntersect(start, end, edgeStart, edgeEnd)) return 0
    minimumDistanceSquared = Math.min(
      minimumDistanceSquared,
      pointSegmentDistanceSquared(start, edgeStart, edgeEnd),
      pointSegmentDistanceSquared(end, edgeStart, edgeEnd),
      pointSegmentDistanceSquared(edgeStart, start, end),
      pointSegmentDistanceSquared(edgeEnd, start, end),
    )
  }
  return minimumDistanceSquared
}

describe('格式 8 连接器端点与杆端约束', () => {
  it.each([
    ['fixed', 'free'],
    ['free', 'fixed'],
  ] as const)('杆支持 %s / %s 的单端固定组合', (aRotation, bRotation) => {
    const scene = baseScene()
    const first = makeBody(
      scene,
      'first',
      { x: -1, y: 0 },
      { x: 0, y: -1 },
      {
        shape: { type: 'circle', radius: 0.1, collisionEnabled: false },
        initialAngularVelocityRad: aRotation === 'fixed' ? 1 : 0,
      },
    )
    const second = makeBody(
      scene,
      'second',
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      {
        shape: { type: 'circle', radius: 0.1, collisionEnabled: false },
        initialAngularVelocityRad: bRotation === 'fixed' ? 1 : 0,
      },
    )
    const rod = makeConnector(scene, 'rod', first.id, second.id, {
      type: 'rod',
      length: 2,
      endpointRotation: { a: aRotation, b: bRotation },
    })
    scene.entities = [first, second, rod]
    const world = createWorld(scene)

    world.step(240)
    const firstState = stateOf(world, first.id)
    const secondState = stateOf(world, second.id)
    const rodAngle = Math.atan2(
      secondState.position.y - firstState.position.y,
      secondState.position.x - firstState.position.x,
    )
    const fixedBodyAngle = aRotation === 'fixed' ? firstState.angleRad : secondState.angleRad

    expect(
      Math.hypot(
        secondState.position.x - firstState.position.x,
        secondState.position.y - firstState.position.y,
      ),
    ).toBeCloseTo(2, 4)
    expect(
      Math.abs(
        Math.atan2(Math.sin(rodAngle - fixedBodyAngle), Math.cos(rodAngle - fixedBodyAngle)),
      ),
    ).toBeLessThan(1e-3)
  })

  it('绳、杆和弹簧都可以使用地面固定端点，弹簧也可以使用世界端点', () => {
    const scene = baseScene()
    const ground = makeGround(scene, {
      type: 'line',
      start: { x: -2, y: 2 },
      end: { x: 2, y: 2 },
    })
    const ropeBody = makeBody(scene, 'rope-body', { x: -1, y: 0 }, { x: 0, y: 0 })
    const rodBody = makeBody(
      scene,
      'rod-body',
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      {
        shape: { type: 'circle', radius: 0.1, collisionEnabled: false },
      },
    )
    const springBody = makeBody(
      scene,
      'spring-body',
      { x: 3, y: 0 },
      { x: 0, y: 0 },
      {
        shape: { type: 'circle', radius: 0.1, collisionEnabled: false },
      },
    )
    const rope: ConnectorEntity = makeConnector(scene, 'rope', ropeBody.id, rodBody.id, {
      type: 'rope',
      maxLength: Math.sqrt(5),
    })
    rope.b = { type: 'ground', groundId: ground.id, pathRatio: 0.5 }
    const rod: ConnectorEntity = makeConnector(scene, 'rod', rodBody.id, ropeBody.id, {
      type: 'rod',
      length: 2,
      endpointRotation: { a: 'free', b: 'free' },
    })
    rod.b = { type: 'ground', groundId: ground.id, pathRatio: 0.5 }
    const spring: ConnectorEntity = makeConnector(scene, 'spring', springBody.id, ropeBody.id, {
      type: 'spring',
      restLength: 1,
      stiffness: 20,
      damping: 0,
    })
    spring.b = { type: 'world', position: { x: 1, y: 0 } }
    scene.entities = [ground, ropeBody, rodBody, springBody, rope, rod, spring]
    const world = createWorld(scene)

    world.step(120)
    const rodState = stateOf(world, rodBody.id)
    const springState = stateOf(world, springBody.id)

    expect(Math.hypot(rodState.position.x, rodState.position.y - 2)).toBeCloseTo(2, 4)
    expect(springState.position.x).toBeLessThan(3)
    expect(
      world.warnings.filter(
        (warning) =>
          warning.entityId === rope.id ||
          warning.entityId === rod.id ||
          warning.entityId === spring.id,
      ),
    ).toEqual([])
  })

  it.each(['rope', 'rod'] as const)(
    '质量为零的 %s 碰撞会阻挡物体并把反作用冲量传给动态端点',
    (connectorType) => {
      const scene = baseScene()
      const first = makeBody(
        scene,
        'first',
        { x: -1, y: 0 },
        { x: 0, y: 0 },
        {
          shape: { type: 'circle', radius: 0.1, collisionEnabled: false },
        },
      )
      const second = makeBody(
        scene,
        'second',
        { x: 1, y: 0 },
        { x: 0, y: 0 },
        {
          shape: { type: 'circle', radius: 0.1, collisionEnabled: false },
        },
      )
      const projectile = makeBody(
        scene,
        'projectile',
        { x: 0, y: 1.5 },
        { x: 0, y: -5 },
        {
          shape: { type: 'circle', radius: 0.2, collisionEnabled: true },
          material: { friction: 0, restitution: 1 },
        },
      )
      const definition: ConnectorDefinition =
        connectorType === 'rope'
          ? { type: 'rope', maxLength: 2 }
          : connectorType === 'rod'
            ? {
                type: 'rod',
                length: 2,
                endpointRotation: { a: 'free', b: 'free' },
              }
            : { type: 'spring', restLength: 2, stiffness: 0, damping: 0 }
      const connector = makeConnector(scene, connectorType, first.id, second.id, definition)
      connector.collisionEnabled = true
      if (connectorType === 'rope') connector.massKg = 0.001
      connector.radiusM = 0.08
      connector.material = { friction: 0, restitution: 1 }
      scene.entities = [first, second, projectile, connector]
      const world = createWorld(scene)

      world.step(48)
      const projectileState = stateOf(world, projectile.id)
      const firstState = stateOf(world, first.id)
      const secondState = stateOf(world, second.id)
      const totalMomentumY =
        projectileState.linearVelocity.y +
        firstState.linearVelocity.y +
        secondState.linearVelocity.y

      expect(projectileState.position.y).toBeGreaterThan(0.15)
      expect(projectileState.linearVelocity.y).toBeGreaterThan(-1)
      expect(firstState.linearVelocity.y + secondState.linearVelocity.y).toBeLessThan(-1)
      expect(totalMomentumY).toBeCloseTo(-5, 1)
    },
  )

  it.each(['rope', 'rod'] as const)('高速小球不会穿过固定的零质量 %s', (connectorType) => {
    const scene = baseScene()
    const definition: ConnectorDefinition =
      connectorType === 'rope'
        ? { type: 'rope', maxLength: 2 }
        : connectorType === 'rod'
          ? { type: 'rod', length: 2, endpointRotation: { a: 'free', b: 'free' } }
          : { type: 'spring', restLength: 2, stiffness: 0, damping: 0 }
    const connector: ConnectorEntity = makeConnector(
      scene,
      `fixed-projectile-${connectorType}`,
      'unused-a',
      'unused-b',
      definition,
    )
    connector.a = { type: 'world', position: { x: -1, y: 0 } }
    connector.b = { type: 'world', position: { x: 1, y: 0 } }
    connector.collisionEnabled = true
    if (connectorType === 'rope') connector.massKg = 0.001
    connector.radiusM = 0.05
    connector.material = { friction: 0, restitution: 1 }
    const projectile = makeBody(
      scene,
      `fixed-projectile-body-${connectorType}`,
      { x: 0, y: 0.2 },
      { x: 0, y: -60 },
      {
        shape: { type: 'circle', radius: 0.05, collisionEnabled: true },
        material: { friction: 0, restitution: 1 },
        continuousCollisionDetection: true,
      },
    )
    scene.entities = [connector, projectile]
    const world = createWorld(scene)

    world.step()
    const projectileState = stateOf(world, projectile.id)

    expect(projectileState.position.y).toBeGreaterThanOrEqual(0.098)
    expect(projectileState.linearVelocity.y).toBeGreaterThanOrEqual(-1e-6)
    expect(
      Math.hypot(projectileState.linearVelocity.x, projectileState.linearVelocity.y),
    ).toBeCloseTo(60, 1)
  })

  it('无质量连接体与地面碰撞时把地面反作用力传回两侧端点', () => {
    const scene = baseScene()
    const ground = makeGround(
      scene,
      { type: 'line', start: { x: -5, y: 0 }, end: { x: 5, y: 0 } },
      { friction: 0, restitution: 1 },
    )
    const first = makeBody(
      scene,
      'first',
      { x: -1, y: 0.4 },
      { x: 0, y: -2 },
      {
        shape: { type: 'circle', radius: 0.1, collisionEnabled: false },
      },
    )
    const second = makeBody(
      scene,
      'second',
      { x: 1, y: 0.4 },
      { x: 0, y: -2 },
      {
        shape: { type: 'circle', radius: 0.1, collisionEnabled: false },
      },
    )
    const rope = makeConnector(scene, 'ground-collision-rope', first.id, second.id, {
      type: 'rope',
      maxLength: 2,
    })
    rope.collisionEnabled = true
    rope.radiusM = 0.1
    rope.material = { friction: 0, restitution: 1 }
    scene.entities = [ground, first, second, rope]
    const world = createWorld(scene)

    world.step(36)
    const firstState = stateOf(world, first.id)
    const secondState = stateOf(world, second.id)

    expect((firstState.position.y + secondState.position.y) / 2).toBeGreaterThan(0.08)
    expect(firstState.linearVelocity.y + secondState.linearVelocity.y).toBeGreaterThan(0)
  })

  it.each(['rope', 'rod'] as const)(
    '高速无质量 %s 在一个固定步内穿过地面时由扫掠接触阻挡',
    (connectorType) => {
      const scene = baseScene()
      const ground = makeGround(
        scene,
        { type: 'line', start: { x: -5, y: 0 }, end: { x: 5, y: 0 } },
        { friction: 0, restitution: 1 },
      )
      const first = makeBody(
        scene,
        'first',
        { x: -1, y: 0.2 },
        { x: 0, y: -60 },
        { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
      )
      const second = makeBody(
        scene,
        'second',
        { x: 1, y: 0.2 },
        { x: 0, y: -60 },
        { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
      )
      const definition: ConnectorDefinition =
        connectorType === 'rope'
          ? { type: 'rope', maxLength: 2 }
          : connectorType === 'rod'
            ? { type: 'rod', length: 2, endpointRotation: { a: 'free', b: 'free' } }
            : { type: 'spring', restLength: 2, stiffness: 0, damping: 0 }
      const connector = makeConnector(
        scene,
        `swept-${connectorType}`,
        first.id,
        second.id,
        definition,
      )
      connector.collisionEnabled = true
      connector.radiusM = 0.05
      connector.material = { friction: 0, restitution: 1 }
      scene.entities = [ground, first, second, connector]
      const world = createWorld(scene)

      world.step()
      const firstState = stateOf(world, first.id)
      const secondState = stateOf(world, second.id)

      expect(firstState.linearVelocity.y + secondState.linearVelocity.y).toBeGreaterThan(0)
      expect(Math.min(firstState.position.y, secondState.position.y)).toBeGreaterThanOrEqual(
        connector.radiusM - 0.002,
      )
    },
  )

  it.each(['rope'] as const)('带质量的 %s 在两个节点中间也能连续阻挡高速小球', (connectorType) => {
    const scene = baseScene()
    const connector: ConnectorEntity = makeConnector(
      scene,
      `continuous-massive-${connectorType}`,
      'unused-a',
      'unused-b',
      connectorType === 'rope'
        ? { type: 'rope', maxLength: 4 }
        : { type: 'spring', restLength: 4, stiffness: 20, damping: 0 },
    )
    connector.a = { type: 'world', position: { x: -2, y: 0 } }
    connector.b = { type: 'world', position: { x: 2, y: 0 } }
    connector.massKg = 100
    connector.radiusM = 0.01
    connector.collisionEnabled = true
    connector.material = { friction: 0, restitution: 1 }
    const projectile = makeBody(
      scene,
      `continuous-projectile-${connectorType}`,
      { x: 0.05, y: 0.5 },
      { x: 0, y: -30 },
      {
        shape: { type: 'circle', radius: 0.01, collisionEnabled: true },
        material: { friction: 0, restitution: 1 },
        continuousCollisionDetection: true,
      },
    )
    scene.entities = [connector, projectile]
    const world = createWorld(scene)

    world.step(4)
    const projectileState = stateOf(world, projectile.id)

    expect(projectileState.position.y).toBeGreaterThanOrEqual(0.018)
    expect(projectileState.linearVelocity.y).toBeGreaterThan(0)
  })

  it('零质量杆会连续阻挡高速旋转物块', () => {
    const scene = baseScene()
    const rod: ConnectorEntity = makeConnector(
      scene,
      'continuous-massless-rod-box',
      'unused-a',
      'unused-b',
      { type: 'rod', length: 2, endpointRotation: { a: 'free', b: 'free' } },
    )
    rod.a = { type: 'world', position: { x: -1, y: 0 } }
    rod.b = { type: 'world', position: { x: 1, y: 0 } }
    rod.collisionEnabled = true
    rod.radiusM = 0.05
    rod.material = { friction: 0, restitution: 1 }
    const block = makeBody(
      scene,
      'continuous-rotated-block',
      { x: 0, y: 0.3 },
      { x: 0, y: -30 },
      {
        shape: { type: 'box', width: 0.2, height: 0.1 },
        transform: { position: { x: 0, y: 0.3 }, angleRad: 0.35 },
        material: { friction: 0, restitution: 1 },
        continuousCollisionDetection: true,
      },
    )
    scene.entities = [rod, block]
    const world = createWorld(scene)

    world.step()
    const state = stateOf(world, block.id)

    expect(state.position.y).toBeGreaterThan(0)
    expect(state.linearVelocity.y).toBeGreaterThan(0)
  })

  it('连接器继续排除与自身端点物体的碰撞', () => {
    const scene = baseScene()
    const first = makeBody(scene, 'excluded-endpoint-first', { x: -1, y: 0 })
    const second = makeBody(scene, 'excluded-endpoint-second', { x: 1, y: 0 })
    const rod = makeConnector(scene, 'excluded-endpoint-rod', first.id, second.id, {
      type: 'rod',
      length: 2,
      endpointRotation: { a: 'free', b: 'free' },
    })
    rod.collisionEnabled = true
    rod.radiusM = 0.2
    scene.entities = [first, second, rod]
    const world = createWorld(scene)

    world.step(10)

    expect(stateOf(world, first.id).position).toEqual({ x: -1, y: 0 })
    expect(stateOf(world, second.id).position).toEqual({ x: 1, y: 0 })
  })

  it.each(['rope'] as const)('带质量的 %s 在高速外力下不会穿过地面', (connectorType) => {
    const scene = baseScene()
    const ground = makeGround(
      scene,
      { type: 'line', start: { x: -3, y: 0 }, end: { x: 3, y: 0 } },
      { friction: 0, restitution: 0 },
    )
    const connector: ConnectorEntity = makeConnector(
      scene,
      `continuous-massive-ground-${connectorType}`,
      'unused-a',
      'unused-b',
      connectorType === 'rope'
        ? { type: 'rope', maxLength: 2 }
        : { type: 'spring', restLength: 2, stiffness: 20, damping: 0 },
    )
    connector.a = { type: 'world', position: { x: -1, y: 0.2 } }
    connector.b = { type: 'world', position: { x: 1, y: 0.2 } }
    connector.massKg = 1
    connector.radiusM = 0.05
    connector.collisionEnabled = true
    scene.entities = [ground, connector, makeGravity(scene, { x: 0, y: -7_200 })]
    const world = createWorld(scene)

    world.step()
    const points = world
      .getConnectorStates()
      .find((state) => state.entityId === connector.id)?.points

    expect(points?.length).toBeGreaterThan(2)
    expect(Math.min(...(points?.map((point) => point.y) ?? [-Infinity]))).toBeGreaterThanOrEqual(
      0.048,
    )
  })

  it.each(
    (['rope', 'rod'] as const).flatMap((connectorType) =>
      ([1, -1] as const).map((side) => ({ connectorType, side })),
    ),
  )('无质量 $connectorType 从地面第 $side 侧接近时按双面法线反弹', ({ connectorType, side }) => {
    const scene = baseScene()
    const ground = makeGround(
      scene,
      { type: 'line', start: { x: -5, y: 0 }, end: { x: 5, y: 0 } },
      { friction: 0, restitution: 1 },
    )
    const first = makeBody(
      scene,
      'first',
      { x: -1, y: side * 0.45 },
      { x: 0, y: -side * 3 },
      { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
    )
    const second = makeBody(
      scene,
      'second',
      { x: 1, y: side * 0.45 },
      { x: 0, y: -side * 3 },
      { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
    )
    const definition: ConnectorDefinition =
      connectorType === 'rope'
        ? { type: 'rope', maxLength: 2 }
        : connectorType === 'rod'
          ? { type: 'rod', length: 2, endpointRotation: { a: 'free', b: 'free' } }
          : { type: 'spring', restLength: 2, stiffness: 0, damping: 0 }
    const connector = makeConnector(
      scene,
      `bilateral-${connectorType}-${side}`,
      first.id,
      second.id,
      definition,
    )
    connector.collisionEnabled = true
    connector.radiusM = 0.1
    connector.material = { friction: 0, restitution: 1 }
    scene.entities = [ground, first, second, connector]
    const world = createWorld(scene)

    world.step(36)
    const totalVelocityY =
      stateOf(world, first.id).linearVelocity.y + stateOf(world, second.id).linearVelocity.y

    expect(totalVelocityY * side).toBeGreaterThan(0)
  })

  it.each(
    (['rope', 'rod'] as const).flatMap((connectorType) =>
      (['line', 'arc', 'bezier'] as const).map((groundType) => ({ connectorType, groundType })),
    ),
  )('无质量 $connectorType 与 $groundType 地面发生双面碰撞', ({ connectorType, groundType }) => {
    const scene = baseScene()
    const geometry =
      groundType === 'line'
        ? ({ type: 'line', start: { x: -5, y: 0 }, end: { x: 5, y: 0 } } as const)
        : groundType === 'arc'
          ? ({
              type: 'arc',
              center: { x: 0, y: -10 },
              radius: 10,
              startRad: Math.PI / 4,
              endRad: (Math.PI * 3) / 4,
            } as const)
          : ({
              type: 'cubicBezier',
              p0: { x: -5, y: 0 },
              p1: { x: -2, y: 0 },
              p2: { x: 2, y: 0 },
              p3: { x: 5, y: 0 },
            } as const)
    const ground = makeGround(scene, geometry, { friction: 0, restitution: 1 })
    const first = makeBody(
      scene,
      'first',
      { x: -1, y: 0.45 },
      { x: 0, y: -3 },
      { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
    )
    const second = makeBody(
      scene,
      'second',
      { x: 1, y: 0.45 },
      { x: 0, y: -3 },
      { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
    )
    const definition: ConnectorDefinition =
      connectorType === 'rope'
        ? { type: 'rope', maxLength: 2 }
        : connectorType === 'rod'
          ? { type: 'rod', length: 2, endpointRotation: { a: 'free', b: 'free' } }
          : { type: 'spring', restLength: 2, stiffness: 0, damping: 0 }
    const connector: ConnectorEntity = makeConnector(
      scene,
      `ground-${connectorType}-${groundType}`,
      first.id,
      second.id,
      definition,
    )
    connector.collisionEnabled = true
    connector.radiusM = 0.1
    connector.material = { friction: 0, restitution: 1 }
    scene.entities = [ground, first, second, connector]
    const world = createWorld(scene)

    world.step(36)
    const firstState = stateOf(world, first.id)
    const secondState = stateOf(world, second.id)
    const label = `${connectorType}-${groundType}: y=${firstState.position.y},${secondState.position.y}; vy=${firstState.linearVelocity.y},${secondState.linearVelocity.y}`

    expect(firstState.position.y, label).toBeGreaterThan(-0.2)
    expect(secondState.position.y, label).toBeGreaterThan(-0.2)
    expect(firstState.linearVelocity.y + secondState.linearVelocity.y, label).toBeGreaterThan(0)
  })

  it('无质量连接器会与地面连接点的有限过渡段碰撞', () => {
    const scene = baseScene()
    const firstGround = makeGround(
      scene,
      { type: 'line', start: { x: -10, y: 0 }, end: { x: 0, y: 0 } },
      { friction: 0, restitution: 1 },
    )
    firstGround.id = 'connector-transition-first'
    const secondGround = makeGround(
      scene,
      { type: 'line', start: { x: 0, y: 0 }, end: { x: 0, y: 10 } },
      { friction: 0, restitution: 1 },
    )
    secondGround.id = 'connector-transition-second'
    const joint = makeGroundJoint(
      scene,
      'connector-transition-joint',
      firstGround.id,
      'end',
      secondGround.id,
      'start',
    )
    const baseEntities = [firstGround, secondGround, joint]
    const transitionPath = buildGroundPathNetwork(baseEntities).jointPaths.get(joint.id)?.path
    if (!transitionPath) throw new Error('测试场景未生成地面过渡段')
    const center = transitionPath.pointAt(transitionPath.length / 2)
    const tangent = transitionPath.tangentAt(transitionPath.length / 2)
    const normal = transitionPath.normalAt(transitionPath.length / 2)
    const offset = { x: normal.x * 0.4, y: normal.y * 0.4 }
    const halfSpan = { x: tangent.x * 0.6, y: tangent.y * 0.6 }
    const velocity = { x: -normal.x * 3, y: -normal.y * 3 }
    const first = makeBody(
      scene,
      'first',
      { x: center.x + offset.x - halfSpan.x, y: center.y + offset.y - halfSpan.y },
      velocity,
      { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
    )
    const second = makeBody(
      scene,
      'second',
      { x: center.x + offset.x + halfSpan.x, y: center.y + offset.y + halfSpan.y },
      velocity,
      { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
    )
    const rope = makeConnector(scene, 'transition-collision-rope', first.id, second.id, {
      type: 'rope',
      maxLength: 1.2,
    })
    rope.collisionEnabled = true
    rope.radiusM = 0.1
    rope.material = { friction: 0, restitution: 1 }
    scene.entities = [...baseEntities, first, second, rope]
    const world = createWorld(scene)

    world.step(36)
    const firstState = stateOf(world, first.id)
    const secondState = stateOf(world, second.id)
    const normalVelocity =
      (firstState.linearVelocity.x + secondState.linearVelocity.x) * normal.x +
      (firstState.linearVelocity.y + secondState.linearVelocity.y) * normal.y

    expect(normalVelocity).toBeGreaterThan(0)
  })

  it('场景中存在物块时连接器仍只响应标准地面路径一次', () => {
    const simulate = (includeBlock: boolean): number => {
      const scene = baseScene()
      const ground = makeGround(
        scene,
        { type: 'line', start: { x: -5, y: 0 }, end: { x: 5, y: 0 } },
        { friction: 0, restitution: 1 },
      )
      const first = makeBody(
        scene,
        'first',
        { x: -1, y: 0.45 },
        { x: 0, y: -3 },
        { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
      )
      const second = makeBody(
        scene,
        'second',
        { x: 1, y: 0.45 },
        { x: 0, y: -3 },
        { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
      )
      const rope = makeConnector(scene, 'single-ground-response-rope', first.id, second.id, {
        type: 'rope',
        maxLength: 2,
      })
      rope.collisionEnabled = true
      rope.radiusM = 0.1
      rope.material = { friction: 0, restitution: 1 }
      scene.entities = [ground, first, second, rope]
      if (includeBlock) {
        scene.entities.push(
          makeBody(
            scene,
            'remote-block',
            { x: 50, y: 50 },
            { x: 0, y: 0 },
            { shape: { type: 'box', width: 1, height: 1 } },
          ),
        )
      }
      const world = createWorld(scene)
      world.step(36)
      return stateOf(world, first.id).linearVelocity.y + stateOf(world, second.id).linearVelocity.y
    }

    expect(simulate(true)).toBeCloseTo(simulate(false), 5)
  })

  it.each(['rope'] as const)(
    '带质量的 %s 内部节点会被地面阻挡',
    (connectorType) => {
      const scene = baseScene()
      const ground = makeGround(
        scene,
        { type: 'line', start: { x: -6, y: 0 }, end: { x: 6, y: 0 } },
        { friction: 0, restitution: 0 },
      )
      const connector: ConnectorEntity = makeConnector(
        scene,
        `massive-ground-${connectorType}`,
        'unused-a',
        'unused-b',
        connectorType === 'rope'
          ? { type: 'rope', maxLength: 5 }
          : { type: 'spring', restLength: 4, stiffness: 20, damping: 0 },
      )
      connector.a = { type: 'world', position: { x: -2, y: 1 } }
      connector.b = { type: 'world', position: { x: 2, y: 1 } }
      connector.massKg = 2
      connector.radiusM = 0.08
      connector.collisionEnabled = true
      scene.entities = [ground, connector, makeGravity(scene, { x: 0, y: -9.80665 })]
      const world = createWorld(scene)

      world.step(360)
      const runtime = world.getConnectorStates().find((state) => state.entityId === connector.id)
      const internalPoints = runtime?.points.slice(1, -1) ?? []

      expect(internalPoints.length).toBeGreaterThan(0)
      expect(Math.min(...internalPoints.map((point) => point.y))).toBeGreaterThan(-0.02)
    },
    30_000,
  )

  it('最低质量碰撞绳受到物体撞击后形成柔性折线而不是刚性直杆', () => {
    const scene = baseScene()
    const first = makeBody(
      scene,
      'rope-first',
      { x: -1, y: 0 },
      { x: 0, y: 0 },
      { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
    )
    const second = makeBody(
      scene,
      'rope-second',
      { x: 1, y: 0 },
      { x: 0, y: 0 },
      { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
    )
    const projectile = makeBody(
      scene,
      'rope-projectile',
      { x: 0, y: 0.8 },
      { x: 0, y: -3 },
      { shape: { type: 'circle', radius: 0.2, collisionEnabled: true } },
    )
    const rope = makeConnector(scene, 'flexible-massless-rope', first.id, second.id, {
      type: 'rope',
      maxLength: 2.4,
    })
    rope.collisionEnabled = true
    rope.radiusM = 0.05
    scene.entities = [first, second, projectile, rope]
    const world = createWorld(scene)

    world.step(48)
    const runtime = world.getConnectorStates().find((state) => state.entityId === rope.id)
    const interior = runtime?.points.slice(1, -1) ?? []

    expect(runtime?.points.length).toBeGreaterThan(2)
    expect(interior.some((point) => Math.abs(point.y) > 0.02)).toBe(true)
  })

  it.each([0.001, 0.005, 0.01, 1])(
    '质量为 %s kg 的碰撞绳受到端点持续外拉时整条弧长不超过最大长度',
    (ropeMassKg) => {
      const scene = baseScene()
      const first = makeBody(
        scene,
        'massive-rope-first',
        { x: -1, y: 0 },
        { x: -5, y: 0 },
        { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
      )
      const second = makeBody(
        scene,
        'massive-rope-second',
        { x: 1, y: 0 },
        { x: 5, y: 0 },
        { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
      )
      const rope = makeConnector(scene, 'inextensible-massive-rope', first.id, second.id, {
        type: 'rope',
        maxLength: 2,
      })
      rope.massKg = ropeMassKg
      rope.collisionEnabled = true
      rope.radiusM = 0.05
      scene.entities = [first, second, rope]
      const world = createWorld(scene)

      world.step(240)
      const points = world.getConnectorStates().find((state) => state.entityId === rope.id)?.points
      const length =
        points?.slice(1).reduce((sum, point, index) => {
          const previous = points[index]!
          return sum + Math.hypot(point.x - previous.x, point.y - previous.y)
        }, 0) ?? Infinity
      const maximumLinkLength =
        points?.slice(1).reduce((maximum, point, index) => {
          const previous = points[index]!
          return Math.max(maximum, Math.hypot(point.x - previous.x, point.y - previous.y))
        }, 0) ?? Infinity
      const perLinkTolerance = Math.max(1e-4, 2 * 1e-4) / (points!.length - 1)

      expect(length).toBeLessThanOrEqual(2.0002)
      expect(maximumLinkLength).toBeLessThanOrEqual(2 / (points!.length - 1) + perLinkTolerance)
    },
  )

  it('接近拉直的最低质量长绳不会在重力下形成规则锯齿', () => {
    const scene = baseScene()
    const rope: ConnectorEntity = makeConnector(
      scene,
      'near-taut-vertical-rope',
      'unused-a',
      'unused-b',
      { type: 'rope', maxLength: 10 },
    )
    rope.a = { type: 'world', position: { x: 0, y: 5 } }
    rope.b = { type: 'world', position: { x: 0, y: -5 } }
    rope.massKg = 0.001
    rope.collisionEnabled = true
    rope.radiusM = 0.05
    scene.entities = [rope, makeGravity(scene, { x: 0.25, y: -9.80665 })]
    const world = createWorld(scene)

    world.step(600)
    const points = world.getConnectorStates().find((state) => state.entityId === rope.id)?.points
    expect(points).toBeDefined()
    const maximumLinkLength = Math.max(
      ...points!.slice(1).map((point, index) => distance(points![index]!, point)),
    )
    const maximumAlternatingOffset = Math.max(
      ...points!.slice(1, -1).map((point, index) => {
        const previous = points![index]!
        const next = points![index + 2]!
        return Math.hypot(point.x - (previous.x + next.x) / 2, point.y - (previous.y + next.y) / 2)
      }),
    )
    expect(maximumLinkLength).toBeLessThanOrEqual(10 / (points!.length - 1) + 0.00001)
    expect(maximumAlternatingOffset).toBeLessThan(0.01)
  }, 30_000)

  it('旧存档中的无解固定端绳会安全拉直并显示明确警告', () => {
    const scene = baseScene()
    const rope: ConnectorEntity = makeConnector(
      scene,
      'legacy-impossible-fixed-rope',
      'unused-a',
      'unused-b',
      { type: 'rope', maxLength: 2 },
    )
    rope.a = { type: 'world', position: { x: -2, y: 0 } }
    rope.b = { type: 'world', position: { x: 2, y: 0 } }
    rope.massKg = 0.001
    rope.collisionEnabled = true
    scene.entities = [rope]
    const world = createWorld(scene)

    world.step(120)

    const points = world.getConnectorStates().find((state) => state.entityId === rope.id)?.points
    expect(points).toBeDefined()
    expect(points!.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(
      true,
    )
    expect(distance(points![0]!, points!.at(-1)!)).toBeCloseTo(4, 6)
    expect(Math.max(...points!.map((point) => Math.abs(point.y)))).toBeLessThan(1e-6)
    expect(
      world.warnings.some(
        (warning) => warning.entityId === rope.id && warning.message.includes('超过最大长度'),
      ),
    ).toBe(true)
  })

  it('最低质量碰撞绳在重力和地面接触下不累积伸长', () => {
    const scene = baseScene()
    const ground = makeGround(
      scene,
      { type: 'line', start: { x: -8, y: 0 }, end: { x: 8, y: 0 } },
      { friction: 0, restitution: 0 },
    )
    const rope: ConnectorEntity = makeConnector(
      scene,
      'minimum-mass-rope',
      'unused-a',
      'unused-b',
      {
        type: 'rope',
        maxLength: 4.5,
      },
    )
    rope.a = { type: 'world', position: { x: -2, y: 1 } }
    rope.b = { type: 'world', position: { x: 2, y: 1 } }
    rope.massKg = 0.001
    rope.collisionEnabled = true
    rope.radiusM = 0.05
    scene.entities = [ground, rope, makeGravity(scene, { x: 0, y: -9.80665 })]
    const world = createWorld(scene)
    let maximumLength = 0

    for (let index = 0; index < 1200; index += 1) {
      world.step()
      const points = world.getConnectorStates().find((state) => state.entityId === rope.id)?.points
      const length =
        points?.slice(1).reduce((sum, point, pointIndex) => {
          const previous = points[pointIndex]!
          return sum + Math.hypot(point.x - previous.x, point.y - previous.y)
        }, 0) ?? Infinity
      maximumLength = Math.max(maximumLength, length)
    }

    expect(maximumLength).toBeLessThanOrEqual(4.50045)
  }, 30_000)

  it('最低质量的 64 段长绳承受高速端点外拉时仍保持总弧长', () => {
    const scene = baseScene()
    const first = makeBody(
      scene,
      'long-rope-first',
      { x: -5, y: 0 },
      { x: -30, y: 0 },
      { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
    )
    const second = makeBody(
      scene,
      'long-rope-second',
      { x: 5, y: 0 },
      { x: 30, y: 0 },
      { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
    )
    const rope = makeConnector(scene, 'long-minimum-mass-rope', first.id, second.id, {
      type: 'rope',
      maxLength: 10,
    })
    rope.massKg = 0.001
    rope.collisionEnabled = true
    rope.radiusM = 0.01
    scene.entities = [first, second, rope]
    const world = createWorld(scene)
    let maximumLength = 0

    for (let index = 0; index < 1200; index += 1) {
      world.step()
      const points = world.getConnectorStates().find((state) => state.entityId === rope.id)?.points
      const length =
        points?.slice(1).reduce((sum, point, pointIndex) => {
          const previous = points[pointIndex]!
          return sum + Math.hypot(point.x - previous.x, point.y - previous.y)
        }, 0) ?? Infinity
      maximumLength = Math.max(maximumLength, length)
    }

    expect(world.getConnectorStates()[0]?.points).toHaveLength(65)
    expect(maximumLength).toBeLessThanOrEqual(10.001)
  }, 30_000)

  it('最低质量绳被高速物体撞弯后仍满足总弧长约束', () => {
    const scene = baseScene()
    const projectile = makeBody(
      scene,
      'minimum-mass-rope-projectile',
      { x: 0, y: 1.2 },
      { x: 0, y: -60 },
      {
        shape: { type: 'circle', radius: 0.15, collisionEnabled: true },
        continuousCollisionDetection: true,
      },
    )
    const rope: ConnectorEntity = makeConnector(
      scene,
      'minimum-mass-impact-rope',
      'unused-a',
      'unused-b',
      {
        type: 'rope',
        maxLength: 2.4,
      },
    )
    rope.a = { type: 'world', position: { x: -1, y: 0 } }
    rope.b = { type: 'world', position: { x: 1, y: 0 } }
    rope.massKg = 0.001
    rope.collisionEnabled = true
    rope.radiusM = 0.05
    rope.material.restitution = 0
    scene.entities = [projectile, rope]
    const world = createWorld(scene)
    let maximumLength = 0
    let maximumLengthStep = -1
    let maximumLengthPoints: Array<{ x: number; y: number }> = []

    for (let index = 0; index < 120; index += 1) {
      world.step()
      const points = world.getConnectorStates().find((state) => state.entityId === rope.id)?.points
      const length =
        points?.slice(1).reduce((sum, point, pointIndex) => {
          const previous = points[pointIndex]!
          return sum + Math.hypot(point.x - previous.x, point.y - previous.y)
        }, 0) ?? Infinity
      if (length > maximumLength) {
        maximumLength = length
        maximumLengthStep = index
        maximumLengthPoints = points?.map((point) => ({ ...point })) ?? []
      }
    }

    expect(
      maximumLength,
      `step=${maximumLengthStep}; points=${JSON.stringify(maximumLengthPoints)}`,
    ).toBeLessThanOrEqual(2.40024)
  })

  it('单自由端弹簧沿轴向压缩后将小球弹出', () => {
    const scene = baseScene()
    const spring: ConnectorEntity = makeConnector(
      scene,
      'single-free-bumper',
      'unused-a',
      'unused-b',
      { type: 'spring', restLength: 2, stiffness: 200, damping: 0 },
    )
    spring.a = { type: 'world', position: { x: 0, y: 0 } }
    spring.b = { type: 'free', position: { x: 2, y: 0 } }
    spring.radiusM = 0.05
    const projectile = makeBody(scene, 'projectile', { x: 3, y: 0 }, { x: -4, y: 0 })
    scene.entities = [spring, projectile]
    const world = createWorld(scene)
    let minimumLength = Infinity

    for (let index = 0; index < 180; index += 1) {
      world.step()
      const points = world
        .getConnectorStates()
        .find((state) => state.entityId === spring.id)?.points
      if (points?.length === 2)
        minimumLength = Math.min(minimumLength, distance(points[0]!, points[1]!))
    }

    expect(minimumLength).toBeLessThan(1.95)
    expect(stateOf(world, projectile.id).linearVelocity.x).toBeGreaterThan(0)
    expect(spring.b).toEqual({ type: 'free', position: { x: 2, y: 0 } })
  })

  it('短于原长的自由端弹簧停止时保留预压几何，首个物理步展开到原长', () => {
    const scene = baseScene()
    const initialLength = 1
    const spring: ConnectorEntity = makeConnector(
      scene,
      `independent-length-${initialLength}`,
      'unused-a',
      'unused-b',
      { type: 'spring', restLength: 2, stiffness: 200, damping: 0 },
    )
    spring.a = { type: 'world', position: { x: 0, y: 0 } }
    spring.b = { type: 'free', position: { x: initialLength, y: 0 } }
    scene.entities = [spring]

    const world = createWorld(scene)
    const stoppedPoints = world.getConnectorStates()[0]?.points

    expect(stoppedPoints).toHaveLength(2)
    expect(distance(stoppedPoints![0]!, stoppedPoints![1]!)).toBeCloseTo(initialLength, 6)

    world.step()
    const runningPoints = world.getConnectorStates()[0]?.points
    expect(distance(runningPoints![0]!, runningPoints![1]!)).toBeCloseTo(2, 6)
  })

  it('长于原长的单自由端和双自由端弹簧只在首个物理步归到原长', () => {
    const singleScene = baseScene()
    const single: ConnectorEntity = makeConnector(
      singleScene,
      'single-relaxed-spring',
      'unused-a',
      'unused-b',
      {
        type: 'spring',
        restLength: 2,
        stiffness: 100,
        damping: 0,
      },
    )
    single.a = { type: 'world', position: { x: 0, y: 0 } }
    single.b = { type: 'free', position: { x: 3, y: 0 } }
    singleScene.entities = [single]

    const doubleScene = baseScene()
    const double: ConnectorEntity = makeConnector(
      doubleScene,
      'double-relaxed-spring',
      'unused-a',
      'unused-b',
      {
        type: 'spring',
        restLength: 2,
        stiffness: 100,
        damping: 0,
      },
    )
    double.a = { type: 'free', position: { x: -2, y: 0 } }
    double.b = { type: 'free', position: { x: 2, y: 0 } }
    doubleScene.entities = [double]

    const singleWorld = createWorld(singleScene)
    const doubleWorld = createWorld(doubleScene)
    const stoppedSinglePoints = singleWorld.getConnectorStates()[0]?.points
    const stoppedDoublePoints = doubleWorld.getConnectorStates()[0]?.points

    expect(distance(stoppedSinglePoints![0]!, stoppedSinglePoints![1]!)).toBeCloseTo(3, 6)
    expect(distance(stoppedDoublePoints![0]!, stoppedDoublePoints![1]!)).toBeCloseTo(4, 6)

    singleWorld.step()
    doubleWorld.step()
    const runningSinglePoints = singleWorld.getConnectorStates()[0]?.points
    const runningDoublePoints = doubleWorld.getConnectorStates()[0]?.points

    expect(distance(runningSinglePoints![0]!, runningSinglePoints![1]!)).toBeCloseTo(2, 6)
    expect(distance(runningDoublePoints![0]!, runningDoublePoints![1]!)).toBeCloseTo(2, 6)
    expect((runningDoublePoints![0]!.x + runningDoublePoints![1]!.x) / 2).toBeCloseTo(0, 6)
    expect(single.b).toEqual({ type: 'free', position: { x: 3, y: 0 } })
    expect(double.a).toEqual({ type: 'free', position: { x: -2, y: 0 } })
    expect(double.b).toEqual({ type: 'free', position: { x: 2, y: 0 } })
  })

  it('短于原长的自由端弹簧在挡板接触时释放预压能量', () => {
    const scene = baseScene()
    const spring: ConnectorEntity = makeConnector(
      scene,
      'preloaded-free-spring',
      'unused-a',
      'unused-b',
      { type: 'spring', restLength: 2, stiffness: 100, damping: 0 },
    )
    spring.a = { type: 'world', position: { x: 0, y: 0 } }
    spring.b = { type: 'free', position: { x: 1, y: 0 } }
    const projectile = makeBody(scene, 'preload-projectile', { x: 1.5, y: 0 }, { x: 0, y: 0 })
    scene.entities = [spring, projectile]
    const world = createWorld(scene)

    world.step(10)

    expect(stateOf(world, projectile.id).linearVelocity.x).toBeGreaterThan(0)
    const points = world.getConnectorStates().find((state) => state.entityId === spring.id)?.points
    expect(points).toHaveLength(2)
    expect(distance(points![0]!, points![1]!)).toBeGreaterThan(1)
  })

  it('自由端接触半径只扩大挡板横向范围，不会提前轴向反弹', () => {
    const scene = baseScene()
    const spring: ConnectorEntity = makeConnector(
      scene,
      'wide-free-spring',
      'unused-a',
      'unused-b',
      { type: 'spring', restLength: 2, stiffness: 500, damping: 0 },
    )
    spring.a = { type: 'world', position: { x: 0, y: 0 } }
    spring.b = { type: 'free', position: { x: 2, y: 0 } }
    spring.radiusM = 0.4
    const projectile = makeBody(scene, 'wide-cap-projectile', { x: 2.85, y: 0 }, { x: -1, y: 0 })
    scene.entities = [spring, projectile]
    const world = createWorld(scene)

    world.step(10)

    expect(stateOf(world, projectile.id).linearVelocity.x).toBeCloseTo(-1, 5)
    const points = world.getConnectorStates()[0]?.points
    expect(points).toHaveLength(2)
    expect(distance(points![0]!, points![1]!)).toBeCloseTo(2, 5)
  })

  it('单自由端弹簧跟随所连物体的平移和旋转', () => {
    const scene = baseScene()
    const anchor = makeBody(
      scene,
      'moving-anchor',
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { shape: { type: 'box', width: 1, height: 1 }, initialAngularVelocityRad: Math.PI },
    )
    const spring: ConnectorEntity = makeConnector(scene, 'following-spring', anchor.id, 'unused', {
      type: 'spring',
      restLength: 2,
      stiffness: 20,
      damping: 0,
    })
    spring.b = { type: 'free', position: { x: 2, y: 0 } }
    scene.entities = [anchor, spring]
    const world = createWorld(scene)

    world.step(30)
    const anchorState = stateOf(world, anchor.id)
    const points = world.getConnectorStates().find((state) => state.entityId === spring.id)?.points
    if (!points || points.length !== 2) throw new Error('缺少自由端弹簧运行点')
    const runtimeAxis = {
      x: (points[1]!.x - points[0]!.x) / distance(points[0]!, points[1]!),
      y: (points[1]!.y - points[0]!.y) / distance(points[0]!, points[1]!),
    }

    expect(points[0]).toEqual(anchorState.position)
    expect(distance(points[0]!, points[1]!)).toBeCloseTo(2, 5)
    expect(runtimeAxis.x).toBeCloseTo(Math.cos(anchorState.angleRad), 4)
    expect(runtimeAxis.y).toBeCloseTo(Math.sin(anchorState.angleRad), 4)
  })

  it('双自由端弹簧围绕固定中点联动压缩并从两侧反弹', () => {
    const scene = baseScene()
    const spring: ConnectorEntity = makeConnector(
      scene,
      'double-free-bumper',
      'unused-a',
      'unused-b',
      {
        type: 'spring',
        restLength: 2,
        stiffness: 200,
        damping: 0,
      },
    )
    spring.a = { type: 'free', position: { x: -1, y: 0 } }
    spring.b = { type: 'free', position: { x: 1, y: 0 } }
    const left = makeBody(scene, 'left-projectile', { x: -2, y: 0 }, { x: 4, y: 0 })
    const right = makeBody(scene, 'right-projectile', { x: 2, y: 0 }, { x: -4, y: 0 })
    scene.entities = [spring, left, right]
    const world = createWorld(scene)
    let minimumLength = Infinity

    for (let index = 0; index < 180; index += 1) {
      world.step()
      const points = world
        .getConnectorStates()
        .find((state) => state.entityId === spring.id)?.points
      if (!points || points.length !== 2) continue
      minimumLength = Math.min(minimumLength, distance(points[0]!, points[1]!))
      expect(Math.abs((points[0]!.x + points[1]!.x) / 2)).toBeLessThan(1e-6)
    }

    expect(minimumLength).toBeLessThan(1.95)
    expect(stateOf(world, left.id).linearVelocity.x).toBeLessThan(0)
    expect(stateOf(world, right.id).linearVelocity.x).toBeGreaterThan(0)
  })

  it('双自由端预压弹簧对不同质量小球施加相同力而产生不同加速度', () => {
    const scene = baseScene()
    const spring: ConnectorEntity = makeConnector(
      scene,
      'unequal-mass-double-free-bumper',
      'unused-a',
      'unused-b',
      {
        type: 'spring',
        restLength: 4,
        stiffness: 100,
        damping: 0,
      },
    )
    spring.a = { type: 'free', position: { x: -1, y: 0 } }
    spring.b = { type: 'free', position: { x: 1, y: 0 } }
    const light = makeBody(
      scene,
      'light-projectile',
      { x: -1.5, y: 0 },
      { x: 0, y: 0 },
      {
        massKg: 1,
      },
    )
    const heavy = makeBody(
      scene,
      'heavy-projectile',
      { x: 1.5, y: 0 },
      { x: 0, y: 0 },
      {
        massKg: 5,
      },
    )
    scene.entities = [spring, light, heavy]
    const world = createWorld(scene)

    world.step()
    const lightFirstStep = stateOf(world, light.id)
    const heavyFirstStep = stateOf(world, heavy.id)
    expect(Math.abs(lightFirstStep.netForce.x)).toBeCloseTo(Math.abs(heavyFirstStep.netForce.x), 3)
    expect(Math.abs(lightFirstStep.acceleration.x)).toBeCloseTo(
      Math.abs(heavyFirstStep.acceleration.x) * 5,
      3,
    )

    world.step(119)
    const lightFinalVelocity = stateOf(world, light.id).linearVelocity.x
    const heavyFinalVelocity = stateOf(world, heavy.id).linearVelocity.x
    const lightFinalSpeed = Math.abs(lightFinalVelocity)
    const heavyFinalSpeed = Math.abs(heavyFinalVelocity)
    expect(lightFinalSpeed).toBeGreaterThan(heavyFinalSpeed * 1.5)
    expect(lightFinalVelocity + heavyFinalVelocity * 5).toBeCloseTo(0, 3)
  })

  it('自由端弹簧不阻挡侧向经过的物体', () => {
    const scene = baseScene()
    const spring: ConnectorEntity = makeConnector(
      scene,
      'side-pass-spring',
      'unused-a',
      'unused-b',
      {
        type: 'spring',
        restLength: 2,
        stiffness: 500,
        damping: 0,
      },
    )
    spring.a = { type: 'world', position: { x: 0, y: 0 } }
    spring.b = { type: 'free', position: { x: 2, y: 0 } }
    const projectile = makeBody(scene, 'side-projectile', { x: 2.25, y: 1 }, { x: 0, y: -4 })
    scene.entities = [spring, projectile]
    const world = createWorld(scene)

    world.step(60)
    const state = stateOf(world, projectile.id)

    expect(state.linearVelocity.x).toBeCloseTo(0, 5)
    expect(state.linearVelocity.y).toBeCloseTo(-4, 3)
  })

  it('自由端弹簧在高速压缩到底时不会穿过基部', () => {
    const scene = baseScene()
    const spring: ConnectorEntity = makeConnector(
      scene,
      'hard-stop-spring',
      'unused-a',
      'unused-b',
      {
        type: 'spring',
        restLength: 2,
        stiffness: 20,
        damping: 0,
      },
    )
    spring.a = { type: 'world', position: { x: 0, y: 0 } }
    spring.b = { type: 'free', position: { x: 2, y: 0 } }
    const projectile = makeBody(scene, 'fast-projectile', { x: 3, y: 0 }, { x: -100, y: 0 })
    scene.entities = [spring, projectile]
    const world = createWorld(scene)

    world.step(8)

    expect(stateOf(world, projectile.id).position.x).toBeGreaterThanOrEqual(0.249)
  })

  it('自由端弹簧反弹旋转物块且不把侧向速度转换为轴向冲量', () => {
    const scene = baseScene()
    const spring: ConnectorEntity = makeConnector(
      scene,
      'rotated-box-bumper',
      'unused-a',
      'unused-b',
      { type: 'spring', restLength: 2, stiffness: 200, damping: 0 },
    )
    spring.a = { type: 'world', position: { x: 0, y: 0 } }
    spring.b = { type: 'free', position: { x: 2, y: 0 } }
    const box = makeBody(
      scene,
      'rotated-box',
      { x: 3, y: 0.15 },
      { x: -3, y: 0.4 },
      {
        preset: 'block',
        shape: { type: 'box', width: 0.6, height: 1 },
        transform: { position: { x: 3, y: 0.15 }, angleRad: 0.4 },
      },
    )
    scene.entities = [spring, box]
    const world = createWorld(scene)

    world.step(240)
    const state = stateOf(world, box.id)

    expect(state.linearVelocity.x).toBeGreaterThan(0)
    expect(state.linearVelocity.y).toBeCloseTo(0.4, 2)
  })

  it('自由端弹簧与动态锚点交换等大反向动量并保持无阻尼机械能', () => {
    const scene = baseScene()
    const anchor = makeBody(scene, 'dynamic-anchor', { x: 0, y: 0 }, { x: 0, y: 0 })
    const spring: ConnectorEntity = makeConnector(scene, 'dynamic-bumper', anchor.id, 'unused-b', {
      type: 'spring',
      restLength: 2,
      stiffness: 100,
      damping: 0,
    })
    spring.b = { type: 'free', position: { x: 2, y: 0 } }
    const projectile = makeBody(scene, 'dynamic-projectile', { x: 3, y: 0 }, { x: -2, y: 0 })
    scene.entities = [anchor, spring, projectile]
    const world = createWorld(scene)
    const initialMomentum = -2
    const initialEnergy = 2
    let maximumEnergyError = 0
    let maximumMomentumError = 0

    for (let index = 0; index < 360; index += 1) {
      world.step()
      const anchorState = stateOf(world, anchor.id)
      const projectileState = stateOf(world, projectile.id)
      const points = world
        .getConnectorStates()
        .find((state) => state.entityId === spring.id)?.points
      if (!points || points.length !== 2) throw new Error('缺少动态自由端弹簧运行点')
      const compression =
        spring.connector.type === 'spring'
          ? spring.connector.restLength - distance(points[0]!, points[1]!)
          : 0
      const energy =
        anchorState.kineticEnergyJ + projectileState.kineticEnergyJ + 0.5 * 100 * compression ** 2
      maximumEnergyError = Math.max(
        maximumEnergyError,
        Math.abs(energy - initialEnergy) / initialEnergy,
      )
      maximumMomentumError = Math.max(
        maximumMomentumError,
        Math.abs(
          anchorState.linearVelocity.x + projectileState.linearVelocity.x - initialMomentum,
        ) / Math.abs(initialMomentum),
      )
    }

    expect(maximumMomentumError).toBeLessThan(0.005)
    expect(maximumEnergyError).toBeLessThan(0.005)
  })

  it('自由端弹簧的非零阻尼只消耗机械能', () => {
    const scene = baseScene()
    const spring: ConnectorEntity = makeConnector(scene, 'damped-bumper', 'unused-a', 'unused-b', {
      type: 'spring',
      restLength: 2,
      stiffness: 100,
      damping: 8,
    })
    spring.a = { type: 'world', position: { x: 0, y: 0 } }
    spring.b = { type: 'free', position: { x: 2, y: 0 } }
    const projectile = makeBody(scene, 'damped-projectile', { x: 3, y: 0 }, { x: -2, y: 0 })
    scene.entities = [spring, projectile]
    const world = createWorld(scene)
    const initialEnergy = 2
    let maximumEnergy = initialEnergy

    for (let index = 0; index < 360; index += 1) {
      world.step()
      const projectileState = stateOf(world, projectile.id)
      const points = world
        .getConnectorStates()
        .find((state) => state.entityId === spring.id)?.points
      if (!points || points.length !== 2) throw new Error('缺少阻尼自由端弹簧运行点')
      const compression =
        spring.connector.type === 'spring'
          ? spring.connector.restLength - distance(points[0]!, points[1]!)
          : 0
      maximumEnergy = Math.max(
        maximumEnergy,
        projectileState.kineticEnergyJ + 0.5 * 100 * compression ** 2,
      )
    }

    expect(maximumEnergy).toBeLessThanOrEqual(initialEnergy * 1.005)
    expect(stateOf(world, projectile.id).kineticEnergyJ).toBeLessThan(initialEnergy * 0.9)
  })

  it('带质量的杆通过胶囊碰撞体响应地面碰撞', () => {
    const scene = baseScene()
    const ground = makeGround(
      scene,
      { type: 'line', start: { x: -5, y: 0 }, end: { x: 5, y: 0 } },
      { friction: 0, restitution: 1 },
    )
    const first = makeBody(
      scene,
      'first',
      { x: -1, y: 0.45 },
      { x: 0, y: -3 },
      { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
    )
    const second = makeBody(
      scene,
      'second',
      { x: 1, y: 0.45 },
      { x: 0, y: -3 },
      { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
    )
    const rod = makeConnector(scene, 'massive-ground-rod', first.id, second.id, {
      type: 'rod',
      length: 2,
      endpointRotation: { a: 'free', b: 'free' },
    })
    rod.massKg = 1
    rod.radiusM = 0.1
    rod.collisionEnabled = true
    rod.material = { friction: 0, restitution: 1 }
    scene.entities = [ground, first, second, rod]
    const world = createWorld(scene)

    world.step(36)
    const runtime = world.getConnectorStates().find((state) => state.entityId === rod.id)
    const firstState = stateOf(world, first.id)
    const secondState = stateOf(world, second.id)

    expect(runtime?.points).toHaveLength(2)
    expect(Math.min(...(runtime?.points.map((point) => point.y) ?? [-Infinity]))).toBeGreaterThan(
      -0.05,
    )
    expect(firstState.linearVelocity.y + secondState.linearVelocity.y).toBeGreaterThan(-1)
  })

  it.each(['rope'] as const)(
    '带质量的 %s 使用受重力作用的柔性内部节点',
    (connectorType) => {
      const scene = baseScene()
      const definition: ConnectorDefinition =
        connectorType === 'rope'
          ? { type: 'rope', maxLength: 5 }
          : { type: 'spring', restLength: 4, stiffness: 20, damping: 0 }
      const connector: ConnectorEntity = makeConnector(
        scene,
        connectorType,
        'unused-a',
        'unused-b',
        definition,
      )
      connector.a = { type: 'world', position: { x: -2, y: 0 } }
      connector.b = { type: 'world', position: { x: 2, y: 0 } }
      connector.massKg = 2
      connector.radiusM = 0.05
      connector.collisionEnabled = true
      scene.entities = [connector, makeGravity(scene, { x: 0, y: -9.80665 })]
      const world = createWorld(scene)

      world.step(240)
      const runtime = world.getConnectorStates().find((state) => state.entityId === connector.id)

      expect(runtime?.points.length).toBeGreaterThan(2)
      expect(runtime?.points[0]).toEqual({ x: -2, y: 0 })
      expect(runtime?.points.at(-1)).toEqual({ x: 2, y: 0 })
      expect(Math.min(...(runtime?.points.map((point) => point.y) ?? [0]))).toBeLessThan(-0.1)
      expect(
        runtime?.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
      ).toBe(true)
    },
    15_000,
  )

  it('带质量杆使用真实刚体并通过运行时端点输出同一份几何', () => {
    const scene = baseScene()
    const first = makeBody(
      scene,
      'first',
      { x: -1, y: 1 },
      { x: 0, y: 0 },
      {
        shape: { type: 'circle', radius: 0.1, collisionEnabled: false },
      },
    )
    const second = makeBody(
      scene,
      'second',
      { x: 1, y: 1 },
      { x: 0, y: 0 },
      {
        shape: { type: 'circle', radius: 0.1, collisionEnabled: false },
      },
    )
    const rod = makeConnector(scene, 'massive-rod', first.id, second.id, {
      type: 'rod',
      length: 2,
      endpointRotation: { a: 'free', b: 'free' },
    })
    rod.massKg = 3
    rod.collisionEnabled = true
    scene.entities = [first, second, rod, makeGravity(scene, { x: 0, y: -9.80665 })]
    const world = createWorld(scene)

    world.step(120)
    const runtime = world.getConnectorStates().find((state) => state.entityId === rod.id)

    expect(runtime?.points).toHaveLength(2)
    expect(
      Math.hypot(
        runtime!.points[1]!.x - runtime!.points[0]!.x,
        runtime!.points[1]!.y - runtime!.points[0]!.y,
      ),
    ).toBeCloseTo(2, 3)
    expect((runtime!.points[0]!.y + runtime!.points[1]!.y) / 2).toBeLessThan(-3)
  })

  it('连接器分段达到单体或全场上限时给出警告且不改写存档参数', () => {
    const scene = baseScene()
    const connectors = Array.from({ length: 5 }, (_, index) => {
      const connector: ConnectorEntity = makeConnector(
        scene,
        `long-rope-${index}`,
        'unused-a',
        'unused-b',
        { type: 'rope', maxLength: 100 },
      )
      connector.a = { type: 'world', position: { x: index * 3, y: 0 } }
      connector.b = { type: 'world', position: { x: index * 3 + 100, y: 0 } }
      connector.massKg = 1
      connector.collisionEnabled = true
      connector.radiusM = 0.01
      return connector
    })
    scene.entities = connectors
    const world = createWorld(scene)

    expect(
      world.warnings.filter((warning) => warning.message.includes('碰撞分段')).length,
    ).toBeGreaterThanOrEqual(5)
    expect(world.getConnectorStates().every((state) => state.points.length <= 65)).toBe(true)
    for (const connector of connectors) {
      expect(connector.connector).toMatchObject({ type: 'rope', maxLength: 100 })
      expect(connector.massKg).toBe(1)
    }
  })
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
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    simulationEnabled: true,
    kind: 'body',
    preset: 'ball',
    color: '#e45d68',
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
  return {
    id,
    name: id,
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
  connector: ConnectorDefinition | { type: 'rod'; length: number; freeRotation: boolean },
): ConnectorEntity & { a: BodyConnectorEndpoint; b: BodyConnectorEndpoint } {
  const resolvedConnector: ConnectorDefinition =
    connector.type === 'rod' && 'freeRotation' in connector
      ? {
          type: 'rod',
          length: connector.length,
          endpointRotation: connector.freeRotation
            ? { a: 'free', b: 'free' }
            : { a: 'fixed', b: 'fixed' },
        }
      : connector
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    simulationEnabled: true,
    kind: 'connector',
    a: { type: 'body', bodyId: firstBodyId, localAnchor: { x: 0, y: 0 } },
    b: { type: 'body', bodyId: secondBodyId, localAnchor: { x: 0, y: 0 } },
    connector: resolvedConnector,
    collisionEnabled: false,
    radiusM: 0.05,
    massKg: 0,
    material: { friction: 0, restitution: 0 },
  }
}

function makeGround(
  scene: SceneDocument,
  geometry: GroundEntity['geometry'],
  material = { friction: 0.5, restitution: 0 },
): GroundEntity {
  return {
    id: 'ground',
    name: '地面',
    visible: true,
    locked: false,
    simulationEnabled: true,
    kind: 'ground',
    geometry,
    material,
    conveyor: { enabled: false, direction: 'forward', speedMps: 1 },
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
  return {
    id,
    name: id,
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

describe('钢笔物块复合碰撞', () => {
  it('使用共享网格落在平面地面上且不会穿透或产生无效状态', () => {
    const scene = baseScene()
    const body = createBezierBlock(
      '',
      createSmoothBezierPathNodes([
        { x: -1.5, y: 1.5 },
        { x: 1.5, y: 1.5 },
        { x: 1.2, y: 3 },
        { x: 0, y: 2.4 },
        { x: -1.2, y: 3 },
      ]),
      1,
    )
    if (!body) throw new Error('钢笔物块创建失败')
    body.material = { friction: 0, restitution: 0 }
    const ground = makeGround(
      scene,
      {
        type: 'line',
        start: { x: -10, y: 0 },
        end: { x: 10, y: 0 },
      },
      { friction: 0, restitution: 0 },
    )
    const gravity = makeGravity(scene, { x: 0, y: -9.80665 })
    scene.entities = [ground, gravity, body]
    scene.rootItems = scene.entities.map((entity) => ({ kind: 'entity', entityId: entity.id }))
    const world = createWorld(scene)

    world.step(360)
    const state = stateOf(world, body.id)
    expect(world.warnings.some((warning) => warning.entityId === body.id)).toBe(false)
    expect(Number.isFinite(state.position.x)).toBe(true)
    expect(Number.isFinite(state.position.y)).toBe(true)
    expect(state.position.y).toBeGreaterThan(0.25)
  })
})

function springSystemEnergy(
  world: SimulationWorld,
  bodyIds: readonly string[],
  springs: readonly ConnectorEntity[],
): number {
  const states = new Map(bodyIds.map((id) => [id, stateOf(world, id)]))
  const kineticEnergy = [...states.values()].reduce((sum, state) => sum + state.kineticEnergyJ, 0)
  const springPotentialEnergy = springs.reduce((sum, spring) => {
    if (spring.connector.type !== 'spring') return sum
    if (spring.a.type !== 'body' || spring.b.type !== 'body') return sum
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
  it('缩放后的几何会重建碰撞体和转动惯量，但质量保持不变', () => {
    const smallScene = baseScene()
    const smallBody = makeBody(
      smallScene,
      'small',
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      {
        initialAngularVelocityRad: 2,
        massKg: 2,
      },
    )
    smallScene.entities = [smallBody]

    const largeScene = baseScene()
    const scaledBody = scaleEntitiesAroundPivot([smallBody], [smallBody.id], { x: 0, y: 0 }, 2)
      .replacements[0]
    if (scaledBody?.kind !== 'body') throw new Error('测试缩放未返回物体')
    largeScene.entities = [{ ...scaledBody, id: 'large' }]

    const smallWorld = createWorld(smallScene)
    const largeWorld = createWorld(largeScene)
    smallWorld.step()
    largeWorld.step()
    const smallState = stateOf(smallWorld, 'small')
    const largeState = stateOf(largeWorld, 'large')

    expect(scaledBody.massKg).toBe(2)
    expect(largeState.position).toEqual(smallState.position)
    expect(largeState.rotationalKineticEnergyJ).toBeCloseTo(
      smallState.rotationalKineticEnergyJ * 4,
      5,
    )

    const groundScene = baseScene()
    const ground = makeGround(groundScene, {
      type: 'line',
      start: { x: -1, y: 0 },
      end: { x: 1, y: 0 },
    })
    const scaledGround = scaleEntitiesAroundPivot([ground], [ground.id], { x: 0, y: 0 }, 2)
      .replacements[0]
    if (scaledGround?.kind !== 'ground') throw new Error('测试缩放未返回地面')
    groundScene.entities = [
      scaledGround,
      makeBody(groundScene, 'edge-ball', { x: 1.4, y: 1.5 }),
      makeGravity(groundScene, { x: 0, y: -9.80665 }),
    ]
    const groundWorld = createWorld(groundScene)
    groundWorld.step(120)
    expect(stateOf(groundWorld, 'edge-ball').position.y).toBeGreaterThan(0.48)
  })

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

  it('隐藏或锁定实体只影响编辑显示，不会关闭物理模拟', () => {
    const scene = baseScene()
    scene.entities = [
      { ...makeBody(scene, 'hidden-ball', { x: 0, y: 5 }), visible: false, locked: true },
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

  it.each([
    ['forward', 2],
    ['reverse', -2],
  ] as const)('传送带按 %s 方向通过摩擦把静止物块带到表面速度', (direction, expectedSpeed) => {
    const scene = baseScene()
    const ground = makeGround(
      scene,
      { type: 'line', start: { x: -10, y: 0 }, end: { x: 10, y: 0 } },
      { friction: 1, restitution: 0 },
    )
    ground.conveyor = { enabled: true, direction, speedMps: 2 }
    const block = makeBody(
      scene,
      `conveyor-${direction}`,
      { x: 0, y: 0.5 },
      { x: 0, y: 0 },
      {
        preset: 'block',
        shape: { type: 'box', width: 1, height: 1 },
        material: { friction: 1, restitution: 0 },
        rotationEnabled: false,
      },
    )
    scene.entities = [ground, block, makeGravity(scene, { x: 0, y: -9.80665 })]
    const world = createWorld(scene)

    world.step(120)

    expect(stateOf(world, block.id).linearVelocity.x).toBeCloseTo(expectedSpeed, 1)
  })

  it('传送带与物体之间无摩擦时不改变切向速度', () => {
    const scene = baseScene()
    const ground = makeGround(
      scene,
      { type: 'line', start: { x: -10, y: 0 }, end: { x: 10, y: 0 } },
      { friction: 0, restitution: 0 },
    )
    ground.conveyor = { enabled: true, direction: 'forward', speedMps: 3 }
    const block = makeBody(
      scene,
      'frictionless-conveyor-block',
      { x: 0, y: 0.5 },
      { x: 0, y: 0 },
      {
        preset: 'block',
        shape: { type: 'box', width: 1, height: 1 },
        material: { friction: 1, restitution: 0 },
        rotationEnabled: false,
      },
    )
    scene.entities = [ground, block, makeGravity(scene, { x: 0, y: -9.80665 })]
    const world = createWorld(scene)

    world.step(120)

    expect(stateOf(world, block.id).linearVelocity.x).toBeCloseTo(0, 5)
  })

  it('传送带对关闭旋转的小球使用同一表面速度口径', () => {
    const scene = baseScene()
    const ground = makeGround(
      scene,
      { type: 'line', start: { x: -10, y: 0 }, end: { x: 10, y: 0 } },
      { friction: 1, restitution: 0 },
    )
    ground.conveyor = { enabled: true, direction: 'forward', speedMps: 1.5 }
    const ball = makeBody(
      scene,
      'conveyor-ball',
      { x: 0, y: 0.5 },
      { x: 0, y: 0 },
      {
        material: { friction: 1, restitution: 0 },
        rotationEnabled: false,
      },
    )
    scene.entities = [ground, ball, makeGravity(scene, { x: 0, y: -9.80665 })]
    const world = createWorld(scene)

    world.step(120)

    expect(stateOf(world, ball.id).linearVelocity.x).toBeCloseTo(1.5, 1)
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

  it('完全弹性高速斜碰地面时保持切向运动方向', () => {
    const scene = baseScene()
    const initialVelocity = { x: 20, y: -40 }
    scene.entities = [
      makeGround(
        scene,
        { type: 'line', start: { x: -100, y: 0 }, end: { x: 100, y: 0 } },
        { friction: 0, restitution: 1 },
      ),
      makeBody(scene, 'oblique-fast', { x: -5, y: 1 }, initialVelocity, {
        shape: { type: 'circle', radius: 0.2, collisionEnabled: true },
        material: { friction: 0, restitution: 1 },
        continuousCollisionDetection: false,
      }),
    ]
    const world = createWorld(scene)

    world.step(12)
    const state = stateOf(world, 'oblique-fast')

    expect(state.position.y).toBeGreaterThan(0.2)
    expect(state.linearVelocity.x).toBeGreaterThan(0)
    expect(state.linearVelocity.x).toBeCloseTo(initialVelocity.x, 2)
    expect(state.linearVelocity.y).toBeGreaterThan(0)
  })

  it('完全弹性高速斜碰有效地面连接过渡段时不会反向', () => {
    for (const angleDeg of [30, 60, 90, 120, 150]) {
      const angleRad = (angleDeg * Math.PI) / 180
      for (const impactFraction of [0.05, 0.3, 0.5, 0.7, 0.95]) {
        for (const side of [-1, 1] as const) {
          const scene = baseScene()
          const first = makeGround(
            scene,
            { type: 'line', start: { x: -6, y: 0 }, end: { x: 0, y: 0 } },
            { friction: 0, restitution: 1 },
          )
          first.id = `oblique-transition-first-${angleDeg}-${impactFraction}-${side}`
          const second = makeGround(
            scene,
            {
              type: 'line',
              start: { x: 0, y: 0 },
              end: { x: Math.cos(angleRad) * 6, y: Math.sin(angleRad) * 6 },
            },
            { friction: 0, restitution: 1 },
          )
          second.id = `oblique-transition-second-${angleDeg}-${impactFraction}-${side}`
          const joint = makeGroundJoint(
            scene,
            `oblique-transition-joint-${angleDeg}-${impactFraction}-${side}`,
            first.id,
            'end',
            second.id,
            'start',
          )
          joint.transition = {
            mode: 'manual',
            lengthM: angleDeg >= 120 ? 3 : 2,
            directionFlipped: false,
          }
          scene.entities = [first, second, joint]
          const transitionPath = buildGroundPathNetwork(scene.entities).jointPaths.get(
            joint.id,
          )?.path
          if (!transitionPath) throw new Error('测试场景未生成地面连接过渡段')
          const impactS = transitionPath.length * impactFraction
          const surface = transitionPath.pointAt(impactS)
          const tangent = transitionPath.tangentAt(impactS)
          const normal = transitionPath.normalAt(impactS)
          const radius = 0.1
          const tangentialSpeed = 20
          const incomingNormalSpeed = 40
          const initialVelocity = {
            x: tangent.x * tangentialSpeed - normal.x * incomingNormalSpeed * side,
            y: tangent.y * tangentialSpeed - normal.y * incomingNormalSpeed * side,
          }
          const bodyId = `oblique-transition-ball-${angleDeg}-${impactFraction}-${side}`
          scene.entities.push(
            makeBody(
              scene,
              bodyId,
              {
                x: surface.x + normal.x * (radius + 0.25) * side,
                y: surface.y + normal.y * (radius + 0.25) * side,
              },
              initialVelocity,
              {
                shape: { type: 'circle', radius, collisionEnabled: true },
                material: { friction: 0, restitution: 1 },
                continuousCollisionDetection: false,
              },
            ),
          )
          const world = createWorld(scene)
          let verifiedBounce = false
          for (let step = 0; step < 6; step += 1) {
            world.step()
            const state = stateOf(world, bodyId)
            const closest = transitionPath.closestPoint(state.position)
            const localTangent = transitionPath.tangentAt(closest.s)
            const localNormal = transitionPath.normalAt(closest.s)
            const separatingSpeed =
              (state.linearVelocity.x * localNormal.x + state.linearVelocity.y * localNormal.y) *
              side
            if (separatingSpeed <= 0) continue
            const expectedTangentialSpeed =
              initialVelocity.x * localTangent.x + initialVelocity.y * localTangent.y
            const finalTangentialSpeed =
              state.linearVelocity.x * localTangent.x + state.linearVelocity.y * localTangent.y
            expect(finalTangentialSpeed * expectedTangentialSpeed).toBeGreaterThan(0)
            expect(
              Math.abs(
                Math.hypot(state.linearVelocity.x, state.linearVelocity.y) -
                  Math.hypot(initialVelocity.x, initialVelocity.y),
              ) / Math.hypot(initialVelocity.x, initialVelocity.y),
            ).toBeLessThan(0.002)
            verifiedBounce = true
            break
          }
          expect(verifiedBounce).toBe(true)
        }
      }
    }
  })

  it('地面连接点不会改变远处直线地面的完全弹性斜碰结果', () => {
    const run = (withJoint: boolean, suffix: string) => {
      const scene = baseScene()
      const first = makeGround(
        scene,
        { type: 'line', start: { x: -20, y: 0 }, end: { x: 0, y: 0 } },
        { friction: 0, restitution: 1 },
      )
      first.id = `remote-impact-first-${suffix}`
      const second = makeGround(
        scene,
        { type: 'line', start: { x: 0, y: 0 }, end: { x: 0, y: 20 } },
        { friction: 0, restitution: 1 },
      )
      second.id = `remote-impact-second-${suffix}`
      scene.entities = [first, second]
      if (withJoint) {
        const joint = makeGroundJoint(
          scene,
          `remote-impact-joint-${suffix}`,
          first.id,
          'end',
          second.id,
          'start',
        )
        joint.transition = { mode: 'manual', lengthM: 3, directionFlipped: false }
        scene.entities.push(joint)
      }
      scene.entities.push(
        makeBody(
          scene,
          `remote-impact-ball-${suffix}`,
          { x: -15, y: 1 },
          { x: 20, y: -40 },
          {
            shape: { type: 'circle', radius: 0.2, collisionEnabled: true },
            material: { friction: 0, restitution: 1 },
            continuousCollisionDetection: false,
          },
        ),
      )
      const world = createWorld(scene)
      world.step(12)
      return stateOf(world, `remote-impact-ball-${suffix}`)
    }

    const control = run(false, 'control')
    const connected = run(true, 'connected')

    expect(control.linearVelocity.x).toBeGreaterThan(0)
    expect(connected.linearVelocity.x).toBeGreaterThan(0)
    expect(connected.linearVelocity.x).toBeCloseTo(control.linearVelocity.x, 2)
    expect(connected.linearVelocity.y).toBeCloseTo(control.linearVelocity.y, 2)
  })

  it('完全弹性碰撞普通或连接的倾斜面与圆弧面时不会凭空增减机械能', () => {
    const gravity = 9.80665
    const geometries: Array<{
      name: string
      primary: GroundEntity['geometry']
      neighbor: GroundEntity['geometry']
      impactFraction: number
    }> = [
      {
        name: 'incline',
        primary: {
          type: 'line',
          start: { x: -20 * Math.cos(Math.PI / 6), y: -20 * Math.sin(Math.PI / 6) },
          end: { x: 0, y: 0 },
        },
        neighbor: {
          type: 'line',
          start: { x: 0, y: 0 },
          end: { x: -5 * Math.sin(Math.PI / 6), y: 5 * Math.cos(Math.PI / 6) },
        },
        impactFraction: 0.35,
      },
      {
        name: 'arc',
        primary: {
          type: 'arc',
          center: { x: 0, y: 0 },
          radius: 5,
          startRad: Math.PI,
          endRad: 0,
        },
        neighbor: {
          type: 'line',
          start: { x: 5, y: 0 },
          end: { x: 10, y: 0 },
        },
        impactFraction: 0.5,
      },
    ]
    const cases = geometries.flatMap((testCase) =>
      [-gravity, gravity].map((accelerationY) => ({ ...testCase, accelerationY })),
    )

    for (const testCase of cases) {
      for (const withJoint of [false, true]) {
        const mode = withJoint ? 'connected' : 'plain'
        const forceDirection = testCase.accelerationY < 0 ? 'downward' : 'upward'
        const scene = baseScene()
        const primary = makeGround(scene, testCase.primary, { friction: 0, restitution: 1 })
        primary.id = `${testCase.name}-${mode}-elastic-primary`
        const neighbor = makeGround(scene, testCase.neighbor, { friction: 0, restitution: 1 })
        neighbor.id = `${testCase.name}-${mode}-elastic-neighbor`
        const joint = makeGroundJoint(
          scene,
          `${testCase.name}-${mode}-elastic-joint`,
          primary.id,
          'end',
          neighbor.id,
          'start',
        )
        joint.transition = { mode: 'manual', lengthM: 2, directionFlipped: false }
        scene.entities = withJoint ? [primary, neighbor, joint] : [primary]

        const network = buildGroundPathNetwork(scene.entities)
        if (withJoint) {
          expect(
            network.jointPaths.get(joint.id)?.path,
            `${testCase.name} 连接必须有效`,
          ).not.toBeNull()
        }
        const path = network.groundPaths.get(primary.id)?.path
        if (!path) throw new Error(`${testCase.name} 测试场景未生成有效主地面路径`)
        const impactS = path.length * testCase.impactFraction
        const surface = path.pointAt(impactS)
        const tangent = path.tangentAt(impactS)
        const normal = path.normalAt(impactS)
        const radius = 0.2
        const initialPosition = {
          x: surface.x + normal.x * (radius + 0.01),
          y: surface.y + normal.y * (radius + 0.01),
        }
        const initialVelocity = {
          x: tangent.x * 2 - normal.x * 10,
          y: tangent.y * 2 - normal.y * 10,
        }
        const ballId = `${testCase.name}-${mode}-elastic-ball`
        scene.entities.push(
          makeBody(scene, ballId, initialPosition, initialVelocity, {
            shape: { type: 'circle', radius, collisionEnabled: true },
            material: { friction: 0, restitution: 1 },
            continuousCollisionDetection: true,
          }),
          makeGravity(scene, { x: 0, y: testCase.accelerationY }),
        )

        const initialKineticEnergy = 0.5 * (initialVelocity.x ** 2 + initialVelocity.y ** 2)
        const initialMechanicalEnergy =
          initialKineticEnergy - testCase.accelerationY * initialPosition.y
        const world = createWorld(scene)
        let state = stateOf(world, ballId)
        let separatingSpeed = -Infinity
        for (let step = 0; step < 4; step += 1) {
          world.step()
          state = stateOf(world, ballId)
          const closest = path.closestPoint(state.position)
          const outgoingNormal = path.normalAt(closest.s)
          separatingSpeed =
            state.linearVelocity.x * outgoingNormal.x + state.linearVelocity.y * outgoingNormal.y
          if (separatingSpeed > 0) break
        }
        const finalMechanicalEnergy =
          state.kineticEnergyJ - testCase.accelerationY * state.position.y
        const relativeEnergyJump =
          Math.abs(finalMechanicalEnergy - initialMechanicalEnergy) / initialKineticEnergy

        expect(separatingSpeed, `${testCase.name}-${mode}-${forceDirection}`).toBeGreaterThan(0)
        expect(relativeEnergyJump, `${testCase.name}-${mode}-${forceDirection}`).toBeLessThan(0.002)
      }
    }
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

  it('小球从水平直线进入竖直圆弧连接时保持解析接触而不退化为折线碰撞', () => {
    const radius = 0.2
    const gravity = 9.80665
    const cases = [2, 15, 90].flatMap((angleDeg) =>
      [0, -gravity].flatMap((accelerationY) =>
        (accelerationY === 0 ? [1, 2, 4, 8, 12] : [10, 12]).map((speed) => ({
          accelerationY,
          angleDeg,
          speed,
        })),
      ),
    )

    for (const { accelerationY, angleDeg, speed } of cases) {
      const angleRad = (angleDeg * Math.PI) / 180
      const scene = baseScene()
      const line = makeGround(
        scene,
        { type: 'line', start: { x: -10, y: 0 }, end: { x: 0, y: 0 } },
        { friction: 0, restitution: 0 },
      )
      line.id = `line-to-arc-line-${accelerationY}-${speed}`
      const arc = makeGround(
        scene,
        {
          type: 'arc',
          center: { x: 0, y: 3 },
          radius: 3,
          startRad: -Math.PI / 2 + angleRad,
          endRad: angleRad,
        },
        { friction: 0, restitution: 0 },
      )
      arc.id = `line-to-arc-arc-${accelerationY}-${speed}`
      const joint = makeGroundJoint(
        scene,
        `line-to-arc-joint-${accelerationY}-${speed}`,
        line.id,
        'end',
        arc.id,
        'start',
      )
      joint.transition = { mode: 'auto', directionFlipped: false }
      scene.entities = [line, arc, joint]

      const network = buildGroundPathNetwork(scene.entities)
      const linePath = network.groundPaths.get(line.id)?.path
      const arcPath = network.groundPaths.get(arc.id)?.path
      const transitionPath = network.jointPaths.get(joint.id)?.path
      if (!linePath || !arcPath || !transitionPath) {
        throw new Error('测试场景未生成有效的直线—圆弧连接路径')
      }
      const transitionCurvatures = Array.from({ length: 129 }, (_, index) =>
        transitionPath.curvatureAt((transitionPath.length * index) / 128),
      )
      const minimumTransitionCurvature = Math.min(...transitionCurvatures)
      const maximumTransitionCurvature = Math.max(...transitionCurvatures)
      const startS = Math.max(0, linePath.length - 0.5)
      const startSurface = linePath.pointAt(startS)
      const startNormal = linePath.normalAt(startS)
      const startTangent = linePath.tangentAt(startS)
      const bodyId = `line-to-arc-ball-${accelerationY}-${speed}`
      scene.entities.push(
        makeBody(
          scene,
          bodyId,
          {
            x: startSurface.x + startNormal.x * radius,
            y: startSurface.y + startNormal.y * radius,
          },
          { x: startTangent.x * speed, y: startTangent.y * speed },
          {
            shape: { type: 'circle', radius, collisionEnabled: true },
            material: { friction: 0, restitution: 0 },
          },
        ),
      )
      if (accelerationY !== 0) {
        scene.entities.push(makeGravity(scene, { x: 0, y: accelerationY }))
      }

      const world = createWorld(scene)
      let maximumGapM = 0
      let maximumVelocityTurnRad = 0
      let previousVelocity = { x: startTangent.x * speed, y: startTangent.y * speed }
      let reachedArc = false
      let firstSeparation = 'none'
      for (let step = 0; step < 900; step += 1) {
        world.step()
        const state = stateOf(world, bodyId)
        const gapM = Math.min(
          ...network.segments.map((segment) =>
            Math.abs(segment.path.closestPoint(state.position).distance - radius),
          ),
        )
        maximumGapM = Math.max(maximumGapM, gapM)
        if (gapM >= 0.02 && firstSeparation === 'none') {
          const nearestSegment = network.segments
            .map((segment) => ({ segment, closest: segment.path.closestPoint(state.position) }))
            .sort((first, second) => first.closest.distance - second.closest.distance)[0]!
          const nearestTangent = nearestSegment.segment.path.tangentAt(nearestSegment.closest.s)
          firstSeparation =
            `step=${step + 1}, p=(${state.position.x.toFixed(3)},${state.position.y.toFixed(3)}), ` +
            `v=(${state.linearVelocity.x.toFixed(3)},${state.linearVelocity.y.toFixed(3)}), ` +
            `segment=${nearestSegment.segment.kind}, s=${nearestSegment.closest.s.toFixed(3)}, ` +
            `t=(${nearestTangent.x.toFixed(3)},${nearestTangent.y.toFixed(3)}), ` +
            `k=${nearestSegment.segment.path.curvatureAt(nearestSegment.closest.s).toFixed(6)}`
        }
        const previousSpeed = Math.hypot(previousVelocity.x, previousVelocity.y)
        const currentSpeed = Math.hypot(state.linearVelocity.x, state.linearVelocity.y)
        if (previousSpeed > 1e-6 && currentSpeed > 1e-6) {
          const cosine =
            (previousVelocity.x * state.linearVelocity.x +
              previousVelocity.y * state.linearVelocity.y) /
            (previousSpeed * currentSpeed)
          maximumVelocityTurnRad = Math.max(
            maximumVelocityTurnRad,
            Math.acos(Math.min(1, Math.max(-1, cosine))),
          )
        }
        previousVelocity = state.linearVelocity

        const arcClosest = arcPath.closestPoint(state.position)
        if (arcClosest.s > Math.min(0.5, arcPath.length * 0.25) && gapM < 0.02) {
          reachedArc = true
          break
        }
      }

      const label = `${angleDeg}° / ${accelerationY === 0 ? '无重力' : '有重力'} / ${speed} m/s / gap=${maximumGapM.toFixed(4)} / turn=${maximumVelocityTurnRad.toFixed(4)} / k=[${minimumTransitionCurvature.toFixed(3)}, ${maximumTransitionCurvature.toFixed(3)}] / separation=${firstSeparation}`
      expect(reachedArc, label).toBe(true)
      expect(maximumGapM, label).toBeLessThan(0.02)
      expect(maximumVelocityTurnRad, label).toBeLessThan(0.25)
      expect(minimumTransitionCurvature, label).toBeGreaterThanOrEqual(-1e-3)
      expect(maximumTransitionCurvature * radius, label).toBeLessThan(
        1 - GROUND_PATH_MIN_OFFSET_SCALE,
      )
    }
  }, 30_000)

  it('半径 12.5 m 的竖直圆弧在 25 m/s 以上仍保持平滑路径和机械能', () => {
    for (const ballRadius of [0.2, 0.5]) {
      for (const speed of [25, 26, 30, 40]) {
        for (const gravityY of [0, -9.80665]) {
          const scene = baseScene()
          const line = makeGround(
            scene,
            { type: 'line', start: { x: -5, y: 0 }, end: { x: 0, y: 0 } },
            { friction: 0, restitution: 0 },
          )
          line.id = `high-speed-line-${ballRadius}-${speed}-${gravityY}`
          const arc = makeGround(
            scene,
            {
              type: 'arc',
              center: { x: -12.5, y: 0 },
              radius: 12.5,
              startRad: 0,
              endRad: Math.PI / 2,
            },
            { friction: 0, restitution: 0 },
          )
          arc.id = `high-speed-arc-${ballRadius}-${speed}-${gravityY}`
          const joint = makeGroundJoint(
            scene,
            `high-speed-joint-${ballRadius}-${speed}-${gravityY}`,
            line.id,
            'end',
            arc.id,
            'start',
          )
          scene.entities = [line, arc, joint]

          const network = buildGroundPathNetwork(scene.entities)
          const linePath = network.groundPaths.get(line.id)?.path
          const arcPath = network.groundPaths.get(arc.id)?.path
          const transitionPath = network.jointPaths.get(joint.id)?.path
          if (!linePath || !arcPath || !transitionPath) {
            throw new Error('高速回归场景未生成有效路径')
          }
          const startS = Math.max(0, linePath.length - 0.2)
          const surface = linePath.pointAt(startS)
          const tangent = linePath.tangentAt(startS)
          const normal = linePath.normalAt(startS)
          const bodyId = `high-speed-ball-${ballRadius}-${speed}-${gravityY}`
          scene.entities.push(
            makeBody(
              scene,
              bodyId,
              {
                x: surface.x + normal.x * ballRadius,
                y: surface.y + normal.y * ballRadius,
              },
              { x: tangent.x * speed, y: tangent.y * speed },
              {
                shape: { type: 'circle', radius: ballRadius, collisionEnabled: true },
                material: { friction: 0, restitution: 0 },
              },
            ),
          )
          if (gravityY !== 0) scene.entities.push(makeGravity(scene, { x: 0, y: gravityY }))

          const world = createWorld(scene)
          const initialEnergy = 0.5 * speed ** 2 - gravityY * (surface.y + ballRadius)
          let maximumGapM = 0
          let maximumRelativeEnergyError = 0
          let minimumForwardSpeed = speed
          let reachedArc = false
          for (let step = 0; step < 240; step += 1) {
            world.step()
            const state = stateOf(world, bodyId)
            const nearest = network.segments
              .map((segment) => ({ segment, closest: segment.path.closestPoint(state.position) }))
              .sort((first, second) => first.closest.distance - second.closest.distance)[0]!
            maximumGapM = Math.max(maximumGapM, Math.abs(nearest.closest.distance - ballRadius))
            minimumForwardSpeed = Math.min(
              minimumForwardSpeed,
              state.linearVelocity.x * nearest.closest.tangent.x +
                state.linearVelocity.y * nearest.closest.tangent.y,
            )
            const kinetic = 0.5 * (state.linearVelocity.x ** 2 + state.linearVelocity.y ** 2)
            const energy = kinetic - gravityY * state.position.y
            maximumRelativeEnergyError = Math.max(
              maximumRelativeEnergyError,
              Math.abs(energy - initialEnergy) / Math.max(initialEnergy, 1),
            )
            const arcClosest = arcPath.closestPoint(state.position)
            if (arcClosest.s > 0.5 && Math.abs(arcClosest.distance - ballRadius) < 0.003) {
              reachedArc = true
              break
            }
          }

          const transitionCurvature = Array.from({ length: 129 }, (_, index) =>
            Math.abs(transitionPath.curvatureAt((transitionPath.length * index) / 128)),
          )
          const label = `r=${ballRadius}, v=${speed}, g=${gravityY}, gap=${maximumGapM.toFixed(5)}, energy=${maximumRelativeEnergyError.toFixed(5)}, forward=${minimumForwardSpeed.toFixed(3)}, k=${Math.max(...transitionCurvature).toFixed(3)}`
          expect(reachedArc, label).toBe(true)
          expect(maximumGapM, label).toBeLessThan(0.003)
          expect(minimumForwardSpeed, label).toBeGreaterThan(0)
          expect(maximumRelativeEnergyError, label).toBeLessThan(0.005)
          expect(Math.max(...transitionCurvature) * ballRadius, label).toBeLessThan(
            1 - GROUND_PATH_MIN_OFFSET_SCALE,
          )
        }
      }
    }
  }, 30_000)

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

  it.each(
    [0.2, 0.5, 1].flatMap((ballRadius) =>
      [20, 25, 26, 30, 40].flatMap((speed) =>
        [0, -9.80665].map((gravityY) => ({ ballRadius, speed, gravityY })),
      ),
    ),
  )(
    '半径 $ballRadius m 小球以 $speed m/s 通过无形接缝进入半径 12.5 m 圆弧（g=$gravityY）',
    ({ ballRadius, speed, gravityY }) => {
      const scene = baseScene()
      const radius = 12.5
      const line = makeGround(
        scene,
        { type: 'line', start: { x: -8, y: 0 }, end: { x: 0, y: 0 } },
        { friction: 0, restitution: 0 },
      )
      line.id = 'direct-seam-line'
      const arc = makeGround(
        scene,
        {
          type: 'arc',
          center: { x: 0, y: radius },
          radius,
          startRad: Math.PI / 2,
          endRad: -Math.PI / 2,
        },
        { friction: 0, restitution: 0 },
      )
      arc.id = 'direct-seam-arc'
      const joint = makeGroundJoint(scene, 'direct-seam-joint', line.id, 'end', arc.id, 'end')
      const bodyId = 'direct-seam-ball'
      scene.entities = [
        line,
        arc,
        joint,
        makeBody(
          scene,
          bodyId,
          { x: -1, y: ballRadius },
          { x: speed, y: 0 },
          {
            shape: { type: 'circle', radius: ballRadius, collisionEnabled: true },
            material: { friction: 0, restitution: 0 },
          },
        ),
      ]
      if (gravityY !== 0) scene.entities.push(makeGravity(scene, { x: 0, y: gravityY }))

      const network = buildGroundPathNetwork(scene.entities)
      expect(network.jointPaths.get(joint.id)).toMatchObject({
        issue: null,
        kind: 'direct',
        path: null,
        pieces: [],
      })
      const arcPath = network.groundPaths.get(arc.id)?.path
      if (!arcPath) throw new Error('测试圆弧没有生成有效路径')
      const initialEnergy = 0.5 * speed ** 2 - gravityY * ballRadius
      const world = createWorld(scene)
      let maximumGapM = 0
      let maximumRelativeEnergyError = 0
      let minimumForwardSpeed = speed
      let reachedArc = false

      for (let step = 0; step < 180; step += 1) {
        world.step()
        const state = stateOf(world, bodyId)
        const lineClosest = network.groundPaths.get(line.id)!.path.closestPoint(state.position)
        const arcClosest = arcPath.closestPoint(state.position)
        const onArc = arcClosest.distance <= lineClosest.distance
        const closest = onArc ? arcClosest : lineClosest
        const travelTangent = onArc
          ? { x: -closest.tangent.x, y: -closest.tangent.y }
          : closest.tangent
        maximumGapM = Math.max(maximumGapM, Math.abs(closest.distance - ballRadius))
        minimumForwardSpeed = Math.min(
          minimumForwardSpeed,
          state.linearVelocity.x * travelTangent.x + state.linearVelocity.y * travelTangent.y,
        )
        const energy =
          0.5 * (state.linearVelocity.x ** 2 + state.linearVelocity.y ** 2) -
          gravityY * state.position.y
        maximumRelativeEnergyError = Math.max(
          maximumRelativeEnergyError,
          Math.abs(energy - initialEnergy) / Math.max(initialEnergy, 1),
        )
        if (
          arcClosest.s < arcPath.length - 0.5 &&
          Math.abs(arcClosest.distance - ballRadius) < 0.003
        ) {
          reachedArc = true
          break
        }
      }

      const label = `v=${speed}, g=${gravityY}, gap=${maximumGapM}, energy=${maximumRelativeEnergyError}, forward=${minimumForwardSpeed}`
      expect(reachedArc, label).toBe(true)
      expect(maximumGapM, label).toBeLessThan(0.003)
      expect(minimumForwardSpeed, label).toBeGreaterThan(0)
      expect(maximumRelativeEnergyError, label).toBeLessThan(0.005)
      expect(world.warnings.some((warning) => warning.entityId === joint.id)).toBe(false)
    },
  )

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

  it('0° 圆弧或贝塞尔通过无形接缝保持有限且连续的碰撞结果', () => {
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
      expect(buildGroundPathNetwork(scene.entities).jointPaths.get(joint.id)?.kind).toBe('direct')
      expect(world.warnings.some((warning) => warning.entityId === joint.id)).toBe(false)
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

  it('0° 直线—圆弧使用无形接缝连续移交路径', () => {
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
    expect(buildGroundPathNetwork(scene.entities).jointPaths.get('line-arc-joint')?.kind).toBe(
      'direct',
    )
    expect(world.warnings.some((warning) => warning.entityId === 'line-arc-joint')).toBe(false)
    const initialEnergy = 0.5 * 5 ** 2 + 9.80665 * 0.5

    world.step(55)
    const state = stateOf(world, 'line-arc-ball')
    const finalEnergy =
      0.5 * (state.linearVelocity.x ** 2 + state.linearVelocity.y ** 2) + 9.80665 * state.position.y

    expect(state.position.x).toBeGreaterThan(0.5)
    expect(Math.hypot(state.position.x, state.position.y - 3)).toBeCloseTo(2.5, 2)
    expect(Math.abs(finalEnergy - initialEnergy) / initialEnergy).toBeLessThan(0.02)
  })

  it('0° 圆弧—直线反向通过无形接缝连续移交路径', () => {
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
    expect(buildGroundPathNetwork(scene.entities).jointPaths.get('arc-line-joint')?.kind).toBe(
      'direct',
    )
    expect(world.warnings.some((warning) => warning.entityId === 'arc-line-joint')).toBe(false)
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

  it('0° 直线—贝塞尔通过无形接缝保持相切运动', () => {
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
    expect(buildGroundPathNetwork(scene.entities).jointPaths.get('line-bezier-joint')?.kind).toBe(
      'direct',
    )
    expect(world.warnings.some((warning) => warning.entityId === 'line-bezier-joint')).toBe(false)
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
  }, 15_000)

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

describe('碰撞绳与自由端弹簧接触回归', () => {
  it('地面锚点的碰撞绳单摆不会被自身锚定地面停在最低点', () => {
    const scene = baseScene()
    const ground = makeGround(
      scene,
      { type: 'line', start: { x: -4, y: 2 }, end: { x: 4, y: 2 } },
      { friction: 0, restitution: 0 },
    )
    const length = 3
    const startAngle = 0.55
    const bob = makeBody(
      scene,
      'ground-pendulum-bob',
      { x: -length * Math.sin(startAngle), y: 2 - length * Math.cos(startAngle) },
      { x: 0, y: 0 },
      { shape: { type: 'circle', radius: 0.15, collisionEnabled: false } },
    )
    const rope: ConnectorEntity = makeConnector(scene, 'ground-pendulum-rope', bob.id, 'unused', {
      type: 'rope',
      maxLength: length,
    })
    rope.b = { type: 'ground', groundId: ground.id, pathRatio: 0.5 }
    rope.collisionEnabled = true
    rope.massKg = 0.001
    rope.radiusM = 0.05
    rope.material = { friction: 0, restitution: 0 }
    scene.entities = [ground, bob, rope, makeGravity(scene, { x: 0, y: -9.80665 })]
    const world = createWorld(scene)
    let maximumRightX = -Infinity
    let maximumCenterSpeed = 0

    for (let step = 0; step < 360; step += 1) {
      world.step()
      const state = stateOf(world, bob.id)
      maximumRightX = Math.max(maximumRightX, state.position.x)
      if (Math.abs(state.position.x) < 0.15) {
        maximumCenterSpeed = Math.max(
          maximumCenterSpeed,
          Math.hypot(state.linearVelocity.x, state.linearVelocity.y),
        )
      }
    }

    expect(maximumCenterSpeed).toBeGreaterThan(2)
    expect(maximumRightX).toBeGreaterThan(0.75)
  }, 30_000)

  it('地面锚点的碰撞绳单摆在连续摆动中不会出现速度抽搐', () => {
    const scene = baseScene()
    const ground = makeGround(
      scene,
      { type: 'line', start: { x: -4, y: 2 }, end: { x: 4, y: 2 } },
      { friction: 0, restitution: 0 },
    )
    const length = 3
    const startAngle = 0.55
    const bob = makeBody(
      scene,
      'smooth-ground-pendulum-bob',
      { x: -length * Math.sin(startAngle), y: 2 - length * Math.cos(startAngle) },
      { x: 0, y: 0 },
      { shape: { type: 'circle', radius: 0.15, collisionEnabled: false } },
    )
    const rope: ConnectorEntity = makeConnector(
      scene,
      'smooth-ground-pendulum-rope',
      bob.id,
      'unused',
      { type: 'rope', maxLength: length },
    )
    rope.b = { type: 'ground', groundId: ground.id, pathRatio: 0.5 }
    rope.collisionEnabled = true
    rope.massKg = 0.001
    rope.radiusM = 0.05
    rope.material = { friction: 0, restitution: 0 }
    scene.entities = [ground, bob, rope, makeGravity(scene, { x: 0, y: -9.80665 })]
    const world = createWorld(scene)
    let previousVelocity = stateOf(world, bob.id).linearVelocity
    let maximumVelocityStep = 0
    let maximumRadialSeparationSpeed = 0

    for (let step = 0; step < 720; step += 1) {
      world.step()
      const state = stateOf(world, bob.id)
      const velocity = state.linearVelocity
      const velocityStep = Math.hypot(
        velocity.x - previousVelocity.x,
        velocity.y - previousVelocity.y,
      )
      maximumVelocityStep = Math.max(maximumVelocityStep, velocityStep)
      const radialDelta = { x: state.position.x, y: state.position.y - 2 }
      const radialLength = Math.hypot(radialDelta.x, radialDelta.y)
      maximumRadialSeparationSpeed = Math.max(
        maximumRadialSeparationSpeed,
        (velocity.x * radialDelta.x + velocity.y * radialDelta.y) / radialLength,
      )
      previousVelocity = velocity
    }

    expect(maximumVelocityStep).toBeLessThan(0.2)
    expect(maximumRadialSeparationSpeed).toBeLessThan(0.05)
  }, 30_000)

  it('地面锚定的摆绳扫过大质量圆球时形成多段包络并绕到另一侧', () => {
    const scene = baseScene()
    const ground = makeGround(
      scene,
      { type: 'line', start: { x: -4, y: 3 }, end: { x: 4, y: 3 } },
      { friction: 0, restitution: 0 },
    )
    const length = 4
    const startAngle = 0.65
    const speed = 5
    const bob = makeBody(
      scene,
      'wrapping-pendulum-bob',
      { x: -length * Math.sin(startAngle), y: 3 - length * Math.cos(startAngle) },
      { x: speed * Math.cos(startAngle), y: -speed * Math.sin(startAngle) },
      { shape: { type: 'circle', radius: 0.15, collisionEnabled: false } },
    )
    const obstacle = makeBody(
      scene,
      'wrapping-heavy-obstacle',
      { x: 0, y: 1.15 },
      { x: 0, y: 0 },
      {
        massKg: 1e8,
        shape: { type: 'circle', radius: 0.5, collisionEnabled: true },
      },
    )
    obstacle.material = { friction: 0, restitution: 0 }
    const rope: ConnectorEntity = makeConnector(scene, 'wrapping-pendulum-rope', bob.id, 'unused', {
      type: 'rope',
      maxLength: length,
    })
    rope.b = { type: 'ground', groundId: ground.id, pathRatio: 0.5 }
    rope.collisionEnabled = true
    rope.massKg = 0.001
    rope.radiusM = 0.05
    rope.material = { friction: 0, restitution: 0 }
    scene.entities = [ground, bob, obstacle, rope]
    const world = createWorld(scene)
    let maximumContactSegments = 0
    let maximumContactAngle = 0
    let maximumRightX = -Infinity
    let maximumBobSpeed = 0
    let minimumRopeSeparation = Number.POSITIVE_INFINITY
    let minimumRopeSeparationStep = -1
    let minimumRopeSeparationSegment = -1

    for (let step = 0; step < 360; step += 1) {
      world.step()
      const bobState = stateOf(world, bob.id)
      maximumRightX = Math.max(maximumRightX, bobState.position.x)
      maximumBobSpeed = Math.max(
        maximumBobSpeed,
        Math.hypot(bobState.linearVelocity.x, bobState.linearVelocity.y),
      )
      const obstacleState = stateOf(world, obstacle.id)
      const points = world.getConnectorStates().find((state) => state.entityId === rope.id)?.points
      if (!points) continue
      const contactAngles: number[] = []
      for (let index = 1; index < points.length; index += 1) {
        const first = points[index - 1]!
        const second = points[index]!
        const delta = { x: second.x - first.x, y: second.y - first.y }
        const lengthSquared = delta.x * delta.x + delta.y * delta.y
        const projection = Math.max(
          0,
          Math.min(
            1,
            ((obstacleState.position.x - first.x) * delta.x +
              (obstacleState.position.y - first.y) * delta.y) /
              Math.max(Number.EPSILON, lengthSquared),
          ),
        )
        const closest = {
          x: first.x + delta.x * projection,
          y: first.y + delta.y * projection,
        }
        const separation = distance(closest, obstacleState.position)
        if (separation - 0.55 < minimumRopeSeparation) {
          minimumRopeSeparation = separation - 0.55
          minimumRopeSeparationStep = step
          minimumRopeSeparationSegment = index - 1
        }
        if (separation <= 0.552) {
          contactAngles.push(
            Math.atan2(closest.y - obstacleState.position.y, closest.x - obstacleState.position.x),
          )
        }
      }
      maximumContactSegments = Math.max(maximumContactSegments, contactAngles.length)
      for (let first = 0; first < contactAngles.length; first += 1) {
        for (let second = first + 1; second < contactAngles.length; second += 1) {
          const rawDifference = Math.abs(contactAngles[first]! - contactAngles[second]!)
          maximumContactAngle = Math.max(
            maximumContactAngle,
            Math.min(rawDifference, Math.PI * 2 - rawDifference),
          )
        }
      }
    }

    expect(maximumContactSegments).toBeGreaterThanOrEqual(3)
    expect(maximumContactAngle).toBeGreaterThanOrEqual(0.25)
    expect(maximumRightX).toBeGreaterThan(0.25)
    expect(maximumBobSpeed).toBeLessThan(10)
    expect(
      minimumRopeSeparation,
      `最深穿透发生在第 ${minimumRopeSeparationStep} 步、绳段 ${minimumRopeSeparationSegment}`,
    ).toBeGreaterThanOrEqual(-0.002)
  }, 30_000)

  it('绳长收敛后持续受压的旋转物块不会把活动绳段拉到错误一侧', () => {
    const scene = baseScene()
    const ground = makeGround(
      scene,
      { type: 'line', start: { x: -4, y: 3 }, end: { x: 4, y: 3 } },
      { friction: 0, restitution: 0 },
    )
    const ropeLength = 4
    const startAngle = 0.65
    const bob = makeBody(
      scene,
      'rotated-block-wrap-bob',
      {
        x: -ropeLength * Math.sin(startAngle),
        y: 3 - ropeLength * Math.cos(startAngle),
      },
      { x: 5 * Math.cos(startAngle), y: -5 * Math.sin(startAngle) },
      { shape: { type: 'circle', radius: 0.15, collisionEnabled: false } },
    )
    const obstacle = makeBody(
      scene,
      'rotated-block-wrap-obstacle',
      { x: 0, y: 1.15 },
      { x: 0, y: 0 },
      {
        massKg: 1e8,
        preset: 'block',
        shape: { type: 'box', width: 0.9, height: 0.7 },
        transform: { position: { x: 0, y: 1.15 }, angleRad: 0.35 },
        initialAngularVelocityRad: 0.2,
      },
    )
    const rope: ConnectorEntity = makeConnector(
      scene,
      'rotated-block-wrap-rope',
      bob.id,
      'unused',
      { type: 'rope', maxLength: ropeLength },
    )
    rope.b = { type: 'ground', groundId: ground.id, pathRatio: 0.5 }
    rope.collisionEnabled = true
    rope.massKg = 0.001
    rope.radiusM = 0.05
    rope.material = { friction: 0, restitution: 0 }
    scene.entities = [ground, bob, obstacle, rope]
    const world = createWorld(scene)
    let minimumSeparation = Number.POSITIVE_INFINITY
    let minimumSeparationStep = -1
    let minimumSeparationSegment = -1
    let minimumSeparationActiveContacts = -1
    let minimumSeparationSegmentContact = false
    let minimumSeparationContactDistance = Number.POSITIVE_INFINITY
    const internal = world as unknown as {
      activeFlexibleRopeBodyContacts: Map<
        string,
        Array<{ bodyId: string; record: { segmentIndex: number }; separation: number }>
      >
    }

    for (let step = 0; step < 360; step += 1) {
      world.step()
      const obstacleState = stateOf(world, obstacle.id)
      const cosine = Math.cos(obstacleState.angleRad)
      const sine = Math.sin(obstacleState.angleRad)
      const toLocal = (point: Vec2): Vec2 => {
        const offset = {
          x: point.x - obstacleState.position.x,
          y: point.y - obstacleState.position.y,
        }
        return {
          x: cosine * offset.x + sine * offset.y,
          y: -sine * offset.x + cosine * offset.y,
        }
      }
      const points = world.getConnectorStates().find((state) => state.entityId === rope.id)?.points
      if (!points) continue
      for (let index = 1; index < points.length; index += 1) {
        const centerlineDistance = Math.sqrt(
          segmentToAabbDistanceSquared(
            toLocal(points[index - 1]!),
            toLocal(points[index]!),
            0.45,
            0.35,
          ),
        )
        const separation = centerlineDistance - rope.radiusM
        if (separation < minimumSeparation) {
          minimumSeparation = separation
          minimumSeparationStep = step
          minimumSeparationSegment = index - 1
          minimumSeparationActiveContacts =
            internal.activeFlexibleRopeBodyContacts.get(rope.id)?.length ?? 0
          minimumSeparationSegmentContact =
            internal.activeFlexibleRopeBodyContacts
              .get(rope.id)
              ?.some(
                (contact) =>
                  contact.bodyId === obstacle.id && contact.record.segmentIndex === index - 1,
              ) ?? false
          minimumSeparationContactDistance =
            internal.activeFlexibleRopeBodyContacts
              .get(rope.id)
              ?.find(
                (contact) =>
                  contact.bodyId === obstacle.id && contact.record.segmentIndex === index - 1,
              )?.separation ?? Number.POSITIVE_INFINITY
        }
      }
    }

    expect(
      minimumSeparation,
      `最深穿透发生在第 ${minimumSeparationStep} 步、绳段 ${minimumSeparationSegment}，` +
        `活动接触数 ${minimumSeparationActiveContacts}，该段接触 ${minimumSeparationSegmentContact}，` +
        `求解器距离 ${minimumSeparationContactDistance}`,
    ).toBeGreaterThanOrEqual(-0.002)
  }, 30_000)

  it('碰撞弯曲产生的内部绳节点速度不会被整绳约束集中注入端点', () => {
    const scene = baseScene()
    const ground = makeGround(
      scene,
      { type: 'line', start: { x: -1, y: 0 }, end: { x: 1, y: 0 } },
      { friction: 0, restitution: 0 },
    )
    const bob = makeBody(
      scene,
      'internal-rope-velocity-bob',
      { x: Math.sqrt(12), y: 0 },
      { x: 0, y: 0 },
      { shape: { type: 'circle', radius: 0.15, collisionEnabled: false } },
    )
    const rope: ConnectorEntity = makeConnector(
      scene,
      'internal-rope-velocity-rope',
      bob.id,
      'unused',
      { type: 'rope', maxLength: 4 },
    )
    rope.b = { type: 'ground', groundId: ground.id, pathRatio: 0.5 }
    rope.collisionEnabled = true
    rope.massKg = 0.001
    rope.radiusM = 0.05
    scene.entities = [ground, bob, rope]
    const world = createWorld(scene)
    type TestEndpoint = {
      rigidBody: {
        setTranslation(position: { x: number; y: number }, wakeUp: boolean): void
        setLinvel(velocity: { x: number; y: number }, wakeUp: boolean): void
      }
    }
    type TestRopeRecord = { chain: TestEndpoint[]; nodes: TestEndpoint[] }
    const internal = world as unknown as {
      flexibleConnectorsById: Map<string, TestRopeRecord>
      solveFlexibleRopeTotalLength(
        record: TestRopeRecord,
        chain: TestEndpoint[],
        velocityOnly: boolean,
        endpointMotionOnly: boolean,
      ): number
    }
    const record = internal.flexibleConnectorsById.get(rope.id)!
    const lastIndex = record.chain.length - 1
    for (let index = 1; index < lastIndex; index += 1) {
      const ratio = index / lastIndex
      record.chain[index]!.rigidBody.setTranslation(
        {
          x: Math.sqrt(12) * (1 - ratio),
          y: ratio <= 0.5 ? ratio * 2 : (1 - ratio) * 2,
        },
        true,
      )
      record.chain[index]!.rigidBody.setLinvel({ x: 0, y: 1 }, true)
    }

    internal.solveFlexibleRopeTotalLength(record, record.chain, true, true)

    const bobVelocity = stateOf(world, bob.id).linearVelocity
    expect(Math.hypot(bobVelocity.x, bobVelocity.y)).toBeLessThan(1e-9)
  })

  it('碰撞绳绕过大质量圆球时不会持续向端点小球注入沿绳速度', () => {
    const scene = baseScene()
    const ground = makeGround(
      scene,
      { type: 'line', start: { x: -4, y: 3 }, end: { x: 4, y: 3 } },
      { friction: 0, restitution: 0 },
    )
    const length = 4
    const startAngle = 0.65
    const initialSpeed = 5
    const bob = makeBody(
      scene,
      'energy-stable-wrapping-bob',
      { x: -length * Math.sin(startAngle), y: 3 - length * Math.cos(startAngle) },
      { x: initialSpeed * Math.cos(startAngle), y: -initialSpeed * Math.sin(startAngle) },
      {
        shape: { type: 'circle', radius: 0.15, collisionEnabled: true },
        material: { friction: 0, restitution: 0 },
      },
    )
    const obstacle = makeBody(
      scene,
      'energy-stable-wrapping-obstacle',
      { x: 0, y: 1.15 },
      { x: 0, y: 0 },
      {
        massKg: 1e8,
        shape: { type: 'circle', radius: 0.5, collisionEnabled: true },
        material: { friction: 0, restitution: 0 },
      },
    )
    const rope: ConnectorEntity = makeConnector(
      scene,
      'energy-stable-wrapping-rope',
      bob.id,
      'unused',
      { type: 'rope', maxLength: length },
    )
    rope.b = { type: 'ground', groundId: ground.id, pathRatio: 0.5 }
    rope.collisionEnabled = true
    rope.massKg = 0.001
    rope.radiusM = 0.05
    rope.material = { friction: 0, restitution: 0 }
    scene.entities = [ground, bob, obstacle, rope]
    const world = createWorld(scene)
    let maximumBobSpeed = 0
    let minimumBodySeparation = Number.POSITIVE_INFINITY

    for (let step = 0; step < 720; step += 1) {
      world.step()
      const bobState = stateOf(world, bob.id)
      const obstacleState = stateOf(world, obstacle.id)
      maximumBobSpeed = Math.max(
        maximumBobSpeed,
        Math.hypot(bobState.linearVelocity.x, bobState.linearVelocity.y),
      )
      minimumBodySeparation = Math.min(
        minimumBodySeparation,
        distance(bobState.position, obstacleState.position) - 0.65,
      )
    }

    expect(maximumBobSpeed).toBeLessThan(initialSpeed * 1.02)
    expect(minimumBodySeparation).toBeGreaterThanOrEqual(-0.002)
  }, 30_000)

  it('已经沿法向离开球面的近距离绳段不会继续作为活动接触', () => {
    const scene = baseScene()
    const rope: ConnectorEntity = makeConnector(
      scene,
      'separating-nearby-rope',
      'unused-a',
      'unused-b',
      { type: 'rope', maxLength: 2.4 },
    )
    rope.a = { type: 'world', position: { x: -1, y: 0 } }
    rope.b = { type: 'world', position: { x: 1, y: 0 } }
    rope.collisionEnabled = true
    rope.massKg = 0.001
    rope.radiusM = 0.05
    rope.material = { friction: 0, restitution: 0 }
    const ball = makeBody(
      scene,
      'separating-nearby-ball',
      { x: 0, y: 0.249999 },
      { x: 0, y: 0.01 },
      {
        shape: { type: 'circle', radius: 0.2, collisionEnabled: true },
        material: { friction: 0, restitution: 0 },
      },
    )
    scene.entities = [rope, ball]
    const world = createWorld(scene)

    world.step()

    const internal = world as unknown as {
      activeFlexibleRopeBodyContacts: Map<string, unknown[]>
    }
    expect(internal.activeFlexibleRopeBodyContacts.get(rope.id) ?? []).toHaveLength(0)
    expect(stateOf(world, ball.id).linearVelocity.y).toBeCloseTo(0.01, 6)
  })

  it('地面锚点只豁免局部自接触，远处绳段仍与同一地面碰撞', () => {
    const scene = baseScene()
    const ground = makeGround(
      scene,
      { type: 'line', start: { x: -5, y: 0 }, end: { x: 5, y: 0 } },
      { friction: 0, restitution: 0 },
    )
    const endpoint = makeBody(
      scene,
      'same-ground-rope-end',
      { x: 3, y: 0.4 },
      { x: 0, y: 0 },
      { massKg: 1e8, shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
    )
    const rope: ConnectorEntity = makeConnector(scene, 'same-ground-rope', endpoint.id, 'unused', {
      type: 'rope',
      maxLength: 5.5,
    })
    rope.b = { type: 'ground', groundId: ground.id, pathRatio: 0.3 }
    rope.collisionEnabled = true
    rope.massKg = 0.001
    rope.radiusM = 0.05
    scene.entities = [ground, endpoint, rope, makeGravity(scene, { x: 0, y: -9.80665 })]
    const world = createWorld(scene)

    world.step(600)
    const points = world.getConnectorStates().find((state) => state.entityId === rope.id)?.points
    const pointsAwayFromAnchor = points?.slice(0, -2) ?? []

    expect(pointsAwayFromAnchor.length).toBeGreaterThan(2)
    expect(Math.min(...pointsAwayFromAnchor.map((point) => point.y))).toBeGreaterThanOrEqual(-0.002)
  }, 30_000)

  it('地面连接段锚点附近同样不会对碰撞绳施加自碰撞冲量', () => {
    const scene = baseScene()
    const firstGround = makeGround(scene, {
      type: 'line',
      start: { x: -4, y: 0 },
      end: { x: 0, y: 0 },
    })
    firstGround.id = 'rope-joint-first'
    const secondGround = makeGround(scene, {
      type: 'line',
      start: { x: 2, y: 2 },
      end: { x: 2, y: 6 },
    })
    secondGround.id = 'rope-joint-second'
    const joint = makeGroundJoint(
      scene,
      'rope-anchor-joint',
      firstGround.id,
      'end',
      secondGround.id,
      'start',
    )
    const transition = buildGroundPathNetwork([firstGround, secondGround, joint]).jointPaths.get(
      joint.id,
    )?.path
    if (!transition) throw new Error('测试地面连接没有生成有效过渡路径')
    const anchor = transition.pointAt(transition.length / 2)
    const normal = transition.normalAt(transition.length / 2)
    const tangent = transition.tangentAt(transition.length / 2)
    const bob = makeBody(
      scene,
      'joint-anchor-bob',
      { x: anchor.x + normal.x * 3, y: anchor.y + normal.y * 3 },
      { x: tangent.x * 3, y: tangent.y * 3 },
      { shape: { type: 'circle', radius: 0.15, collisionEnabled: false } },
    )
    const rope: ConnectorEntity = makeConnector(scene, 'joint-anchor-rope', bob.id, 'unused', {
      type: 'rope',
      maxLength: 3,
    })
    rope.b = { type: 'groundJoint', groundJointId: joint.id, pathRatio: 0.5 }
    rope.collisionEnabled = true
    rope.massKg = 0.001
    rope.radiusM = 0.05
    scene.entities = [firstGround, secondGround, joint, bob, rope]
    const world = createWorld(scene)
    let minimumSpeed = 3

    for (let step = 0; step < 120; step += 1) {
      world.step()
      const velocity = stateOf(world, bob.id).linearVelocity
      minimumSpeed = Math.min(minimumSpeed, Math.hypot(velocity.x, velocity.y))
    }

    expect(minimumSpeed).toBeGreaterThan(2.5)
  })

  it('有松弛量的碰撞绳在物体撞击处弯曲而不是作为直杆整体响应', () => {
    const scene = baseScene()
    const fixedLike = {
      massKg: 1e8,
      shape: { type: 'circle' as const, radius: 0.1, collisionEnabled: false },
    }
    const first = makeBody(scene, 'flexible-rope-first', { x: -1, y: 0 }, { x: 0, y: 0 }, fixedLike)
    const second = makeBody(
      scene,
      'flexible-rope-second',
      { x: 1, y: 0 },
      { x: 0, y: 0 },
      fixedLike,
    )
    const projectile = makeBody(
      scene,
      'flexible-rope-projectile',
      { x: 0, y: 0.8 },
      { x: 0, y: -5 },
      { shape: { type: 'circle', radius: 0.2, collisionEnabled: true } },
    )
    const rope = makeConnector(scene, 'locally-flexible-rope', first.id, second.id, {
      type: 'rope',
      maxLength: 2.6,
    })
    rope.collisionEnabled = true
    rope.massKg = 0.001
    rope.radiusM = 0.05
    scene.entities = [first, second, projectile, rope]
    const world = createWorld(scene)
    let maximumDeviation = 0
    let maximumLength = 0

    for (let step = 0; step < 80; step += 1) {
      world.step()
      const points = world.getConnectorStates().find((state) => state.entityId === rope.id)?.points
      if (!points || points.length < 3) continue
      const start = points[0]!
      const end = points.at(-1)!
      const chord = { x: end.x - start.x, y: end.y - start.y }
      const chordLength = Math.max(Number.EPSILON, Math.hypot(chord.x, chord.y))
      maximumDeviation = Math.max(
        maximumDeviation,
        ...points
          .slice(1, -1)
          .map(
            (point) =>
              Math.abs(chord.x * (start.y - point.y) - (start.x - point.x) * chord.y) / chordLength,
          ),
      )
      maximumLength = Math.max(
        maximumLength,
        points.slice(1).reduce((sum, point, index) => sum + distance(points[index]!, point), 0),
      )
    }

    expect(maximumDeviation).toBeGreaterThan(0.05)
    expect(maximumLength).toBeLessThanOrEqual(2.60026)
  })

  it('拉紧但端点可移动的碰撞绳受撞击时通过端点靠近形成局部弯曲', () => {
    const scene = baseScene()
    const first = makeBody(
      scene,
      'taut-flexible-rope-first',
      { x: -1, y: 0 },
      { x: 0, y: 0 },
      { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
    )
    const second = makeBody(
      scene,
      'taut-flexible-rope-second',
      { x: 1, y: 0 },
      { x: 0, y: 0 },
      { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
    )
    const projectile = makeBody(
      scene,
      'taut-flexible-rope-projectile',
      { x: 0, y: 0.8 },
      { x: 0, y: -5 },
      { shape: { type: 'circle', radius: 0.2, collisionEnabled: true } },
    )
    const rope = makeConnector(scene, 'taut-locally-flexible-rope', first.id, second.id, {
      type: 'rope',
      maxLength: 2,
    })
    rope.collisionEnabled = true
    rope.massKg = 0.001
    rope.radiusM = 0.05
    scene.entities = [first, second, projectile, rope]
    const world = createWorld(scene)
    let maximumDeviation = 0
    let minimumEndpointDistance = 2
    let maximumLength = 0

    for (let step = 0; step < 100; step += 1) {
      world.step()
      const points = world.getConnectorStates().find((state) => state.entityId === rope.id)?.points
      if (!points || points.length < 3) continue
      const start = points[0]!
      const end = points.at(-1)!
      const chord = { x: end.x - start.x, y: end.y - start.y }
      const chordLength = Math.max(Number.EPSILON, Math.hypot(chord.x, chord.y))
      minimumEndpointDistance = Math.min(minimumEndpointDistance, chordLength)
      maximumDeviation = Math.max(
        maximumDeviation,
        ...points
          .slice(1, -1)
          .map(
            (point) =>
              Math.abs(chord.x * (start.y - point.y) - (start.x - point.x) * chord.y) / chordLength,
          ),
      )
      maximumLength = Math.max(
        maximumLength,
        points.slice(1).reduce((sum, point, index) => sum + distance(points[index]!, point), 0),
      )
    }

    expect(maximumDeviation).toBeGreaterThan(0.03)
    expect(minimumEndpointDistance).toBeLessThan(1.99)
    expect(maximumLength).toBeLessThanOrEqual(2.0002)
  })

  it('自由端弹簧挡板沿轴向撞击地面时压缩并把动态锚点弹回', () => {
    const scene = baseScene()
    const ground = makeGround(
      scene,
      { type: 'line', start: { x: -4, y: 0 }, end: { x: 4, y: 0 } },
      { friction: 0, restitution: 0 },
    )
    const anchor = makeBody(
      scene,
      'spring-ground-anchor',
      { x: 0, y: 2.5 },
      { x: 0, y: -4 },
      { shape: { type: 'circle', radius: 0.2, collisionEnabled: false } },
    )
    const spring: ConnectorEntity = makeConnector(
      scene,
      'spring-ground-bumper',
      anchor.id,
      'unused',
      {
        type: 'spring',
        restLength: 2,
        stiffness: 400,
        damping: 0,
      },
    )
    spring.b = { type: 'free', position: { x: 0, y: 0.5 } }
    spring.radiusM = 0.25
    scene.entities = [ground, anchor, spring]
    const world = createWorld(scene)
    let minimumCapY = Infinity
    let maximumUpwardSpeed = -Infinity
    let maximumEnergyError = 0

    for (let step = 0; step < 180; step += 1) {
      world.step()
      const points = world
        .getConnectorStates()
        .find((state) => state.entityId === spring.id)?.points
      if (points?.length === 2) minimumCapY = Math.min(minimumCapY, points[1]!.y)
      const anchorState = stateOf(world, anchor.id)
      maximumUpwardSpeed = Math.max(maximumUpwardSpeed, anchorState.linearVelocity.y)
      const compression =
        points?.length === 2 ? Math.max(0, 2 - distance(points[0]!, points[1]!)) : 0
      const energy = anchorState.kineticEnergyJ + 0.5 * 400 * compression ** 2
      maximumEnergyError = Math.max(maximumEnergyError, Math.abs(energy - 8) / 8)
    }

    expect(minimumCapY).toBeGreaterThanOrEqual(-0.002)
    expect(maximumUpwardSpeed).toBeGreaterThan(1)
    expect(maximumEnergyError).toBeLessThan(0.005)
  })

  it.each(
    (['line', 'arc', 'bezier'] as const).flatMap((groundType) =>
      ([1, -1] as const).map((side) => ({ groundType, side })),
    ),
  )('自由端挡板与 $groundType 地面的第 $side 侧连续接触', ({ groundType, side }) => {
    const scene = baseScene()
    const geometry: GroundEntity['geometry'] =
      groundType === 'line'
        ? { type: 'line', start: { x: -5, y: 0 }, end: { x: 5, y: 0 } }
        : groundType === 'arc'
          ? {
              type: 'arc',
              center: { x: 0, y: -10 * side },
              radius: 10,
              startRad: side === 1 ? Math.PI / 4 : (Math.PI * 5) / 4,
              endRad: side === 1 ? (Math.PI * 3) / 4 : (Math.PI * 7) / 4,
            }
          : {
              type: 'cubicBezier',
              p0: { x: -5, y: 0 },
              p1: { x: -2, y: 0 },
              p2: { x: 2, y: 0 },
              p3: { x: 5, y: 0 },
            }
    const ground = makeGround(scene, geometry, { friction: 0, restitution: 0 })
    const anchor = makeBody(
      scene,
      `spring-${groundType}-${side}-anchor`,
      { x: 0, y: 2.5 * side },
      { x: 0, y: -4 * side },
      { shape: { type: 'circle', radius: 0.2, collisionEnabled: false } },
    )
    const spring: ConnectorEntity = makeConnector(
      scene,
      `spring-${groundType}-${side}`,
      anchor.id,
      'unused',
      {
        type: 'spring',
        restLength: 2,
        stiffness: 400,
        damping: 0,
      },
    )
    spring.b = { type: 'free', position: { x: 0, y: 0.5 * side } }
    spring.radiusM = 0.25
    scene.entities = [ground, anchor, spring]
    const world = createWorld(scene)
    let minimumSignedCapHeight = Infinity
    let maximumReboundSpeed = -Infinity

    for (let step = 0; step < 180; step += 1) {
      world.step()
      const points = world
        .getConnectorStates()
        .find((state) => state.entityId === spring.id)?.points
      if (points?.length === 2) {
        minimumSignedCapHeight = Math.min(minimumSignedCapHeight, points[1]!.y * side)
      }
      maximumReboundSpeed = Math.max(
        maximumReboundSpeed,
        stateOf(world, anchor.id).linearVelocity.y * side,
      )
    }

    expect(minimumSignedCapHeight).toBeGreaterThanOrEqual(-0.002)
    expect(maximumReboundSpeed).toBeGreaterThan(1)
  })

  it.each([5, 30, 60, 100])('自由端挡板以 %s m/s 撞击直线地面时不穿透', (speedMps) => {
    const scene = baseScene()
    const ground = makeGround(scene, {
      type: 'line',
      start: { x: -5, y: 0 },
      end: { x: 5, y: 0 },
    })
    const anchor = makeBody(
      scene,
      `fast-spring-ground-anchor-${speedMps}`,
      { x: 0, y: 2.5 },
      { x: 0, y: -speedMps },
      { shape: { type: 'circle', radius: 0.2, collisionEnabled: false } },
    )
    const spring: ConnectorEntity = makeConnector(
      scene,
      `fast-spring-ground-${speedMps}`,
      anchor.id,
      'unused',
      {
        type: 'spring',
        restLength: 2,
        stiffness: 2_000,
        damping: 0,
      },
    )
    spring.b = { type: 'free', position: { x: 0, y: 0.5 } }
    spring.radiusM = 0.2
    scene.entities = [ground, anchor, spring]
    const world = createWorld(scene)
    let minimumCapY = Infinity

    for (let step = 0; step < 180; step += 1) {
      world.step()
      const points = world
        .getConnectorStates()
        .find((state) => state.entityId === spring.id)?.points
      if (points?.length === 2) minimumCapY = Math.min(minimumCapY, points[1]!.y)
    }

    expect(minimumCapY).toBeGreaterThanOrEqual(-0.002)
    expect(stateOf(world, anchor.id).linearVelocity.y).toBeGreaterThanOrEqual(0)
  })

  it('自由端挡板与地面连接过渡发生连续接触', () => {
    const scene = baseScene()
    const firstGround = makeGround(scene, {
      type: 'line',
      start: { x: -4, y: 0 },
      end: { x: 0, y: 0 },
    })
    firstGround.id = 'spring-transition-first'
    const secondGround = makeGround(scene, {
      type: 'line',
      start: { x: 2, y: 2 },
      end: { x: 2, y: 6 },
    })
    secondGround.id = 'spring-transition-second'
    const joint = makeGroundJoint(
      scene,
      'spring-transition-joint',
      firstGround.id,
      'end',
      secondGround.id,
      'start',
    )
    const network = buildGroundPathNetwork([firstGround, secondGround, joint])
    const transition = network.jointPaths.get(joint.id)?.path
    if (!transition) throw new Error('测试地面连接没有生成有效过渡路径')
    const contactS = transition.length / 2
    const contactPoint = transition.pointAt(contactS)
    const normal = transition.normalAt(contactS)
    const anchor = makeBody(
      scene,
      'spring-transition-anchor',
      {
        x: contactPoint.x + normal.x * 2.5,
        y: contactPoint.y + normal.y * 2.5,
      },
      { x: -normal.x * 4, y: -normal.y * 4 },
      { shape: { type: 'circle', radius: 0.2, collisionEnabled: false } },
    )
    const spring: ConnectorEntity = makeConnector(
      scene,
      'spring-transition-bumper',
      anchor.id,
      'unused',
      {
        type: 'spring',
        restLength: 2,
        stiffness: 400,
        damping: 0,
      },
    )
    spring.b = {
      type: 'free',
      position: {
        x: contactPoint.x + normal.x * 0.5,
        y: contactPoint.y + normal.y * 0.5,
      },
    }
    spring.radiusM = 0.2
    scene.entities = [firstGround, secondGround, joint, anchor, spring]
    const world = createWorld(scene)
    let minimumSignedDistance = Infinity
    let maximumReboundSpeed = -Infinity

    for (let step = 0; step < 180; step += 1) {
      world.step()
      const points = world
        .getConnectorStates()
        .find((state) => state.entityId === spring.id)?.points
      if (points?.length === 2) {
        minimumSignedDistance = Math.min(
          minimumSignedDistance,
          transition.closestPoint(points[1]!).signedDistance,
        )
      }
      const velocity = stateOf(world, anchor.id).linearVelocity
      maximumReboundSpeed = Math.max(
        maximumReboundSpeed,
        velocity.x * normal.x + velocity.y * normal.y,
      )
    }

    expect(minimumSignedDistance).toBeGreaterThanOrEqual(-0.002)
    expect(maximumReboundSpeed).toBeGreaterThan(1)
  })

  it('双端普通弹簧在实际长度大于原长时从首个子步开始回拉', () => {
    const scene = baseScene()
    const first = makeBody(scene, 'stretched-spring-first', { x: -1.5, y: 0 })
    const second = makeBody(scene, 'stretched-spring-second', { x: 1.5, y: 0 })
    const spring = makeConnector(scene, 'stretched-spring', first.id, second.id, {
      type: 'spring',
      restLength: 2,
      stiffness: 20,
      damping: 0,
    })
    scene.entities = [first, second, spring]
    const world = createWorld(scene)

    world.step()

    expect(stateOf(world, first.id).linearVelocity.x).toBeGreaterThan(0)
    expect(stateOf(world, second.id).linearVelocity.x).toBeLessThan(0)
  })

  it('碰撞绳绕过大质量球时不会把接触修正持续转换成端点沿绳速度', () => {
    const scene = baseScene()
    const ground = makeGround(
      scene,
      { type: 'line', start: { x: -4, y: 3 }, end: { x: 4, y: 3 } },
      { friction: 0, restitution: 0 },
    )
    const obstacleSupport = makeGround(
      scene,
      { type: 'line', start: { x: -1, y: -0.05 }, end: { x: 1, y: -0.05 } },
      { friction: 0, restitution: 0 },
    )
    const ropeLength = 4.5
    const bob = makeBody(
      scene,
      'xpbd-rope-energy-bob',
      { x: -2.5, y: -0.2 },
      { x: 4, y: 2.8 },
      {
        massKg: 1,
        shape: { type: 'circle', radius: 0.15, collisionEnabled: true },
        material: { friction: 0, restitution: 0 },
      },
    )
    const obstacle = makeBody(
      scene,
      'xpbd-rope-energy-obstacle',
      { x: 0, y: 0.7 },
      { x: 0, y: 0 },
      {
        massKg: 1e8,
        shape: { type: 'circle', radius: 0.75, collisionEnabled: true },
        material: { friction: 0, restitution: 0 },
      },
    )
    const rope: ConnectorEntity = makeConnector(
      scene,
      'xpbd-rope-energy-regression',
      bob.id,
      'unused',
      { type: 'rope', maxLength: ropeLength },
    )
    rope.b = { type: 'ground', groundId: ground.id, pathRatio: 0.5 }
    rope.collisionEnabled = true
    rope.massKg = 0.001
    rope.radiusM = 0.05
    rope.material = { friction: 0, restitution: 0 }
    scene.entities = [
      ground,
      obstacleSupport,
      bob,
      obstacle,
      rope,
      makeGravity(scene, { x: 0, y: -9.80665 }),
    ]
    const world = createWorld(scene)
    type TestMassPoint = {
      rigidBody: {
        translation(): { x: number; y: number }
        linvel(): { x: number; y: number }
      }
    }
    const internal = world as unknown as {
      flexibleConnectorsById: Map<string, { nodes: TestMassPoint[] }>
    }
    const nodes = internal.flexibleConnectorsById.get(rope.id)?.nodes ?? []
    const nodeMass = rope.massKg / nodes.length
    const mechanicalEnergy = () => {
      const bobState = stateOf(world, bob.id)
      const bobEnergy = bobState.kineticEnergyJ + bob.massKg * 9.80665 * bobState.position.y
      return nodes.reduce((total, node) => {
        const position = node.rigidBody.translation()
        const velocity = node.rigidBody.linvel()
        return (
          total +
          (nodeMass * (velocity.x ** 2 + velocity.y ** 2)) / 2 +
          nodeMass * 9.80665 * position.y
        )
      }, bobEnergy)
    }
    const initialEnergy = mechanicalEnergy()
    let maximumEnergy = initialEnergy
    let maximumEnergyStep = 0
    let maximumEnergyState = stateOf(world, bob.id)

    for (let step = 0; step < 1_200; step += 1) {
      world.step()
      const energy = mechanicalEnergy()
      if (energy > maximumEnergy) {
        maximumEnergy = energy
        maximumEnergyStep = step
        maximumEnergyState = stateOf(world, bob.id)
      }
    }

    expect(
      maximumEnergy,
      `最大能量发生在第 ${maximumEnergyStep} 步：${JSON.stringify(maximumEnergyState)}`,
    ).toBeLessThan(initialEnergy * 1.005)
  }, 30_000)
})

describe('格式 21 时变场与外加力', () => {
  function makeForce(bodyId: string, overrides: Partial<ForceEntity> = {}): ForceEntity {
    return {
      id: `force-${bodyId}`,
      name: '测试力',
      visible: true,
      locked: false,
      simulationEnabled: true,
      kind: 'force',
      bodyId,
      localAnchor: { x: 0, y: 0 },
      magnitudeN: 10,
      directionRad: 0,
      ...overrides,
    }
  }

  it('场强表达式使用固定步模拟时间和全局变量', () => {
    const scene = baseScene()
    scene.globalVariables = [{ name: 'a', expression: '2', value: 2 }]
    const body = makeBody(
      scene,
      'time-field-body',
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
    )
    const field = makeGravity(scene, { x: 0, y: -2 })
    if (field.field.type !== 'uniformGravity') throw new Error('测试重力场无效')
    field.field.magnitudeExpression = { expression: 'a+t', fallbackValue: 2 }
    scene.entities = [body, field]
    const world = createWorld(scene)

    world.step(120)

    const expectedSpeed =
      scene.settings.fixedTimeStep *
      Array.from({ length: 120 }, (_, index) => 2 + index * scene.settings.fixedTimeStep).reduce(
        (sum, value) => sum + value,
        0,
      )
    expect(world.simulationTime).toBeCloseTo(1, 12)
    expect(stateOf(world, body.id).linearVelocity.y).toBeCloseTo(-expectedSpeed, 5)
  })

  it('电场 X/Y 分量分别使用固定步时间和全局变量', () => {
    const scene = baseScene()
    scene.globalVariables = [{ name: 'a', expression: '2', value: 2 }]
    const body = makeBody(
      scene,
      'electric-component-body',
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      {
        chargeC: 2,
        shape: { type: 'circle', radius: 0.1, collisionEnabled: false },
      },
    )
    const field = makeField(scene, 'electric-components', {
      type: 'uniformElectric',
      strength: { x: 0, y: 0 },
      componentExpressions: {
        x: { expression: 'a+t', fallbackValue: 2 },
        y: { expression: '2*a-t', fallbackValue: 4 },
      },
    })
    scene.entities = [body, field]
    const world = createWorld(scene)

    world.step()

    expect(stateOf(world, body.id).netForce.x).toBeCloseTo(4, 6)
    expect(stateOf(world, body.id).netForce.y).toBeCloseTo(8, 6)
  })

  it('电场任一分量非有限时跳过该步并去重警告', () => {
    const scene = baseScene()
    const body = makeBody(
      scene,
      'invalid-electric-body',
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      {
        chargeC: 1,
        shape: { type: 'circle', radius: 0.1, collisionEnabled: false },
      },
    )
    const field = makeField(scene, 'invalid-electric', {
      type: 'uniformElectric',
      strength: { x: 1, y: 2 },
      componentExpressions: { x: { expression: '1/t', fallbackValue: 1 } },
    })
    scene.entities = [body, field]
    const world = createWorld(scene)

    world.step(240)

    expect(world.warnings.filter((warning) => warning.entityId === field.id)).toHaveLength(1)
    expect(Number.isFinite(stateOf(world, body.id).linearVelocity.x)).toBe(true)
  })

  it('质心恒力按质量产生加速度，方向表达式可使用 t', () => {
    const scene = baseScene()
    const body = makeBody(
      scene,
      'center-force-body',
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { massKg: 2, shape: { type: 'circle', radius: 0.1, collisionEnabled: false } },
    )
    const force = makeForce(body.id, {
      magnitudeExpression: { expression: '10+t', fallbackValue: 10 },
      directionDegreesExpression: { expression: '90+180*t/pi', fallbackValue: 90 },
    })
    scene.entities = [body, force]
    const world = createWorld(scene)

    world.step()
    const state = stateOf(world, body.id)

    expect(state.netForce.x).toBeCloseTo(0, 8)
    expect(state.netForce.y).toBeCloseTo(10, 6)
    expect(state.linearVelocity.y).toBeCloseTo((10 / 2) * scene.settings.fixedTimeStep, 8)
  })

  it('偏心力产生真实力矩，关闭旋转时只保留平动', () => {
    const scene = baseScene()
    const rotating = makeBody(
      scene,
      'rotating-force-body',
      { x: -3, y: 0 },
      { x: 0, y: 0 },
      {
        preset: 'block',
        shape: { type: 'box', width: 2, height: 2 },
        massKg: 2,
      },
    )
    const locked = makeBody(
      scene,
      'locked-force-body',
      { x: 3, y: 0 },
      { x: 0, y: 0 },
      {
        preset: 'block',
        shape: { type: 'box', width: 2, height: 2 },
        massKg: 2,
        rotationEnabled: false,
      },
    )
    scene.entities = [
      rotating,
      locked,
      makeForce(rotating.id, { id: 'offset-force-rotating', localAnchor: { x: 0, y: 0.75 } }),
      makeForce(locked.id, { id: 'offset-force-locked', localAnchor: { x: 0, y: 0.75 } }),
    ]
    const world = createWorld(scene)

    world.step(30)

    expect(stateOf(world, rotating.id).angularVelocityRad).toBeLessThan(-0.1)
    expect(stateOf(world, locked.id).angularVelocityRad).toBe(0)
    expect(stateOf(world, rotating.id).linearVelocity.x).toBeCloseTo(
      stateOf(world, locked.id).linearVelocity.x,
      8,
    )
  })

  it('运行时非有限结果只跳过对应步并去重警告', () => {
    const scene = baseScene()
    const body = makeBody(
      scene,
      'invalid-force-body',
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      {
        shape: { type: 'circle', radius: 0.1, collisionEnabled: false },
      },
    )
    const force = makeForce(body.id, {
      magnitudeExpression: { expression: '1/t', fallbackValue: 1 },
    })
    scene.entities = [body, force]
    const world = createWorld(scene)

    world.step(240)

    expect(world.warnings.filter((warning) => warning.entityId === force.id)).toHaveLength(1)
    expect(Number.isFinite(stateOf(world, body.id).linearVelocity.x)).toBe(true)
  })
})
