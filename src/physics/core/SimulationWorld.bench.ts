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
  createRope,
  createSpring,
} from '../../scene/model/entityFactories'
import { SimulationWorld } from './SimulationWorld'

const scene = createEmptyScene('性能基准', new Date('2026-07-21T00:00:00.000Z'))
const layerId = ''
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
const persistentLayerId = ''
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
const blockJointLayerId = ''
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
const stiffSpringLayerId = ''
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
const rodLayerId = ''
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
  rod.connector.endpointRotation =
    index % 2 === 0 ? { a: 'free', b: 'free' } : { a: 'fixed', b: 'fixed' }
  return [first, second, rod]
}).flat()

rodScene.entities = rodEntities
const rodWorld = new SimulationWorld(rodScene)
rodWorld.step(2)

const massiveConnectorScene = createEmptyScene(
  '带质量柔性连接器性能基准',
  new Date('2026-08-02T00:00:00.000Z'),
)
const massiveConnectorLayerId = ''
const massiveConnectors = Array.from({ length: 8 }, (_, index) => {
  const y = index * 1.5
  const rope = createRope(
    massiveConnectorLayerId,
    { type: 'world', position: { x: -1, y } },
    { type: 'world', position: { x: 1, y } },
    2.5,
    index + 1,
  )
  rope.massKg = 0.001
  rope.collisionEnabled = true
  return rope
})
massiveConnectorScene.entities = [
  ...massiveConnectors,
  createGravityField(massiveConnectorLayerId, { x: 0, y: 5 }, 20, 20, 1),
]
const massiveConnectorWorld = new SimulationWorld(massiveConnectorScene)
massiveConnectorWorld.step(2)

const wrappingRopeScene = createEmptyScene(
  '碰撞绳多点绕行性能基准',
  new Date('2026-08-09T00:00:00.000Z'),
)
const wrappingRopeLayerId = ''
wrappingRopeScene.settings.pairwiseElectrostatics = false
wrappingRopeScene.entities = Array.from({ length: 8 }, (_, index) => {
  const y = index * 2
  const rope = createRope(
    wrappingRopeLayerId,
    { type: 'world', position: { x: -1.5, y } },
    { type: 'world', position: { x: 1.5, y } },
    3.6,
    index + 1,
  )
  rope.collisionEnabled = true
  rope.massKg = 0.001
  rope.radiusM = 0.05
  rope.material = { friction: 0, restitution: 0 }
  const obstacle = createBall(wrappingRopeLayerId, { x: 0, y }, 0.5, 100 + index)
  obstacle.massKg = 1e8
  obstacle.material = { friction: 0, restitution: 0 }
  return [rope, obstacle]
}).flat()
const wrappingRopeWorld = new SimulationWorld(wrappingRopeScene)
wrappingRopeWorld.step(600)

const springBumperScene = createEmptyScene(
  '自由端弹簧端帽性能基准',
  new Date('2026-08-08T00:00:00.000Z'),
)
const springBumperLayerId = ''
springBumperScene.settings.pairwiseElectrostatics = false

const springBumperEntities = Array.from({ length: 20 }, (_, index) => {
  const y = index * 1.5
  const spring = createSpring(
    springBumperLayerId,
    { type: 'world', position: { x: 0, y } },
    { type: 'free', position: { x: 2, y } },
    2,
    index + 1,
  )
  spring.radiusM = 0.05
  if (spring.connector.type !== 'spring') throw new Error('自由端弹簧基准需要弹簧')
  spring.connector.stiffness = 200
  spring.connector.damping = 0
  const body = createBall(springBumperLayerId, { x: 2.53, y }, 0.5, index + 1)
  return [spring, body]
}).flat()
const springBumperGravity = createGravityField(springBumperLayerId, { x: 2, y: 15 }, 10, 40, 1)
springBumperGravity.field = {
  type: 'uniformGravity',
  acceleration: { x: -5, y: 0 },
}
springBumperScene.entities = [...springBumperEntities, springBumperGravity]
const springBumperWorld = new SimulationWorld(springBumperScene)
springBumperWorld.step(2)

const masslessConnectorScene = createEmptyScene(
  '无质量连接器地面碰撞性能基准',
  new Date('2026-08-02T00:00:00.000Z'),
)
const masslessConnectorLayerId = ''
masslessConnectorScene.settings.pairwiseElectrostatics = false

const masslessConnectorEntities = Array.from({ length: 20 }, (_, index) => {
  const offsetX = (index - 10) * 3
  const first = createBall(
    masslessConnectorLayerId,
    { x: offsetX - 1, y: 0.04 },
    0.1,
    index * 2 + 1,
  )
  const second = createBall(
    masslessConnectorLayerId,
    { x: offsetX + 1, y: 0.04 },
    0.1,
    index * 2 + 2,
  )
  if (first.shape.type !== 'circle' || second.shape.type !== 'circle') {
    throw new Error('无质量连接器性能场景需要小球')
  }
  first.shape.collisionEnabled = false
  second.shape.collisionEnabled = false
  const rope = createRope(masslessConnectorLayerId, first.id, second.id, 2.5, index + 1)
  rope.collisionEnabled = true
  rope.massKg = 0.001
  rope.radiusM = 0.05
  const projectile = createBall(masslessConnectorLayerId, { x: offsetX, y: 0.3 }, 0.08, 100 + index)
  if (projectile.shape.type !== 'circle') throw new Error('连接器碰撞基准需要小球')
  projectile.shape.collisionEnabled = true
  projectile.initialVelocity = { x: 0, y: -2 }
  return [first, second, rope, projectile]
}).flat()

masslessConnectorScene.entities = [
  createLineGround(masslessConnectorLayerId, { x: -40, y: 0 }, { x: 40, y: 0 }, 1),
  createGravityField(masslessConnectorLayerId, { x: 0, y: 5 }, 100, 20, 1),
  ...masslessConnectorEntities,
]
const masslessConnectorWorld = new SimulationWorld(masslessConnectorScene)
masslessConnectorWorld.step(2)

afterAll(() => {
  world.dispose()
  persistentWorld.dispose()
  blockJointWorld.dispose()
  stiffSpringWorld.dispose()
  rodWorld.dispose()
  massiveConnectorWorld.dispose()
  wrappingRopeWorld.dispose()
  springBumperWorld.dispose()
  masslessConnectorWorld.dispose()
})

bench(
  '200 动态刚体 + 500 静态段 + 10 个场 + 20 个连接器：单个固定步',
  () => {
    world.step()
  },
  { time: 1200, warmupTime: 300 },
)

bench(
  '8 根最低质量碰撞绳（约 216 个柔性段）：单个固定步',
  () => {
    massiveConnectorWorld.step()
  },
  { time: 1200, warmupTime: 300 },
)

bench(
  '8 组碰撞绳持续绕过大质量圆球：单个固定步',
  () => {
    wrappingRopeWorld.step()
  },
  { time: 1200, warmupTime: 300 },
)

bench(
  '20 根自由端弹簧持续接触物体：单个固定步',
  () => {
    springBumperWorld.step()
  },
  { time: 1200, warmupTime: 300 },
)

bench(
  '20 根连接器持续碰撞地面和第三方物体：单个固定步',
  () => {
    masslessConnectorWorld.step()
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
