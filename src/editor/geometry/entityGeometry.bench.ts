import { bench, describe } from 'vitest'

import { createBall, createBlock } from '../../scene/model/entityFactories'
import { snapBodyToSurfaces } from './entityGeometry'

const layerId = '00000000-0000-4000-8000-000000000001'
const movingBall = createBall(layerId, { x: 0.8, y: 0.8 }, 0.25, 1)
const blockTargets = Array.from({ length: 500 }, (_, index) => {
  const column = index % 25
  const row = Math.floor(index / 25)
  const block = createBlock(layerId, { x: column * 1.4, y: row * 1.4 }, 1, 1, index + 1)
  return {
    ...block,
    transform: {
      ...block.transform,
      angleRad: ((index % 9) * Math.PI) / 36,
    },
  }
})

describe('物块吸附编辑期性能', () => {
  bench(
    '一个物体从 500 个旋转物块候选中选择最近表面',
    () => {
      snapBodyToSurfaces(movingBall, blockTargets, 0.6)
    },
    { time: 1000, warmupTime: 200 },
  )
})
