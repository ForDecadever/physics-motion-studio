import { describe, expect, it } from 'vitest'

import { createBall } from '../../scene/model/entityFactories'
import type { RuntimeBodyState } from '../../physics/worker/messages'
import { resolveRenderedEntity } from './renderEntityState'

describe('resolveRenderedEntity', () => {
  it('编辑预览优先于模拟运行时位置', () => {
    const body = createBall('layer-1', { x: 0, y: 0 }, 0.5, 1)
    const runtime: RuntimeBodyState = {
      entityId: body.id,
      position: { x: 1, y: 1 },
      angleRad: 0.25,
      linearVelocity: { x: 0, y: 0 },
      angularVelocityRad: 0,
    }
    const preview = {
      ...body,
      transform: { position: { x: 2, y: 3 }, angleRad: 0.75 },
    }

    const rendered = resolveRenderedEntity(body, { [body.id]: runtime }, { [body.id]: preview })

    expect(rendered.kind).toBe('body')
    if (rendered.kind !== 'body') return
    expect(rendered.transform).toEqual(preview.transform)
  })

  it('没有编辑预览时使用模拟运行时位置', () => {
    const body = createBall('layer-1', { x: 0, y: 0 }, 0.5, 1)
    const runtime: RuntimeBodyState = {
      entityId: body.id,
      position: { x: 4, y: 5 },
      angleRad: 1.25,
      linearVelocity: { x: 0, y: 0 },
      angularVelocityRad: 0,
    }

    const rendered = resolveRenderedEntity(body, { [body.id]: runtime }, {})

    expect(rendered.kind).toBe('body')
    if (rendered.kind !== 'body') return
    expect(rendered.transform).toEqual({ position: runtime.position, angleRad: runtime.angleRad })
  })
})
