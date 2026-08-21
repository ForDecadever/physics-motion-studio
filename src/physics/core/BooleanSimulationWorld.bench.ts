import { afterAll, bench } from 'vitest'

import { createEmptyScene } from '../../scene/model/createEmptyScene'
import {
  createBlock,
  createGravityField,
  createLineGround,
} from '../../scene/model/entityFactories'
import { createBooleanLayer } from '../../scene/model/layerFactories'
import { SimulationWorld } from './SimulationWorld'

const scene = createEmptyScene('8 个复合刚体基准', new Date('2026-08-11T00:00:00.000Z'))
scene.entities.push(
  createLineGround('', { x: -20, y: 0 }, { x: 20, y: 0 }, 1),
  createGravityField('', { x: 0, y: 10 }, 50, 30, 1),
)

for (let index = 0; index < 8; index += 1) {
  const layer = createBooleanLayer('union', `复合刚体 ${index + 1}`)
  const x = (index - 3.5) * 3
  const upper = createBlock(layer.id, { x: x - 0.35, y: 2.5 + (index % 2) }, 1.4, 1, 1)
  const lower = createBlock(layer.id, { x: x + 0.35, y: 2.5 + (index % 2) }, 1.4, 1, 2)
  upper.transform.angleRad = Math.PI / 12
  lower.transform.angleRad = -Math.PI / 12
  layer.operands = [
    { kind: 'entity', entityId: upper.id },
    { kind: 'entity', entityId: lower.id },
  ]
  scene.rootItems.push(layer)
  scene.entities.push(upper, lower)
}

const world = new SimulationWorld(scene)
world.step(2)

afterAll(() => world.dispose())

bench(
  '8 个多凸片复合刚体：单个固定步',
  () => {
    world.step()
  },
  { time: 1200, warmupTime: 300 },
)
