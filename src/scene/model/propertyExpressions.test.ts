import { describe, expect, it } from 'vitest'

import {
  createArcGround,
  createBall,
  createBlock,
  createForce,
  createGravityField,
  createLineGround,
  createMarkerMeasurement,
  createParticleSource,
  createSpring,
} from './entityFactories'
import { createEmptyScene } from './createEmptyScene'
import {
  recomputePropertyExpressions,
  setPropertyExpression,
  stepPropertyExpressionSource,
} from './propertyExpressions'

describe('全局变量与属性表达式', () => {
  it('按定义顺序解析变量，并原子重算物体、地面属性', () => {
    const scene = createEmptyScene('表达式', new Date('2026-08-23T00:00:00.000Z'))
    const ball = createBall('', { x: 0, y: 0 }, 0.5, 1)
    const ground = createLineGround('', { x: -1, y: 0 }, { x: 1, y: 0 }, 1)
    scene.entities = [ball, ground]
    scene.rootItems = [ball, ground].map((entity) => ({ kind: 'entity', entityId: entity.id }))
    scene.globalVariables = [
      { name: 'a', expression: '10', value: 10 },
      { name: 'b', expression: 'a/2', value: 5 },
    ]

    let next = setPropertyExpression(
      scene,
      { type: 'entity', entityId: ball.id, property: 'body.massKg' },
      '3a',
    )
    next = setPropertyExpression(
      next,
      { type: 'entity', entityId: ground.id, property: 'ground.material.friction' },
      'b/10',
    )
    next = recomputePropertyExpressions(next, [
      { name: 'a', expression: '20', value: 20 },
      { name: 'b', expression: 'a/4', value: 5 },
    ])

    expect(next.entities.find((entity) => entity.id === ball.id)).toMatchObject({ massKg: 60 })
    expect(next.entities.find((entity) => entity.id === ground.id)).toMatchObject({
      material: { friction: 0.5 },
    })
    expect(next.propertyExpressions.map((binding) => binding.fallbackValue)).toEqual([60, 0.5])
  })

  it('输入纯数字会解除原绑定', () => {
    const scene = createEmptyScene()
    const ball = createBall('', { x: 0, y: 0 }, 0.5, 1)
    scene.entities = [ball]
    scene.rootItems = [{ kind: 'entity', entityId: ball.id }]
    scene.globalVariables = [{ name: 'a', expression: '10', value: 10 }]

    const bound = setPropertyExpression(
      scene,
      { type: 'entity', entityId: ball.id, property: 'body.massKg' },
      'a',
    )
    const literal = setPropertyExpression(
      bound,
      { type: 'entity', entityId: ball.id, property: 'body.massKg' },
      '2',
    )

    expect(literal.propertyExpressions).toEqual([])
    expect(literal.entities[0]).toMatchObject({ massKg: 2 })
  })

  it('用同一受控注册表计算变换、几何、场、粒子源、连接器、力、测量和场景设置', () => {
    let scene = createEmptyScene()
    const body = createBlock('', { x: 0, y: 0 }, 2, 1, 1)
    const arc = createArcGround('', { x: 0, y: 0 }, 2, 0, Math.PI, 1)
    const field = createGravityField('', { x: 0, y: 0 }, 4, 3, 1)
    const source = createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 1)
    const spring = createSpring(
      '',
      { type: 'body', bodyId: body.id, localAnchor: { x: 0, y: 0 } },
      { type: 'free', position: { x: 2, y: 0 } },
      2,
      1,
    )
    const force = createForce('', body.id, { x: 0, y: 0 }, 1)
    const marker = createMarkerMeasurement(
      '',
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      1,
    )
    scene.entities = [body, arc, field, source, spring, force, marker]
    scene.rootItems = scene.entities.map((entity) => ({
      kind: 'entity' as const,
      entityId: entity.id,
    }))
    scene.globalVariables = [{ name: 'a', expression: '10', value: 10 }]

    const bind = (target: Parameters<typeof setPropertyExpression>[1], expression: string) => {
      scene = setPropertyExpression(scene, target, expression)
    }
    bind({ type: 'entity', entityId: body.id, property: 'transform.position.x' }, '3a')
    bind({ type: 'entity', entityId: body.id, property: 'body.shape.width' }, 'a/2')
    bind({ type: 'entity', entityId: arc.id, property: 'ground.geometry.radius' }, 'a/2')
    bind({ type: 'entity', entityId: arc.id, property: 'ground.geometry.startDegrees' }, '9a')
    bind({ type: 'entity', entityId: field.id, property: 'field.region.width' }, '2a')
    bind({ type: 'entity', entityId: field.id, property: 'field.gravity.y' }, '-a')
    bind({ type: 'entity', entityId: source.id, property: 'particleSource.directionDegrees' }, '9a')
    bind({ type: 'entity', entityId: source.id, property: 'particleSource.spreadDegrees' }, '9a')
    bind(
      { type: 'entity', entityId: source.id, property: 'particleSource.densityPerDegree' },
      'a/2',
    )
    bind(
      {
        type: 'entity',
        entityId: source.id,
        property: 'particleSource.continuous.intervalSeconds',
      },
      'a/10',
    )
    bind({ type: 'entity', entityId: spring.id, property: 'connector.length' }, 'a')
    bind({ type: 'entity', entityId: spring.id, property: 'connector.stiffness' }, '2a')
    bind(
      { type: 'entity', entityId: spring.id, property: 'connector.endpoint.a.localAnchor.x' },
      'a/10',
    )
    bind(
      { type: 'entity', entityId: spring.id, property: 'connector.endpoint.b.position.x' },
      'a/2',
    )
    bind({ type: 'entity', entityId: force.id, property: 'force.localAnchor.x' }, 'a/10')
    bind(
      { type: 'entity', entityId: marker.id, property: 'measurement.marker.lineWidthM' },
      'a/100',
    )
    bind({ type: 'scene', property: 'settings.gridStep' }, 'a/2')

    expect(scene.entities.find((entity) => entity.id === body.id)).toMatchObject({
      shape: { type: 'box', width: 5 },
      transform: { position: { x: 30, y: 0 } },
    })
    expect(scene.entities.find((entity) => entity.id === arc.id)).toMatchObject({
      geometry: { type: 'arc', radius: 5, startRad: Math.PI / 2 },
    })
    expect(scene.entities.find((entity) => entity.id === field.id)).toMatchObject({
      region: { type: 'rectangle', width: 20 },
      field: { type: 'uniformGravity', acceleration: { x: 0, y: -10 } },
    })
    expect(scene.entities.find((entity) => entity.id === source.id)).toMatchObject({
      directionRad: Math.PI / 2,
      spreadRad: Math.PI / 2,
      densityPerDegree: 5,
      continuousEmission: { intervalSeconds: 1 },
    })
    expect(scene.entities.find((entity) => entity.id === spring.id)).toMatchObject({
      a: { type: 'body', localAnchor: { x: 1, y: 0 } },
      b: { type: 'free', position: { x: 5, y: 0 } },
      connector: { type: 'spring', restLength: 10, stiffness: 20 },
    })
    expect(scene.entities.find((entity) => entity.id === force.id)).toMatchObject({
      localAnchor: { x: 1, y: 0 },
    })
    expect(scene.entities.find((entity) => entity.id === marker.id)).toMatchObject({
      measurement: { type: 'marker', lineWidthM: 0.1 },
    })
    expect(scene.settings.gridStep).toBe(5)
    expect(scene.propertyExpressions).toHaveLength(17)
    expect(() =>
      setPropertyExpression(
        scene,
        { type: 'entity', entityId: spring.id, property: 'connector.endpoint.a.localAnchor.x' },
        '10a',
      ),
    ).toThrow('必须位于目标物体内')
  })

  it('步进公式只规范化一个加减偏移，并保持原变量绑定', () => {
    expect(stepPropertyExpressionSource('3a', 1)).toBe('(3a)+1')
    expect(stepPropertyExpressionSource('(3a)+1', 1)).toBe('(3a)+2')
    expect(stepPropertyExpressionSource('(3a)+2', -2)).toBe('3a')

    const scene = createEmptyScene()
    const ball = createBall('', { x: 0, y: 0 }, 0.5, 1)
    scene.entities = [ball]
    scene.rootItems = [{ kind: 'entity', entityId: ball.id }]
    scene.globalVariables = [{ name: 'a', expression: '10', value: 10 }]
    const target = { type: 'entity' as const, entityId: ball.id, property: 'body.massKg' as const }
    const bound = setPropertyExpression(scene, target, '3a')
    const stepped = setPropertyExpression(bound, target, stepPropertyExpressionSource('3a', 1))

    expect(stepped.propertyExpressions[0]?.expression).toBe('(3a)+1')
    expect(stepped.entities[0]).toMatchObject({ massKg: 31 })
  })

  it('拒绝循环式前向引用、重复变量和非法属性结果', () => {
    const scene = createEmptyScene()
    expect(() =>
      recomputePropertyExpressions(scene, [
        { name: 'a', expression: 'b', value: 0 },
        { name: 'b', expression: 'a', value: 0 },
      ]),
    ).toThrow('未知全局变量')
    expect(() =>
      recomputePropertyExpressions(scene, [
        { name: 'a', expression: '1', value: 1 },
        { name: 'a', expression: '2', value: 2 },
      ]),
    ).toThrow('重复')
  })
})
