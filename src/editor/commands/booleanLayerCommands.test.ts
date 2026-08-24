import { describe, expect, it } from 'vitest'

import { createEmptyScene } from '../../scene/model/createEmptyScene'
import { createBall, createBlock, createForce } from '../../scene/model/entityFactories'
import { findBooleanNode, sceneTreeItemTargetId } from '../../scene/model/booleanLayerGraph'
import {
  createAddBooleanOperandCommand,
  createBooleanLayerCommand,
  createDissolveBooleanLayerCommand,
  createMoveRootItemCommand,
  createMoveTreeItemToRootCommand,
  createRemoveBooleanOperandCommand,
  createReplaceBooleanNodeCommand,
  createSwapBooleanOperandsCommand,
} from './booleanLayerCommands'
import { setPropertyExpression } from '../../scene/model/propertyExpressions'

function sceneWithTwoBodies() {
  const scene = createEmptyScene()
  const upper = createBlock('', { x: 0, y: 0 }, 2, 2, 1)
  const lower = createBall('', { x: 1, y: 0 }, 1, 2)
  scene.entities = [upper, lower]
  scene.rootItems = [
    { kind: 'entity', entityId: upper.id },
    { kind: 'entity', entityId: lower.id },
  ]
  return { scene, upper, lower }
}

describe('场景树布尔命令', () => {
  it('按根视觉顺序组合两个兼容输入，并完整撤销', () => {
    const { scene, upper, lower } = sceneWithTwoBodies()
    const result = createBooleanLayerCommand(scene, 'union', [lower.id, upper.id])
    const after = result.command.execute(scene)
    const node = after.rootItems[0]

    expect(node?.kind).toBe('boolean')
    expect(node?.kind === 'boolean' && node.operands).toEqual([
      { kind: 'entity', entityId: upper.id },
      { kind: 'entity', entityId: lower.id },
    ])
    expect(result.command.undo(after)).toEqual(scene)
  })

  it('选择不兼容时创建空布尔节点', () => {
    const { scene, upper } = sceneWithTwoBodies()
    const groundLikeId = crypto.randomUUID()
    scene.entities.push({
      id: groundLikeId,
      kind: 'field',
      name: '无限场',
      visible: true,
      locked: false,
      simulationEnabled: true,
      region: { type: 'infinite' },
      field: { type: 'uniformGravity', acceleration: { x: 0, y: -9.8 } },
    })
    scene.rootItems.push({ kind: 'entity', entityId: groundLikeId })
    const result = createBooleanLayerCommand(scene, 'union', [upper.id, groundLikeId])
    const node = findBooleanNode(result.command.execute(scene).rootItems, result.nodeId)
    expect(node?.operands).toEqual([])
  })

  it('支持空节点拖入、交换、移出和根排序', () => {
    const { scene, upper, lower } = sceneWithTwoBodies()
    const created = createBooleanLayerCommand(scene, 'union', [])
    let current = created.command.execute(scene)
    current = createAddBooleanOperandCommand(current, created.nodeId, lower.id)!.execute(current)
    current = createAddBooleanOperandCommand(current, created.nodeId, upper.id)!.execute(current)
    expect(
      findBooleanNode(current.rootItems, created.nodeId)?.operands.map(
        (item) => item.kind === 'entity' && item.entityId,
      ),
    ).toEqual([lower.id, upper.id])

    current = createSwapBooleanOperandsCommand(current, created.nodeId)!.execute(current)
    expect(
      findBooleanNode(current.rootItems, created.nodeId)?.operands.map(
        (item) => item.kind === 'entity' && item.entityId,
      ),
    ).toEqual([upper.id, lower.id])

    current = createRemoveBooleanOperandCommand(current, created.nodeId, 1)!.execute(current)
    expect(
      current.rootItems.some((item) => item.kind === 'entity' && item.entityId === lower.id),
    ).toBe(true)
    expect(createMoveRootItemCommand(current, lower.id, -1)).not.toBeNull()
  })

  it('可把嵌套输入拖回指定根项目旁，并作为一条命令撤销', () => {
    const { scene, upper, lower } = sceneWithTwoBodies()
    const outside = createBall('', { x: 4, y: 0 }, 0.5, 3)
    scene.entities.push(outside)
    scene.rootItems.push({ kind: 'entity', entityId: outside.id })
    const created = createBooleanLayerCommand(scene, 'union', [upper.id, lower.id])
    const combined = created.command.execute(scene)
    const command = createMoveTreeItemToRootCommand(combined, lower.id, outside.id, 'before')!
    const moved = command.execute(combined)

    expect(moved.rootItems.map((item) => sceneTreeItemTargetId(item))).toEqual([
      created.resultId,
      lower.id,
      outside.id,
    ])
    expect(findBooleanNode(moved.rootItems, created.nodeId)?.operands).toEqual([
      { kind: 'entity', entityId: upper.id },
    ])
    expect(command.undo(moved)).toEqual(combined)
  })

  it('解散时上方输入替代节点，下方输入提升为根项', () => {
    const { scene, upper, lower } = sceneWithTwoBodies()
    const created = createBooleanLayerCommand(scene, 'difference', [upper.id, lower.id])
    const combined = created.command.execute(scene)
    const command = createDissolveBooleanLayerCommand(combined, created.nodeId)!
    const dissolved = command.execute(combined)
    expect(dissolved.rootItems).toEqual([
      { kind: 'entity', entityId: upper.id },
      { kind: 'entity', entityId: lower.id },
    ])
    expect(command.undo(dissolved)).toEqual(combined)
  })

  it('组合与解散刚体时保持外加力的世界锚点并重映射目标', () => {
    const { scene, upper, lower } = sceneWithTwoBodies()
    const force = createForce('', upper.id, { x: 0.5, y: -0.25 }, 1)
    scene.entities.push(force)
    const created = createBooleanLayerCommand(scene, 'union', [upper.id, lower.id])
    const combined = created.command.execute(scene)
    const combinedForce = combined.entities.find((entity) => entity.id === force.id)

    expect(combinedForce?.kind).toBe('force')
    expect(combinedForce?.kind === 'force' && combinedForce.bodyId).toBe(created.resultId)

    const command = createDissolveBooleanLayerCommand(combined, created.nodeId)!
    const dissolved = command.execute(combined)
    const dissolvedForce = dissolved.entities.find((entity) => entity.id === force.id)
    expect(dissolvedForce).toMatchObject({
      kind: 'force',
      bodyId: upper.id,
      localAnchor: { x: 0.5, y: -0.25 },
    })
    expect(command.undo(dissolved)).toEqual(combined)
  })

  it('质量覆盖是一条独立可撤销命令', () => {
    const { scene, upper, lower } = sceneWithTwoBodies()
    const created = createBooleanLayerCommand(scene, 'union', [upper.id, lower.id])
    const combined = created.command.execute(scene)
    const node = findBooleanNode(combined.rootItems, created.nodeId)!
    const command = createReplaceBooleanNodeCommand(
      combined,
      { ...node, massDistribution: { mode: 'uniform', totalMassKg: 20 } },
      '修改布尔总质量',
    )
    expect(findBooleanNode(command.execute(combined).rootItems, node.id)?.massDistribution).toEqual(
      { mode: 'uniform', totalMassKg: 20 },
    )
    expect(command.undo(command.execute(combined))).toEqual(combined)
  })

  it('直接修改布尔数值覆盖会解除对应公式，撤销后恢复', () => {
    const { scene, upper, lower } = sceneWithTwoBodies()
    scene.globalVariables = [{ name: 'a', expression: '10', value: 10 }]
    const created = createBooleanLayerCommand(scene, 'union', [upper.id, lower.id])
    const combined = created.command.execute(scene)
    const bound = setPropertyExpression(
      combined,
      { type: 'boolean', nodeId: created.nodeId, property: 'boolean.totalMassKg' },
      '2a',
    )
    const node = findBooleanNode(bound.rootItems, created.nodeId)
    if (!node) throw new Error('测试布尔节点无效')
    const command = createReplaceBooleanNodeCommand(
      bound,
      { ...node, massDistribution: { mode: 'uniform', totalMassKg: 30 } },
      '修改布尔总质量',
    )
    const changed = command.execute(bound)

    expect(changed.propertyExpressions).toEqual([])
    expect(command.undo(changed)).toEqual(bound)
  })
})
