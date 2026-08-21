import { describe, expect, it } from 'vitest'

import { createAddEntityCommand } from '../commands/entityCommands'
import {
  createArcGround,
  createBezierGround,
  createGroundJoint,
  createLineGround,
} from '../../scene/model/entityFactories'
import { createEmptyScene } from '../../scene/model/createEmptyScene'
import { createGroundWithAutoJoint, resolveGroundCreationStart } from './autoGroundJoint'

describe('自动地面连接', () => {
  it('把新地面和连接点作为同一次命令创建与撤销', () => {
    const empty = createEmptyScene()
    const layerId = ''
    const existing = createLineGround(layerId, { x: -2, y: 0 }, { x: 0, y: 0 }, 1)
    const scene = { ...empty, entities: [existing] }
    const created = createLineGround(layerId, { x: 0, y: 0 }, { x: 2, y: 1 }, 2)
    const additions = createGroundWithAutoJoint(scene, created, {
      groundId: existing.id,
      endpoint: 'end',
    })

    expect(additions).toHaveLength(2)
    expect(additions[0]).toBe(created)
    expect(additions[1]).toMatchObject({
      kind: 'groundJoint',
      a: { groundId: existing.id, endpoint: 'end' },
      b: { groundId: created.id, endpoint: 'start' },
    })

    const command = createAddEntityCommand(scene, additions)
    const after = command.execute(scene)
    expect(after.entities).toHaveLength(3)
    expect(command.undo(after).entities).toEqual([existing])
  })

  it('近同向的新地面不会自动创建无意义连接点', () => {
    const empty = createEmptyScene()
    const layerId = ''
    const existing = createLineGround(layerId, { x: -2, y: 0 }, { x: 0, y: 0 }, 1)
    const scene = { ...empty, entities: [existing] }
    const collinear = createLineGround(layerId, { x: 0, y: 0 }, { x: 2, y: 0 }, 2)

    expect(
      createGroundWithAutoJoint(scene, collinear, {
        groundId: existing.id,
        endpoint: 'end',
      }),
    ).toEqual([collinear])
  })

  it('为重合且反向的端点保留无形直接接缝', () => {
    const empty = createEmptyScene()
    const layerId = ''
    const existing = createLineGround(layerId, { x: -2, y: 0 }, { x: 0, y: 0 }, 1)
    const scene = { ...empty, entities: [existing] }
    const reverse = createLineGround(layerId, { x: 0, y: 0 }, { x: -2, y: 0 }, 2)

    const additions = createGroundWithAutoJoint(scene, reverse, {
      groundId: existing.id,
      endpoint: 'end',
    })

    expect(additions).toHaveLength(2)
    expect(additions[0]).toBe(reverse)
    expect(additions[1]).toMatchObject({
      kind: 'groundJoint',
      a: { groundId: existing.id, endpoint: 'end' },
      b: { groundId: reverse.id, endpoint: 'start' },
    })
  })

  it('端点在提交前被占用时只创建地面', () => {
    const empty = createEmptyScene()
    const layerId = ''
    const existing = createLineGround(layerId, { x: -2, y: 0 }, { x: 0, y: 0 }, 1)
    const partner = createLineGround(layerId, { x: 0, y: 0 }, { x: 1, y: 0 }, 2)
    const occupied = createGroundJoint(
      layerId,
      { groundId: existing.id, endpoint: 'end' },
      { groundId: partner.id, endpoint: 'start' },
      1,
    )
    const scene = { ...empty, entities: [existing, partner, occupied] }
    const created = createLineGround(layerId, { x: 0, y: 0 }, { x: 2, y: 0 }, 3)

    expect(
      createGroundWithAutoJoint(scene, created, {
        groundId: existing.id,
        endpoint: 'end',
      }),
    ).toEqual([created])
  })

  it('使用 10 屏幕像素阈值，并让端点吸附优先于网格吸附', () => {
    const layerId = ''
    const existing = createLineGround(layerId, { x: -2, y: 0 }, { x: 0, y: 0 }, 1)

    const nearAtLowZoom = resolveGroundCreationStart({
      entities: [existing],
      rawWorld: { x: 0.2, y: 0 },
      fallbackWorld: { x: 1, y: 0 },
      pixelsPerMeter: 20,
      enabled: true,
      bypassSnap: false,
    })
    expect(nearAtLowZoom).toEqual({
      startWorld: { x: 0, y: 0 },
      pendingEndpoint: { groundId: existing.id, endpoint: 'end' },
    })

    const farAtHighZoom = resolveGroundCreationStart({
      entities: [existing],
      rawWorld: { x: 0.2, y: 0 },
      fallbackWorld: { x: 1, y: 0 },
      pixelsPerMeter: 100,
      enabled: true,
      bypassSnap: false,
    })
    expect(farAtHighZoom).toEqual({ startWorld: { x: 1, y: 0 }, pendingEndpoint: null })
  })

  it('Alt 与关闭开关都会绕过自动端点连接', () => {
    const layerId = ''
    const existing = createLineGround(layerId, { x: -2, y: 0 }, { x: 0, y: 0 }, 1)
    const base = {
      entities: [existing],
      rawWorld: { x: 0.05, y: 0 },
      fallbackWorld: { x: 0.05, y: 0 },
      pixelsPerMeter: 20,
    }

    expect(resolveGroundCreationStart({ ...base, enabled: true, bypassSnap: true })).toEqual({
      startWorld: base.fallbackWorld,
      pendingEndpoint: null,
    })
    expect(resolveGroundCreationStart({ ...base, enabled: false, bypassSnap: false })).toEqual({
      startWorld: base.fallbackWorld,
      pendingEndpoint: null,
    })
  })

  it('贝塞尔地面也与自动连接点原子创建', () => {
    const empty = createEmptyScene()
    const layerId = ''
    const existing = createLineGround(layerId, { x: -2, y: 0 }, { x: 0, y: 0 }, 1)
    const scene = { ...empty, entities: [existing] }
    const bezier = createBezierGround(
      layerId,
      { x: 0, y: 0 },
      { x: 0.6, y: 0.4 },
      { x: 1.4, y: 1 },
      { x: 2, y: 1 },
      2,
    )
    const additions = createGroundWithAutoJoint(scene, bezier, {
      groundId: existing.id,
      endpoint: 'end',
    })
    const command = createAddEntityCommand(scene, additions)

    expect(additions.map((entity) => entity.kind)).toEqual(['ground', 'groundJoint'])
    expect(command.execute(scene).entities).toHaveLength(3)
    expect(command.undo(command.execute(scene)).entities).toEqual([existing])
  })

  it('圆弧地面也可从捕获的端点自动连接', () => {
    const empty = createEmptyScene()
    const layerId = ''
    const existing = createLineGround(layerId, { x: -10, y: 0 }, { x: 0, y: 0 }, 1)
    const scene = { ...empty, entities: [existing] }
    const arc = createArcGround(layerId, { x: 5, y: 0 }, 5, Math.PI, Math.PI * 2, 2)
    const additions = createGroundWithAutoJoint(scene, arc, {
      groundId: existing.id,
      endpoint: 'end',
    })

    expect(additions.map((entity) => entity.kind)).toEqual(['ground', 'groundJoint'])
    expect(additions[1]).toMatchObject({
      b: { groundId: arc.id, endpoint: 'start' },
    })
  })

  it('隐藏或锁定地面不会成为自动连接候选', () => {
    const layerId = ''
    const visible = createLineGround(layerId, { x: -2, y: 0 }, { x: 0, y: 0 }, 1)
    const request = {
      rawWorld: { x: 0.01, y: 0 },
      fallbackWorld: { x: 1, y: 0 },
      pixelsPerMeter: 20,
      enabled: true,
      bypassSnap: false,
    }

    expect(
      resolveGroundCreationStart({ ...request, entities: [{ ...visible, visible: false }] }),
    ).toMatchObject({ pendingEndpoint: null, startWorld: request.fallbackWorld })
    expect(
      resolveGroundCreationStart({ ...request, entities: [{ ...visible, locked: true }] }),
    ).toMatchObject({ pendingEndpoint: null, startWorld: request.fallbackWorld })
  })
})
