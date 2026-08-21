import { bench } from 'vitest'

import { createEmptyScene } from './createEmptyScene'
import { createArcGround, createGroundJoint, createLineGround } from './entityFactories'
import { buildGroundPathNetwork } from './groundPath'

const scene = createEmptyScene('地面连接建网性能基准', new Date('2026-08-01T00:00:00.000Z'))
const layerId = ''

scene.entities = Array.from({ length: 20 }, (_, index) => {
  const offsetX = index * 20
  const line = createLineGround(
    layerId,
    { x: offsetX - 10, y: 0 },
    { x: offsetX, y: 0 },
    index * 2 + 1,
  )
  const arc = createArcGround(layerId, { x: offsetX, y: 3 }, 3, -Math.PI / 2, 0, index * 2 + 2)
  const joint = createGroundJoint(
    layerId,
    { groundId: line.id, endpoint: 'end' },
    { groundId: arc.id, endpoint: 'start' },
    index + 1,
  )
  return [line, arc, joint]
}).flat()

bench(
  '重建 20 组水平直线—竖直圆弧平顺连接',
  () => {
    buildGroundPathNetwork(scene.entities)
  },
  { time: 1200, warmupTime: 300 },
)
