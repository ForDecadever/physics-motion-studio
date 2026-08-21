import { describe, expect, it } from 'vitest'

import {
  createArcGround,
  createGroundJoint,
  createLineGround,
} from '../../scene/model/entityFactories'
import { buildGroundPathNetwork } from '../../scene/model/groundPath'
import { buildGroundCollisionChains } from './groundCollisionChains'

const layerId = 'layer-1'

function connectedRightAngle() {
  const first = createLineGround(layerId, { x: -10, y: 0 }, { x: 0, y: 0 }, 1)
  const second = createLineGround(layerId, { x: 0, y: 0 }, { x: 0, y: 10 }, 2)
  const joint = createGroundJoint(
    layerId,
    { groundId: first.id, endpoint: 'end' },
    { groundId: second.id, endpoint: 'start' },
    1,
  )
  joint.transition = { mode: 'manual', lengthM: 3, directionFlipped: false }
  return { first, second, joint }
}

describe('物块地面碰撞链', () => {
  it('删除直线内部的冗余采样点，避免共线端点产生横向假法线', () => {
    const ground = createLineGround(layerId, { x: -10, y: 0 }, { x: 10, y: 0 }, 1)
    const chains = buildGroundCollisionChains(buildGroundPathNetwork([ground]))

    expect(chains).toHaveLength(1)
    expect(chains[0]?.points).toEqual([
      { x: -10, y: 0 },
      { x: 10, y: 0 },
    ])
  })

  it('把相同材质的地面与过渡拼成一个连续碰撞链', () => {
    const { first, second, joint } = connectedRightAngle()
    const network = buildGroundPathNetwork([first, second, joint])
    const chains = buildGroundCollisionChains(network)

    expect(chains).toHaveLength(1)
    expect(chains[0]?.pieceIds).toHaveLength(4)
    expect(chains[0]?.points.length).toBeGreaterThan(4)
    expect(chains[0]).toMatchObject({ startConnected: false, endConnected: false })
    expect(chains[0]?.points[0]).toMatchObject({ x: -10, y: 0 })
    expect(chains[0]?.points.at(-1)).toMatchObject({ x: 0, y: 10 })
    const longSegments = chains[0]!.points.slice(1).flatMap((point, index) => {
      const previous = chains[0]!.points[index]!
      const dx = point.x - previous.x
      const dy = point.y - previous.y
      return Math.hypot(dx, dy) > 0.101 ? [{ dx, dy }] : []
    })
    expect(longSegments.every(({ dx, dy }) => Math.abs(dx) <= 1e-7 || Math.abs(dy) <= 1e-7)).toBe(
      true,
    )
  })

  it('连接裁剪后的直线仍只生成首尾两个碰撞采样点', () => {
    const { first, second, joint } = connectedRightAngle()
    const network = buildGroundPathNetwork([first, second, joint])

    expect(network.groundPaths.get(first.id)?.path.sample()).toHaveLength(2)
    expect(network.groundPaths.get(second.id)?.path.sample()).toHaveLength(2)
  })

  it('材质发生变化时保留碰撞体边界，避免覆盖各地面的属性', () => {
    const { first, second, joint } = connectedRightAngle()
    second.material = { friction: 0.5, restitution: 0.25 }
    const network = buildGroundPathNetwork([first, second, joint])
    const chains = buildGroundCollisionChains(network)

    expect(chains).toHaveLength(2)
    expect(chains.every((chain) => chain.startConnected || chain.endConnected)).toBe(true)
    expect(chains.map((chain) => chain.material)).toEqual(
      expect.arrayContaining([first.material, second.material]),
    )
  })

  it('完整圆周首尾相接，不把采样起点暴露成物块可撞击的端帽', () => {
    const circle = createArcGround(layerId, { x: 0, y: 0 }, 3, 0, Math.PI * 2, 1)
    const chains = buildGroundCollisionChains(buildGroundPathNetwork([circle]))

    expect(chains).toHaveLength(1)
    expect(chains[0]).toMatchObject({
      closed: true,
      startConnected: true,
      endConnected: true,
    })
    expect(chains[0]?.points[0]).toEqual(chains[0]?.points.at(-1))
  })
})
