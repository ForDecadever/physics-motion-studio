import { describe, expect, it } from 'vitest'

import { createEmptyScene } from '../../scene/model/createEmptyScene'
import {
  createBall,
  createBlock,
  createForce,
  createRulerMeasurement,
} from '../../scene/model/entityFactories'
import {
  createAddEntityCommand,
  createDeleteEntitiesCommand,
  createReplaceEntitiesCommand,
} from './entityCommands'
import { resolveBooleanScene } from '../../scene/model/booleanGeometry'
import { createBooleanLayerCommand } from './booleanLayerCommands'
import { setPropertyExpression } from '../../scene/model/propertyExpressions'

describe('实体与场景树命令', () => {
  it('新建实体同时加入根场景树并支持撤销', () => {
    const scene = createEmptyScene()
    const body = createBall('', { x: 0, y: 0 }, 1, 1)
    const command = createAddEntityCommand(scene, body)
    const after = command.execute(scene)
    expect(after.entities).toContain(body)
    expect(after.rootItems).toContainEqual({ kind: 'entity', entityId: body.id })
    expect(command.undo(after)).toEqual(scene)
  })

  it('只有纯测量标注命令可在运行时安全撤销、修改和删除', () => {
    const scene = createEmptyScene()
    const body = createBall('', { x: 0, y: 0 }, 1, 1)
    const ruler = createRulerMeasurement('', { x: 0, y: 0 }, { x: 1, y: 0 }, 1)
    expect(createAddEntityCommand(scene, body).runtimeSafe).toBe(false)
    const added = createAddEntityCommand(scene, ruler)
    expect(added.runtimeSafe).toBe(true)
    const withRuler = added.execute(scene)
    const movedRuler = {
      ...ruler,
      measurement: { ...ruler.measurement, a: { x: 2, y: 0 } },
    }
    expect(createReplaceEntitiesCommand(withRuler, [movedRuler], '移动直尺').runtimeSafe).toBe(true)
    expect(createDeleteEntitiesCommand(withRuler, [ruler.id])?.runtimeSafe).toBe(true)
  })

  it('删除布尔结果会递归删除整棵来源树和引用', () => {
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
    const force = createForce('', created.resultId, { x: 0, y: 0 }, 1)
    combined.entities.push(force)
    combined.rootItems.push({ kind: 'entity', entityId: force.id })
    combined.propertyExpressions.push({
      id: crypto.randomUUID(),
      target: { type: 'entity', entityId: first.id, property: 'body.massKg' },
      expression: '2',
      fallbackValue: 2,
    })
    const command = createDeleteEntitiesCommand(combined, [created.resultId])!
    const deleted = command.execute(combined)
    expect(deleted.entities).toEqual([])
    expect(deleted.rootItems).toEqual([])
    expect(deleted.propertyExpressions).toEqual([])
    expect(command.undo(deleted)).toEqual(combined)
  })

  it('整体移动布尔结果时连接锚点跟随，来源几何编辑时保持世界位置', () => {
    const scene = createEmptyScene()
    const first = createBall('', { x: -1, y: 0 }, 1, 1)
    const second = createBall('', { x: 1, y: 0 }, 1, 2)
    scene.entities = [first, second]
    scene.rootItems = [
      { kind: 'entity', entityId: first.id },
      { kind: 'entity', entityId: second.id },
    ]
    const created = createBooleanLayerCommand(scene, 'union', [first.id, second.id])
    const combined = created.command.execute(scene)
    const spring = {
      id: crypto.randomUUID(),
      kind: 'connector' as const,
      name: '弹簧',
      visible: true,
      locked: false,
      simulationEnabled: true,
      a: { type: 'body' as const, bodyId: created.resultId, localAnchor: { x: 0, y: 0 } },
      b: { type: 'world' as const, position: { x: 0, y: 4 } },
      connector: { type: 'spring' as const, restLength: 4, stiffness: 20, damping: 0 },
      collisionEnabled: false,
      radiusM: 0.04,
      massKg: 0,
      material: { friction: 0.4, restitution: 0.2 },
    }
    const withSpring = { ...combined, entities: [...combined.entities, spring] }
    const movedSources = withSpring.entities.flatMap((entity) =>
      entity.kind === 'body'
        ? [
            {
              ...entity,
              transform: {
                ...entity.transform,
                position: { x: entity.transform.position.x + 2, y: 0 },
              },
            },
          ]
        : [],
    )
    const moved = createReplaceEntitiesCommand(
      withSpring,
      movedSources,
      '整体移动布尔结果',
      'follow-result',
    ).execute(withSpring)
    const movedResult = resolveBooleanScene(moved).byResultId.get(created.resultId)
    expect(
      movedResult?.valid && movedResult.kind === 'body' && movedResult.centerOfMass.x,
    ).toBeCloseTo(2, 10)
    expect((moved.entities.find((entity) => entity.id === spring.id) as typeof spring).a).toEqual(
      spring.a,
    )

    const edited = createReplaceEntitiesCommand(withSpring, movedSources, '编辑来源').execute(
      withSpring,
    )
    const editedSpring = edited.entities.find((entity) => entity.id === spring.id) as typeof spring
    expect(editedSpring.a.type === 'body' && editedSpring.a.localAnchor.x).toBeCloseTo(-2, 10)
  })

  it('画布修改只解除实际变化的数值绑定，撤销后完整恢复绑定', () => {
    const scene = createEmptyScene()
    const body = createBlock('', { x: 0, y: 0 }, 2, 1, 1)
    scene.entities = [body]
    scene.rootItems = [{ kind: 'entity', entityId: body.id }]
    scene.globalVariables = [{ name: 'a', expression: '2', value: 2 }]
    let bound = setPropertyExpression(
      scene,
      { type: 'entity', entityId: body.id, property: 'transform.position.x' },
      'a',
    )
    bound = setPropertyExpression(
      bound,
      { type: 'entity', entityId: body.id, property: 'body.shape.width' },
      '2a',
    )
    const current = bound.entities[0]
    if (current?.kind !== 'body') throw new Error('测试物块无效')
    const command = createReplaceEntitiesCommand(
      bound,
      [{ ...current, transform: { ...current.transform, position: { x: 7, y: 0 } } }],
      '拖动物块',
    )
    const moved = command.execute(bound)

    expect(moved.propertyExpressions).toMatchObject([
      { target: { type: 'entity', entityId: body.id, property: 'body.shape.width' } },
    ])
    expect(command.undo(moved)).toEqual(bound)
  })
})
