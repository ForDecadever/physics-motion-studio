import { describe, expect, it } from 'vitest'

import { createBall, createLineGround } from '../../scene/model/entityFactories'
import { getEntityTransform, withEntityTransform } from './entityGeometry'
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
})
