import { describe, expect, it } from 'vitest'

import {
  createBall,
  createGravityField,
  createLineGround,
  createRope,
} from '../../scene/model/entityFactories'
import {
  distance,
  getEntityTransform,
  resolveConnectorEndpoint,
  snapBodyToGround,
  withEntityTransform,
  worldToLocalAnchor,
} from './entityGeometry'
import { findTopEntity } from './hitTest'

const layerId = '00000000-0000-4000-8000-000000000001'

describe('实体几何变换', () => {
  it('移动和旋转直线地面时保持长度', () => {
    const ground = createLineGround(layerId, { x: -1, y: 0 }, { x: 1, y: 0 }, 1)
    const transformed = withEntityTransform(ground, {
      position: { x: 2, y: 3 },
      angleRad: Math.PI / 2,
    })

    expect(transformed.kind).toBe('ground')
    if (transformed.kind !== 'ground' || transformed.geometry.type !== 'line') return
    expect(transformed.geometry.start.x).toBeCloseTo(2)
    expect(transformed.geometry.end.x).toBeCloseTo(2)
    expect(transformed.geometry.start.y).toBeCloseTo(2)
    expect(transformed.geometry.end.y).toBeCloseTo(4)
    expect(getEntityTransform(transformed)?.position).toEqual({ x: 2, y: 3 })
  })

  it('命中测试按视觉叠放顺序选择最上层物体', () => {
    const lower = createBall(layerId, { x: 0, y: 0 }, 1, 1)
    const upper = createBall(layerId, { x: 0.5, y: 0 }, 1, 2)

    expect(findTopEntity([lower, upper], { x: 0, y: 0 }, 0.05)?.id).toBe(upper.id)
    expect(findTopEntity([lower, upper], { x: 4, y: 4 }, 0.05)).toBeNull()
  })

  it('墙面吸附让小球碰撞外轮廓与地面相切', () => {
    const ground = createLineGround(layerId, { x: -3, y: 0 }, { x: 3, y: 0 }, 1)
    const ball = createBall(layerId, { x: 0, y: 0.68 }, 0.5, 1)
    const snapped = snapBodyToGround(ball, [ground], 0.2)

    expect(snapped.transform.position.y).toBeCloseTo(0.5)
  })

  it('物体沿切线方向远离地面端点时不会吸附', () => {
    const ground = createLineGround(layerId, { x: -3, y: 0 }, { x: 3, y: 0 }, 1)
    const ball = createBall(layerId, { x: 8, y: 0.5 }, 0.5, 1)
    const snapped = snapBodyToGround(ball, [ground], 0.2)

    expect(snapped).toBe(ball)
    expect(snapped.transform.position).toEqual({ x: 8, y: 0.5 })
  })

  it('物体位于端点吸附阈值内时会沿真实分离方向相切', () => {
    const endpoint = { x: 3, y: 0 }
    const ground = createLineGround(layerId, { x: -3, y: 0 }, endpoint, 1)
    const ball = createBall(layerId, { x: 3.42, y: 0.28 }, 0.5, 1)
    const snapped = snapBodyToGround(ball, [ground], 0.1)

    expect(snapped).not.toBe(ball)
    expect(distance(snapped.transform.position, endpoint)).toBeCloseTo(0.5)
    expect(snapped.transform.position.x).toBeGreaterThan(endpoint.x)
    expect(snapped.transform.position.y).toBeGreaterThan(endpoint.y)
  })

  it('连接件可以在画布中命中，并能在世界与局部锚点间换算', () => {
    const first = createBall(layerId, { x: -2, y: 0 }, 0.5, 1)
    const second = createBall(layerId, { x: 2, y: 0 }, 0.5, 2)
    const rope = createRope(layerId, first.id, second.id, 4, 1)
    const entities = [first, second, rope]

    expect(findTopEntity(entities, { x: 0, y: 0 }, 0.1)?.id).toBe(rope.id)
    const draggedWorld = { x: -1.5, y: 0.25 }
    const local = worldToLocalAnchor(first, draggedWorld)
    expect(resolveConnectorEndpoint(entities, { bodyId: first.id, localAnchor: local })).toEqual(
      draggedWorld,
    )
  })

  it('旋转扇形场会同步改变它的起始方向', () => {
    const base = createGravityField(layerId, { x: 0, y: 0 }, 2, 2, 1)
    const sector = {
      ...base,
      region: {
        type: 'circle' as const,
        center: { x: 0, y: 0 },
        radius: 2,
        startRad: 0,
        sweepRad: Math.PI / 2,
      },
    }
    const rotated = withEntityTransform(sector, {
      position: { x: 1, y: 2 },
      angleRad: Math.PI / 3,
    })
    expect(rotated.kind).toBe('field')
    if (rotated.kind !== 'field' || rotated.region.type !== 'circle') return
    expect(rotated.region.center).toEqual({ x: 1, y: 2 })
    expect(rotated.region.startRad).toBeCloseTo(Math.PI / 3)
  })
})
