import { afterAll, bench } from 'vitest'

import { createEmptyScene } from '../../scene/model/createEmptyScene'
import {
  createBall,
  createGravityField,
  createLineGround,
  createSpring,
} from '../../scene/model/entityFactories'
import { SimulationWorld } from './SimulationWorld'

const scene = createEmptyScene('性能基准', new Date('2026-07-21T00:00:00.000Z'))
const layerId = scene.layers[0]?.id
if (!layerId) throw new Error('性能场景缺少图层')
scene.settings.pairwiseElectrostatics = false

const bodies = Array.from({ length: 200 }, (_, index) => {
  const body = createBall(
    layerId,
    { x: (index % 20) * 1.2 - 12, y: Math.floor(index / 20) * 1.2 + 5 },
    0.35,
    index + 1,
  )
  body.initialVelocity = { x: index % 2 === 0 ? 0.2 : -0.2, y: 0 }
  return body
})
const grounds = Array.from({ length: 500 }, (_, index) =>
  createLineGround(
    layerId,
    { x: index * 0.2 - 50, y: 0 },
    { x: index * 0.2 - 49.8, y: 0 },
    index + 1,
  ),
)
const fields = Array.from({ length: 10 }, (_, index) => {
  const field = createGravityField(layerId, { x: 0, y: 10 }, 200, 200, index + 1)
  field.field = { type: 'uniformGravity', acceleration: { x: 0, y: -0.1 } }
  return field
})
const connectors = Array.from({ length: 20 }, (_, index) =>
  createSpring(layerId, bodies[index * 2]!.id, bodies[index * 2 + 1]!.id, 1.2, index + 1),
)

scene.entities = [...grounds, ...fields, ...bodies, ...connectors]
const world = new SimulationWorld(scene)

afterAll(() => world.dispose())

bench(
  '200 动态刚体 + 500 静态段 + 10 个场 + 20 个连接器：单个固定步',
  () => {
    world.step()
  },
  { time: 1200, warmupTime: 300 },
)
