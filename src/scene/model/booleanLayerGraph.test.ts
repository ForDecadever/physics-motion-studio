import { describe, expect, it } from 'vitest'

import { createEmptyScene } from './createEmptyScene'
import { createBall } from './entityFactories'
import { createBooleanLayer } from './layerFactories'
import {
  findBooleanNode,
  findSceneTreeLocation,
  isTreeItemEffectivelyLocked,
  isTreeItemEffectivelyVisible,
  validateBooleanLayerGraph,
} from './booleanLayerGraph'

describe('统一场景树', () => {
  it('递归定位真实节点并继承父级显示和锁定状态', () => {
    const scene = createEmptyScene()
    const first = createBall('', { x: 0, y: 0 }, 1, 1)
    const second = createBall('', { x: 2, y: 0 }, 1, 2)
    const child = createBooleanLayer('union', '子组合', [
      { kind: 'entity', entityId: first.id },
      { kind: 'entity', entityId: second.id },
    ])
    const root = createBooleanLayer('union', '根组合', [child])
    root.visible = false
    root.locked = true
    scene.entities = [first, second]
    scene.rootItems = [root]

    expect(findBooleanNode(scene.rootItems, child.resultId)).toBe(child)
    expect(findSceneTreeLocation(scene.rootItems, first.id)?.parent).toBe(child)
    expect(isTreeItemEffectivelyVisible(scene.rootItems, child.id)).toBe(false)
    expect(isTreeItemEffectivelyLocked(scene.rootItems, first.id)).toBe(true)
  })

  it('拒绝重复归属、缺失实体和第三个输入', () => {
    const scene = createEmptyScene()
    const body = createBall('', { x: 0, y: 0 }, 1, 1)
    const node = createBooleanLayer('union', '错误组合', [
      { kind: 'entity', entityId: body.id },
      { kind: 'entity', entityId: body.id },
    ])
    node.operands.push({ kind: 'entity', entityId: crypto.randomUUID() })
    scene.entities = [body]
    scene.rootItems = [node]
    const messages = validateBooleanLayerGraph(scene).map((issue) => issue.message)
    expect(messages).toContain('布尔节点最多只能包含两个输入。')
    expect(messages).toContain('同一实体只能在场景树中出现一次。')
    expect(messages).toContain('场景树引用了不存在的实体。')
  })

  it('要求每个实体恰好在树中出现一次', () => {
    const scene = createEmptyScene()
    scene.entities = [createBall('', { x: 0, y: 0 }, 1, 1)]
    expect(validateBooleanLayerGraph(scene)[0]?.message).toBe(
      '每个实体必须在场景树中恰好出现一次。',
    )
  })
})
