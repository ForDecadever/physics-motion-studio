import { afterAll, bench } from 'vitest'

import { createEmptyScene } from '../../scene/model/createEmptyScene'
import {
  createArcGround,
  createBall,
  createBlock,
  createGravityField,
  createGroundJoint,
  createLineGround,
  createRod,
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
const connectors = Array.from({ length: 20 }, (_, index) => {
  const spring = createSpring(
    layerId,
    bodies[index * 2]!.id,
    bodies[index * 2 + 1]!.id,
    1.2,
    index + 1,
  )
  if (spring.connector.type === 'spring') spring.connector.damping = 0.5
  return spring
})

scene.entities = [...grounds, ...fields, ...bodies, ...connectors]
const world = new SimulationWorld(scene)

const persistentScene = createEmptyScene(
  '持续路径接触性能基准',
  new Date('2026-07-21T00:00:00.000Z'),
)
const persistentLayerId = persistentScene.layers[0]?.id
if (!persistentLayerId) throw new Error('持续路径性能场景缺少图层')
persistentScene.settings.pairwiseElectrostatics = false
const persistentBodyCount = 100
const persistentGrounds = Array.from({ length: persistentBodyCount }, (_, index) => {
  const center = { x: (index % 10) * 8, y: Math.floor(index / 10) * 8 }
  return createArcGround(persistentLayerId, center, 3, 0, Math.PI * 2, index + 1)
})
const persistentBodies = persistentGrounds.map((ground, index) => {
  if (ground.geometry.type !== 'arc') throw new Error('持续路径基准需要完整圆弧')
  const ball = createBall(
    persistentLayerId,
    { x: ground.geometry.center.x, y: ground.geometry.center.y + 2.65 },
    0.35,
    index + 1,
  )
  ball.initialVelocity = { x: 4, y: 0 }
  return ball
})
persistentScene.entities = [...persistentGrounds, ...persistentBodies]
const persistentWorld = new SimulationWorld(persistentScene)
persistentWorld.step(2)

const blockJointScene = createEmptyScene(
  '物块连接地面性能基准',
  new Date('2026-07-26T00:00:00.000Z'),
)
const blockJointLayerId = blockJointScene.layers[0]?.id
if (!blockJointLayerId) throw new Error('物块连接地面性能场景缺少图层')
blockJointScene.settings.pairwiseElectrostatics = false

const blockJointEntities = Array.from({ length: 20 }, (_, index) => {
  const offsetX = (index % 5) * 20
  const offsetY = Math.floor(index / 5) * 20
  const first = createLineGround(
    blockJointLayerId,
    { x: offsetX - 8, y: offsetY },
    { x: offsetX, y: offsetY },
    index * 2 + 1,
  )
  const second = createLineGround(
    blockJointLayerId,
    { x: offsetX, y: offsetY },
    { x: offsetX, y: offsetY + 8 },
    index * 2 + 2,
  )
  const joint = createGroundJoint(
    blockJointLayerId,
    { groundId: first.id, endpoint: 'end' },
    { groundId: second.id, endpoint: 'start' },
    index + 1,
  )
  joint.transition = { mode: 'manual', lengthM: 2, directionFlipped: false }
  const horizontalBlock = createBlock(
    blockJointLayerId,
    { x: offsetX - 4, y: offsetY + 0.2005 },
    0.4,
    0.4,
    index * 2 + 1,
  )
  const verticalBlock = createBlock(
    blockJointLayerId,
    { x: offsetX - 0.2005, y: offsetY + 4 },
    0.4,
    0.4,
    index * 2 + 2,
  )
  return [first, second, joint, horizontalBlock, verticalBlock]
}).flat()

blockJointScene.entities = blockJointEntities
const blockJointWorld = new SimulationWorld(blockJointScene)
blockJointWorld.step(2)

const stiffSpringScene = createEmptyScene(
  '高刚度弹簧性能基准',
  new Date('2026-07-27T00:00:00.000Z'),
)
const stiffSpringLayerId = stiffSpringScene.layers[0]?.id
if (!stiffSpringLayerId) throw new Error('高刚度弹簧性能场景缺少图层')
stiffSpringScene.settings.pairwiseElectrostatics = false

const stiffSpringEntities = Array.from({ length: 20 }, (_, index) => {
  const offsetX = (index % 5) * 8
  const offsetY = Math.floor(index / 5) * 6
  const first = createBall(stiffSpringLayerId, { x: offsetX - 1.5, y: offsetY }, 0.1, index * 2 + 1)
  const second = createBall(
    stiffSpringLayerId,
    { x: offsetX + 1.5, y: offsetY },
    0.1,
    index * 2 + 2,
  )
  if (first.shape.type !== 'circle' || second.shape.type !== 'circle') {
    throw new Error('高刚度弹簧性能场景需要小球')
  }
  first.shape.collisionEnabled = false
  second.shape.collisionEnabled = false
  const spring = createSpring(stiffSpringLayerId, first.id, second.id, 2, index + 1)
  if (spring.connector.type !== 'spring') {
    throw new Error('高刚度弹簧性能场景需要弹簧')
  }
  spring.connector.stiffness = 1000
  spring.connector.damping = 0
  return [first, second, spring]
}).flat()

stiffSpringScene.entities = stiffSpringEntities
const stiffSpringWorld = new SimulationWorld(stiffSpringScene)
stiffSpringWorld.step(2)

const rodScene = createEmptyScene('杆约束性能基准', new Date('2026-07-28T00:00:00.000Z'))
const rodLayerId = rodScene.layers[0]?.id
if (!rodLayerId) throw new Error('杆约束性能场景缺少图层')
rodScene.settings.pairwiseElectrostatics = false

const rodEntities = Array.from({ length: 20 }, (_, index) => {
  const offsetX = (index % 5) * 6
  const offsetY = Math.floor(index / 5) * 5
  const first = createBall(rodLayerId, { x: offsetX - 1, y: offsetY }, 0.2, index * 2 + 1)
  const second = createBall(rodLayerId, { x: offsetX + 1, y: offsetY }, 0.2, index * 2 + 2)
  first.initialVelocity = { x: 0, y: -0.5 }
  second.initialVelocity = { x: 0, y: 0.5 }
  if (index % 5 === 0) first.rotationEnabled = false
  const rod = createRod(rodLayerId, first.id, second.id, 2, index + 1)
  if (rod.connector.type !== 'rod') throw new Error('杆约束性能场景需要杆')
  rod.connector.freeRotation = index % 2 === 0
  return [first, second, rod]
}).flat()

rodScene.entities = rodEntities
const rodWorld = new SimulationWorld(rodScene)
rodWorld.step(2)

afterAll(() => {
  world.dispose()
  persistentWorld.dispose()
  blockJointWorld.dispose()
  stiffSpringWorld.dispose()
  rodWorld.dispose()
})

bench(
  '200 动态刚体 + 500 静态段 + 10 个场 + 20 个连接器：单个固定步',
  () => {
    world.step()
  },
  { time: 1200, warmupTime: 300 },
)

bench(
  '100 个小球持续沿独立完整圆轨道运动：单个固定步',
  () => {
    persistentWorld.step()
  },
  { time: 1200, warmupTime: 300 },
)

bench(
  '40 个物块接触 20 组直角连接地面：单个固定步',
  () => {
    blockJointWorld.step()
  },
  { time: 1200, warmupTime: 300 },
)

bench(
  '20 对高刚度弹簧（约 4 个内部子步）：单个固定步',
  () => {
    stiffSpringWorld.step()
  },
  { time: 1200, warmupTime: 300 },
)

bench(
  '10 根自由端杆 + 10 根固定端杆：单个固定步',
  () => {
    rodWorld.step()
  },
  { time: 1200, warmupTime: 300 },
)
