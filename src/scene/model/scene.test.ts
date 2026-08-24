import { describe, expect, it } from 'vitest'

import { migrateScene, SceneVersionError } from '../migrations/migrateScene'
import { validateSceneDocument } from '../validation/sceneSchema'
import { createEmptyScene } from './createEmptyScene'
import {
  createBall,
  createBezierBlock,
  createElectricField,
  createForce,
  createLineGround,
  createMarkerMeasurement,
  createParticleSource,
  createProtractorMeasurement,
  createRulerMeasurement,
} from './entityFactories'
import { createSmoothBezierPathNodes, toggleBezierPathNodeMode } from './bezierPath'
import { createBooleanLayer } from './layerFactories'
import { evaluateFieldDefinition } from './fieldExpressions'
import { compileScalarExpression } from '../expressions/scalarExpression'
import { CURRENT_APP_VERSION, CURRENT_SCHEMA_VERSION } from './types'

describe('schema 22 场景格式', () => {
  it('新场景使用 schemaVersion 22、空变量和空根场景树', () => {
    const scene = createEmptyScene('测试')
    expect(scene.schemaVersion).toBe(22)
    expect(scene.appVersion).toBe('1.6.2')
    expect(scene.rootItems).toEqual([])
    expect(scene.globalVariables).toEqual([])
    expect(scene.propertyExpressions).toEqual([])
    expect('layers' in scene).toBe(false)
  })

  it('记号、直尺与量角器可往返校验，并且永不参与模拟', () => {
    const scene = createEmptyScene()
    const marker = createMarkerMeasurement(
      '',
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      1,
    )
    const ruler = createRulerMeasurement('', { x: 0, y: 0 }, { x: 3, y: 4 }, 2)
    const protractor = createProtractorMeasurement(
      '',
      { x: 1, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      3,
    )
    scene.entities = [marker, ruler, protractor]
    scene.rootItems = scene.entities.map((entity) => ({
      kind: 'entity' as const,
      entityId: entity.id,
    }))

    expect(validateSceneDocument(JSON.parse(JSON.stringify(scene)))).toEqual(scene)

    const enabled = structuredClone(scene) as unknown as {
      entities: Array<{ simulationEnabled: boolean }>
    }
    enabled.entities[0]!.simulationEnabled = true
    expect(() => validateSceneDocument(enabled)).toThrow()

    const tooShort = structuredClone(scene)
    const invalidMarker = tooShort.entities[0]
    if (invalidMarker?.kind !== 'measurement' || invalidMarker.measurement.type !== 'marker') {
      throw new Error('测试记号无效')
    }
    invalidMarker.measurement.points = [{ x: 0, y: 0 }]
    expect(() => validateSceneDocument(tooShort)).toThrow()
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

  it('全局变量、属性公式、时变场与外加力可往返校验', () => {
    const scene = createEmptyScene()
    const body = createBall('', { x: 0, y: 0 }, 1, 1)
    const force = createForce('', body.id, { x: 0, y: 0 }, 1)
    force.magnitudeExpression = { expression: 'a+t', fallbackValue: 10 }
    force.directionDegreesExpression = { expression: '90+10*t', fallbackValue: 90 }
    const field = {
      id: crypto.randomUUID(),
      kind: 'field' as const,
      name: '时变磁场',
      visible: true,
      locked: false,
      simulationEnabled: true,
      region: { type: 'infinite' as const },
      field: {
        type: 'uniformMagnetic' as const,
        bzTesla: 10,
        magnitudeExpression: { expression: 'a*cos(t)', fallbackValue: 10 },
      },
    }
    body.massKg = 30
    scene.globalVariables = [{ name: 'a', expression: '10', value: 10 }]
    scene.propertyExpressions = [
      {
        id: crypto.randomUUID(),
        target: { type: 'entity', entityId: body.id, property: 'body.massKg' },
        expression: '3a',
        fallbackValue: 30,
      },
    ]
    scene.entities = [body, field, force]
    scene.rootItems = [body, field, force].map((entity) => ({
      kind: 'entity' as const,
      entityId: entity.id,
    }))

    expect(validateSceneDocument(JSON.parse(JSON.stringify(scene)))).toEqual(scene)
    const invalid = structuredClone(scene)
    const invalidForce = invalid.entities.find((entity) => entity.kind === 'force')
    if (invalidForce?.kind !== 'force') throw new Error('测试外加力无效')
    invalidForce.magnitudeExpression = { expression: 'globalThis.alert(1)', fallbackValue: 0 }
    expect(() => validateSceneDocument(invalid)).toThrow()

    const invalidTarget = structuredClone(scene) as unknown as {
      propertyExpressions: Array<{ target: { property: string } }>
    }
    invalidTarget.propertyExpressions[0]!.target.property = 'body.__proto__.massKg'
    expect(() => validateSceneDocument(invalidTarget)).toThrow()
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
    delete legacyNode.fieldDistribution
    const migrated = migrateScene({ ...scene, schemaVersion: 12, rootItems: [legacyNode] })

    expect(validateSceneDocument(migrated).rootItems[0]).toMatchObject({
      frictionDistribution: { mode: 'source' },
      restitutionDistribution: { mode: 'source' },
      initialVelocity: { mode: 'source' },
      initialAngularVelocity: { mode: 'source' },
      fieldDistribution: { mode: 'source' },
    })
  })

  it('把 schema 13 到 19 依次迁移到 schema 22', () => {
    const scene = createEmptyScene()
    const migrated13 = migrateScene({ ...scene, schemaVersion: 13 }) as typeof scene
    const migrated14 = migrateScene({ ...scene, schemaVersion: 14 }) as typeof scene
    const migrated15 = migrateScene({ ...scene, schemaVersion: 15 }) as typeof scene
    const legacyBall = createBall('', { x: 0, y: 0 }, 1, 1)
    const legacySource = createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 1)
    const legacyBallRecord = { ...legacyBall } as Partial<typeof legacyBall>
    const legacySourceRecord = { ...legacySource } as Partial<typeof legacySource>
    delete legacyBallRecord.color
    delete legacySourceRecord.spreadRad
    const migrated16 = migrateScene({
      ...scene,
      schemaVersion: 16,
      entities: [legacyBallRecord, legacySourceRecord],
      rootItems: [
        { kind: 'entity', entityId: legacyBall.id },
        { kind: 'entity', entityId: legacySource.id },
      ],
    }) as typeof scene
    const legacyGround = createLineGround('', { x: -1, y: 0 }, { x: 1, y: 0 }, 1)
    const legacyGroundRecord = { ...legacyGround } as Partial<typeof legacyGround>
    delete legacyGroundRecord.conveyor
    const migrated17 = migrateScene({
      ...scene,
      schemaVersion: 17,
      entities: [legacyGroundRecord],
      rootItems: [{ kind: 'entity', entityId: legacyGround.id }],
    }) as typeof scene
    const migrated18 = migrateScene({
      ...scene,
      schemaVersion: 18,
      globalVariables: undefined,
      propertyExpressions: undefined,
    }) as typeof scene
    const migrated19 = migrateScene({ ...scene, schemaVersion: 19 }) as typeof scene

    expect(migrated13.schemaVersion).toBe(22)
    expect(migrated14.schemaVersion).toBe(22)
    expect(migrated15.schemaVersion).toBe(22)
    expect(migrated16.schemaVersion).toBe(22)
    expect(migrated17.schemaVersion).toBe(22)
    expect(migrated18.schemaVersion).toBe(22)
    expect(migrated19.schemaVersion).toBe(22)
    expect(migrated13.entities).toEqual(scene.entities)
    expect(migrated14.rootItems).toEqual(scene.rootItems)
    expect(migrated16.entities).toMatchObject([
      { kind: 'body', color: '#e45d68' },
      { kind: 'particleSource', spreadRad: 0 },
    ])
    expect(migrated17.entities).toMatchObject([
      {
        kind: 'ground',
        conveyor: { enabled: false, direction: 'forward', speedMps: 1 },
      },
    ])
    expect(migrated18.globalVariables).toEqual([])
    expect(migrated18.propertyExpressions).toEqual([])
  })

  it('把 schema 20 的粒子源、电场和力方向公式确定性迁移到 schema 21', () => {
    const scene = createEmptyScene()
    const body = createBall('', { x: 0, y: 0 }, 1, 1)
    const source = createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 1)
    const electric = createElectricField('', { x: 0, y: 0 }, 4, 4, 1)
    const otherElectric = createElectricField('', { x: 0, y: 0 }, 2, 2, 2)
    electric.field = { type: 'uniformElectric', strength: { x: 3, y: 4 } }
    const force = createForce('', body.id, { x: 0, y: 0 }, 1)
    const legacySource = { ...source } as Record<string, unknown>
    delete legacySource.densityPerDegree
    delete legacySource.continuousEmission
    const legacyElectric = structuredClone(electric) as unknown as Record<string, unknown>
    ;(legacyElectric.field as Record<string, unknown>).magnitudeExpression = {
      expression: '10+t',
      fallbackValue: 10,
    }
    const legacyForce = { ...force } as unknown as Record<string, unknown>
    legacyForce.directionExpression = { expression: 'pi/2+t', fallbackValue: Math.PI / 2 }
    const booleanNode = createBooleanLayer('intersection', '电场交集', [
      { kind: 'entity', entityId: electric.id },
      { kind: 'entity', entityId: otherElectric.id },
    ])
    booleanNode.fieldDistribution = {
      mode: 'uniform',
      field: { type: 'uniformElectric', strength: { x: 0, y: 2 } },
    }
    const legacyBooleanNode = structuredClone(booleanNode) as unknown as Record<string, unknown>
    const legacyBooleanDistribution = legacyBooleanNode.fieldDistribution as Record<string, unknown>
    ;(legacyBooleanDistribution.field as Record<string, unknown>).magnitudeExpression = {
      expression: '5+t',
      fallbackValue: 5,
    }
    const migrated = validateSceneDocument(
      migrateScene({
        ...scene,
        schemaVersion: 20,
        entities: [body, legacySource, legacyElectric, otherElectric, legacyForce],
        rootItems: [
          { kind: 'entity', entityId: body.id },
          { kind: 'entity', entityId: source.id },
          { kind: 'entity', entityId: force.id },
          legacyBooleanNode,
        ],
      }),
    )

    const migratedSource = migrated.entities.find((entity) => entity.id === source.id)
    expect(migratedSource).toMatchObject({
      densityPerDegree: 3,
      continuousEmission: {
        enabled: false,
        simultaneous: false,
        intervalSeconds: 1,
        lifetimeSeconds: 60,
      },
    })
    const migratedElectric = migrated.entities.find((entity) => entity.id === electric.id)
    if (migratedElectric?.kind !== 'field') throw new Error('迁移后的电场无效')
    const evaluatedElectric = evaluateFieldDefinition(migratedElectric.field, 2, {})
    if (evaluatedElectric?.type !== 'uniformElectric') throw new Error('迁移后的电场公式无效')
    expect(evaluatedElectric.strength.x).toBeCloseTo(7.2, 12)
    expect(evaluatedElectric.strength.y).toBeCloseTo(9.6, 12)
    const migratedForce = migrated.entities.find((entity) => entity.id === force.id)
    if (migratedForce?.kind !== 'force') throw new Error('迁移后的力无效')
    expect(migratedForce.directionDegreesExpression?.fallbackValue).toBeCloseTo(90)
    const directionDegrees = compileScalarExpression(
      migratedForce.directionDegreesExpression?.expression ?? '',
      { allowTime: true },
    ).evaluate({ time: 0.25, variables: {} })
    expect(((directionDegrees ?? 0) * Math.PI) / 180).toBeCloseTo(Math.PI / 2 + 0.25, 12)
    const migratedBoolean = migrated.rootItems.find((item) => item.kind === 'boolean')
    if (
      migratedBoolean?.kind !== 'boolean' ||
      migratedBoolean.fieldDistribution.mode !== 'uniform'
    ) {
      throw new Error('迁移后的布尔电场无效')
    }
    const booleanField = evaluateFieldDefinition(migratedBoolean.fieldDistribution.field, 1, {})
    if (booleanField?.type !== 'uniformElectric') throw new Error('布尔电场公式迁移失败')
    expect(booleanField.strength.x).toBeCloseTo(0, 12)
    expect(booleanField.strength.y).toBeCloseTo(6, 12)
  })

  it('把 schema 21 粒子源迁移到 schema 22 并保留逐个连续发射行为', () => {
    const scene = createEmptyScene()
    const source = createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 1)
    const legacySource = structuredClone(source) as unknown as Record<string, unknown>
    const legacyContinuous = legacySource.continuousEmission as Record<string, unknown>
    delete legacyContinuous.simultaneous

    const migrated = validateSceneDocument(
      migrateScene({
        ...scene,
        schemaVersion: 21,
        entities: [legacySource],
        rootItems: [{ kind: 'entity', entityId: source.id }],
      }),
    )

    expect(migrated.schemaVersion).toBe(22)
    expect(migrated.entities[0]).toMatchObject({
      kind: 'particleSource',
      continuousEmission: { simultaneous: false },
    })
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
    expect(CURRENT_SCHEMA_VERSION).toBe(22)
    expect(CURRENT_APP_VERSION).toBe('1.6.2')
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
