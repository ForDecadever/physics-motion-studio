import { describe, expect, it } from 'vitest'

import { createEmptyScene } from '../../scene/model/createEmptyScene'
import {
  createBall,
  createGroundJoint,
  createLineGround,
  createRope,
} from '../../scene/model/entityFactories'
import { duplicateEntities } from './entityClipboard'

describe('实体复制与粘贴', () => {
  it('生成新 ID、偏移物体，并把连接器重定向到副本', () => {
    const scene = createEmptyScene()
    const layerId = scene.layers[0]?.id
    if (!layerId) throw new Error('测试场景缺少图层')
    const first = createBall(layerId, { x: 0, y: 0 }, 0.5, 1)
    const second = createBall(layerId, { x: 2, y: 0 }, 0.5, 2)
    const rope = createRope(layerId, first.id, second.id, 2, 1)
    let nextId = 0

    const copies = duplicateEntities([first, second, rope], () => `copy-${++nextId}`)
    const firstCopy = copies.find((entity) => entity.id === 'copy-1')
    const ropeCopy = copies.find((entity) => entity.kind === 'connector')

    expect(firstCopy?.kind).toBe('body')
    if (firstCopy?.kind === 'body')
      expect(firstCopy.transform.position).toEqual({ x: 0.2, y: -0.2 })
    if (ropeCopy?.kind !== 'connector') throw new Error('连接器副本缺失')
    expect(ropeCopy.a.bodyId).toBe('copy-1')
    expect(ropeCopy.b.bodyId).toBe('copy-2')
  })

  it('未同时复制两个端点时跳过悬空连接器', () => {
    const scene = createEmptyScene()
    const layerId = scene.layers[0]?.id
    if (!layerId) throw new Error('测试场景缺少图层')
    const first = createBall(layerId, { x: 0, y: 0 }, 0.5, 1)
    const second = createBall(layerId, { x: 2, y: 0 }, 0.5, 2)
    const rope = createRope(layerId, first.id, second.id, 2, 1)

    expect(duplicateEntities([first, rope], () => crypto.randomUUID())).toHaveLength(1)
  })

  it('复制两块地面时重映射地面连接点，缺少一块时跳过连接点', () => {
    const scene = createEmptyScene()
    const layerId = scene.layers[0]?.id
    if (!layerId) throw new Error('测试场景缺少图层')
    const first = createLineGround(layerId, { x: -1, y: 0 }, { x: 0, y: 0 }, 1)
    const second = createLineGround(layerId, { x: 0, y: 0 }, { x: 1, y: 0 }, 2)
    const joint = createGroundJoint(
      layerId,
      { groundId: first.id, endpoint: 'end' },
      { groundId: second.id, endpoint: 'start' },
      1,
    )
    let nextId = 0

    const copies = duplicateEntities([first, second, joint], () => `copy-${++nextId}`)
    const jointCopy = copies.find((entity) => entity.kind === 'groundJoint')

    expect(jointCopy?.kind).toBe('groundJoint')
    if (jointCopy?.kind !== 'groundJoint') return
    expect(jointCopy.a.groundId).toBe('copy-1')
    expect(jointCopy.b.groundId).toBe('copy-2')
    expect(duplicateEntities([first, joint], () => crypto.randomUUID())).toHaveLength(1)
  })
})
