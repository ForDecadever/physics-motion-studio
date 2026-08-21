import { describe, expect, it } from 'vitest'

import { createBooleanLayerCommand } from '../commands/booleanLayerCommands'
import { createEmptyScene } from '../../scene/model/createEmptyScene'
import { createBall, createSpring } from '../../scene/model/entityFactories'
import { collectSceneClipboard, duplicateSceneClipboard } from './entityClipboard'

describe('统一树剪贴板', () => {
  it('复制根布尔结果会复制完整子树并重映射全部 ID', () => {
    const scene = createEmptyScene()
    const first = createBall('', { x: 0, y: 0 }, 1, 1)
    const second = createBall('', { x: 2, y: 0 }, 1, 2)
    scene.entities = [first, second]
    scene.rootItems = [
      { kind: 'entity', entityId: first.id },
      { kind: 'entity', entityId: second.id },
    ]
    const created = createBooleanLayerCommand(scene, 'union', [first.id, second.id])
    const combined = created.command.execute(scene)
    const payload = collectSceneClipboard(combined, [created.resultId])
    const copied = duplicateSceneClipboard(
      payload,
      (() => {
        let index = 100
        return () => `00000000-0000-4000-8000-${String(index++).padStart(12, '0')}`
      })(),
    )

    expect(payload.rootItems).toHaveLength(1)
    expect(copied.rootItems).toHaveLength(1)
    expect(copied.entities).toHaveLength(2)
    expect(copied.selectedIds[0]).not.toBe(created.resultId)
    expect(copied.rootItems[0]?.kind).toBe('boolean')
  })

  it('单独复制来源会生成普通根对象', () => {
    const scene = createEmptyScene()
    const body = createBall('', { x: 0, y: 0 }, 1, 1)
    scene.entities = [body]
    scene.rootItems = [{ kind: 'entity', entityId: body.id }]
    const copied = duplicateSceneClipboard(collectSceneClipboard(scene, [body.id]))
    expect(copied.rootItems).toEqual([{ kind: 'entity', entityId: copied.entities[0]?.id }])
  })

  it('复制完整连接两端时会把连接器一并加入根场景树', () => {
    const scene = createEmptyScene()
    const first = createBall('', { x: -1, y: 0 }, 1, 1)
    const second = createBall('', { x: 1, y: 0 }, 1, 2)
    const spring = createSpring('', first.id, second.id, 2, 1)
    scene.entities = [first, second, spring]
    scene.rootItems = [first, second, spring].map((entity) => ({
      kind: 'entity' as const,
      entityId: entity.id,
    }))

    const payload = collectSceneClipboard(scene, [first.id, second.id])
    const copied = duplicateSceneClipboard(payload)

    expect(payload.rootItems.map((item) => item.kind === 'entity' && item.entityId)).toEqual([
      first.id,
      second.id,
      spring.id,
    ])
    expect(copied.entities.find((entity) => entity.kind === 'connector')?.name).toBe('弹簧 1 副本')
    expect(copied.rootItems).toHaveLength(3)
  })
})
