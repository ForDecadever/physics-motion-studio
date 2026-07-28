import { describe, expect, it } from 'vitest'

import { createGroundJoint, createLineGround } from '../../scene/model/entityFactories'
import { buildGroundPathNetwork } from '../../scene/model/groundPath'
import {
  findNearestGroundEndpoint,
  findNearestUnoccupiedGroundEndpoint,
  findTopEntity,
} from './hitTest'

const layerId = '00000000-0000-4000-8000-000000000001'

describe('地面连接点命中', () => {
  it('重合端点第二次查找时可排除第一块地面', () => {
    const first = createLineGround(layerId, { x: -1, y: 0 }, { x: 0, y: 0 }, 1)
    const second = createLineGround(layerId, { x: 0, y: 0 }, { x: 1, y: 0 }, 2)
    const entities = [first, second]
    const initial = findNearestGroundEndpoint(entities, { x: 0, y: 0 }, 0.1)
    expect(initial).not.toBeNull()

    const next = findNearestGroundEndpoint(
      entities,
      { x: 0, y: 0 },
      0.1,
      new Set([initial!.ground.id]),
    )

    expect(next?.ground.id).not.toBe(initial?.ground.id)
    expect(next?.position).toEqual({ x: 0, y: 0 })
  })

  it('画布可以命中独立的地面连接点实体', () => {
    const first = createLineGround(layerId, { x: -1, y: 0 }, { x: 0, y: 0 }, 1)
    const second = createLineGround(layerId, { x: 0, y: 0 }, { x: 1, y: 0 }, 2)
    const joint = createGroundJoint(
      layerId,
      { groundId: first.id, endpoint: 'end' },
      { groundId: second.id, endpoint: 'start' },
      1,
    )

    expect(findTopEntity([first, second, joint], { x: 0, y: 0 }, 0.1)?.id).toBe(joint.id)
  })

  it('画布可以直接命中连接点生成的有限过渡曲线', () => {
    const first = createLineGround(layerId, { x: -4, y: 0 }, { x: 0, y: 0 }, 1)
    const second = createLineGround(layerId, { x: 0, y: 0 }, { x: 0, y: 4 }, 2)
    const joint = createGroundJoint(
      layerId,
      { groundId: first.id, endpoint: 'end' },
      { groundId: second.id, endpoint: 'start' },
      1,
    )
    const entities = [first, second, joint]
    const path = buildGroundPathNetwork(entities).jointPaths.get(joint.id)?.path
    expect(path).not.toBeNull()
    const midpoint = path!.pointAt(path!.length / 2)

    expect(findTopEntity(entities, midpoint, 0.05)?.id).toBe(joint.id)
  })

  it('自动连接会跳过已经占用的最近端点', () => {
    const first = createLineGround(layerId, { x: -1, y: 0 }, { x: 0, y: 0 }, 1)
    const occupiedPartner = createLineGround(layerId, { x: 0, y: 0 }, { x: 1, y: 0 }, 2)
    const available = createLineGround(layerId, { x: 0.06, y: 0 }, { x: 2, y: 0 }, 3)
    const joint = createGroundJoint(
      layerId,
      { groundId: first.id, endpoint: 'end' },
      { groundId: occupiedPartner.id, endpoint: 'start' },
      1,
    )

    const hit = findNearestUnoccupiedGroundEndpoint(
      [first, occupiedPartner, available, joint],
      { x: 0, y: 0 },
      0.1,
    )

    expect(hit?.ground.id).toBe(available.id)
    expect(hit?.reference.endpoint).toBe('start')
  })
})
