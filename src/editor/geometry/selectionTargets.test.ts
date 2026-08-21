import { describe, expect, it } from 'vitest'

import { createEmptyScene } from '../../scene/model/createEmptyScene'
import { createBall, createBlock } from '../../scene/model/entityFactories'
import { createBooleanLayer } from '../../scene/model/layerFactories'
import {
  listEditingSelectionTargets,
  selectionSourceEntityIds,
  selectionTargetBounds,
  selectionTargetsInsideBounds,
} from './selectionTargets'

function booleanScene() {
  const scene = createEmptyScene()
  const upper = createBlock('', { x: 0, y: 0 }, 4, 2, 1)
  const lower = createBall('', { x: 0, y: 1 }, 1, 2)
  const ordinary = createBall('', { x: 5, y: 0 }, 0.5, 3)
  scene.entities = [upper, lower, ordinary]
  scene.rootItems = [
    createBooleanLayer('difference', '圆槽', [
      { kind: 'entity', entityId: upper.id },
      { kind: 'entity', entityId: lower.id },
    ]),
    { kind: 'entity', entityId: ordinary.id },
  ]
  return { scene, upper, lower, ordinary }
}

describe('统一编辑选择目标', () => {
  it('根布尔结果参与完整包含框选，来源对象不重复参与', () => {
    const { scene, upper, lower } = booleanScene()
    const targets = listEditingSelectionTargets(scene, scene.entities)
    expect(targets.map((target) => target.id)).not.toContain(upper.id)
    expect(targets.map((target) => target.id)).not.toContain(lower.id)
    const boolean = scene.rootItems[0]
    expect(boolean?.kind).toBe('boolean')
    const selected = selectionTargetsInsideBounds(targets, { x: -3, y: -2 }, { x: 3, y: 2 })
    expect(selected.map((target) => target.id)).toEqual([
      boolean?.kind === 'boolean' ? boolean.resultId : '',
    ])
  })

  it('混合选择使用普通对象和布尔结果共同包围框', () => {
    const { scene, ordinary } = booleanScene()
    const boolean = scene.rootItems[0]
    const bounds = selectionTargetBounds(
      listEditingSelectionTargets(scene, scene.entities),
      [boolean?.kind === 'boolean' ? boolean.resultId : '', ordinary.id],
      true,
    )
    expect(bounds).toEqual({ minX: -2, minY: -1, maxX: 5.5, maxY: 1 })
  })

  it('混合选择把布尔来源和普通实体合并去重为同一移动组', () => {
    const { scene, upper, lower, ordinary } = booleanScene()
    const boolean = scene.rootItems[0]
    if (boolean?.kind !== 'boolean') throw new Error('测试场景缺少布尔节点')

    expect(
      selectionSourceEntityIds(listEditingSelectionTargets(scene, scene.entities), [
        boolean.resultId,
        ordinary.id,
        boolean.resultId,
      ]),
    ).toEqual([upper.id, lower.id, ordinary.id])
  })

  it('场景树显式选中的布尔来源可单独缩放，父结果同时选中时父节点优先', () => {
    const { scene, upper } = booleanScene()
    const boolean = scene.rootItems[0]
    if (boolean?.kind !== 'boolean') throw new Error('测试场景缺少布尔节点')

    const sourceTargets = listEditingSelectionTargets(
      scene,
      scene.entities,
      {},
      new Set(),
      new Set([upper.id]),
    )
    expect(sourceTargets.find((target) => target.id === upper.id)).toMatchObject({
      kind: 'entity',
      sourceEntityIds: [upper.id],
      scalable: true,
    })

    const parentTargets = listEditingSelectionTargets(
      scene,
      scene.entities,
      {},
      new Set(),
      new Set([boolean.resultId, upper.id]),
    )
    expect(parentTargets.some((target) => target.id === upper.id)).toBe(false)
  })

  it('隐藏和锁定的根布尔结果不参与编辑选择', () => {
    const { scene } = booleanScene()
    const boolean = scene.rootItems[0]
    if (boolean?.kind !== 'boolean') throw new Error('测试场景缺少布尔节点')
    boolean.visible = false
    expect(
      listEditingSelectionTargets(scene, scene.entities).some(
        (target) => target.id === boolean.resultId,
      ),
    ).toBe(false)
    boolean.visible = true
    boolean.locked = true
    expect(
      listEditingSelectionTargets(scene, scene.entities).some(
        (target) => target.id === boolean.resultId,
      ),
    ).toBe(false)
  })
})
