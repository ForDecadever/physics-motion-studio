import { describe, expect, it } from 'vitest'

import {
  createBall,
  createGroundJoint,
  createLineGround,
  createMarkerMeasurement,
  createProtractorMeasurement,
  createRulerMeasurement,
  createRope,
} from '../../scene/model/entityFactories'
import { buildGroundPathNetwork } from '../../scene/model/groundPath'
import {
  findNearestGroundEndpoint,
  findNearestUnoccupiedGroundEndpoint,
  findTopEntity,
  snappedGroundPathRatio,
} from './hitTest'

const layerId = '00000000-0000-4000-8000-000000000001'

describe('连接器地面端点网格吸附', () => {
  it('开启网格吸附时把地面端点吸附到最近的网格点', () => {
    const ground = createLineGround(layerId, { x: 0, y: 0 }, { x: 2, y: 0 }, 1)
    const path = buildGroundPathNetwork([ground]).groundPaths.get(ground.id)?.path
    if (!path) throw new Error('缺少地面路径')

    const ratio = snappedGroundPathRatio(path, { x: 0.35, y: 0.2 }, { step: 0.5 })

    expect(ratio).toBeCloseTo(0.5 / path.length, 6)
  })

  it('关闭吸附时地面端点保持点击位置的最近点', () => {
    const ground = createLineGround(layerId, { x: 0, y: 0 }, { x: 2, y: 0 }, 1)
    const path = buildGroundPathNetwork([ground]).groundPaths.get(ground.id)?.path
    if (!path) throw new Error('缺少地面路径')

    const ratio = snappedGroundPathRatio(path, { x: 0.35, y: 0.2 }, null)

    expect(ratio).toBeCloseTo(0.35 / path.length, 6)
  })

  it('网格吸附点超出地面范围时夹紧到地面端点', () => {
    const ground = createLineGround(layerId, { x: 0, y: 0 }, { x: 2, y: 0 }, 1)
    const path = buildGroundPathNetwork([ground]).groundPaths.get(ground.id)?.path
    if (!path) throw new Error('缺少地面路径')

    const endRatio = snappedGroundPathRatio(path, { x: 1.9, y: 0.2 }, { step: 0.5 })
    const startRatio = snappedGroundPathRatio(path, { x: 0.1, y: 0.2 }, { step: 0.5 })

    expect(endRatio).toBe(1)
    expect(startRatio).toBe(0)
  })

  it('地面连接段端点同样支持网格吸附', () => {
    const first = createLineGround(layerId, { x: -4, y: 0 }, { x: 0, y: 0 }, 1)
    const second = createLineGround(layerId, { x: 0, y: 0 }, { x: 0, y: 4 }, 2)
    const joint = createGroundJoint(
      layerId,
      { groundId: first.id, endpoint: 'end' },
      { groundId: second.id, endpoint: 'start' },
      1,
    )
    const path = buildGroundPathNetwork([first, second, joint]).jointPaths.get(joint.id)?.path
    if (!path) throw new Error('缺少连接段路径')

    const ratio = snappedGroundPathRatio(path, { x: -0.1, y: 0.1 }, { step: 0.5 })

    expect(ratio).toBeGreaterThanOrEqual(0)
    expect(ratio).toBeLessThanOrEqual(1)
    expect(Number.isFinite(ratio)).toBe(true)
  })
})

describe('地面连接点命中', () => {
  it('重合端点第二次查找时可排除第一块地面', () => {
    const first = createLineGround(layerId, { x: -1, y: 0 }, { x: 0, y: 0 }, 1)
    const second = createLineGround(layerId, { x: 0, y: 0 }, { x: 1, y: 0 }, 2)
    const entities = [first, second]
    const initial = findNearestGroundEndpoint(entities, { x: 0, y: 0 }, 0.1)
    expect(initial).not.toBeNull()

    const next = findNearestGroundEndpoint(
      entities,
      { x: 0, y: 0 },
      0.1,
      new Set([initial!.ground.id]),
    )

    expect(next?.ground.id).not.toBe(initial?.ground.id)
    expect(next?.position).toEqual({ x: 0, y: 0 })
  })

  it('画布可以命中独立的地面连接点实体', () => {
    const first = createLineGround(layerId, { x: -1, y: 0 }, { x: 0, y: 0 }, 1)
    const second = createLineGround(layerId, { x: 0, y: 0 }, { x: 1, y: 0 }, 2)
    const joint = createGroundJoint(
      layerId,
      { groundId: first.id, endpoint: 'end' },
      { groundId: second.id, endpoint: 'start' },
      1,
    )

    expect(findTopEntity([first, second, joint], { x: 0, y: 0 }, 0.1)?.id).toBe(joint.id)
  })

  it('画布可以直接命中连接点生成的有限过渡曲线', () => {
    const first = createLineGround(layerId, { x: -4, y: 0 }, { x: 0, y: 0 }, 1)
    const second = createLineGround(layerId, { x: 0, y: 0 }, { x: 0, y: 4 }, 2)
    const joint = createGroundJoint(
      layerId,
      { groundId: first.id, endpoint: 'end' },
      { groundId: second.id, endpoint: 'start' },
      1,
    )
    const entities = [first, second, joint]
    const path = buildGroundPathNetwork(entities).jointPaths.get(joint.id)?.path
    expect(path).not.toBeNull()
    const midpoint = path!.pointAt(path!.length / 2)

    expect(findTopEntity(entities, midpoint, 0.05)?.id).toBe(joint.id)
  })

  it('自动连接会跳过已经占用的最近端点', () => {
    const first = createLineGround(layerId, { x: -1, y: 0 }, { x: 0, y: 0 }, 1)
    const occupiedPartner = createLineGround(layerId, { x: 0, y: 0 }, { x: 1, y: 0 }, 2)
    const available = createLineGround(layerId, { x: 0.06, y: 0 }, { x: 2, y: 0 }, 3)
    const joint = createGroundJoint(
      layerId,
      { groundId: first.id, endpoint: 'end' },
      { groundId: occupiedPartner.id, endpoint: 'start' },
      1,
    )

    const hit = findNearestUnoccupiedGroundEndpoint(
      [first, occupiedPartner, available, joint],
      { x: 0, y: 0 },
      0.1,
    )

    expect(hit?.ground.id).toBe(available.id)
    expect(hit?.reference.endpoint).toBe('start')
  })

  it('模拟运行时按连接器节点折线命中，而不是按初始直线命中', () => {
    const first = createBall(layerId, { x: -1, y: 0 }, 0.2, 1)
    const second = createBall(layerId, { x: 1, y: 0 }, 0.2, 2)
    const rope = createRope(layerId, first.id, second.id, 3, 1)
    const runtime = {
      [rope.id]: {
        entityId: rope.id,
        points: [
          { x: -1, y: 0 },
          { x: 0, y: -1 },
          { x: 1, y: 0 },
        ],
      },
    }

    expect(findTopEntity([first, second, rope], { x: 0, y: -1 }, 0.05, runtime)?.id).toBe(rope.id)
    expect(findTopEntity([first, second, rope], { x: 0, y: 0 }, 0.05, runtime)).toBeNull()
  })
})

describe('测量标注命中', () => {
  it('可命中记号、直尺和量角器的可见线段', () => {
    const marker = createMarkerMeasurement(
      layerId,
      [
        { x: -2, y: 0 },
        { x: -1, y: 1 },
      ],
      1,
    )
    const ruler = createRulerMeasurement(layerId, { x: 0, y: 0 }, { x: 2, y: 0 }, 1)
    const protractor = createProtractorMeasurement(
      layerId,
      { x: 3, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 1 },
      1,
    )

    expect(findTopEntity([marker], { x: -1.5, y: 0.5 }, 0.05)?.id).toBe(marker.id)
    expect(findTopEntity([ruler], { x: 1, y: 0.03 }, 0.05)?.id).toBe(ruler.id)
    expect(findTopEntity([protractor], { x: 4, y: 0.5 }, 0.05)?.id).toBe(protractor.id)
  })
})
