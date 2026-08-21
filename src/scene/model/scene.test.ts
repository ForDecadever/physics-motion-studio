import { describe, expect, it } from 'vitest'

import { migrateScene, SceneVersionError } from '../migrations/migrateScene'
import { validateSceneDocument } from '../validation/sceneSchema'
import { createEmptyScene } from './createEmptyScene'
import { createBall, createBezierBlock, createParticleSource } from './entityFactories'
import { createSmoothBezierPathNodes, toggleBezierPathNodeMode } from './bezierPath'
import { createBooleanLayer } from './layerFactories'
import { CURRENT_APP_VERSION, CURRENT_SCHEMA_VERSION } from './types'

describe('v1.5.4 场景格式', () => {
  it('新场景使用 schemaVersion 16 和空根场景树', () => {
    const scene = createEmptyScene('测试')
    expect(scene.schemaVersion).toBe(16)
    expect(scene.appVersion).toBe('1.5.4')
    expect(scene.rootItems).toEqual([])
    expect('layers' in scene).toBe(false)
  })

  it('当前场景树格式可往返校验', () => {
    const scene = createEmptyScene()
    const first = createBall('', { x: 0, y: 0 }, 1, 1)
    const second = createBall('', { x: 2, y: 0 }, 1, 2)
    scene.entities = [first, second]
    scene.rootItems = [
      createBooleanLayer('union', '组合', [
        { kind: 'entity', entityId: first.id },
        { kind: 'entity', entityId: second.id },
      ]),
    ]
    expect(validateSceneDocument(JSON.parse(JSON.stringify(scene)))).toEqual(scene)
  })

  it('钢笔物块使用局部节点往返保存，并拒绝无效轮廓', () => {
    const scene = createEmptyScene()
    const body = createBezierBlock(
      '',
      createSmoothBezierPathNodes([
        { x: -2, y: -1 },
        { x: 2, y: -1 },
        { x: 1, y: 2 },
        { x: -1, y: 1 },
      ]),
      1,
    )
    if (!body) throw new Error('钢笔物块创建失败')
    if (body.shape.type !== 'bezierPath') throw new Error('测试物块轮廓无效')
    body.shape.nodes = toggleBezierPathNodeMode(body.shape.nodes, 0)
    scene.entities = [body]
    scene.rootItems = [{ kind: 'entity', entityId: body.id }]
    const roundTripped = validateSceneDocument(JSON.parse(JSON.stringify(scene)))
    expect(roundTripped).toEqual(scene)
    const roundTrippedBody = roundTripped.entities[0]
    if (roundTrippedBody?.kind !== 'body' || roundTrippedBody.shape.type !== 'bezierPath') {
      throw new Error('往返后的测试物块无效')
    }
    expect(roundTrippedBody.shape.nodes[0]?.collapsedHandles).toBeDefined()

    const invalid = structuredClone(scene)
    const invalidBody = invalid.entities[0]
    if (invalidBody?.kind !== 'body') throw new Error('测试实体无效')
    invalidBody.shape = {
      type: 'bezierPath',
      nodes: createSmoothBezierPathNodes([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ]),
    }
    expect(() => validateSceneDocument(invalid)).toThrow('钢笔物块轮廓面积过小或已经退化')
  })

  it('把 schema 12 布尔节点迁移为来源模式覆盖设置', () => {
    const scene = createEmptyScene()
    const first = createBall('', { x: 0, y: 0 }, 1, 1)
    const second = createBall('', { x: 2, y: 0 }, 1, 2)
    scene.entities = [first, second]
    const node = createBooleanLayer('union', '组合', [
      { kind: 'entity', entityId: first.id },
      { kind: 'entity', entityId: second.id },
    ])
    const legacyNode = { ...node } as Record<string, unknown>
    delete legacyNode.frictionDistribution
    delete legacyNode.restitutionDistribution
    delete legacyNode.initialVelocity
    delete legacyNode.initialAngularVelocity
    const migrated = migrateScene({ ...scene, schemaVersion: 12, rootItems: [legacyNode] })

    expect(validateSceneDocument(migrated).rootItems[0]).toMatchObject({
      frictionDistribution: { mode: 'source' },
      restitutionDistribution: { mode: 'source' },
      initialVelocity: { mode: 'source' },
      initialAngularVelocity: { mode: 'source' },
    })
  })

  it('把 schema 13 和 14 无损迁移到 schema 16', () => {
    const scene = createEmptyScene()
    const migrated13 = migrateScene({ ...scene, schemaVersion: 13 }) as typeof scene
    const migrated14 = migrateScene({ ...scene, schemaVersion: 14 }) as typeof scene

    expect(migrated13.schemaVersion).toBe(16)
    expect(migrated14.schemaVersion).toBe(16)
    expect(migrated13.entities).toEqual(scene.entities)
    expect(migrated14.rootItems).toEqual(scene.rootItems)
  })

  it('拒绝超出物块材质范围的布尔整体摩擦系数', () => {
    const scene = createEmptyScene()
    const first = createBall('', { x: 0, y: 0 }, 1, 1)
    const second = createBall('', { x: 2, y: 0 }, 1, 2)
    const node = createBooleanLayer('union', '组合', [
      { kind: 'entity', entityId: first.id },
      { kind: 'entity', entityId: second.id },
    ])
    node.frictionDistribution = { mode: 'uniform', value: 5.01 }
    scene.entities = [first, second]
    scene.rootItems = [node]

    expect(() => validateSceneDocument(scene)).toThrow('摩擦系数必须在 0 到 5 之间。')
  })

  it('拒绝旧 schema 11，不执行迁移', () => {
    const legacy = { ...createEmptyScene(), schemaVersion: 11 }
    expect(() => migrateScene(legacy)).toThrow(SceneVersionError)
  })

  it('版本常量一致', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(16)
    expect(CURRENT_APP_VERSION).toBe('1.5.4')
  })

  it('粒子源（点/线）可往返校验，并拒绝非法质量', () => {
    const scene = createEmptyScene()
    const pointSource = createParticleSource('', { type: 'point', position: { x: 1, y: 2 } }, 1)
    const lineSource = createParticleSource(
      '',
      { type: 'line', start: { x: 0, y: 0 }, end: { x: 3, y: 0 } },
      2,
    )
    scene.entities = [pointSource, lineSource]
    scene.rootItems = [
      { kind: 'entity', entityId: pointSource.id },
      { kind: 'entity', entityId: lineSource.id },
    ]
    expect(validateSceneDocument(JSON.parse(JSON.stringify(scene)))).toEqual(scene)

    const invalid = structuredClone(scene)
    const invalidSource = invalid.entities[0]
    if (invalidSource?.kind !== 'particleSource') throw new Error('测试实体无效')
    invalidSource.massKg = 0
    expect(() => validateSceneDocument(invalid)).toThrow()
  })
})
