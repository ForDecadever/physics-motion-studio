import { describe, expect, it } from 'vitest'

import { createEmptyScene } from '../../scene/model/createEmptyScene'
import { createBall } from '../../scene/model/entityFactories'
import {
  createAddEntityCommand,
  createDeleteEntitiesCommand,
  createReplaceEntitiesCommand,
} from './entityCommands'
import { resolveBooleanScene } from '../../scene/model/booleanGeometry'
import { createBooleanLayerCommand } from './booleanLayerCommands'

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
    const command = createDeleteEntitiesCommand(combined, [created.resultId])!
    const deleted = command.execute(combined)
    expect(deleted.entities).toEqual([])
    expect(deleted.rootItems).toEqual([])
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
})
