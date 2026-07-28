import { describe, expect, it } from 'vitest'

import { parseSceneText, serializeScene } from '../../persistence/sceneFile'
import { createEmptyScene } from './createEmptyScene'
import {
  createBall,
  createBlock,
  createGroundJoint,
  createLineGround,
  createSpring,
} from './entityFactories'

describe('场景文档', () => {
  it('创建符合规范的空场景', () => {
    const scene = createEmptyScene('测试场景', new Date('2026-07-21T00:00:00.000Z'))
    const parsed = parseSceneText(serializeScene(scene))

    expect(parsed.metadata.name).toBe('测试场景')
    expect(parsed.layers).toHaveLength(1)
    expect(parsed.entities).toEqual([])
    expect(parsed.settings.fixedTimeStep).toBeCloseTo(1 / 120)
    expect(parsed.settings.gridStep).toBe(5)
    expect(parsed.settings.pairwiseElectrostatics).toBe(false)
  })

  it('拒绝来自未来版本的场景', () => {
    const scene = createEmptyScene()
    const futureScene = { ...scene, schemaVersion: 99 }

    expect(() => parseSceneText(JSON.stringify(futureScene))).toThrow('该场景来自更新版本')
  })

  it('把格式 1 逐级迁移到当前格式，并保留未知字段', () => {
    const scene = createEmptyScene()
    const oldSettings: Record<string, unknown> = { ...scene.settings }
    delete oldSettings.recordingSampleRate
    delete oldSettings.recordingDurationSeconds
    const oldScene = {
      ...scene,
      schemaVersion: 1,
      settings: { ...oldSettings, futurePreference: 'preserve-me' },
      futureTopLevel: { enabled: true },
    }

    const migrated = parseSceneText(JSON.stringify(oldScene))

    expect(migrated.schemaVersion).toBe(6)
    expect(migrated.settings.recordingSampleRate).toBe(60)
    expect(migrated.settings.recordingDurationSeconds).toBe(300)
    expect(migrated).toMatchObject({ futureTopLevel: { enabled: true } })
    expect(migrated.settings).toMatchObject({ futurePreference: 'preserve-me' })
  })

  it('把旧质点和点电荷兼容迁移为小球', () => {
    const scene = createEmptyScene()
    const legacy = {
      ...scene,
      schemaVersion: 2,
      entities: [
        {
          ...createBall(scene.layers[0]!.id, { x: 0, y: 0 }, 0.5, 1),
          preset: 'pointCharge',
          shape: { type: 'particle', collisionRadius: 0.15, collisionEnabled: false },
        },
      ],
    }
    const migrated = parseSceneText(JSON.stringify(legacy))
    const body = migrated.entities[0]
    expect(body?.kind).toBe('body')
    if (body?.kind !== 'body') return
    expect(body.preset).toBe('ball')
    expect(body.shape).toEqual(
      expect.objectContaining({ type: 'circle', radius: 0.15, collisionEnabled: false }),
    )
  })

  it('把格式 3 的单面地面迁移为双面碰撞', () => {
    const scene = createEmptyScene()
    const ground = {
      ...createLineGround(scene.layers[0]!.id, { x: -1, y: 0 }, { x: 1, y: 0 }, 1),
      collisionSide: 'normal' as const,
      normalFlipped: true,
    }
    const migrated = parseSceneText(
      JSON.stringify({ ...scene, schemaVersion: 3, appVersion: '0.5.0', entities: [ground] }),
    )

    expect(migrated.schemaVersion).toBe(6)
    expect(migrated.entities[0]).toMatchObject({
      kind: 'ground',
      collisionSide: 'both',
      normalFlipped: false,
    })
  })

  it('当前格式不再接受单面地面配置', () => {
    const scene = createEmptyScene()
    const ground = {
      ...createLineGround(scene.layers[0]!.id, { x: -1, y: 0 }, { x: 1, y: 0 }, 1),
      collisionSide: 'normal',
    }

    expect(() => parseSceneText(JSON.stringify({ ...scene, entities: [ground] }))).toThrow(
      '场景内容不完整',
    )
  })

  it('保存并重新读取地面连接点引用', () => {
    const scene = createEmptyScene()
    const layerId = scene.layers[0]!.id
    const first = createLineGround(layerId, { x: -1, y: 0 }, { x: 0, y: 0 }, 1)
    const second = createLineGround(layerId, { x: 0, y: 0 }, { x: 1, y: 0 }, 2)
    const joint = createGroundJoint(
      layerId,
      { groundId: first.id, endpoint: 'end' },
      { groundId: second.id, endpoint: 'start' },
      1,
    )
    scene.entities = [first, second, joint]

    const parsed = parseSceneText(serializeScene(scene))

    expect(parsed.schemaVersion).toBe(6)
    expect(parsed.entities[2]).toEqual(joint)
  })

  it('把格式 4 的地面连接点迁移为默认自动过渡', () => {
    const scene = createEmptyScene()
    const layerId = scene.layers[0]!.id
    const first = createLineGround(layerId, { x: -1, y: 0 }, { x: 0, y: 0 }, 1)
    const second = createLineGround(layerId, { x: 0, y: 0 }, { x: 1, y: 0 }, 2)
    const joint = createGroundJoint(
      layerId,
      { groundId: first.id, endpoint: 'end' },
      { groundId: second.id, endpoint: 'start' },
      1,
    )
    const legacyJoint: Record<string, unknown> = { ...joint }
    delete legacyJoint.transition

    const parsed = parseSceneText(
      JSON.stringify({
        ...scene,
        schemaVersion: 4,
        appVersion: '0.6.0',
        entities: [first, second, legacyJoint],
      }),
    )

    expect(parsed.schemaVersion).toBe(6)
    expect(parsed.appVersion).toBe('0.8.0')
    expect(parsed.entities[2]).toMatchObject({
      kind: 'groundJoint',
      transition: { mode: 'auto', directionFlipped: false },
    })
  })

  it('格式 5 拒绝缺少过渡配置的地面连接点', () => {
    const scene = createEmptyScene()
    const layerId = scene.layers[0]!.id
    const first = createLineGround(layerId, { x: -1, y: 0 }, { x: 0, y: 0 }, 1)
    const second = createLineGround(layerId, { x: 0, y: 0 }, { x: 1, y: 0 }, 2)
    const joint = createGroundJoint(
      layerId,
      { groundId: first.id, endpoint: 'end' },
      { groundId: second.id, endpoint: 'start' },
      1,
    )
    const invalidJoint: Record<string, unknown> = { ...joint }
    delete invalidJoint.transition

    expect(() =>
      parseSceneText(JSON.stringify({ ...scene, entities: [first, second, invalidJoint] })),
    ).toThrow('场景内容不完整')
  })

  it('新建地面和物体使用安全的零接触参数与零电荷', () => {
    const layerId = createEmptyScene().layers[0]!.id
    const ground = createLineGround(layerId, { x: 0, y: 0 }, { x: 1, y: 0 }, 1)
    const ball = createBall(layerId, { x: 0, y: 1 }, 0.5, 1)
    const block = createBlock(layerId, { x: 2, y: 1 }, 1, 1, 2)

    expect(ground.material).toEqual({ friction: 0, restitution: 0 })
    for (const body of [ball, block]) {
      expect(body.material).toEqual({ friction: 0, restitution: 0 })
      expect(body.chargeC).toBe(0)
      expect(body.rotationEnabled).toBe(true)
    }
  })

  it('读取已有场景时保留物体原有电荷', () => {
    const scene = createEmptyScene()
    const chargedBall = {
      ...createBall(scene.layers[0]!.id, { x: 0, y: 1 }, 0.5, 1),
      chargeC: -2.5,
    }
    scene.entities = [chargedBall]

    const parsed = parseSceneText(serializeScene(scene))
    const body = parsed.entities[0]

    expect(body?.kind).toBe('body')
    if (body?.kind !== 'body') return
    expect(body.chargeC).toBe(-2.5)
  })

  it('新建弹簧默认无阻尼，并在读取场景时保留已有阻尼', () => {
    const scene = createEmptyScene()
    const layerId = scene.layers[0]!.id
    const first = createBall(layerId, { x: -1, y: 0 }, 0.5, 1)
    const second = createBall(layerId, { x: 1, y: 0 }, 0.5, 2)
    const spring = createSpring(layerId, first.id, second.id, 2, 1)

    expect(spring.connector).toMatchObject({ type: 'spring', damping: 0 })
    if (spring.connector.type !== 'spring') return
    spring.connector.damping = 0.75
    scene.entities = [first, second, spring]

    const parsed = parseSceneText(serializeScene(scene))
    const restoredSpring = parsed.entities.find((entity) => entity.kind === 'connector')
    expect(restoredSpring?.kind).toBe('connector')
    if (restoredSpring?.kind !== 'connector' || restoredSpring.connector.type !== 'spring') return
    expect(restoredSpring.connector.damping).toBe(0.75)
  })

  it('把格式 5 的物体迁移为默认开启旋转', () => {
    const scene = createEmptyScene()
    const legacyBody: Record<string, unknown> = {
      ...createBall(scene.layers[0]!.id, { x: 0, y: 1 }, 0.5, 1),
    }
    delete legacyBody.rotationEnabled

    const parsed = parseSceneText(
      JSON.stringify({
        ...scene,
        schemaVersion: 5,
        appVersion: '0.7.0',
        entities: [legacyBody],
      }),
    )
    const body = parsed.entities[0]

    expect(parsed.schemaVersion).toBe(6)
    expect(parsed.appVersion).toBe('0.8.0')
    expect(body?.kind).toBe('body')
    if (body?.kind !== 'body') return
    expect(body.rotationEnabled).toBe(true)
  })

  it('保存并重新读取关闭旋转的物体', () => {
    const scene = createEmptyScene()
    scene.entities = [
      {
        ...createBlock(scene.layers[0]!.id, { x: 0, y: 1 }, 2, 1, 1),
        rotationEnabled: false,
        initialAngularVelocityRad: 3,
      },
    ]

    const parsed = parseSceneText(serializeScene(scene))
    const body = parsed.entities[0]

    expect(body?.kind).toBe('body')
    if (body?.kind !== 'body') return
    expect(body.rotationEnabled).toBe(false)
    expect(body.initialAngularVelocityRad).toBe(3)
  })

  it('当前格式拒绝缺少旋转开关的物体', () => {
    const scene = createEmptyScene()
    const invalidBody: Record<string, unknown> = {
      ...createBall(scene.layers[0]!.id, { x: 0, y: 1 }, 0.5, 1),
    }
    delete invalidBody.rotationEnabled

    expect(() => parseSceneText(JSON.stringify({ ...scene, entities: [invalidBody] }))).toThrow(
      '场景内容不完整',
    )
  })

  it('拒绝非法物理参数', () => {
    const scene = createEmptyScene()
    const invalidScene = {
      ...scene,
      settings: { ...scene.settings, fixedTimeStep: 0 },
    }

    expect(() => parseSceneText(JSON.stringify(invalidScene))).toThrow('场景内容不完整')
  })
})
