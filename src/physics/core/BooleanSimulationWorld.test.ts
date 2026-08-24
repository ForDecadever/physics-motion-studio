import { afterEach, describe, expect, it } from 'vitest'

import { createEmptyScene } from '../../scene/model/createEmptyScene'
import {
  createBall,
  createArcGround,
  createBlock,
  createBezierBlock,
  createElectricField,
  createGravityField,
  createLineGround,
  createMagneticField,
  createRope,
  createSpring,
} from '../../scene/model/entityFactories'
import { createCurvedBlockPresetNodes } from '../../scene/model/blockPresets'
import type { BooleanNode, SceneDocument } from '../../scene/model/types'
import { resolveBooleanScene } from '../../scene/model/booleanGeometry'
import { SimulationWorld } from './SimulationWorld'

const worlds: SimulationWorld[] = []

afterEach(() => {
  for (const world of worlds.splice(0)) world.dispose()
})

function booleanLayer(
  id: string,
  resultId: string,
  operation: BooleanNode['operation'],
  firstId: string,
  secondId: string,
): BooleanNode {
  return {
    id,
    kind: 'boolean',
    name: '布尔物理',
    visible: true,
    locked: false,
    operation,
    resultId,
    operands: [
      { kind: 'entity', entityId: firstId },
      { kind: 'entity', entityId: secondId },
    ],
    simulationEnabled: true,
    rotationEnabled: true,
    continuousCollisionDetection: true,
    massDistribution: { mode: 'source' },
    chargeDistribution: { mode: 'source' },
    fieldDistribution: { mode: 'source' },
    frictionDistribution: { mode: 'source' },
    restitutionDistribution: { mode: 'source' },
    initialVelocity: { mode: 'source' },
    initialAngularVelocity: { mode: 'source' },
  }
}

function ids(index: number): string {
  return `00000000-0000-4000-8000-${String(500 + index).padStart(12, '0')}`
}

function createBooleanBodyScene(operation: BooleanNode['operation'] = 'union'): {
  scene: SceneDocument
  layer: BooleanNode
  upper: ReturnType<typeof createBlock>
  lower: ReturnType<typeof createBlock>
} {
  const scene = createEmptyScene()
  const layerId = ids(1)
  const resultId = ids(2)
  const upper = createBlock(layerId, { x: -0.5, y: 0 }, 1, 1, 1)
  const lower = createBlock(layerId, { x: 0.5, y: 0 }, 1, 1, 2)
  upper.id = ids(3)
  lower.id = ids(4)
  const layer = booleanLayer(layerId, resultId, operation, upper.id, lower.id)
  scene.rootItems = [layer]
  scene.entities = [upper, lower]
  return { scene, layer, upper, lower }
}

describe('布尔复合刚体', () => {
  it('只为根结果创建运行状态，并以质量中心和上方来源运动初始化', () => {
    const { scene, layer, upper, lower } = createBooleanBodyScene()
    upper.massKg = 1
    lower.massKg = 3
    upper.initialVelocity = { x: 2, y: -1 }
    upper.initialAngularVelocityRad = 0.75
    const world = new SimulationWorld(scene)
    worlds.push(world)

    const states = world.getBodyStates()
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({
      entityId: layer.resultId,
      position: { x: 0.25, y: 0 },
      linearVelocity: { x: 2, y: -1 },
      angularVelocityRad: 0.75,
    })
    expect(states.some((state) => state.entityId === upper.id || state.entityId === lower.id)).toBe(
      false,
    )
  })

  it('结果级初始状态覆盖用于运行刚体且不修改来源实体', () => {
    const { scene, layer, upper } = createBooleanBodyScene()
    upper.initialVelocity = { x: 2, y: -1 }
    upper.initialAngularVelocityRad = 0.75
    layer.initialVelocity = { mode: 'override', value: { x: -4, y: 6 } }
    layer.initialAngularVelocity = { mode: 'override', valueRadPerSecond: -1.25 }
    const world = new SimulationWorld(scene)
    worlds.push(world)

    expect(world.getBodyStates()[0]).toMatchObject({
      entityId: layer.resultId,
      linearVelocity: { x: -4, y: 6 },
      angularVelocityRad: -1.25,
    })
    expect(upper.initialVelocity).toEqual({ x: 2, y: -1 })
    expect(upper.initialAngularVelocityRad).toBe(0.75)
  })

  it('结果级摩擦与弹性覆盖应用到全部复合碰撞网格', () => {
    const { scene, layer, upper, lower } = createBooleanBodyScene()
    upper.material = { friction: 0.1, restitution: 0.2 }
    lower.material = { friction: 0.9, restitution: 0.8 }
    layer.frictionDistribution = { mode: 'uniform', value: 0.35 }
    layer.restitutionDistribution = { mode: 'uniform', value: 0.6 }

    const result = resolveBooleanScene(scene).roots[0]
    expect(
      result?.valid && result.kind === 'body' && result.collisionMeshes.length,
    ).toBeGreaterThan(0)
    if (!result?.valid || result.kind !== 'body') return
    expect(result.collisionMeshes.every((mesh) => mesh.material.friction === 0.35)).toBe(true)
    expect(result.collisionMeshes.every((mesh) => mesh.material.restitution === 0.6)).toBe(true)
  })

  it('孔洞中没有碰撞片，而实体区域会参与接触', () => {
    const { scene, layer, upper, lower } = createBooleanBodyScene('difference')
    upper.shape = { type: 'box', width: 4, height: 4 }
    upper.transform.position = { x: 0, y: 0 }
    upper.massKg = 16
    lower.shape = { type: 'box', width: 2, height: 2 }
    lower.transform.position = { x: 0, y: 0 }
    const insideHole = createBall('', { x: 0, y: 0 }, 0.35, 3)
    const overlappingBar = createBall('', { x: 0, y: 1.8 }, 0.35, 4)
    scene.entities.push(insideHole, overlappingBar)
    const world = new SimulationWorld(scene)
    worlds.push(world)
    world.step(10)

    const stateById = new Map(world.getBodyStates().map((state) => [state.entityId, state]))
    expect(stateById.get(insideHole.id)?.position).toEqual({ x: 0, y: 0 })
    expect(stateById.get(overlappingBar.id)?.position.y).not.toBeCloseTo(1.8, 6)
    expect(stateById.has(layer.resultId)).toBe(true)
  })

  it('块减内切小球可以创建、步进并安全重复释放', () => {
    const { scene, layer, upper } = createBooleanBodyScene('difference')
    upper.shape = { type: 'box', width: 1, height: 1 }
    upper.transform.position = { x: 0, y: 0 }
    const lower = createBall(layer.id, { x: 0, y: 0 }, 0.5, 2)
    lower.id = ids(4)
    scene.entities = [upper, lower]

    for (let iteration = 0; iteration < 3; iteration += 1) {
      const world = new SimulationWorld(scene)
      worlds.push(world)
      world.step(120)

      const state = world.getBodyStates().find((candidate) => candidate.entityId === layer.resultId)
      expect(state).toBeDefined()
      expect(Number.isFinite(state?.position.x)).toBe(true)
      expect(Number.isFinite(state?.position.y)).toBe(true)

      expect(() => world.dispose()).not.toThrow()
      expect(() => world.dispose()).not.toThrow()
    }
  })

  it('按电荷区域质心施加电场力矩', () => {
    const { scene, layer, upper, lower } = createBooleanBodyScene()
    upper.massKg = 1
    lower.massKg = 3
    upper.chargeC = 1
    lower.chargeC = 0
    const field = createElectricField('', { x: 0, y: 0 }, 10, 10, 1)
    field.field = { type: 'uniformElectric', strength: { x: 0, y: 4 } }
    scene.entities.push(field)
    const world = new SimulationWorld(scene)
    worlds.push(world)
    world.step()

    const state = world.getBodyStates().find((candidate) => candidate.entityId === layer.resultId)
    expect(state?.netForce.y).toBeCloseTo(4, 4)
    expect(Math.abs(state?.angularVelocityRad ?? 0)).toBeGreaterThan(1e-4)
  })

  it('磁场隐式中点更新不改变复合体总动能', () => {
    const { scene, layer, upper, lower } = createBooleanBodyScene()
    upper.chargeC = 1
    lower.chargeC = -0.25
    upper.initialVelocity = { x: 2, y: 0.5 }
    const field = createMagneticField('', { x: 0, y: 0 }, 100, 100, 1)
    field.field = { type: 'uniformMagnetic', bzTesla: 0.8 }
    scene.entities.push(field)
    const world = new SimulationWorld(scene)
    worlds.push(world)
    const initial = world
      .getBodyStates()
      .find((candidate) => candidate.entityId === layer.resultId)!
    world.step(1_000)
    const final = world.getBodyStates().find((candidate) => candidate.entityId === layer.resultId)!
    expect(final.kineticEnergyJ).toBeCloseTo(initial.kineticEnergyJ, 5)
  })

  it('碰撞绳按复合体真实凸片阻挡高速运动', () => {
    const { scene, layer, upper, lower } = createBooleanBodyScene()
    upper.transform.position = { x: -0.5, y: 1 }
    lower.transform.position = { x: 0.5, y: 1 }
    upper.initialVelocity = { x: 0, y: -6 }
    const rope = createRope(
      '',
      { type: 'world', position: { x: -2, y: 0 } },
      { type: 'world', position: { x: 2, y: 0 } },
      4,
      1,
    )
    rope.collisionEnabled = true
    rope.massKg = 0.001
    rope.radiusM = 0.05
    scene.entities.push(rope)
    const world = new SimulationWorld(scene)
    worlds.push(world)
    world.step(120)

    const state = world.getBodyStates().find((candidate) => candidate.entityId === layer.resultId)
    expect(state?.position.y).toBeLessThan(1)
    expect(state?.position.y).toBeGreaterThan(-0.5)
    expect(state?.linearVelocity.y).toBeGreaterThan(-20)
  })

  it('自由端弹簧按复合体真实外轮廓压缩并反弹', () => {
    const { scene, layer, upper, lower } = createBooleanBodyScene()
    upper.transform.position = { x: 2.7, y: 0 }
    lower.transform.position = { x: 3.3, y: 0 }
    upper.initialVelocity = { x: -3, y: 0 }
    const spring = createSpring(
      '',
      { type: 'world', position: { x: 0, y: 0 } },
      { type: 'free', position: { x: 2, y: 0 } },
      2,
      1,
    )
    spring.connector = { type: 'spring', restLength: 2, stiffness: 200, damping: 0 }
    spring.radiusM = 0.05
    scene.entities.push(spring)
    const world = new SimulationWorld(scene)
    worlds.push(world)
    world.step(240)

    const state = world.getBodyStates().find((candidate) => candidate.entityId === layer.resultId)
    expect(state?.linearVelocity.x).toBeGreaterThan(0)
  })

  it('复合电荷区域间库仑力保持作用反作用并产生区域力矩', () => {
    const scene = createEmptyScene()
    scene.settings.pairwiseElectrostatics = true
    const firstLayerId = ids(21)
    const secondLayerId = ids(22)
    const firstResultId = ids(23)
    const secondResultId = ids(24)
    const firstUpper = createBlock(firstLayerId, { x: -2, y: 0.5 }, 1, 1, 1)
    const firstLower = createBlock(firstLayerId, { x: -2, y: -0.5 }, 1, 1, 2)
    const secondUpper = createBlock(secondLayerId, { x: 2, y: 0.5 }, 1, 1, 3)
    const secondLower = createBlock(secondLayerId, { x: 2, y: -0.5 }, 1, 1, 4)
    firstUpper.id = ids(25)
    firstLower.id = ids(26)
    secondUpper.id = ids(27)
    secondLower.id = ids(28)
    firstUpper.chargeC = 1e-6
    secondLower.chargeC = 1e-6
    const firstLayer = booleanLayer(
      firstLayerId,
      firstResultId,
      'union',
      firstUpper.id,
      firstLower.id,
    )
    const secondLayer = booleanLayer(
      secondLayerId,
      secondResultId,
      'union',
      secondUpper.id,
      secondLower.id,
    )
    scene.rootItems.push(firstLayer, secondLayer)
    scene.entities.push(firstUpper, firstLower, secondUpper, secondLower)
    const world = new SimulationWorld(scene)
    worlds.push(world)
    world.step()

    const first = world.getBodyStates().find((state) => state.entityId === firstResultId)!
    const second = world.getBodyStates().find((state) => state.entityId === secondResultId)!
    expect(first.netForce.x + second.netForce.x).toBeCloseTo(0, 10)
    expect(first.netForce.y + second.netForce.y).toBeCloseTo(0, 10)
    expect(Math.abs(first.angularVelocityRad)).toBeGreaterThan(1e-6)
    expect(Math.abs(second.angularVelocityRad)).toBeGreaterThan(1e-6)
  })

  it('开启 CCD 的高速复合体不会穿过零厚度地面', () => {
    const { scene, layer, upper, lower } = createBooleanBodyScene()
    upper.transform.position = { x: -0.5, y: 3 }
    lower.transform.position = { x: 0.5, y: 3 }
    upper.initialVelocity = { x: 0, y: -100 }
    scene.entities.push(createLineGround('', { x: -5, y: 0 }, { x: 5, y: 0 }, 1))
    const world = new SimulationWorld(scene)
    worlds.push(world)
    world.step(10)

    const state = world.getBodyStates().find((candidate) => candidate.entityId === layer.resultId)
    expect(state?.position.y).toBeGreaterThan(-0.5)
  })

  it('开启 CCD 的高速复合体不会横向穿过竖直零厚度地面', () => {
    const { scene, layer, upper, lower } = createBooleanBodyScene()
    upper.transform.position = { x: -2.5, y: -0.5 }
    lower.transform.position = { x: -1.5, y: 0.5 }
    upper.initialVelocity = { x: 100, y: 0 }
    scene.entities.push(createLineGround('', { x: 0, y: -5 }, { x: 0, y: 5 }, 1))
    const world = new SimulationWorld(scene)
    worlds.push(world)
    world.step(10)

    const state = world.getBodyStates().find((candidate) => candidate.entityId === layer.resultId)
    expect(state?.position.x).toBeGreaterThan(-2.5)
    expect(state?.position.x).toBeLessThan(0.5)
    expect(state?.linearVelocity.x).toBeLessThan(20)
  })

  it('开启 CCD 的高速复合体不会穿过普通小球', () => {
    const { scene, layer, upper, lower } = createBooleanBodyScene()
    upper.transform.position = { x: -2.5, y: -0.5 }
    lower.transform.position = { x: -1.5, y: 0.5 }
    upper.initialVelocity = { x: 100, y: 0 }
    const target = createBall('', { x: 0, y: 0 }, 0.5, 5)
    target.massKg = 1_000
    target.rotationEnabled = false
    target.material = { friction: 0, restitution: 0 }
    scene.entities.push(target)
    const world = new SimulationWorld(scene)
    worlds.push(world)

    world.step(10)

    const state = world.getBodyStates().find((candidate) => candidate.entityId === layer.resultId)
    expect(state?.position.x).toBeLessThan(0.5)
    expect(state?.linearVelocity.x).toBeLessThan(20)
  })

  it('存在圆形重叠的差集在无摩擦水平地面上长期运动时不会异常弹起', () => {
    const { scene, layer, upper } = createBooleanBodyScene('difference')
    upper.shape = { type: 'box', width: 6, height: 3 }
    upper.transform.position = { x: 0, y: 1.505 }
    upper.massKg = 18
    upper.initialVelocity = { x: 1.5, y: 0 }
    upper.material = { friction: 0, restitution: 0 }
    const cutter = createBall(layer.id, { x: 0, y: 3.005 }, 2, 2)
    cutter.id = ids(4)
    cutter.material = upper.material
    const ground = createLineGround('', { x: -100, y: 0 }, { x: 100, y: 0 }, 1)
    ground.material = { friction: 0, restitution: 0 }
    const gravity = createGravityField('', { x: 0, y: 5 }, 220, 30, 2)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -9.8 } }
    scene.entities = [upper, cutter, ground, gravity]
    const world = new SimulationWorld(scene)
    worlds.push(world)

    let minimumY = Number.POSITIVE_INFINITY
    let maximumY = Number.NEGATIVE_INFINITY
    let maximumVerticalSpeed = 0
    let maximumAngularSpeed = 0
    for (let step = 0; step < 2_400; step += 1) {
      world.step()
      const state = world
        .getBodyStates()
        .find((candidate) => candidate.entityId === layer.resultId)!
      if (step >= 120) {
        minimumY = Math.min(minimumY, state.position.y)
        maximumY = Math.max(maximumY, state.position.y)
        maximumVerticalSpeed = Math.max(maximumVerticalSpeed, Math.abs(state.linearVelocity.y))
        maximumAngularSpeed = Math.max(maximumAngularSpeed, Math.abs(state.angularVelocityRad))
      }
    }

    const final = world.getBodyStates().find((candidate) => candidate.entityId === layer.resultId)!
    expect.soft(final.linearVelocity.x).toBeCloseTo(1.5, 2)
    expect.soft(maximumY - minimumY).toBeLessThan(0.01)
    expect.soft(maximumVerticalSpeed).toBeLessThan(0.05)
    expect.soft(maximumAngularSpeed).toBeLessThan(0.01)
  })

  it('存在重叠的加法体在无摩擦水平地面上长期运动时不会异常弹起', () => {
    const { scene, layer, upper } = createBooleanBodyScene('union')
    upper.shape = { type: 'box', width: 4, height: 2 }
    upper.transform.position = { x: -1, y: 1.005 }
    upper.massKg = 8
    upper.initialVelocity = { x: -8, y: 0 }
    upper.material = { friction: 0, restitution: 0 }
    const overlap = createBlock(layer.id, { x: 1, y: 1.005 }, 4, 2, 2)
    overlap.id = ids(4)
    overlap.massKg = 12
    overlap.material = { friction: 0.4, restitution: 0 }
    const ground = createLineGround('', { x: -300, y: 0 }, { x: 300, y: 0 }, 1)
    ground.material = { friction: 0, restitution: 0 }
    const gravity = createGravityField('', { x: 0, y: 4 }, 220, 30, 2)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -9.8 } }
    scene.entities = [upper, overlap, ground, gravity]
    const world = new SimulationWorld(scene)
    worlds.push(world)

    let minimumY = Number.POSITIVE_INFINITY
    let maximumY = Number.NEGATIVE_INFINITY
    let maximumVerticalSpeed = 0
    let maximumAngularSpeed = 0
    for (let step = 0; step < 2_400; step += 1) {
      world.step()
      const state = world
        .getBodyStates()
        .find((candidate) => candidate.entityId === layer.resultId)!
      if (step >= 120) {
        minimumY = Math.min(minimumY, state.position.y)
        maximumY = Math.max(maximumY, state.position.y)
        maximumVerticalSpeed = Math.max(maximumVerticalSpeed, Math.abs(state.linearVelocity.y))
        maximumAngularSpeed = Math.max(maximumAngularSpeed, Math.abs(state.angularVelocityRad))
      }
    }

    const final = world.getBodyStates().find((candidate) => candidate.entityId === layer.resultId)!
    expect.soft(Math.abs(final.linearVelocity.x + 8) / 8).toBeLessThan(0.002)
    expect.soft(maximumY - minimumY).toBeLessThan(0.01)
    expect.soft(maximumVerticalSpeed).toBeLessThan(0.05)
    expect.soft(maximumAngularSpeed).toBeLessThan(0.01)
  })

  it('块球加法体在无摩擦平面上不会无故弹起或卡停', () => {
    const { scene, layer, upper } = createBooleanBodyScene()
    upper.shape = { type: 'box', width: 2, height: 1 }
    upper.transform.position = { x: 0, y: 0.505 }
    upper.massKg = 2
    upper.initialVelocity = { x: 1.5, y: 0 }
    upper.material = { friction: 0, restitution: 0 }
    const cap = createBall(layer.id, { x: 0, y: 1.005 }, 0.5, 2)
    cap.id = ids(4)
    cap.material = upper.material
    const ground = createLineGround('', { x: -10, y: 0 }, { x: 10, y: 0 }, 1)
    ground.material = { friction: 0, restitution: 0 }
    const gravity = createGravityField('', { x: 0, y: 2 }, 30, 20, 2)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -9.8 } }
    scene.entities = [upper, cap, ground, gravity]
    const world = new SimulationWorld(scene)
    worlds.push(world)

    let minimumY = Number.POSITIVE_INFINITY
    let maximumY = Number.NEGATIVE_INFINITY
    let maximumVerticalSpeed = 0
    for (let step = 0; step < 600; step += 1) {
      world.step()
      const state = world
        .getBodyStates()
        .find((candidate) => candidate.entityId === layer.resultId)!
      if (step >= 120) {
        minimumY = Math.min(minimumY, state.position.y)
        maximumY = Math.max(maximumY, state.position.y)
        maximumVerticalSpeed = Math.max(maximumVerticalSpeed, Math.abs(state.linearVelocity.y))
      }
    }

    const final = world.getBodyStates().find((candidate) => candidate.entityId === layer.resultId)!
    expect(final.position.x).toBeGreaterThan(6)
    expect(final.linearVelocity.x).toBeCloseTo(1.5, 2)
    expect(maximumY - minimumY).toBeLessThan(0.01)
    expect(maximumVerticalSpeed).toBeLessThan(0.05)
  })

  it('普通物块在布尔结果附近但未接触时连续 600 步不会提前获得碰撞冲量', () => {
    const { scene, layer, upper, lower } = createBooleanBodyScene('union')
    upper.shape = { type: 'box', width: 3, height: 1 }
    upper.transform.position = { x: -1.5, y: 0 }
    upper.massKg = 1_000
    lower.shape = { type: 'box', width: 3, height: 1 }
    lower.transform.position = { x: 1.5, y: 0 }
    lower.massKg = 1_000
    layer.rotationEnabled = false
    const moving = createBlock('', { x: -2, y: 1.06 }, 1, 1, 3)
    moving.initialVelocity = { x: 0.4, y: 0 }
    moving.material = { friction: 0, restitution: 0 }
    scene.entities = [upper, lower, moving]
    const world = new SimulationWorld(scene)
    worlds.push(world)

    world.step(600)

    const states = new Map(world.getBodyStates().map((state) => [state.entityId, state]))
    const platformState = states.get(layer.resultId)!
    const movingState = states.get(moving.id)!
    expect(platformState.linearVelocity).toEqual({ x: 0, y: 0 })
    expect(movingState.linearVelocity.x).toBeCloseTo(0.4, 7)
    expect(movingState.linearVelocity.y).toBeCloseTo(0, 7)
    expect(movingState.position.y).toBeCloseTo(1.06, 6)
  })

  it('小球停在布尔平直顶面靠近端部时不会被虚假曲率拉入平面并异常加速', () => {
    const { scene, layer, upper, lower } = createBooleanBodyScene('union')
    upper.shape = { type: 'box', width: 3, height: 1 }
    upper.transform.position = { x: -1.5, y: 0.505 }
    upper.massKg = 500
    upper.material = { friction: 0, restitution: 0 }
    lower.shape = { type: 'box', width: 3, height: 1 }
    lower.transform.position = { x: 1.5, y: 0.505 }
    lower.massKg = 500
    lower.material = upper.material
    layer.rotationEnabled = false
    const ball = createBall('', { x: -2.4, y: 1.305 }, 0.3, 3)
    ball.material = { friction: 0, restitution: 0 }
    const ground = createLineGround('', { x: -10, y: 0 }, { x: 10, y: 0 }, 4)
    ground.material = { friction: 0, restitution: 0 }
    const gravity = createGravityField('', { x: 0, y: 3 }, 30, 20, 5)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -9.8 } }
    scene.entities = [upper, lower, ball, ground, gravity]
    const world = new SimulationWorld(scene)
    worlds.push(world)

    const initialRelativePosition = { x: -2.4, y: 0.8 }
    let maximumPenetration = 0
    let maximumSpeed = 0
    for (let step = 0; step < 360; step += 1) {
      world.step()
      const states = new Map(world.getBodyStates().map((state) => [state.entityId, state]))
      const platformState = states.get(layer.resultId)!
      const ballState = states.get(ball.id)!
      maximumPenetration = Math.max(
        maximumPenetration,
        0.8 - (ballState.position.y - platformState.position.y),
      )
      maximumSpeed = Math.max(
        maximumSpeed,
        Math.hypot(
          ballState.linearVelocity.x - platformState.linearVelocity.x,
          ballState.linearVelocity.y - platformState.linearVelocity.y,
        ),
      )
    }

    const states = new Map(world.getBodyStates().map((state) => [state.entityId, state]))
    const platformState = states.get(layer.resultId)!
    const ballState = states.get(ball.id)!
    expect.soft(maximumPenetration).toBeLessThan(0.003)
    expect
      .soft(Math.abs(ballState.position.x - platformState.position.x - initialRelativePosition.x))
      .toBeLessThan(0.01)
    expect.soft(maximumSpeed).toBeLessThan(0.05)
  })

  it('无摩擦小球沿布尔平直顶面运动时保持高度、水平速度和机械能', () => {
    const { scene, layer, upper, lower } = createBooleanBodyScene('union')
    upper.shape = { type: 'box', width: 6, height: 1 }
    upper.transform.position = { x: -3, y: 0.505 }
    upper.massKg = 500
    upper.material = { friction: 0, restitution: 0 }
    lower.shape = { type: 'box', width: 6, height: 1 }
    lower.transform.position = { x: 3, y: 0.505 }
    lower.massKg = 500
    lower.material = upper.material
    layer.rotationEnabled = false
    const ball = createBall('', { x: -4.5, y: 1.305 }, 0.3, 3)
    ball.initialVelocity = { x: 1, y: 0 }
    ball.material = { friction: 0, restitution: 0 }
    const ground = createLineGround('', { x: -10, y: 0 }, { x: 10, y: 0 }, 4)
    ground.material = { friction: 0, restitution: 0 }
    const gravity = createGravityField('', { x: 0, y: 3 }, 30, 20, 5)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -9.8 } }
    scene.entities = [upper, lower, ball, ground, gravity]
    const world = new SimulationWorld(scene)
    worlds.push(world)

    let maximumHeightError = 0
    let minimumEnergy = Number.POSITIVE_INFINITY
    let maximumEnergy = Number.NEGATIVE_INFINITY
    for (let step = 0; step < 360; step += 1) {
      world.step()
      const states = new Map(world.getBodyStates().map((state) => [state.entityId, state]))
      const platformState = states.get(layer.resultId)!
      const ballState = states.get(ball.id)!
      maximumHeightError = Math.max(
        maximumHeightError,
        Math.abs(ballState.position.y - platformState.position.y - 0.8),
      )
      const relativeVelocity = {
        x: ballState.linearVelocity.x - platformState.linearVelocity.x,
        y: ballState.linearVelocity.y - platformState.linearVelocity.y,
      }
      const energy =
        (ball.massKg * (relativeVelocity.x ** 2 + relativeVelocity.y ** 2)) / 2 +
        ball.massKg * 9.8 * (ballState.position.y - platformState.position.y)
      minimumEnergy = Math.min(minimumEnergy, energy)
      maximumEnergy = Math.max(maximumEnergy, energy)
    }

    const states = new Map(world.getBodyStates().map((state) => [state.entityId, state]))
    const platformState = states.get(layer.resultId)!
    const ballState = states.get(ball.id)!
    expect.soft(maximumHeightError).toBeLessThan(0.003)
    expect.soft(ballState.linearVelocity.x - platformState.linearVelocity.x).toBeCloseTo(1, 2)
    expect.soft(maximumEnergy - minimumEnergy).toBeLessThan(0.01)
  })

  it('块球加法体与圆弧地面接触时保持连续运动并产生转动', () => {
    const { scene, layer, upper } = createBooleanBodyScene()
    const contactAngle = (2 * Math.PI) / 3
    const bodyAngle = contactAngle - Math.PI / 2
    const normal = { x: Math.cos(contactAngle), y: Math.sin(contactAngle) }
    const tangent = { x: -normal.y, y: normal.x }
    const arcPoint = { x: normal.x * 4, y: normal.y * 4 }
    const blockCenter = {
      x: arcPoint.x + normal.x * 0.45,
      y: arcPoint.y + normal.y * 0.45,
    }
    upper.shape = { type: 'box', width: 1.6, height: 0.8 }
    upper.transform = { position: blockCenter, angleRad: bodyAngle }
    upper.massKg = 2
    upper.initialVelocity = { x: tangent.x * 0.5, y: tangent.y * 0.5 }
    upper.material = { friction: 0.2, restitution: 0 }
    const cap = createBall(
      layer.id,
      {
        x: blockCenter.x - Math.sin(bodyAngle) * 0.4,
        y: blockCenter.y + Math.cos(bodyAngle) * 0.4,
      },
      0.4,
      2,
    )
    cap.id = ids(4)
    cap.transform.angleRad = bodyAngle
    cap.material = upper.material
    const arc = createArcGround('', { x: 0, y: 0 }, 4, Math.PI / 2, Math.PI, 1)
    arc.material = { friction: 0.2, restitution: 0 }
    const gravity = createGravityField('', { x: 0, y: 2 }, 30, 30, 2)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -9.8 } }
    scene.entities = [upper, cap, arc, gravity]
    const world = new SimulationWorld(scene)
    worlds.push(world)

    let maximumVelocityJump = 0
    let contactEstablished = false
    let previousVelocity = upper.initialVelocity
    for (let step = 0; step < 80; step += 1) {
      world.step()
      const state = world
        .getBodyStates()
        .find((candidate) => candidate.entityId === layer.resultId)!
      const velocityJump = Math.hypot(
        state.linearVelocity.x - previousVelocity.x,
        state.linearVelocity.y - previousVelocity.y,
      )
      const contactAcceleration = Math.hypot(state.acceleration.x, state.acceleration.y + 9.8)
      if (contactEstablished) {
        maximumVelocityJump = Math.max(maximumVelocityJump, velocityJump)
      } else if (contactAcceleration > 1) {
        contactEstablished = true
      }
      previousVelocity = state.linearVelocity
    }

    const final = world.getBodyStates().find((candidate) => candidate.entityId === layer.resultId)!
    expect(contactEstablished).toBe(true)
    expect(Math.abs(final.position.x - blockCenter.x)).toBeGreaterThan(0.5)
    expect(Math.abs(final.angleRad - bodyAngle)).toBeGreaterThan(0.05)
    expect(maximumVelocityJump).toBeLessThan(0.5)
    expect(Number.isFinite(final.position.y)).toBe(true)
  })

  it('大跨度挖孔布尔体落到完整圆弧内侧时不会穿过真实曲面', () => {
    const { scene, layer, upper } = createBooleanBodyScene('difference')
    upper.shape = { type: 'box', width: 3.2, height: 1.2 }
    upper.transform = { position: { x: 1, y: 0.4 }, angleRad: Math.PI / 4 }
    upper.massKg = 10
    upper.initialVelocity = { x: 0, y: -2 }
    upper.material = { friction: 0.2, restitution: 0 }
    const cutter = createBall(layer.id, { x: 0.5, y: 0.6 }, 0.6, 2)
    cutter.id = ids(4)
    cutter.material = upper.material
    const arc = createArcGround('', { x: 0, y: 0 }, 3, 0, Math.PI * 2, 1)
    arc.material = { friction: 0.2, restitution: 0 }
    const gravity = createGravityField('', { x: 0, y: 4 }, 30, 30, 2)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -9.8 } }
    scene.entities = [upper, cutter, arc, gravity]
    const world = new SimulationWorld(scene)
    worlds.push(world)

    let maximumPenetration = 0
    for (let step = 0; step < 720; step += 1) {
      world.step()
      const state = world
        .getBodyStates()
        .find((candidate) => candidate.entityId === layer.resultId)!
      const resolved = resolveBooleanScene(scene).byResultId.get(layer.resultId)
      if (!resolved?.valid || resolved.kind !== 'body') return
      const cosine = Math.cos(state.angleRad)
      const sine = Math.sin(state.angleRad)
      for (const part of resolved.convexParts) {
        for (const point of part.localPoints) {
          const worldPoint = {
            x: state.position.x + point.x * cosine - point.y * sine,
            y: state.position.y + point.x * sine + point.y * cosine,
          }
          const radius = Math.hypot(worldPoint.x, worldPoint.y)
          maximumPenetration = Math.max(maximumPenetration, radius - 3)
        }
      }
    }
    expect(maximumPenetration).toBeLessThan(0.01)
  })

  it('小球沿块减圆形成的半圆槽连续贴合而不会退化为自由落体', () => {
    const { scene, layer, upper } = createBooleanBodyScene('difference')
    upper.shape = { type: 'box', width: 6, height: 4 }
    upper.transform.position = { x: 0, y: 2.005 }
    upper.massKg = 1_000
    upper.material = { friction: 0, restitution: 0 }
    const cutter = createBall(layer.id, { x: 0, y: 4.005 }, 2.5, 2)
    cutter.id = ids(4)
    layer.rotationEnabled = false
    const rolling = createBall(
      '',
      {
        x: Math.cos((7 * Math.PI) / 6) * 2.2,
        y: 4.005 + Math.sin((7 * Math.PI) / 6) * 2.2,
      },
      0.3,
      3,
    )
    rolling.material = { friction: 0, restitution: 0 }
    const ground = createLineGround('', { x: -10, y: 0 }, { x: 10, y: 0 }, 4)
    ground.material = { friction: 0, restitution: 0 }
    const gravity = createGravityField('', { x: 0, y: 3 }, 30, 20, 5)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -9.8 } }
    scene.entities = [upper, cutter, rolling, ground, gravity]
    const resolved = resolveBooleanScene(scene).byResultId.get(layer.resultId)
    expect(resolved?.valid && resolved.kind).toBe('body')
    if (!resolved?.valid || resolved.kind !== 'body') return
    const localCavityCenter = {
      x: cutter.transform.position.x - resolved.centerOfMass.x,
      y: cutter.transform.position.y - resolved.centerOfMass.y,
    }
    const world = new SimulationWorld(scene)
    worlds.push(world)

    let maximumRadialError = 0
    let consecutiveFreeFallSteps = 0
    let maximumConsecutiveFreeFallSteps = 0
    for (let step = 0; step < 600; step += 1) {
      world.step()
      const states = new Map(world.getBodyStates().map((state) => [state.entityId, state]))
      const cupState = states.get(layer.resultId)!
      const ballState = states.get(rolling.id)!
      const cosine = Math.cos(cupState.angleRad)
      const sine = Math.sin(cupState.angleRad)
      const cavityCenter = {
        x: cupState.position.x + localCavityCenter.x * cosine - localCavityCenter.y * sine,
        y: cupState.position.y + localCavityCenter.x * sine + localCavityCenter.y * cosine,
      }
      const radialDistance = Math.hypot(
        ballState.position.x - cavityCenter.x,
        ballState.position.y - cavityCenter.y,
      )
      const radialError = Math.abs(radialDistance - 2.2)
      maximumRadialError = Math.max(maximumRadialError, radialError)
      const isUnsupportedFreeFall =
        radialError > 0.005 && Math.abs(ballState.acceleration.y + 9.8) < 0.2
      consecutiveFreeFallSteps = isUnsupportedFreeFall ? consecutiveFreeFallSteps + 1 : 0
      maximumConsecutiveFreeFallSteps = Math.max(
        maximumConsecutiveFreeFallSteps,
        consecutiveFreeFallSteps,
      )
    }

    expect(maximumRadialError).toBeLessThan(0.01)
    expect(maximumConsecutiveFreeFallSteps).toBeLessThanOrEqual(2)
  })

  it('小球在固定布尔圆槽内往复运动时不会在边界片间切换并持续损能', () => {
    const { scene, layer, upper } = createBooleanBodyScene('difference')
    upper.shape = { type: 'box', width: 8, height: 5 }
    upper.transform.position = { x: 0, y: 2.505 }
    upper.massKg = 1e9
    upper.material = { friction: 0, restitution: 0 }
    const cutter = createBall(layer.id, { x: 0, y: 5.005 }, 3, 2)
    cutter.id = ids(4)
    cutter.material = upper.material
    layer.rotationEnabled = false
    const contactAngle = (7 * Math.PI) / 6
    const rolling = createBall(
      '',
      {
        x: Math.cos(contactAngle) * 2.7,
        y: 5.005 + Math.sin(contactAngle) * 2.7,
      },
      0.3,
      3,
    )
    rolling.material = { friction: 0, restitution: 0 }
    const ground = createLineGround('', { x: -10, y: 0 }, { x: 10, y: 0 }, 4)
    ground.material = { friction: 0, restitution: 0 }
    const gravity = createGravityField('', { x: 0, y: 4 }, 30, 30, 5)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -9.8 } }
    scene.entities = [upper, cutter, rolling, ground, gravity]
    const world = new SimulationWorld(scene)
    worlds.push(world)

    let minimumEnergy = Number.POSITIVE_INFINITY
    let maximumEnergy = Number.NEGATIVE_INFINITY
    let maximumAcceleration = 0
    let maximumConsecutiveFreeFallSteps = 0
    let consecutiveFreeFallSteps = 0
    for (let step = 0; step < 1_440; step += 1) {
      world.step()
      const state = world.getBodyStates().find((candidate) => candidate.entityId === rolling.id)!
      const energy = state.kineticEnergyJ + rolling.massKg * 9.8 * state.position.y
      if (step >= 120) {
        minimumEnergy = Math.min(minimumEnergy, energy)
        maximumEnergy = Math.max(maximumEnergy, energy)
        maximumAcceleration = Math.max(
          maximumAcceleration,
          Math.hypot(state.acceleration.x, state.acceleration.y),
        )
        const freeFall =
          Math.abs(state.acceleration.x) < 0.2 && Math.abs(state.acceleration.y + 9.8) < 0.2
        consecutiveFreeFallSteps = freeFall ? consecutiveFreeFallSteps + 1 : 0
        maximumConsecutiveFreeFallSteps = Math.max(
          maximumConsecutiveFreeFallSteps,
          consecutiveFreeFallSteps,
        )
      }
    }

    expect
      .soft((maximumEnergy - minimumEnergy) / (rolling.massKg * 9.8 * 2 * 2.7))
      .toBeLessThan(0.005)
    expect.soft(maximumAcceleration).toBeLessThan(80)
    expect.soft(maximumConsecutiveFreeFallSteps).toBeLessThanOrEqual(2)
  })

  it('小球从空中落入布尔半圆槽后不会因接触过渡获得额外能量', () => {
    const { scene, layer, upper } = createBooleanBodyScene('difference')
    upper.shape = { type: 'box', width: 8, height: 5 }
    upper.transform.position = { x: 0, y: 2.505 }
    upper.massKg = 1e9
    upper.material = { friction: 0, restitution: 0 }
    const cutter = createBall(layer.id, { x: 0, y: 5.005 }, 3, 2)
    cutter.id = ids(4)
    cutter.material = upper.material
    layer.rotationEnabled = false
    const initialPosition = { x: 1.5, y: 6.5 }
    const rolling = createBall('', initialPosition, 0.3, 3)
    rolling.material = { friction: 0, restitution: 0 }
    const ground = createLineGround('', { x: -10, y: 0 }, { x: 10, y: 0 }, 4)
    ground.material = { friction: 0, restitution: 0 }
    const gravity = createGravityField('', { x: 0, y: 4 }, 30, 30, 5)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -9.8 } }
    scene.entities = [upper, cutter, rolling, ground, gravity]
    const world = new SimulationWorld(scene)
    worlds.push(world)

    const initialEnergy = rolling.massKg * 9.8 * initialPosition.y
    let contactStep = -1
    let contactEnergy = Number.NaN
    let maximumEnergyAfterContact = Number.NEGATIVE_INFINITY
    let maximumOppositeHeight = Number.NEGATIVE_INFINITY
    let maximumAccelerationAfterTransition = 0
    for (let step = 0; step < 1_200; step += 1) {
      world.step()
      const state = world.getBodyStates().find((candidate) => candidate.entityId === rolling.id)!
      const radialDistance = Math.hypot(state.position.x, state.position.y - 5.005)
      if (contactStep < 0 && Math.abs(radialDistance - 2.7) < 0.01) {
        contactStep = step
        contactEnergy = state.kineticEnergyJ + rolling.massKg * 9.8 * state.position.y
      }
      if (contactStep < 0) continue
      const energy = state.kineticEnergyJ + rolling.massKg * 9.8 * state.position.y
      maximumEnergyAfterContact = Math.max(maximumEnergyAfterContact, energy)
      if (state.position.x < -0.5) {
        maximumOppositeHeight = Math.max(maximumOppositeHeight, state.position.y)
      }
      if (step >= contactStep + 3) {
        const acceleration = Math.hypot(state.acceleration.x, state.acceleration.y)
        maximumAccelerationAfterTransition = Math.max(
          maximumAccelerationAfterTransition,
          acceleration,
        )
      }
    }

    expect.soft(contactStep).toBeGreaterThanOrEqual(0)
    expect.soft(contactEnergy).toBeLessThanOrEqual(initialEnergy)
    expect
      .soft((maximumEnergyAfterContact - contactEnergy) / (rolling.massKg * 9.8 * 2.7))
      .toBeLessThan(0.005)
    expect
      .soft(maximumOppositeHeight)
      .toBeLessThanOrEqual(contactEnergy / (rolling.massKg * 9.8) + 0.01)
    expect.soft(maximumAccelerationAfterTransition).toBeLessThan(15)
  })

  it('有限质量布尔半圆槽承受落球时不会凭空增能', () => {
    const { scene, layer, upper } = createBooleanBodyScene('difference')
    upper.shape = { type: 'box', width: 8, height: 5 }
    upper.transform.position = { x: 0, y: 2.505 }
    upper.massKg = 20
    upper.material = { friction: 0, restitution: 0 }
    const cutter = createBall(layer.id, { x: 0, y: 5.005 }, 3, 2)
    cutter.id = ids(4)
    cutter.material = upper.material
    layer.rotationEnabled = false
    const rolling = createBall('', { x: 1.5, y: 6.5 }, 0.3, 3)
    rolling.material = { friction: 0, restitution: 0 }
    const ground = createLineGround('', { x: -10, y: 0 }, { x: 10, y: 0 }, 4)
    ground.material = { friction: 0, restitution: 0 }
    const gravity = createGravityField('', { x: 0, y: 4 }, 30, 30, 5)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -9.8 } }
    scene.entities = [upper, cutter, rolling, ground, gravity]
    const resolved = resolveBooleanScene(scene).byResultId.get(layer.resultId)
    expect(resolved?.valid && resolved.kind).toBe('body')
    if (!resolved?.valid || resolved.kind !== 'body') return
    const localCavityCenter = {
      x: cutter.transform.position.x - resolved.centerOfMass.x,
      y: cutter.transform.position.y - resolved.centerOfMass.y,
    }
    const world = new SimulationWorld(scene)
    worlds.push(world)

    const initialStates = new Map(world.getBodyStates().map((state) => [state.entityId, state]))
    const initialCup = initialStates.get(layer.resultId)!
    const initialBall = initialStates.get(rolling.id)!
    const initialEnergy =
      initialCup.kineticEnergyJ +
      initialBall.kineticEnergyJ +
      9.8 * (resolved.massKg * initialCup.position.y + rolling.massKg * initialBall.position.y)
    let contactStep = -1
    let contactEnergy = Number.NaN
    let maximumEnergyAfterContact = Number.NEGATIVE_INFINITY
    let maximumRadialError = 0
    for (let step = 0; step < 900; step += 1) {
      world.step()
      const states = new Map(world.getBodyStates().map((state) => [state.entityId, state]))
      const cup = states.get(layer.resultId)!
      const ball = states.get(rolling.id)!
      const cavityCenter = {
        x: cup.position.x + localCavityCenter.x,
        y: cup.position.y + localCavityCenter.y,
      }
      const radialDistance = Math.hypot(
        ball.position.x - cavityCenter.x,
        ball.position.y - cavityCenter.y,
      )
      const energy =
        cup.kineticEnergyJ +
        ball.kineticEnergyJ +
        9.8 * (resolved.massKg * cup.position.y + rolling.massKg * ball.position.y)
      if (contactStep < 0 && Math.abs(radialDistance - 2.7) < 0.01) {
        contactStep = step
        contactEnergy = energy
      }
      if (contactStep < 0) continue
      const radialError = Math.abs(radialDistance - 2.7)
      maximumRadialError = Math.max(maximumRadialError, radialError)
      maximumEnergyAfterContact = Math.max(maximumEnergyAfterContact, energy)
    }

    const finalStates = new Map(world.getBodyStates().map((state) => [state.entityId, state]))
    const finalCup = finalStates.get(layer.resultId)!
    const finalBall = finalStates.get(rolling.id)!
    const totalHorizontalMomentum =
      resolved.massKg * finalCup.linearVelocity.x + rolling.massKg * finalBall.linearVelocity.x
    expect.soft(contactStep).toBeGreaterThanOrEqual(0)
    expect.soft(contactEnergy).toBeLessThanOrEqual(initialEnergy)
    expect
      .soft((maximumEnergyAfterContact - contactEnergy) / (rolling.massKg * 9.8 * 2.7))
      .toBeLessThan(0.005)
    expect.soft(maximumRadialError).toBeLessThan(0.01)
    expect.soft(Math.abs(totalHorizontalMomentum)).toBeLessThan(0.01)
  })

  it('无摩擦有限质量布尔圆槽在地面上长期往复时不损能且不穿地', () => {
    const { scene, layer, upper } = createBooleanBodyScene('difference')
    upper.shape = { type: 'box', width: 8, height: 5 }
    upper.transform.position = { x: 0, y: 2.5005 }
    upper.massKg = 1
    upper.material = { friction: 0, restitution: 0 }
    const cutter = createBall(layer.id, { x: 0, y: 5.0005 }, 3, 2)
    cutter.id = ids(4)
    cutter.material = upper.material
    const contactAngle = (7 * Math.PI) / 6
    const rolling = createBall(
      '',
      {
        x: Math.cos(contactAngle) * 2.7,
        y: 5.0005 + Math.sin(contactAngle) * 2.7,
      },
      0.3,
      3,
    )
    rolling.material = { friction: 0, restitution: 0 }
    const ground = createLineGround('', { x: -10, y: 0 }, { x: 10, y: 0 }, 4)
    ground.material = { friction: 0, restitution: 0 }
    const gravity = createGravityField('', { x: 0, y: 4 }, 30, 30, 5)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -9.8 } }
    scene.entities = [upper, cutter, rolling, ground, gravity]
    const resolved = resolveBooleanScene(scene).byResultId.get(layer.resultId)
    expect(resolved?.valid && resolved.kind).toBe('body')
    if (!resolved?.valid || resolved.kind !== 'body') return
    const world = new SimulationWorld(scene)
    worlds.push(world)

    let minimumEnergy = Number.POSITIVE_INFINITY
    let maximumEnergy = Number.NEGATIVE_INFINITY
    let minimumCupSurfaceY = Number.POSITIVE_INFINITY
    let maximumCupAngle = 0
    const turningHeights: number[] = []
    let previousVerticalVelocity = 0
    for (let step = 0; step < 2_400; step += 1) {
      world.step()
      const states = new Map(world.getBodyStates().map((state) => [state.entityId, state]))
      const cup = states.get(layer.resultId)!
      const ball = states.get(rolling.id)!
      maximumCupAngle = Math.max(maximumCupAngle, Math.abs(cup.angleRad))
      if (step >= 30) {
        const energy =
          cup.kineticEnergyJ +
          ball.kineticEnergyJ +
          9.8 * (resolved.massKg * cup.position.y + rolling.massKg * ball.position.y)
        minimumEnergy = Math.min(minimumEnergy, energy)
        maximumEnergy = Math.max(maximumEnergy, energy)
        if (previousVerticalVelocity > 0 && ball.linearVelocity.y <= 0) {
          turningHeights.push(ball.position.y - cup.position.y)
        }
      }
      previousVerticalVelocity = ball.linearVelocity.y
      const cosine = Math.cos(cup.angleRad)
      const sine = Math.sin(cup.angleRad)
      for (const part of resolved.convexParts) {
        for (const point of part.localPoints) {
          minimumCupSurfaceY = Math.min(
            minimumCupSurfaceY,
            cup.position.y + point.x * sine + point.y * cosine,
          )
        }
      }
    }

    const convertibleEnergy = rolling.massKg * 9.8 * 2 * 2.7
    expect.soft((maximumEnergy - minimumEnergy) / convertibleEnergy).toBeLessThan(0.005)
    expect.soft(minimumCupSurfaceY).toBeGreaterThanOrEqual(-0.002)
    expect.soft(maximumCupAngle).toBeLessThan(0.005)
    expect.soft(turningHeights.length).toBeGreaterThanOrEqual(4)
    expect.soft(Math.abs(turningHeights.at(-1)! - turningHeights[0]!) / 2.7).toBeLessThan(0.005)
    const finalStates = new Map(world.getBodyStates().map((state) => [state.entityId, state]))
    const finalCup = finalStates.get(layer.resultId)!
    const finalBall = finalStates.get(rolling.id)!
    expect
      .soft(
        Math.abs(
          resolved.massKg * finalCup.linearVelocity.x + rolling.massKg * finalBall.linearVelocity.x,
        ),
      )
      .toBeLessThan(0.01)
  }, 20_000)

  it('有限质量布尔圆槽与小球持续接触时保持总动量并获得反向响应', () => {
    const { scene, layer, upper } = createBooleanBodyScene('difference')
    upper.shape = { type: 'box', width: 8, height: 8 }
    upper.transform.position = { x: 0, y: 0 }
    upper.massKg = 64
    upper.material = { friction: 0, restitution: 0 }
    const cutter = createBall(layer.id, { x: 0, y: 0 }, 3, 2)
    cutter.id = ids(4)
    cutter.material = upper.material
    const rolling = createBall('', { x: 2.7, y: 0 }, 0.3, 3)
    rolling.initialVelocity = { x: 0, y: 1.5 }
    rolling.material = upper.material
    scene.entities = [upper, cutter, rolling]
    const world = new SimulationWorld(scene)
    worlds.push(world)

    const resolved = resolveBooleanScene(scene).byResultId.get(layer.resultId)
    expect(resolved?.valid && resolved.kind).toBe('body')
    if (!resolved?.valid || resolved.kind !== 'body') return
    const initialStates = new Map(world.getBodyStates().map((state) => [state.entityId, state]))
    const initialCup = initialStates.get(layer.resultId)!
    const initialBall = initialStates.get(rolling.id)!
    const initialMomentum = {
      x:
        resolved.massKg * initialCup.linearVelocity.x +
        rolling.massKg * initialBall.linearVelocity.x,
      y:
        resolved.massKg * initialCup.linearVelocity.y +
        rolling.massKg * initialBall.linearVelocity.y,
    }
    const initialEnergy = initialCup.kineticEnergyJ + initialBall.kineticEnergyJ

    world.step(1_200)

    const finalStates = new Map(world.getBodyStates().map((state) => [state.entityId, state]))
    const finalCup = finalStates.get(layer.resultId)!
    const finalBall = finalStates.get(rolling.id)!
    const finalMomentum = {
      x: resolved.massKg * finalCup.linearVelocity.x + rolling.massKg * finalBall.linearVelocity.x,
      y: resolved.massKg * finalCup.linearVelocity.y + rolling.massKg * finalBall.linearVelocity.y,
    }
    const finalEnergy = finalCup.kineticEnergyJ + finalBall.kineticEnergyJ

    expect.soft(finalMomentum.x).toBeCloseTo(initialMomentum.x, 4)
    expect.soft(finalMomentum.y).toBeCloseTo(initialMomentum.y, 4)
    expect.soft(Math.abs(finalEnergy - initialEnergy) / initialEnergy).toBeLessThan(0.01)
    expect(Math.hypot(finalCup.linearVelocity.x, finalCup.linearVelocity.y)).toBeGreaterThan(1e-4)
  })

  it('有限质量布尔圆槽的摩擦会消除相对滑动且不破坏总线动量', () => {
    const { scene, layer, upper } = createBooleanBodyScene('difference')
    upper.shape = { type: 'box', width: 8, height: 8 }
    upper.transform.position = { x: 0, y: 0 }
    upper.massKg = 64
    upper.material = { friction: 0.6, restitution: 0 }
    const cutter = createBall(layer.id, { x: 0, y: 0 }, 3, 2)
    cutter.id = ids(4)
    cutter.material = upper.material
    const rollingRadiusM = 0.3
    const rolling = createBall('', { x: 2.7, y: 0 }, rollingRadiusM, 3)
    rolling.initialVelocity = { x: 0, y: 1.5 }
    rolling.material = upper.material
    scene.entities = [upper, cutter, rolling]
    const resolved = resolveBooleanScene(scene).byResultId.get(layer.resultId)
    expect(resolved?.valid && resolved.kind).toBe('body')
    if (!resolved?.valid || resolved.kind !== 'body') return
    const world = new SimulationWorld(scene)
    worlds.push(world)

    const initialMomentumY = rolling.massKg * rolling.initialVelocity.y
    const initialEnergy = world
      .getBodyStates()
      .reduce((sum, state) => sum + state.kineticEnergyJ, 0)
    world.step(600)

    const states = new Map(world.getBodyStates().map((state) => [state.entityId, state]))
    const cup = states.get(layer.resultId)!
    const ball = states.get(rolling.id)!
    const cosine = Math.cos(cup.angleRad)
    const sine = Math.sin(cup.angleRad)
    const localCavityCenter = {
      x: cutter.transform.position.x - resolved.centerOfMass.x,
      y: cutter.transform.position.y - resolved.centerOfMass.y,
    }
    const cavityCenter = {
      x: cup.position.x + localCavityCenter.x * cosine - localCavityCenter.y * sine,
      y: cup.position.y + localCavityCenter.x * sine + localCavityCenter.y * cosine,
    }
    const radial = {
      x: ball.position.x - cavityCenter.x,
      y: ball.position.y - cavityCenter.y,
    }
    const radialLength = Math.hypot(radial.x, radial.y)
    const outward = { x: radial.x / radialLength, y: radial.y / radialLength }
    const tangent = { x: -outward.y, y: outward.x }
    const contactPoint = {
      x: ball.position.x + outward.x * rollingRadiusM,
      y: ball.position.y + outward.y * rollingRadiusM,
    }
    const ballOffset = {
      x: contactPoint.x - ball.position.x,
      y: contactPoint.y - ball.position.y,
    }
    const cupOffset = { x: contactPoint.x - cup.position.x, y: contactPoint.y - cup.position.y }
    const ballSurfaceVelocity = {
      x: ball.linearVelocity.x - ball.angularVelocityRad * ballOffset.y,
      y: ball.linearVelocity.y + ball.angularVelocityRad * ballOffset.x,
    }
    const cupSurfaceVelocity = {
      x: cup.linearVelocity.x - cup.angularVelocityRad * cupOffset.y,
      y: cup.linearVelocity.y + cup.angularVelocityRad * cupOffset.x,
    }
    const slipSpeed = Math.abs(
      (ballSurfaceVelocity.x - cupSurfaceVelocity.x) * tangent.x +
        (ballSurfaceVelocity.y - cupSurfaceVelocity.y) * tangent.y,
    )
    const finalMomentum = {
      x: resolved.massKg * cup.linearVelocity.x + rolling.massKg * ball.linearVelocity.x,
      y: resolved.massKg * cup.linearVelocity.y + rolling.massKg * ball.linearVelocity.y,
    }
    const finalEnergy = cup.kineticEnergyJ + ball.kineticEnergyJ

    expect.soft(finalMomentum.x).toBeCloseTo(0, 4)
    expect.soft(finalMomentum.y).toBeCloseTo(initialMomentumY, 4)
    expect.soft(slipSpeed).toBeLessThan(0.05)
    expect(finalEnergy).toBeLessThanOrEqual(initialEnergy * (1 + 1e-4))
  })

  it('小球主动离开布尔圆槽后不会被邻近边界重新吸回', () => {
    const { scene, layer, upper } = createBooleanBodyScene('difference')
    upper.shape = { type: 'box', width: 8, height: 8 }
    upper.transform.position = { x: 0, y: 0 }
    upper.massKg = 1e9
    upper.material = { friction: 0, restitution: 0 }
    layer.rotationEnabled = false
    const cutter = createBall(layer.id, { x: 0, y: 0 }, 3, 2)
    cutter.id = ids(4)
    cutter.material = upper.material
    const rolling = createBall('', { x: 2.7, y: 0 }, 0.3, 3)
    rolling.initialVelocity = { x: -2, y: 0 }
    rolling.material = upper.material
    scene.entities = [upper, cutter, rolling]
    const world = new SimulationWorld(scene)
    worlds.push(world)

    world.step(120)

    const state = world.getBodyStates().find((candidate) => candidate.entityId === rolling.id)!
    expect(state.position.x).toBeLessThan(0.8)
    expect(state.linearVelocity.x).toBeLessThan(-1.9)
  })

  it('小球到达布尔圆弧与反向外壁的尖点时沿切线飞出而不会被拉到外壁', () => {
    const scene = createEmptyScene()
    const carvedBlock = createBlock('', { x: 3.5, y: 2.5 }, 3, 5, 1)
    const cutter = createBall('', { x: 2, y: 5 }, 3, 2)
    const platform = createBlock('', { x: -1.5, y: 1 }, 7, 2, 3)
    carvedBlock.id = ids(20)
    cutter.id = ids(21)
    platform.id = ids(22)
    carvedBlock.massKg = 1e9
    platform.massKg = 1e9
    carvedBlock.material = { friction: 0, restitution: 0 }
    cutter.material = carvedBlock.material
    platform.material = carvedBlock.material

    const difference = booleanLayer(ids(23), ids(24), 'difference', carvedBlock.id, cutter.id)
    difference.rotationEnabled = false
    const root = booleanLayer(ids(25), ids(26), 'union', difference.resultId, platform.id)
    root.operands = [difference, { kind: 'entity', entityId: platform.id }]
    root.rotationEnabled = false

    const rolling = createBall('', { x: 0, y: 2.2 }, 0.2, 4)
    rolling.id = ids(27)
    rolling.initialVelocity = { x: 9, y: 0 }
    rolling.material = { friction: 0, restitution: 0 }
    const ground = createLineGround('', { x: -10, y: 0 }, { x: 10, y: 0 }, 5)
    ground.material = rolling.material
    const gravity = createGravityField('', { x: 0, y: 3 }, 30, 20, 6)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -9.8 } }
    scene.entities = [carvedBlock, cutter, platform, rolling, ground, gravity]
    scene.rootItems = [root, { kind: 'entity', entityId: rolling.id }]
    const world = new SimulationWorld(scene)
    worlds.push(world)

    let firstAboveTip: ReturnType<SimulationWorld['getBodyStates']>[number] | null = null
    let maximumSpeed = 0
    let maximumAcceleration = 0
    for (let step = 0; step < 180; step += 1) {
      world.step()
      const state = world.getBodyStates().find((candidate) => candidate.entityId === rolling.id)!
      maximumSpeed = Math.max(
        maximumSpeed,
        Math.hypot(state.linearVelocity.x, state.linearVelocity.y),
      )
      const acceleration = Math.hypot(state.acceleration.x, state.acceleration.y)
      maximumAcceleration = Math.max(maximumAcceleration, acceleration)
      if (!firstAboveTip && state.position.y > 5.25) firstAboveTip = state
    }

    expect(firstAboveTip).not.toBeNull()
    if (!firstAboveTip) return
    expect.soft(firstAboveTip.position.x).toBeLessThan(4.9)
    expect.soft(firstAboveTip.linearVelocity.y).toBeGreaterThan(4.4)
    expect.soft(Math.abs(firstAboveTip.linearVelocity.x)).toBeLessThan(0.3)
    expect.soft(maximumSpeed).toBeLessThan(9.01)
    expect(maximumAcceleration).toBeLessThan(45)
  })

  it('小球在可移动四分之一圆滑道上平滑离轨并以相同水平速度返回', () => {
    const scene = createEmptyScene()
    const ramp = createBezierBlock(
      '',
      createCurvedBlockPresetNodes('quarterRamp', { x: 0, y: 2.5 }, 10, 5),
      5,
    )!
    ramp.id = ids(30)
    ramp.rotationEnabled = false
    ramp.material = { friction: 0, restitution: 0 }
    const ballRadiusM = 0.2
    const ball = createBall('', { x: -4, y: 1.2 }, ballRadiusM, 1)
    ball.id = ids(31)
    ball.initialVelocity = { x: 15, y: 0 }
    ball.material = ramp.material
    const ground = createLineGround('', { x: -20, y: 0 }, { x: 20, y: 0 }, 3)
    ground.material = ramp.material
    const gravity = createGravityField('', { x: 0, y: 5 }, 40, 20, 4)
    scene.entities = [ramp, ball, ground, gravity]
    scene.rootItems = [
      { kind: 'entity', entityId: ramp.id },
      { kind: 'entity', entityId: ball.id },
      { kind: 'entity', entityId: ground.id },
      { kind: 'entity', entityId: gravity.id },
    ]
    const world = new SimulationWorld(scene)
    worlds.push(world)

    const initialRampPosition = ramp.transform.position
    const tipOffset = { x: 5 - initialRampPosition.x, y: 5 - initialRampPosition.y }
    const joinOffset = { x: 1 - initialRampPosition.x, y: 1 - initialRampPosition.y }
    let maximumHorizontalMomentumError = 0
    let maximumInteriorAccelerationJump = 0
    let previousInteriorAcceleration: number | null = null
    let exitHorizontalVelocityDifference: number | null = null
    let returnedToRamp = false
    let minimumReturnSpeedRatio = 1
    let speedBeforeReturn: number | null = null

    for (let step = 0; step < 720; step += 1) {
      world.step()
      const states = world.getBodyStates()
      const rampState = states.find((candidate) => candidate.entityId === ramp.id)!
      const ballState = states.find((candidate) => candidate.entityId === ball.id)!
      const horizontalMomentum =
        ramp.massKg * rampState.linearVelocity.x + ball.massKg * ballState.linearVelocity.x
      maximumHorizontalMomentumError = Math.max(
        maximumHorizontalMomentumError,
        Math.abs(horizontalMomentum - ball.massKg * 15),
      )
      const local = {
        x: ballState.position.x - rampState.position.x,
        y: ballState.position.y - rampState.position.y,
      }
      const acceleration = Math.hypot(ballState.acceleration.x, ballState.acceleration.y)
      const onArcInterior =
        local.x > joinOffset.x + 0.25 &&
        local.x < tipOffset.x - 0.25 &&
        local.y > joinOffset.y + 0.25 &&
        local.y < tipOffset.y - 0.25
      if (onArcInterior) {
        if (previousInteriorAcceleration !== null) {
          maximumInteriorAccelerationJump = Math.max(
            maximumInteriorAccelerationJump,
            Math.abs(acceleration - previousInteriorAcceleration),
          )
        }
        previousInteriorAcceleration = acceleration
      }
      if (exitHorizontalVelocityDifference === null && local.y > tipOffset.y + ballRadiusM * 0.5) {
        exitHorizontalVelocityDifference = Math.abs(
          ballState.linearVelocity.x - rampState.linearVelocity.x,
        )
      }
      if (exitHorizontalVelocityDifference !== null && ballState.linearVelocity.y < 0) {
        speedBeforeReturn ??= Math.hypot(
          ballState.linearVelocity.x - rampState.linearVelocity.x,
          ballState.linearVelocity.y - rampState.linearVelocity.y,
        )
        if (local.y <= tipOffset.y + ballRadiusM * 0.25) {
          returnedToRamp = true
          const relativeSpeed = Math.hypot(
            ballState.linearVelocity.x - rampState.linearVelocity.x,
            ballState.linearVelocity.y - rampState.linearVelocity.y,
          )
          minimumReturnSpeedRatio = Math.min(
            minimumReturnSpeedRatio,
            relativeSpeed / Math.max(speedBeforeReturn, 1e-9),
          )
        }
      }
    }

    expect.soft(maximumHorizontalMomentumError).toBeLessThan(0.01)
    expect.soft(maximumInteriorAccelerationJump).toBeLessThan(8)
    expect(exitHorizontalVelocityDifference).not.toBeNull()
    expect.soft(exitHorizontalVelocityDifference ?? Infinity).toBeLessThan(1e-6)
    expect(returnedToRamp).toBe(true)
    expect(minimumReturnSpeedRatio).toBeGreaterThan(0.98)
  })
})

describe('布尔有限场', () => {
  it('重叠区只采用上方场属性，来源场不再重复生效', () => {
    const scene = createEmptyScene()
    const layerId = ids(11)
    const resultId = ids(12)
    const upper = createGravityField(layerId, { x: 0, y: 0 }, 4, 4, 1)
    const lower = createGravityField(layerId, { x: 1, y: 0 }, 4, 4, 2)
    upper.id = ids(13)
    lower.id = ids(14)
    upper.field = { type: 'uniformGravity', acceleration: { x: 0, y: -2 } }
    lower.field = { type: 'uniformGravity', acceleration: { x: 0, y: -20 } }
    const layer = booleanLayer(layerId, resultId, 'union', upper.id, lower.id)
    scene.rootItems.push(layer)
    const body = createBall('', { x: 0, y: 0 }, 0.2, 1)
    const outside = createBall('', { x: 10, y: 0 }, 0.2, 2)
    scene.entities = [upper, lower, body, outside]
    const world = new SimulationWorld(scene)
    worlds.push(world)
    world.step()

    const state = world.getBodyStates().find((candidate) => candidate.entityId === body.id)
    expect(state?.linearVelocity.y).toBeCloseTo(-2 / 120, 5)
    expect(
      world.getBodyStates().find((candidate) => candidate.entityId === outside.id)?.linearVelocity,
    ).toEqual({ x: 0, y: 0 })
  })
})
