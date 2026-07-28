import { describe, expect, it } from 'vitest'

import { createBall, createLineGround } from '../../scene/model/entityFactories'
import { GroundRenderNetworkCache } from './groundNetworkCache'

const layerId = '00000000-0000-4000-8000-000000000001'

describe('地面渲染网络缓存', () => {
  it('只改变运动物体状态时复用网络', () => {
    const ground = createLineGround(layerId, { x: -1, y: 0 }, { x: 1, y: 0 }, 1)
    const ball = createBall(layerId, { x: 0, y: 1 }, 0.5, 1)
    const cache = new GroundRenderNetworkCache()
    const first = cache.resolve([ground, ball], null, null)
    const movedBall = {
      ...ball,
      transform: { ...ball.transform, position: { x: 0.5, y: 0.8 } },
    }
    const second = cache.resolve([ground, movedBall], null, null)

    expect(second).toBe(first)
  })

  it('地面对象或自动连接预览变化时重建网络', () => {
    const ground = createLineGround(layerId, { x: -1, y: 0 }, { x: 1, y: 0 }, 1)
    const draft = createLineGround(layerId, { x: 1, y: 0 }, { x: 2, y: 1 }, 2)
    const endpoint = { groundId: ground.id, endpoint: 'end' as const }
    const cache = new GroundRenderNetworkCache()
    const first = cache.resolve([ground, draft], draft, endpoint)
    const unchanged = cache.resolve([ground, draft], draft, { ...endpoint })
    expect(unchanged).toBe(first)
    expect(first.previewJointId).not.toBeNull()

    const changedDraft = {
      ...draft,
      geometry: { type: 'line' as const, start: { x: 1, y: 0 }, end: { x: 3, y: 1 } },
    }
    const changed = cache.resolve([ground, changedDraft], changedDraft, endpoint)
    expect(changed).not.toBe(first)
    expect(
      changed.network.groundPaths.get(draft.id)?.path.pointAt(Number.POSITIVE_INFINITY),
    ).toEqual({ x: 3, y: 1 })
  })

  it('为手动工具缓存两个相隔端点之间的临时连接预览', () => {
    const first = createLineGround(layerId, { x: -10, y: 0 }, { x: 0, y: 0 }, 1)
    const second = createLineGround(layerId, { x: 3, y: 3 }, { x: 3, y: 13 }, 2)
    const start = { groundId: first.id, endpoint: 'end' as const }
    const hover = { groundId: second.id, endpoint: 'start' as const }
    const cache = new GroundRenderNetworkCache()

    const preview = cache.resolve([first, second], null, null, start, hover)
    const resolved = preview.previewJointId
      ? preview.network.jointPaths.get(preview.previewJointId)
      : null

    expect(preview.previewJointId).not.toBeNull()
    expect(resolved).toMatchObject({ issue: null, kind: 'quintic' })
    expect(resolved?.path).not.toBeNull()
    expect(resolved?.path?.pointAt(0)).toEqual(
      preview.network.groundPaths
        .get(first.id)
        ?.path.pointAt(preview.network.groundPaths.get(first.id)?.path.length ?? 0),
    )
  })
})
