import { describe, expect, it } from 'vitest'

import {
  createArcGround,
  createBezierGround,
  createGroundJoint,
  createLineGround,
} from './entityFactories'
import { resolveGroundEndpoint, resolveGroundJoint } from './groundEndpoints'

const layerId = '00000000-0000-4000-8000-000000000001'

describe('地面连接端点解析', () => {
  it('按语义端点解析直线、圆弧和贝塞尔，而不依赖采样索引', () => {
    const line = createLineGround(layerId, { x: -1, y: 0 }, { x: 0, y: 0 }, 1)
    const arc = createArcGround(layerId, { x: 2, y: 0 }, 1, 0, Math.PI / 2, 2)
    const bezier = createBezierGround(
      layerId,
      { x: 4, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 1 },
      { x: 6, y: 1 },
      3,
    )
    const entities = [line, arc, bezier]

    expect(
      resolveGroundEndpoint(entities, { groundId: line.id, endpoint: 'end' })?.position,
    ).toEqual({
      x: 0,
      y: 0,
    })
    const arcEnd = resolveGroundEndpoint(entities, { groundId: arc.id, endpoint: 'end' })
    expect(arcEnd?.position.x).toBeCloseTo(2)
    expect(arcEnd?.position.y).toBeCloseTo(1)
    expect(arcEnd?.inwardTangent).toEqual(expect.objectContaining({ x: 1 }))
    expect(
      resolveGroundEndpoint(entities, { groundId: bezier.id, endpoint: 'start' })?.inwardTangent,
    ).toEqual({ x: 1, y: 0 })
  })

  it('允许连接相隔一定距离的两个有效端点', () => {
    const first = createLineGround(layerId, { x: -1, y: 0 }, { x: 0, y: 0 }, 1)
    const smooth = createLineGround(layerId, { x: 0, y: 0 }, { x: 1, y: 0 }, 2)
    const angled = createLineGround(layerId, { x: 0, y: 0 }, { x: 0, y: 1 }, 3)
    const separated = createLineGround(layerId, { x: 2, y: 3 }, { x: 4, y: 3 }, 4)
    const makeJoint = (secondId: string, index: number) =>
      createGroundJoint(
        layerId,
        { groundId: first.id, endpoint: 'end' },
        { groundId: secondId, endpoint: 'start' },
        index,
      )

    expect(resolveGroundJoint([first, smooth], makeJoint(smooth.id, 1)).issue).toBeNull()
    expect(resolveGroundJoint([first, angled], makeJoint(angled.id, 2)).issue).toBeNull()
    const resolvedSeparated = resolveGroundJoint([first, separated], makeJoint(separated.id, 3))
    expect(resolvedSeparated.issue).toBeNull()
    expect(resolvedSeparated.gapM).toBeCloseTo(Math.hypot(2, 3))
    expect(resolvedSeparated.position).toEqual({ x: 1, y: 1.5 })
  })

  it('把同地面自连和端点重复占用统一判定为无效', () => {
    const first = createLineGround(layerId, { x: -1, y: 0 }, { x: 0, y: 0 }, 1)
    const second = createLineGround(layerId, { x: 0, y: 0 }, { x: 1, y: 0 }, 2)
    const third = createLineGround(layerId, { x: 0, y: 0 }, { x: 2, y: 0 }, 3)
    const firstJoint = createGroundJoint(
      layerId,
      { groundId: first.id, endpoint: 'end' },
      { groundId: second.id, endpoint: 'start' },
      1,
    )
    const conflictingJoint = createGroundJoint(
      layerId,
      { groundId: first.id, endpoint: 'end' },
      { groundId: third.id, endpoint: 'start' },
      2,
    )
    const sameGroundJoint = createGroundJoint(
      layerId,
      { groundId: first.id, endpoint: 'start' },
      { groundId: first.id, endpoint: 'end' },
      3,
    )

    const entities = [first, second, third, firstJoint, conflictingJoint, sameGroundJoint]
    expect(resolveGroundJoint(entities, firstJoint).issue).toBe('endpoint-conflict')
    expect(resolveGroundJoint(entities, conflictingJoint).issue).toBe('endpoint-conflict')
    expect(resolveGroundJoint(entities, sameGroundJoint).issue).toBe('same-ground')
  })

  it('零长度圆弧的端点没有可用于连接的切线', () => {
    const arc = createArcGround(layerId, { x: 0, y: 0 }, 2, 1, 1, 1)

    expect(resolveGroundEndpoint([arc], { groundId: arc.id, endpoint: 'start' })).toBeNull()
  })
})
