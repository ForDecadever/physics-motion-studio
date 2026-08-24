import { describe, expect, it } from 'vitest'

import type { RuntimeBodyState } from '../../physics/worker/messages'
import { createEmptyScene } from '../../scene/model/createEmptyScene'
import {
  createBall,
  createElectricField,
  createForce,
  createGravityField,
  createLineGround,
  createMagneticField,
  createRope,
} from '../../scene/model/entityFactories'
import { analyzeBodyForces } from './forceAnalysis'

function runtimeBody(entityId: string): RuntimeBodyState {
  return {
    entityId,
    position: { x: 5, y: 0 },
    angleRad: 0,
    linearVelocity: { x: 4, y: 0 },
    angularVelocityRad: 0,
    netForce: { x: 7, y: -20 },
    acceleration: { x: 3.5, y: -10 },
    translationalKineticEnergyJ: 16,
    rotationalKineticEnergyJ: 0,
    kineticEnergyJ: 16,
  }
}

describe('测力计受力分析', () => {
  it('分解场力、时变外加力和由最终合力反推的约束力', () => {
    const scene = createEmptyScene()
    const body = createBall('', { x: 5, y: 0 }, 1, 1)
    body.massKg = 2
    body.chargeC = 3
    const gravity = createGravityField('', { x: 5, y: 0 }, 4, 4, 1)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -10 } }
    const electric = createElectricField('', { x: 5, y: 0 }, 4, 4, 1)
    electric.field = { type: 'uniformElectric', strength: { x: 2, y: 0 } }
    const magnetic = createMagneticField('', { x: 5, y: 0 }, 4, 4, 1)
    magnetic.field = { type: 'uniformMagnetic', bzTesla: 1 }
    const force = createForce('', body.id, { x: 0, y: 0 }, 1)
    force.magnitudeN = 0
    force.directionRad = 0
    force.magnitudeExpression = { expression: '5*t', fallbackValue: 0 }
    force.directionDegreesExpression = { expression: '90', fallbackValue: 90 }
    scene.entities = [body, gravity, electric, magnetic, force]
    scene.rootItems = scene.entities.map((entity) => ({
      kind: 'entity' as const,
      entityId: entity.id,
    }))

    const entries = analyzeBodyForces(scene, body.id, { [body.id]: runtimeBody(body.id) }, 2)
    const byKey = Object.fromEntries(entries?.map((entry) => [entry.key, entry.force]) ?? [])

    expect(byKey.gravity).toEqual({ x: 0, y: -20 })
    expect(byKey.electric).toEqual({ x: 6, y: 0 })
    expect(byKey.magnetic).toEqual({ x: 0, y: -12 })
    expect(byKey.external?.x).toBeCloseTo(0, 10)
    expect(byKey.external?.y).toBeCloseTo(10, 10)
    expect(byKey.constraint?.x).toBeCloseTo(1, 10)
    expect(byKey.constraint?.y).toBeCloseTo(2, 10)
    expect(byKey.net).toEqual({ x: 7, y: -20 })
  })

  it('暂停时按对象初始位置判断其所在场', () => {
    const scene = createEmptyScene()
    const body = createBall('', { x: 5, y: 0 }, 1, 1)
    body.massKg = 2
    const gravity = createGravityField('', { x: 5, y: 0 }, 2, 2, 1)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -3 } }
    scene.entities = [body, gravity]
    scene.rootItems = scene.entities.map((entity) => ({
      kind: 'entity' as const,
      entityId: entity.id,
    }))

    const entries = analyzeBodyForces(scene, body.id, {}, 0)
    expect(entries?.find((entry) => entry.key === 'gravity')?.force).toEqual({ x: 0, y: -6 })
  })

  it('把同一物体上的两根绳分别列出并按各自方向分解拉力', () => {
    const scene = createEmptyScene()
    const body = createBall('', { x: 0, y: 0 }, 0.5, 1)
    const gravity = createGravityField('', { x: 0, y: 0 }, 4, 4, 1)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -10 } }
    const left = createRope(
      '',
      { type: 'body', bodyId: body.id, localAnchor: { x: 0, y: 0 } },
      { type: 'world', position: { x: -1, y: 1 } },
      Math.SQRT2,
      1,
    )
    const right = createRope(
      '',
      { type: 'body', bodyId: body.id, localAnchor: { x: 0, y: 0 } },
      { type: 'world', position: { x: 1, y: 1 } },
      Math.SQRT2,
      2,
    )
    scene.entities = [body, gravity, left, right]
    scene.rootItems = scene.entities.map((entity) => ({
      kind: 'entity' as const,
      entityId: entity.id,
    }))
    const runtime = runtimeBody(body.id)
    runtime.position = { x: 0, y: 0 }
    runtime.linearVelocity = { x: 0, y: 0 }
    runtime.netForce = { x: 0, y: 0 }

    const entries = analyzeBodyForces(scene, body.id, { [body.id]: runtime }, 1, {
      [left.id]: {
        entityId: left.id,
        points: [
          { x: 0, y: 0 },
          { x: -1, y: 1 },
        ],
      },
      [right.id]: {
        entityId: right.id,
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      },
    })

    const leftForce = entries?.find((entry) => entry.key === `connector:${left.id}`)?.force
    const rightForce = entries?.find((entry) => entry.key === `connector:${right.id}`)?.force
    expect(leftForce?.x).toBeCloseTo(-5, 8)
    expect(leftForce?.y).toBeCloseTo(5, 8)
    expect(rightForce?.x).toBeCloseTo(5, 8)
    expect(rightForce?.y).toBeCloseTo(5, 8)
    expect(entries?.find((entry) => entry.key === 'constraint')).toBeUndefined()
  })

  it('把不同接触对象分别列为独立接触力', () => {
    const scene = createEmptyScene()
    const body = createBall('', { x: 0, y: 0.5 }, 0.5, 1)
    const leftGround = createLineGround('', { x: -2, y: 0 }, { x: 0, y: 0 }, 1)
    const rightGround = createLineGround('', { x: 0, y: 0 }, { x: 2, y: 0 }, 2)
    const gravity = createGravityField('', { x: 0, y: 0 }, 4, 4, 1)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -10 } }
    scene.entities = [body, leftGround, rightGround, gravity]
    scene.rootItems = scene.entities.map((entity) => ({
      kind: 'entity' as const,
      entityId: entity.id,
    }))
    const runtime = runtimeBody(body.id)
    runtime.position = { x: 0, y: 0.5 }
    runtime.linearVelocity = { x: 0, y: 0 }
    runtime.netForce = { x: 0, y: 0 }
    runtime.contactSources = [
      {
        sourceEntityId: leftGround.id,
        sourceKind: 'ground',
        direction: { x: -1, y: 1 },
      },
      {
        sourceEntityId: rightGround.id,
        sourceKind: 'ground',
        direction: { x: 1, y: 1 },
      },
    ]

    const entries = analyzeBodyForces(scene, body.id, { [body.id]: runtime }, 1, {})
    const leftContact = entries?.find((entry) => entry.key === `contact:ground:${leftGround.id}`)
    const rightContact = entries?.find((entry) => entry.key === `contact:ground:${rightGround.id}`)
    expect(leftContact?.label).toContain(leftGround.name)
    expect(rightContact?.label).toContain(rightGround.name)
    expect(leftContact?.force.x).toBeCloseTo(-5, 8)
    expect(leftContact?.force.y).toBeCloseTo(5, 8)
    expect(rightContact?.force.x).toBeCloseTo(5, 8)
    expect(rightContact?.force.y).toBeCloseTo(5, 8)
    expect(entries?.find((entry) => entry.key === 'constraint')).toBeUndefined()
  })

  it('单个接触来源只承担沿自身法线的力而不吞掉垂直残差', () => {
    const scene = createEmptyScene()
    const body = createBall('', { x: 0, y: 0 }, 0.5, 1)
    const ground = createLineGround('', { x: 0, y: -2 }, { x: 0, y: 2 }, 1)
    scene.entities = [body, ground]
    scene.rootItems = scene.entities.map((entity) => ({
      kind: 'entity' as const,
      entityId: entity.id,
    }))
    const runtime = runtimeBody(body.id)
    runtime.position = { x: 0.5, y: 0 }
    runtime.linearVelocity = { x: 0, y: 0 }
    runtime.netForce = { x: 0, y: 10 }
    runtime.contactSources = [
      {
        sourceEntityId: ground.id,
        sourceKind: 'ground',
        direction: { x: 1, y: 0 },
      },
    ]

    const entries = analyzeBodyForces(scene, body.id, { [body.id]: runtime }, 1)
    expect(entries?.find((entry) => entry.key === `contact:ground:${ground.id}`)?.force).toEqual({
      x: 0,
      y: 0,
    })
    expect(entries?.find((entry) => entry.key === 'constraint')?.force).toEqual({ x: 0, y: 10 })
  })
})
