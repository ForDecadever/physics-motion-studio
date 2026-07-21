import { describe, expect, it } from 'vitest'

import { createBall, createRope } from '../../scene/model/entityFactories'
import { createEmptyScene } from '../../scene/model/createEmptyScene'
import { createAddEntityCommand, createDeleteEntitiesCommand } from './entityCommands'

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
})
