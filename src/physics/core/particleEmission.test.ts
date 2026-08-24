import { describe, expect, it } from 'vitest'

import { createParticleSource } from '../../scene/model/entityFactories'
import { particleEmissionSamples } from './particleEmission'

describe('粒子源确定性采样', () => {
  it.each([
    [0, 3, 1],
    [1, 3, 3],
    [10, 3, 30],
    [180, 3, 540],
    [360, 3, 1080],
    [360, 10, 3600],
    [360, 0.01, 4],
  ])('%d°、密度 %d 个/度生成 %d 个不重复方向', (spreadDegrees, density, count) => {
    const source = createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 1)
    source.spreadRad = (spreadDegrees * Math.PI) / 180
    source.densityPerDegree = density
    const samples = particleEmissionSamples(source)

    expect(samples).toHaveLength(count)
    expect(new Set(samples.map((sample) => sample.t.toPrecision(15))).size).toBe(count)
  })

  it('非整圆低密度至少生成两个粒子并包含角范围两端', () => {
    const source = createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 1)
    source.directionRad = Math.PI / 2
    source.spreadRad = Math.PI / 18
    source.densityPerDegree = 0.01
    const samples = particleEmissionSamples(source)

    expect(samples.map((sample) => sample.t)).toEqual([0, 1])
  })
})
