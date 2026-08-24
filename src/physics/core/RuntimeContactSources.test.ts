import { afterEach, describe, expect, it } from 'vitest'

import { analyzeBodyForces } from '../../features/measurements/forceAnalysis'
import { createEmptyScene } from '../../scene/model/createEmptyScene'
import {
  createBall,
  createGravityField,
  createLineGround,
  createRope,
} from '../../scene/model/entityFactories'
import { SimulationWorld } from './SimulationWorld'

const worlds: SimulationWorld[] = []

afterEach(() => {
  for (const world of worlds.splice(0)) world.dispose()
})

describe('测力计运行时接触来源', () => {
  it('关闭碰撞的两根无质量绳仍发布运行时方向并被测力计分别列出', () => {
    const scene = createEmptyScene()
    const ball = createBall('', { x: 0, y: 0 }, 0.25, 1)
    const gravity = createGravityField('', { x: 0, y: 0 }, 8, 8, 1)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -9.80665 } }
    const left = createRope(
      '',
      { type: 'body', bodyId: ball.id, localAnchor: { x: 0, y: 0 } },
      { type: 'world', position: { x: -1, y: 1 } },
      Math.SQRT2,
      1,
    )
    const right = createRope(
      '',
      { type: 'body', bodyId: ball.id, localAnchor: { x: 0, y: 0 } },
      { type: 'world', position: { x: 1, y: 1 } },
      Math.SQRT2,
      2,
    )
    expect(left.collisionEnabled).toBe(false)
    expect(right.collisionEnabled).toBe(false)
    scene.entities = [ball, gravity, left, right]
    scene.rootItems = scene.entities.map((entity) => ({
      kind: 'entity' as const,
      entityId: entity.id,
    }))
    const world = new SimulationWorld(scene)
    worlds.push(world)

    world.step(240)

    const body = world.getBodyStates().find((state) => state.entityId === ball.id)!
    const connectors = world.getConnectorStates()
    expect(connectors.map((connector) => connector.entityId).sort()).toEqual(
      [left.id, right.id].sort(),
    )
    const entries = analyzeBodyForces(
      scene,
      ball.id,
      { [ball.id]: body },
      world.simulationTime,
      Object.fromEntries(connectors.map((connector) => [connector.entityId, connector])),
    )
    expect(entries?.find((entry) => entry.key === `connector:${left.id}`)?.label).toContain(
      left.name,
    )
    expect(entries?.find((entry) => entry.key === `connector:${right.id}`)?.label).toContain(
      right.name,
    )
    expect(entries?.find((entry) => entry.key === 'constraint')).toBeUndefined()
  })

  it('单根竖直无质量绳悬挂静止小球时每个固定步都平衡重力', () => {
    const scene = createEmptyScene()
    const ball = createBall('', { x: 0, y: 0 }, 0.25, 1)
    const gravity = createGravityField('', { x: 0, y: 0 }, 8, 8, 1)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -9.80665 } }
    const rope = createRope(
      '',
      { type: 'body', bodyId: ball.id, localAnchor: { x: 0, y: 0 } },
      { type: 'world', position: { x: 0, y: 1 } },
      1,
      1,
    )
    scene.entities = [ball, gravity, rope]
    scene.rootItems = scene.entities.map((entity) => ({
      kind: 'entity' as const,
      entityId: entity.id,
    }))
    const world = new SimulationWorld(scene)
    worlds.push(world)

    world.step(120)
    const samples = Array.from({ length: 240 }, () => {
      world.step()
      return world.getBodyStates().find((state) => state.entityId === ball.id)!
    })

    expect(Math.max(...samples.map((state) => Math.abs(state.position.y)))).toBeLessThan(1e-5)
    expect(Math.max(...samples.map((state) => Math.abs(state.linearVelocity.y)))).toBeLessThan(1e-5)
    expect(Math.max(...samples.map((state) => Math.abs(state.netForce.y)))).toBeLessThan(1e-3)
  })

  it('斜绳把小球压在竖直地面时不会在相邻固定步间上下抽搐', () => {
    const scene = createEmptyScene()
    const radius = 0.25
    const ball = createBall('', { x: radius, y: 0 }, radius, 1)
    const wall = createLineGround('', { x: 0, y: -2 }, { x: 0, y: 3 }, 1)
    const gravity = createGravityField('', { x: 0, y: 0 }, 8, 8, 1)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -9.80665 } }
    const rope = createRope(
      '',
      { type: 'body', bodyId: ball.id, localAnchor: { x: 0, y: 0 } },
      { type: 'world', position: { x: 0, y: 2 } },
      Math.hypot(radius, 2),
      1,
    )
    scene.entities = [wall, ball, rope, gravity]
    scene.rootItems = scene.entities.map((entity) => ({
      kind: 'entity' as const,
      entityId: entity.id,
    }))
    const world = new SimulationWorld(scene)
    worlds.push(world)

    world.step(120)
    const samples = Array.from({ length: 240 }, () => {
      world.step()
      return {
        state: world.getBodyStates().find((state) => state.entityId === ball.id)!,
        contacts: world.getRuntimeDiagnostics().persistentGroundContactCount,
      }
    })

    const maximumVerticalSpeed = Math.max(
      ...samples.map(({ state }) => Math.abs(state.linearVelocity.y)),
    )
    const maximumVerticalForce = Math.max(...samples.map(({ state }) => Math.abs(state.netForce.y)))
    const diagnostic = JSON.stringify(
      samples.slice(-12).map(({ state, contacts }) => ({
        x: state.position.x,
        y: state.position.y,
        length: Math.hypot(state.position.x, 2 - state.position.y),
        vx: state.linearVelocity.x,
        vy: state.linearVelocity.y,
        fy: state.netForce.y,
        contacts,
      })),
    )
    expect(maximumVerticalSpeed, diagnostic).toBeLessThan(1e-3)
    expect(maximumVerticalForce, diagnostic).toBeLessThan(0.05)

    const body = samples.at(-1)!.state
    const connectors = world.getConnectorStates()
    const entries = analyzeBodyForces(
      scene,
      ball.id,
      { [ball.id]: body },
      world.simulationTime,
      Object.fromEntries(connectors.map((connector) => [connector.entityId, connector])),
    )
    const ropeForce = entries?.find((entry) => entry.key === `connector:${rope.id}`)?.force
    const wallForce = entries?.find((entry) => entry.key === `contact:ground:${wall.id}`)?.force
    expect(ropeForce?.y).toBeCloseTo(9.80665, 2)
    expect(ropeForce?.x).toBeLessThan(0)
    expect(wallForce?.x).toBeGreaterThan(0)
    expect(Math.abs(wallForce?.y ?? Number.POSITIVE_INFINITY)).toBeLessThan(1e-6)
    expect(entries?.find((entry) => entry.key === 'constraint')).toBeUndefined()
  })

  it('静止在地面上的小球保留地面 ID 和支持力方向', () => {
    const scene = createEmptyScene()
    const ball = createBall('', { x: 0, y: 0.5 }, 0.5, 1)
    const ground = createLineGround('', { x: -3, y: 0 }, { x: 3, y: 0 }, 1)
    const gravity = createGravityField('', { x: 0, y: 0 }, 8, 8, 1)
    gravity.field = { type: 'uniformGravity', acceleration: { x: 0, y: -9.80665 } }
    scene.entities = [ball, ground, gravity]
    scene.rootItems = scene.entities.map((entity) => ({
      kind: 'entity' as const,
      entityId: entity.id,
    }))
    const world = new SimulationWorld(scene)
    worlds.push(world)

    world.step(240)

    const source = world
      .getBodyStates()[0]!
      .contactSources?.find((candidate) => candidate.sourceEntityId === ground.id)
    expect(source).toMatchObject({ sourceKind: 'ground' })
    expect(source?.direction.x).toBeCloseTo(0, 6)
    expect(source?.direction.y).toBeGreaterThan(0.99)
  })
})
