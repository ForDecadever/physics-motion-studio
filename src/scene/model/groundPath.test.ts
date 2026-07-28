import { describe, expect, it } from 'vitest'

import {
  createArcGround,
  createBezierGround,
  createGroundJoint,
  createLineGround,
} from './entityFactories'
import {
  GROUND_PATH_MIN_OFFSET_SCALE,
  buildGroundPathNetwork,
  createGroundPath,
  createCompositeGroundPath,
  groundPathHasSelfIntersection,
  groundPathMinimumOffsetScale,
  groundJointPathSegmentId,
  groundPathSegmentId,
  traverseGroundPath,
  type GroundPath,
} from './groundPath'
import type { GroundEntity, GroundJointEntity, Vec2 } from './types'

const layerId = '00000000-0000-4000-8000-000000000001'

function expectVectorClose(actual: Vec2, expected: Vec2, digits = 5): void {
  expect(actual.x).toBeCloseTo(expected.x, digits)
  expect(actual.y).toBeCloseTo(expected.y, digits)
}

function makeAngledPair(angleDeg: number): {
  first: GroundEntity
  second: GroundEntity
  joint: GroundJointEntity
} {
  const angle = (angleDeg * Math.PI) / 180
  const first = createLineGround(layerId, { x: -10, y: 0 }, { x: 0, y: 0 }, 1)
  const second = createLineGround(
    layerId,
    { x: 0, y: 0 },
    { x: 10 * Math.cos(angle), y: 10 * Math.sin(angle) },
    2,
  )
  const joint = createGroundJoint(
    layerId,
    { groundId: first.id, endpoint: 'end' },
    { groundId: second.id, endpoint: 'start' },
    1,
  )
  return { first, second, joint }
}

function makeSeparatedAngledPair(
  angleDeg: number,
  secondStart: Vec2 = { x: 3, y: 2 },
): {
  first: GroundEntity
  second: GroundEntity
  joint: GroundJointEntity
} {
  const angle = (angleDeg * Math.PI) / 180
  const first = createLineGround(layerId, { x: -10, y: 0 }, { x: 0, y: 0 }, 1)
  const second = createLineGround(
    layerId,
    secondStart,
    {
      x: secondStart.x + 10 * Math.cos(angle),
      y: secondStart.y + 10 * Math.sin(angle),
    },
    2,
  )
  const joint = createGroundJoint(
    layerId,
    { groundId: first.id, endpoint: 'end' },
    { groundId: second.id, endpoint: 'start' },
    1,
  )
  return { first, second, joint }
}

function maximumSampledCurvature(path: GroundPath): number {
  let maximum = 0
  for (let index = 0; index <= 100; index += 1) {
    maximum = Math.max(maximum, Math.abs(path.curvatureAt((path.length * index) / 100)))
  }
  return maximum
}

describe('统一地面路径', () => {
  it('精确解析直线和圆弧的位置、切线、曲率与最近点', () => {
    const line = createGroundPath({ type: 'line', start: { x: 0, y: 0 }, end: { x: 4, y: 0 } })
    expect(line).not.toBeNull()
    expect(line?.length).toBe(4)
    expectVectorClose(line!.pointAt(1.25), { x: 1.25, y: 0 })
    expectVectorClose(line!.tangentAt(2), { x: 1, y: 0 })
    expectVectorClose(line!.normalAt(2), { x: 0, y: 1 })
    expect(line!.curvatureAt(2)).toBe(0)
    expect(line!.closestPoint({ x: 2, y: 3 })).toMatchObject({ s: 2, distance: 3 })
    // 0.1 m is a curve approximation limit; an analytic line stays one exact segment
    // to avoid duplicate solver contacts at redundant collinear vertices.
    expect(line!.sample({ maxSegmentLength: 0.1 })).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ])

    const arc = createGroundPath({
      type: 'arc',
      center: { x: 0, y: 0 },
      radius: 2,
      startRad: 0,
      endRad: Math.PI / 2,
    })
    expect(arc).not.toBeNull()
    expect(arc?.length).toBeCloseTo(Math.PI)
    expectVectorClose(arc!.pointAt(arc!.length / 2), { x: Math.SQRT2, y: Math.SQRT2 })
    expectVectorClose(arc!.tangentAt(0), { x: 0, y: 1 })
    expect(arc!.curvatureAt(0)).toBeCloseTo(0.5)
    expect(arc!.closestPoint({ x: 0, y: 3 }).s).toBeCloseTo(arc!.length)
  })

  it('用尺度相对容差识别严格相交、端点接触和共线重叠', () => {
    const makeLine = (start: Vec2, end: Vec2) => createGroundPath({ type: 'line', start, end })!
    const crossing = createCompositeGroundPath([
      makeLine({ x: 1_000_000, y: 1_000_000 }, { x: 1_000_010, y: 1_000_010 }),
      makeLine({ x: 1_000_010, y: 1_000_010 }, { x: 1_000_000, y: 1_000_010 }),
      makeLine({ x: 1_000_000, y: 1_000_010 }, { x: 1_000_010, y: 1_000_000 }),
    ])!
    expect(groundPathHasSelfIntersection(crossing)).toBe(true)

    const overlapping = createCompositeGroundPath([
      makeLine({ x: 0, y: 0 }, { x: 2, y: 0 }),
      makeLine({ x: 2, y: 0 }, { x: 3, y: 1 }),
      makeLine({ x: 3, y: 1 }, { x: 1, y: 0 }),
    ])!
    expect(groundPathHasSelfIntersection(overlapping)).toBe(true)
  })

  it('为三次贝塞尔建立弧长坐标、裁剪和自适应采样', () => {
    const path = createGroundPath({
      type: 'cubicBezier',
      p0: { x: 0, y: 0 },
      p1: { x: 1, y: 0 },
      p2: { x: 1, y: 1 },
      p3: { x: 2, y: 1 },
    })
    expect(path).not.toBeNull()
    expect(path!.length).toBeGreaterThan(2)
    expectVectorClose(path!.pointAt(0), { x: 0, y: 0 })
    expectVectorClose(path!.pointAt(path!.length), { x: 2, y: 1 })
    expectVectorClose(path!.tangentAt(0), { x: 1, y: 0 })
    expectVectorClose(path!.tangentAt(path!.length), { x: 1, y: 0 })
    const closest = path!.closestPoint({ x: 1, y: 0.5 })
    expectVectorClose(closest.point, { x: 1, y: 0.5 }, 3)

    const trimmed = path!.trim(0.25, 0.4)
    expect(trimmed).not.toBeNull()
    expect(trimmed!.length).toBeCloseTo(path!.length - 0.65)
    expectVectorClose(trimmed!.pointAt(0), path!.pointAt(0.25))
    expectVectorClose(trimmed!.pointAt(trimmed!.length), path!.pointAt(path!.length - 0.4))

    const points = path!.sample({ maxError: 0.002, maxSegmentLength: 0.1, maxSegments: 2048 })
    expect(points.length).toBeGreaterThan(20)
    expect(points.length).toBeLessThanOrEqual(2049)
    for (let index = 1; index < points.length; index += 1) {
      expect(
        Math.hypot(
          points[index]!.x - points[index - 1]!.x,
          points[index]!.y - points[index - 1]!.y,
        ),
      ).toBeLessThanOrEqual(0.101)
    }
  })

  it('缓存未变化的弧长表，并在几何对象被修改时安全失效', () => {
    const geometry = {
      type: 'cubicBezier' as const,
      p0: { x: 1_000_000, y: 1_000_000 },
      p1: { x: 1_000_250, y: 1_000_500 },
      p2: { x: 1_000_750, y: 999_500 },
      p3: { x: 1_001_000, y: 1_000_000 },
    }
    const first = createGroundPath(geometry)
    const cached = createGroundPath(geometry)
    expect(cached).toBe(first)
    expect(first?.length).toBeGreaterThan(1_000)
    expect(Number.isFinite(first!.closestPoint({ x: 1_000_500, y: 1_000_100 }).s)).toBe(true)

    geometry.p1.x += 10
    const changed = createGroundPath(geometry)
    expect(changed).not.toBe(first)
    expect(Number.isFinite(changed!.length)).toBe(true)
  })

  it('让完整圆周保持闭合并可通过网络连续运行多周', () => {
    const circle = createArcGround(layerId, { x: 0, y: 0 }, 3, 0, Math.PI * 2, 1)
    const network = buildGroundPathNetwork([circle])
    const effective = network.groundPaths.get(circle.id)
    expect(effective?.path.closed).toBe(true)
    const segment = network.segmentById.get(groundPathSegmentId(circle.id))
    expect(segment?.neighbors.start).toMatchObject({
      segmentId: groundPathSegmentId(circle.id),
      endpoint: 'end',
    })
    expect(segment?.neighbors.end).toMatchObject({
      segmentId: groundPathSegmentId(circle.id),
      endpoint: 'start',
    })

    const travelled = traverseGroundPath(
      network,
      { segmentId: groundPathSegmentId(circle.id), s: 1, direction: 1 },
      effective!.path.length * 3 + 2,
    )
    expect(travelled.stoppedAtOpenEnd).toBe(false)
    expect(travelled.transitions).toBe(3)
    expect(travelled.location.s).toBeCloseTo(3)
  })
})

describe('受限夹角地面过渡', () => {
  it.each([0, 0.5, 1])('拒绝 %d° 的近同向连接', (angleDeg) => {
    const { first, second, joint } = makeSeparatedAngledPair(angleDeg)
    const network = buildGroundPathNetwork([first, second, joint])
    const transition = network.jointPaths.get(joint.id)

    expect(transition).toMatchObject({
      issue: 'angle-too-small',
      kind: 'invalid',
      path: null,
      trimA: 0,
      trimB: 0,
    })
    expect(network.groundPaths.get(first.id)?.path.length).toBeCloseTo(10)
    expect(network.groundPaths.get(second.id)?.path.length).toBeCloseTo(10)
  })

  it.each([30, 90, 150])('为 %d° 连接生成连续且有限的五次路径', (angleDeg) => {
    const { first, second, joint } = makeAngledPair(angleDeg)
    const network = buildGroundPathNetwork([first, second, joint])
    const transition = network.jointPaths.get(joint.id)
    const firstPath = network.groundPaths.get(first.id)
    const secondPath = network.groundPaths.get(second.id)

    expect(transition?.issue).toBeNull()
    expect(transition?.kind).toBe('quintic')
    expect(transition?.path).not.toBeNull()
    expect(transition?.segmentId).toBe(groundJointPathSegmentId(joint.id))
    expect(transition?.pieces).toHaveLength(2)
    const path = transition!.path!
    expect(Number.isFinite(path.length)).toBe(true)
    expect(path.length).toBeGreaterThan(0)
    expect(Number.isFinite(maximumSampledCurvature(path))).toBe(true)
    expect(groundPathMinimumOffsetScale(path)).toBeGreaterThanOrEqual(GROUND_PATH_MIN_OFFSET_SCALE)
    expect(groundPathHasSelfIntersection(path)).toBe(false)
    expectVectorClose(path.pointAt(0), firstPath!.path.pointAt(firstPath!.path.length), 4)
    expectVectorClose(path.pointAt(path.length), secondPath!.path.pointAt(0), 4)
    expectVectorClose(path.tangentAt(0), firstPath!.path.tangentAt(firstPath!.path.length), 3)
    expectVectorClose(path.tangentAt(path.length), secondPath!.path.tangentAt(0), 3)
    expect(path.curvatureAt(0)).toBeCloseTo(firstPath!.path.curvatureAt(firstPath!.path.length), 3)
    expect(path.curvatureAt(path.length)).toBeCloseTo(secondPath!.path.curvatureAt(0), 3)
  })

  it.each([179, 179.5, 180])('为相隔端点的 %d° 连接只生成直线', (angleDeg) => {
    const { first, second, joint } = makeSeparatedAngledPair(angleDeg)
    joint.transition = { mode: 'manual', lengthM: 4, directionFlipped: true }
    const network = buildGroundPathNetwork([first, second, joint])
    const transition = network.jointPaths.get(joint.id)
    const path = transition?.path

    expect(transition).toMatchObject({
      issue: null,
      kind: 'linear',
      trimA: 0,
      trimB: 0,
    })
    expect(path?.length).toBeCloseTo(Math.hypot(3, 2))
    expectVectorClose(path!.pointAt(0), { x: 0, y: 0 })
    expectVectorClose(path!.pointAt(path!.length), { x: 3, y: 2 })
    expect(groundPathHasSelfIntersection(path!)).toBe(false)
  })

  it('拒绝重合端点的 180° 零长度直线', () => {
    const { first, second, joint } = makeAngledPair(180)
    const transition = buildGroundPathNetwork([first, second, joint]).jointPaths.get(joint.id)

    expect(transition).toMatchObject({
      issue: 'linear-zero-length',
      kind: 'invalid',
      path: null,
      trimA: 0,
      trimB: 0,
    })
  })

  it('接近 179° 的普通连接不得退回发卡弯或生成环形路径', () => {
    const { first, second, joint } = makeSeparatedAngledPair(178.99, { x: 1, y: 0.2 })
    const transition = buildGroundPathNetwork([first, second, joint]).jointPaths.get(joint.id)

    expect(transition?.kind).not.toBe('hairpin')
    expect(['quintic', 'invalid']).toContain(transition?.kind)
    if (transition?.path) {
      expect(groundPathHasSelfIntersection(transition.path)).toBe(false)
      expect(transition.path.length).toBeLessThan(40)
    }
  })

  it('按公式计算自动裁剪，并允许手动长度覆盖', () => {
    const automatic = makeAngledPair(90)
    const autoNetwork = buildGroundPathNetwork([automatic.first, automatic.second, automatic.joint])
    const expected = 0.4 * 10 * Math.sin(Math.PI / 4)
    expect(autoNetwork.jointPaths.get(automatic.joint.id)?.trimA).toBeCloseTo(expected)
    expect(autoNetwork.jointPaths.get(automatic.joint.id)?.trimB).toBeCloseTo(expected)

    const manual = makeAngledPair(90)
    manual.joint.transition = { mode: 'manual', lengthM: 2, directionFlipped: false }
    const manualNetwork = buildGroundPathNetwork([manual.first, manual.second, manual.joint])
    expect(manualNetwork.jointPaths.get(manual.joint.id)?.trimA).toBeCloseTo(2)
    expect(manualNetwork.jointPaths.get(manual.joint.id)?.trimB).toBeCloseTo(2)
  })

  it('把同一地面两端的总裁剪量限制为长度的 90%', () => {
    const left = createLineGround(layerId, { x: 0, y: -10 }, { x: 0, y: 0 }, 1)
    const middle = createLineGround(layerId, { x: 0, y: 0 }, { x: 10, y: 0 }, 2)
    const right = createLineGround(layerId, { x: 10, y: 0 }, { x: 10, y: 10 }, 3)
    const firstJoint = createGroundJoint(
      layerId,
      { groundId: left.id, endpoint: 'end' },
      { groundId: middle.id, endpoint: 'start' },
      1,
    )
    const secondJoint = createGroundJoint(
      layerId,
      { groundId: middle.id, endpoint: 'end' },
      { groundId: right.id, endpoint: 'start' },
      2,
    )
    firstJoint.transition = { mode: 'manual', lengthM: 8, directionFlipped: false }
    secondJoint.transition = { mode: 'manual', lengthM: 8, directionFlipped: false }

    const network = buildGroundPathNetwork([left, middle, right, firstJoint, secondJoint])
    const effective = network.groundPaths.get(middle.id)
    expect(effective?.trimStartM).toBeCloseTo(4.5)
    expect(effective?.trimEndM).toBeCloseTo(4.5)
    expect(effective?.path.length).toBeCloseTo(1)
  })

  it('复用未变化连接的昂贵过渡曲线计算', () => {
    const pair = makeAngledPair(90)
    const firstNetwork = buildGroundPathNetwork([pair.first, pair.second, pair.joint])
    const secondNetwork = buildGroundPathNetwork([pair.first, pair.second, pair.joint])
    expect(secondNetwork.jointPaths.get(pair.joint.id)?.path).toBe(
      firstNetwork.jointPaths.get(pair.joint.id)?.path,
    )

    pair.joint.transition = { mode: 'manual', lengthM: 1, directionFlipped: false }
    const changedNetwork = buildGroundPathNetwork([pair.first, pair.second, pair.joint])
    expect(changedNetwork.jointPaths.get(pair.joint.id)?.path).not.toBe(
      firstNetwork.jointPaths.get(pair.joint.id)?.path,
    )
  })

  it('自动选择左右转向，并允许双向无缝跨越过渡段', () => {
    const leftTurn = makeAngledPair(90)
    const leftNetwork = buildGroundPathNetwork([leftTurn.first, leftTurn.second, leftTurn.joint])
    expect(leftNetwork.jointPaths.get(leftTurn.joint.id)?.directionSign).toBe(1)

    const rightTurn = makeAngledPair(-90)
    const rightNetwork = buildGroundPathNetwork([
      rightTurn.first,
      rightTurn.second,
      rightTurn.joint,
    ])
    expect(rightNetwork.jointPaths.get(rightTurn.joint.id)?.directionSign).toBe(-1)

    const first = leftNetwork.groundPaths.get(leftTurn.first.id)!
    const second = leftNetwork.groundPaths.get(leftTurn.second.id)!
    const transition = leftNetwork.jointPaths.get(leftTurn.joint.id)!
    const forward = traverseGroundPath(
      leftNetwork,
      { segmentId: first.segmentId, s: first.path.length - 0.1, direction: 1 },
      0.1 + transition.path!.length + 0.25,
    )
    expect(forward.stoppedAtOpenEnd).toBe(false)
    expect(forward.transitions).toBe(2)
    expect(forward.location).toMatchObject({
      segmentId: second.segmentId,
      direction: 1,
    })
    expect(forward.location.s).toBeCloseTo(0.25)

    const backward = traverseGroundPath(
      leftNetwork,
      { segmentId: second.segmentId, s: 0.25, direction: -1 },
      0.25 + transition.path!.length + 0.1,
    )
    expect(backward.stoppedAtOpenEnd).toBe(false)
    expect(backward.transitions).toBe(2)
    expect(backward.location).toMatchObject({
      segmentId: first.segmentId,
      direction: -1,
    })
    expect(backward.location.s).toBeCloseTo(first.path.length - 0.1)
  })

  it('连接直线、圆弧和贝塞尔时复用同一网络接口', () => {
    const line = createLineGround(layerId, { x: 0, y: -3 }, { x: 0, y: 0 }, 1)
    const arc = createArcGround(layerId, { x: 0, y: 2 }, 2, -Math.PI / 2, 0, 2)
    const bezier = createBezierGround(
      layerId,
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 3, y: 4 },
      { x: 4, y: 4 },
      3,
    )
    const firstJoint = createGroundJoint(
      layerId,
      { groundId: line.id, endpoint: 'end' },
      { groundId: arc.id, endpoint: 'start' },
      1,
    )
    const secondJoint = createGroundJoint(
      layerId,
      { groundId: arc.id, endpoint: 'end' },
      { groundId: bezier.id, endpoint: 'start' },
      2,
    )
    const network = buildGroundPathNetwork([line, arc, bezier, firstJoint, secondJoint])

    expect(network.groundPaths).toHaveProperty('size', 3)
    expect(network.jointPaths.get(firstJoint.id)?.issue).toBeNull()
    expect(network.jointPaths.get(secondJoint.id)?.issue).toBeNull()
    expect(network.segments.filter((segment) => segment.kind === 'transition')).toHaveLength(2)
    const firstTransition = network.jointPaths.get(firstJoint.id)?.path
    const secondTransition = network.jointPaths.get(secondJoint.id)?.path
    expect(firstTransition?.curvatureAt(firstTransition.length)).toBeCloseTo(0.5, 3)
    expect(secondTransition?.curvatureAt(0)).toBeCloseTo(0.5, 3)
  })

  it('直线进入 150° 圆弧时只接受无自交且可供默认小球偏置的路径', () => {
    const angle = (150 * Math.PI) / 180
    const radius = 10
    const startRad = angle - Math.PI / 2
    const line = createLineGround(layerId, { x: -10, y: 0 }, { x: 0, y: 0 }, 1)
    const arc = createArcGround(
      layerId,
      { x: -radius * Math.cos(startRad), y: -radius * Math.sin(startRad) },
      radius,
      startRad,
      startRad + 1,
      2,
    )
    const joint = createGroundJoint(
      layerId,
      { groundId: line.id, endpoint: 'end' },
      { groundId: arc.id, endpoint: 'start' },
      1,
    )
    const network = buildGroundPathNetwork([line, arc, joint])
    const transition = network.jointPaths.get(joint.id)

    expect(transition?.kind).not.toBe('hairpin')
    expect(['quintic', 'invalid']).toContain(transition?.kind)
    if (transition?.path) {
      expect(groundPathHasSelfIntersection(transition.path)).toBe(false)
      expect(groundPathMinimumOffsetScale(transition.path)).toBeGreaterThanOrEqual(
        GROUND_PATH_MIN_OFFSET_SCALE,
      )
    } else {
      expect(transition?.issue).toBe('transition-invalid')
    }
  })

  it('让 -178° 手动短过渡保持无自交和有效偏置', () => {
    const pair = makeAngledPair(-178)
    pair.joint.transition = { mode: 'manual', lengthM: 1, directionFlipped: false }
    const network = buildGroundPathNetwork([pair.first, pair.second, pair.joint])
    const transition = network.jointPaths.get(pair.joint.id)

    expect(transition?.kind).not.toBe('hairpin')
    expect(['quintic', 'invalid']).toContain(transition?.kind)
    if (transition?.path) {
      expect(groundPathHasSelfIntersection(transition.path)).toBe(false)
      expect(groundPathMinimumOffsetScale(transition.path)).toBeGreaterThanOrEqual(
        GROUND_PATH_MIN_OFFSET_SCALE,
      )
    }
  })

  it('退化端点明确失效且不会裁剪或错误邻接另一块地面', () => {
    const degenerate = createLineGround(layerId, { x: 0, y: 0 }, { x: 0, y: 0 }, 1)
    const line = createLineGround(layerId, { x: 0, y: 0 }, { x: 2, y: 0 }, 2)
    const joint = createGroundJoint(
      layerId,
      { groundId: degenerate.id, endpoint: 'end' },
      { groundId: line.id, endpoint: 'start' },
      1,
    )
    const network = buildGroundPathNetwork([degenerate, line, joint])
    const resolved = network.jointPaths.get(joint.id)

    expect(resolved).toMatchObject({
      issue: 'degenerate-tangent',
      kind: 'invalid',
      path: null,
      trimA: 0,
      trimB: 0,
    })
    expect(network.groundPaths.get(line.id)?.path.length).toBeCloseTo(2)
    expect(network.groundPaths.has(degenerate.id)).toBe(false)
    expect(network.segmentById.get(groundPathSegmentId(line.id))?.neighbors.start).toBeUndefined()
  })

  it('紧圆弧不会因固定参考球半径导致整个连接点失效', () => {
    const line = createLineGround(layerId, { x: -2, y: 0 }, { x: 0, y: 0 }, 1)
    const arc = createArcGround(layerId, { x: -0.25, y: 0 }, 0.25, 0, Math.PI / 2, 2)
    const joint = createGroundJoint(
      layerId,
      { groundId: line.id, endpoint: 'end' },
      { groundId: arc.id, endpoint: 'start' },
      1,
    )
    const network = buildGroundPathNetwork([line, arc, joint])

    expect(network.jointPaths.get(joint.id)?.issue).toBeNull()
    expect(network.jointPaths.get(joint.id)?.path).not.toBeNull()
  })
})
