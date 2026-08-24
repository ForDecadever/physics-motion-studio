import { describe, expect, it } from 'vitest'

import {
  advancePointInMagneticField,
  coulombForceOnFirst,
  electricForce,
  magneticForce,
  rotateVelocityInMagneticField,
  springForceOnFirst,
} from './forces'

describe('阶段 3 力模型', () => {
  it('电场力方向随电荷正负反转', () => {
    expect(electricForce(2, { x: 3, y: -4 })).toEqual({ x: 6, y: -8 })
    expect(electricForce(-2, { x: 3, y: -4 })).toEqual({ x: -6, y: 8 })
  })

  it('磁场力始终垂直速度，精确旋转不改变速率', () => {
    const velocity = { x: 3, y: 4 }
    const force = magneticForce(2, velocity, 0.5)
    expect(force.x * velocity.x + force.y * velocity.y).toBeCloseTo(0, 12)

    const rotated = rotateVelocityInMagneticField(velocity, 2, 0.5, 1, 0.25)
    expect(Math.hypot(rotated.x, rotated.y)).toBeCloseTo(5, 12)
  })

  it('匀强磁场按解析圆弧同时推进位置和速度', () => {
    const advanced = advancePointInMagneticField(
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      1,
      1,
      1,
      Math.PI / 2,
    )

    expect(advanced.position.x).toBeCloseTo(1, 12)
    expect(advanced.position.y).toBeCloseTo(-1, 12)
    expect(advanced.velocity.x).toBeCloseTo(0, 12)
    expect(advanced.velocity.y).toBeCloseTo(-1, 12)
  })

  it('同号点电荷排斥，异号点电荷吸引', () => {
    const repulsion = coulombForceOnFirst(1e-6, 1e-6, { x: -1, y: 0 }, { x: 1, y: 0 }, 0.1)
    const attraction = coulombForceOnFirst(1e-6, -1e-6, { x: -1, y: 0 }, { x: 1, y: 0 }, 0.1)
    expect(repulsion.x).toBeLessThan(0)
    expect(attraction.x).toBeGreaterThan(0)
  })

  it('拉伸弹簧会把两端拉向彼此，阻尼反抗相对运动', () => {
    const stretched = springForceOnFirst(
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 0 },
      1,
      10,
      2,
    )
    expect(stretched.x).toBeCloseTo(12)
    expect(stretched.y).toBe(0)
  })
})
