import { describe, expect, it } from 'vitest'

import {
  createBall,
  createGroundJoint,
  createLineGround,
  createRope,
} from '../../scene/model/entityFactories'
import { createEmptyScene } from '../../scene/model/createEmptyScene'
import {
  createAddEntityCommand,
  createDeleteEntitiesCommand,
  createReplaceEntitiesCommand,
  createReplaceSceneSettingsCommand,
} from './entityCommands'

describe('实体命令', () => {
  it('创建命令可以执行和撤销', () => {
    const scene = createEmptyScene()
    const layerId = scene.layers[0]?.id
    expect(layerId).toBeTruthy()
    if (!layerId) return
    const ball = createBall(layerId, { x: 1, y: 2 }, 0.5, 1)
    const command = createAddEntityCommand(scene, ball)

    const after = command.execute(scene)
    expect(after.entities).toEqual([ball])
    expect(command.undo(after).entities).toEqual([])
  })

  it('删除物体时一起删除依赖的连接器', () => {
    const scene = createEmptyScene()
    const layerId = scene.layers[0]?.id
    if (!layerId) return
    const first = createBall(layerId, { x: 0, y: 0 }, 0.5, 1)
    const second = createBall(layerId, { x: 2, y: 0 }, 0.5, 2)
    const rope = createRope(layerId, first.id, second.id, 2, 1)
    const populated = { ...scene, entities: [first, second, rope] }
    const command = createDeleteEntitiesCommand(populated, [first.id])

    expect(command).not.toBeNull()
    expect(command?.execute(populated).entities).toEqual([second])
    expect(command?.undo(populated).entities).toEqual([first, second, rope])
  })

  it('删除地面时一起删除依赖的地面连接点，并可撤销恢复', () => {
    const scene = createEmptyScene()
    const layerId = scene.layers[0]?.id
    if (!layerId) return
    const first = createLineGround(layerId, { x: -1, y: 0 }, { x: 0, y: 0 }, 1)
    const second = createLineGround(layerId, { x: 0, y: 0 }, { x: 1, y: 0 }, 2)
    const joint = createGroundJoint(
      layerId,
      { groundId: first.id, endpoint: 'end' },
      { groundId: second.id, endpoint: 'start' },
      1,
    )
    const populated = { ...scene, entities: [first, second, joint] }
    const command = createDeleteEntitiesCommand(populated, [first.id])

    expect(command?.execute(populated).entities).toEqual([second])
    expect(command?.undo(populated).entities).toEqual([first, second, joint])
  })

  it('隐藏对象只改变显示状态，不会关闭物理参与', () => {
    const scene = createEmptyScene()
    const layerId = scene.layers[0]?.id
    if (!layerId) return
    const ball = createBall(layerId, { x: 0, y: 0 }, 0.5, 1)
    const populated = { ...scene, entities: [ball] }
    const command = createReplaceEntitiesCommand(
      populated,
      [{ ...ball, visible: false }],
      '隐藏对象',
    )

    const [hidden] = command.execute(populated).entities
    expect(hidden?.visible).toBe(false)
    expect(hidden?.simulationEnabled).toBe(true)
    expect(command.undo(populated).entities).toEqual([ball])
  })

  it('场景级物体静电作用开关可以撤销', () => {
    const scene = createEmptyScene()
    const command = createReplaceSceneSettingsCommand(
      scene,
      { ...scene.settings, pairwiseElectrostatics: true },
      '开启物体间静电作用',
    )

    const after = command.execute(scene)
    expect(after.settings.pairwiseElectrostatics).toBe(true)
    expect(command.undo(after).settings.pairwiseElectrostatics).toBe(false)
  })
})
