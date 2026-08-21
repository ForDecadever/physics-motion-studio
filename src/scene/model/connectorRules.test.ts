import { describe, expect, it } from 'vitest'
import {
  MIN_COLLIDING_ROPE_MASS_KG,
  minimumFixedRopeLength,
  setConnectorCollisionEnabled,
} from './connectorRules'
import { createRod, createRope, createSpring } from './entityFactories'

describe('连接器属性规则', () => {
  it('开启绳碰撞时补足最低质量，关闭时恢复零质量', () => {
    const rope = createRope('layer', 'first', 'second', 2, 1)

    const enabled = setConnectorCollisionEnabled(rope, true)
    expect(enabled.collisionEnabled).toBe(true)
    expect(enabled.massKg).toBe(MIN_COLLIDING_ROPE_MASS_KG)

    const disabled = setConnectorCollisionEnabled({ ...enabled, massKg: 0.25 }, false)
    expect(disabled.collisionEnabled).toBe(false)
    expect(disabled.massKg).toBe(0)
  })

  it('杆切换碰撞时保留用户质量', () => {
    const rod = { ...createRod('layer', 'first', 'second', 2, 1), massKg: 3 }
    expect(setConnectorCollisionEnabled(rod, true)).toMatchObject({
      collisionEnabled: true,
      massKg: 3,
    })
  })

  it('弹簧不能通过通用碰撞入口开启碰撞或设置运行质量', () => {
    const spring = { ...createSpring('layer', 'first', 'second', 2, 1), massKg: 2 }
    expect(setConnectorCollisionEnabled(spring, true)).toMatchObject({
      collisionEnabled: false,
      massKg: 0,
    })
  })

  it('仅为两个固定端点计算绳的最小可行长度', () => {
    const rope = createRope(
      'layer',
      { type: 'world', position: { x: 1, y: 2 } },
      { type: 'world', position: { x: 4, y: 6 } },
      5,
      1,
    )
    const resolve = (endpoint: typeof rope.a) =>
      endpoint.type === 'world' ? endpoint.position : null

    expect(minimumFixedRopeLength(rope, resolve)).toBe(5)
    expect(
      minimumFixedRopeLength(
        { ...rope, a: { type: 'body', bodyId: 'body', localAnchor: { x: 0, y: 0 } } },
        resolve,
      ),
    ).toBeNull()
  })
})
