import { describe, expect, it } from 'vitest'

import {
  createArcGround,
  createBall,
  createBezierGround,
  createBezierBlock,
  createBlock,
  createGravityField,
  createGroundJoint,
  createLineGround,
  createRope,
} from '../../scene/model/entityFactories'
import { createSmoothBezierPathNodes } from '../../scene/model/bezierPath'
import { sampleBezierBodyWorldPoints } from '../../scene/model/bodyPath'
import { createTriangleBlockNodes } from '../../scene/model/blockPresets'
import { createEmptyScene } from '../../scene/model/createEmptyScene'
import type { BooleanMultiPolygon } from '../../scene/model/booleanGeometry'
import { buildGroundPathNetwork } from '../../scene/model/groundPath'
import type { FieldEntity } from '../../scene/model/types'
import { validateSceneDocument } from '../../scene/validation/sceneSchema'
import {
  createScaleHandleGeometry,
  bodyLocalAnchorIsInside,
  clampBodyLocalAnchor,
  createBodyCenterConnectorEndpoint,
  distance,
  dot,
  getEntityTransform,
  getScalableSelectionBounds,
  resolveConnectorEndpoint,
  scaleEntitiesAroundPivot,
  snapBodyToGround,
  snapBodyToSurfaces,
  snapBooleanBodyToSurfaces,
  withEntityTransform,
  worldToLocalAnchor,
} from './entityGeometry'
import { findTopEntity } from './hitTest'

const layerId = '00000000-0000-4000-8000-000000000001'

describe('实体几何变换', () => {
  it('移动和旋转直线地面时保持长度', () => {
    const ground = createLineGround(layerId, { x: -1, y: 0 }, { x: 1, y: 0 }, 1)
    const transformed = withEntityTransform(ground, {
      position: { x: 2, y: 3 },
      angleRad: Math.PI / 2,
    })

    expect(transformed.kind).toBe('ground')
    if (transformed.kind !== 'ground' || transformed.geometry.type !== 'line') return
    expect(transformed.geometry.start.x).toBeCloseTo(2)
    expect(transformed.geometry.end.x).toBeCloseTo(2)
    expect(transformed.geometry.start.y).toBeCloseTo(2)
    expect(transformed.geometry.end.y).toBeCloseTo(4)
    expect(getEntityTransform(transformed)?.position).toEqual({ x: 2, y: 3 })
  })

  it('命中测试按视觉叠放顺序选择最上层物体', () => {
    const lower = createBall(layerId, { x: 0, y: 0 }, 1, 1)
    const upper = createBall(layerId, { x: 0.5, y: 0 }, 1, 2)

    expect(findTopEntity([lower, upper], { x: 0, y: 0 }, 0.05)?.id).toBe(upper.id)
    expect(findTopEntity([lower, upper], { x: 4, y: 4 }, 0.05)).toBeNull()
  })

  it('墙面吸附让小球碰撞外轮廓与地面相切', () => {
    const ground = createLineGround(layerId, { x: -3, y: 0 }, { x: 3, y: 0 }, 1)
    const ball = createBall(layerId, { x: 0, y: 0.68 }, 0.5, 1)
    const snapped = snapBodyToGround(ball, [ground], 0.2)

    expect(snapped.transform.position.y).toBeCloseTo(0.5)
  })

  it('非对称钢笔物块使用朝向墙面的真实支撑距离', () => {
    const ground = createLineGround(layerId, { x: -5, y: 0 }, { x: 5, y: 0 }, 1)
    const triangle = createBezierBlock(
      layerId,
      createTriangleBlockNodes({ x: -2, y: 0 }, 4, 36.869_897_645_844_02, 1),
      1,
    )
    if (!triangle || triangle.shape.type !== 'bezierPath') {
      throw new Error('三角钢笔物块创建失败')
    }
    const nearGround = {
      ...triangle,
      transform: {
        ...triangle.transform,
        position: { ...triangle.transform.position, y: triangle.transform.position.y + 0.12 },
      },
    }
    const snapped = snapBodyToSurfaces(nearGround, [ground], 0.2)
    const minimumY = Math.min(...sampleBezierBodyWorldPoints(snapped).map((point) => point.y))

    expect(snapped).not.toBe(nearGround)
    expect(minimumY).toBeCloseTo(0, 8)
  })

  it('物体沿切线方向远离地面端点时不会吸附', () => {
    const ground = createLineGround(layerId, { x: -3, y: 0 }, { x: 3, y: 0 }, 1)
    const ball = createBall(layerId, { x: 8, y: 0.5 }, 0.5, 1)
    const snapped = snapBodyToGround(ball, [ground], 0.2)

    expect(snapped).toBe(ball)
    expect(snapped.transform.position).toEqual({ x: 8, y: 0.5 })
  })

  it('物体位于端点吸附阈值内时会沿真实分离方向相切', () => {
    const endpoint = { x: 3, y: 0 }
    const ground = createLineGround(layerId, { x: -3, y: 0 }, endpoint, 1)
    const ball = createBall(layerId, { x: 3.42, y: 0.28 }, 0.5, 1)
    const snapped = snapBodyToGround(ball, [ground], 0.1)

    expect(snapped).not.toBe(ball)
    expect(distance(snapped.transform.position, endpoint)).toBeCloseTo(0.5)
    expect(snapped.transform.position.x).toBeGreaterThan(endpoint.x)
    expect(snapped.transform.position.y).toBeGreaterThan(endpoint.y)
  })

  it('小球可以吸附物块的四条边与真实角点', () => {
    const target = createBlock(layerId, { x: 0, y: 0 }, 2, 2, 1)
    const cases = [
      { start: { x: 1.6, y: 0 }, expected: { x: 1.5, y: 0 } },
      { start: { x: -1.6, y: 0 }, expected: { x: -1.5, y: 0 } },
      { start: { x: 0, y: 1.6 }, expected: { x: 0, y: 1.5 } },
      { start: { x: 0, y: -1.6 }, expected: { x: 0, y: -1.5 } },
    ]

    for (const [index, testCase] of cases.entries()) {
      const ball = createBall(layerId, testCase.start, 0.5, index + 2)
      const snapped = snapBodyToSurfaces(ball, [target], 0.2)
      expect(snapped.transform.position.x).toBeCloseTo(testCase.expected.x)
      expect(snapped.transform.position.y).toBeCloseTo(testCase.expected.y)
    }

    const corner = { x: 1, y: 1 }
    const cornerBall = createBall(layerId, { x: 1.4, y: 1.4 }, 0.5, 6)
    const cornerSnapped = snapBodyToSurfaces(cornerBall, [target], 0.2)
    expect(distance(cornerSnapped.transform.position, corner)).toBeCloseTo(0.5)
    expect(cornerSnapped.transform.position.x).toBeCloseTo(1 + Math.SQRT1_2 * 0.5)
    expect(cornerSnapped.transform.position.y).toBeCloseTo(1 + Math.SQRT1_2 * 0.5)
  })

  it('旋转物块之间使用真实碰撞轮廓和移动物块的支撑半径', () => {
    const targetBase = createBlock(layerId, { x: 0, y: 0 }, 2, 4, 1)
    const target = {
      ...targetBase,
      transform: { ...targetBase.transform, angleRad: Math.PI / 4 },
    }
    const movingBase = createBlock(layerId, { x: Math.SQRT1_2 * 2, y: Math.SQRT1_2 * 2 }, 1, 2, 2)
    const moving = {
      ...movingBase,
      transform: { ...movingBase.transform, angleRad: Math.PI / 6 },
    }
    const normal = { x: Math.SQRT1_2, y: Math.SQRT1_2 }
    const expectedSupport =
      Math.abs(Math.cos(Math.PI / 12)) * 0.5 + Math.abs(Math.sin(Math.PI / 12)) * 1
    const snapped = snapBodyToSurfaces(moving, [target], 1)

    expect(dot(snapped.transform.position, normal)).toBeCloseTo(1 + expectedSupport)
    expect(dot(snapped.transform.position, { x: -normal.y, y: normal.x })).toBeCloseTo(0)
  })

  it('浅层重叠会向外修正，深层重叠会被阈值拒绝', () => {
    const target = createBlock(layerId, { x: 0, y: 0 }, 2, 2, 1)
    const shallow = createBall(layerId, { x: 0.95, y: 0 }, 0.5, 2)
    const shallowSnapped = snapBodyToSurfaces(shallow, [target], 0.6)
    expect(shallowSnapped.transform.position).toEqual({ x: 1.5, y: 0 })

    const deep = createBall(layerId, { x: 0, y: 0 }, 0.5, 3)
    const deepSnapped = snapBodyToSurfaces(deep, [target], 0.6)
    expect(deepSnapped).toBe(deep)
  })

  it('边界零距离时使用稳定法线且不会产生非有限位置', () => {
    const target = createBlock(layerId, { x: 0, y: 0 }, 2, 2, 1)
    const ball = createBall(layerId, { x: 1, y: 0 }, 0.5, 2)
    const snapped = snapBodyToSurfaces(ball, [target], 0.5)

    expect(snapped.transform.position).toEqual({ x: 1.5, y: 0 })
    expect(Number.isFinite(snapped.transform.position.x)).toBe(true)
    expect(Number.isFinite(snapped.transform.position.y)).toBe(true)
  })

  it('墙面和物块按最小修正竞争，等距离时保持场景顺序', () => {
    const block = createBlock(layerId, { x: 0, y: 0 }, 2, 4, 1)
    const ground = createLineGround(layerId, { x: -3, y: 0 }, { x: 3, y: 0 }, 1)
    const nearerGroundBall = createBall(layerId, { x: 1.65, y: 0.58 }, 0.5, 2)
    const groundSnapped = snapBodyToSurfaces(nearerGroundBall, [block, ground], 0.2)
    expect(groundSnapped.transform.position).toEqual({ x: 1.65, y: 0.5 })

    const equalBall = createBall(layerId, { x: 1.6, y: 0.6 }, 0.5, 3)
    const blockFirst = snapBodyToSurfaces(equalBall, [block, ground], 0.2)
    expect(blockFirst.transform.position).toEqual({ x: 1.5, y: 0.6 })
    const groundFirst = snapBodyToSurfaces(equalBall, [ground, block], 0.2)
    expect(groundFirst.transform.position).toEqual({ x: 1.6, y: 0.5 })
  })

  it('布尔结果使用真实外环分别吸附墙面和旋转物块', () => {
    const ground = createLineGround(layerId, { x: -3, y: 0 }, { x: 3, y: 0 }, 1)
    const wallGeometry: BooleanMultiPolygon = [
      [
        [
          [-1, 0.18],
          [1, 0.18],
          [1, 1.18],
          [-1, 1.18],
          [-1, 0.18],
        ],
        [
          [-0.2, 0.5],
          [-0.2, 0.8],
          [0.2, 0.8],
          [0.2, 0.5],
          [-0.2, 0.5],
        ],
      ],
    ]
    const wallPosition = snapBooleanBodyToSurfaces(
      {
        resultId: '00000000-0000-4000-8000-000000000099',
        centerOfMass: { x: 0, y: 0.68 },
        geometry: wallGeometry,
      },
      [ground],
      0.2,
    )
    expect(wallPosition).toEqual({ x: 0, y: 0.5 })

    const target = createBlock(layerId, { x: 0, y: 0 }, 2, 2, 2)
    target.transform.angleRad = Math.PI / 2
    const blockGeometry: BooleanMultiPolygon = [
      [
        [
          [1.18, -0.5],
          [2.18, -0.5],
          [2.18, 0.5],
          [1.18, 0.5],
          [1.18, -0.5],
        ],
      ],
    ]
    const blockPosition = snapBooleanBodyToSurfaces(
      {
        resultId: '00000000-0000-4000-8000-000000000098',
        centerOfMass: { x: 1.68, y: 0 },
        geometry: blockGeometry,
      },
      [target],
      0.2,
    )
    expect(blockPosition.x).toBeCloseTo(1.5)
    expect(blockPosition.y).toBeCloseTo(0)
  })

  it('布尔结果复用圆弧和贝塞尔墙面的真实采样轮廓', () => {
    const geometryAt = (centerY: number): BooleanMultiPolygon => [
      [
        [
          [-0.5, centerY - 0.5],
          [0.5, centerY - 0.5],
          [0.5, centerY + 0.5],
          [-0.5, centerY + 0.5],
          [-0.5, centerY - 0.5],
        ],
      ],
    ]
    const arc = createArcGround(layerId, { x: 0, y: 0 }, 2, 0, Math.PI, 1)
    const arcPosition = snapBooleanBodyToSurfaces(
      {
        resultId: '00000000-0000-4000-8000-000000000097',
        centerOfMass: { x: 0, y: 2.68 },
        geometry: geometryAt(2.68),
      },
      [arc],
      0.2,
    )
    const arcReference = snapBodyToSurfaces(
      createBlock(layerId, { x: 0, y: 2.68 }, 1, 1, 3),
      [arc],
      0.2,
    )
    expect(arcPosition.x).toBeCloseTo(arcReference.transform.position.x, 10)
    expect(arcPosition.y).toBeCloseTo(arcReference.transform.position.y, 10)

    const bezier = createBezierGround(
      layerId,
      { x: -2, y: 0 },
      { x: -1, y: 2 },
      { x: 1, y: 2 },
      { x: 2, y: 0 },
      2,
    )
    const bezierPosition = snapBooleanBodyToSurfaces(
      {
        resultId: '00000000-0000-4000-8000-000000000096',
        centerOfMass: { x: 0, y: 2.18 },
        geometry: geometryAt(2.18),
      },
      [bezier],
      0.2,
    )
    const bezierReference = snapBodyToSurfaces(
      createBlock(layerId, { x: 0, y: 2.18 }, 1, 1, 4),
      [bezier],
      0.2,
    )
    expect(bezierPosition.x).toBeCloseTo(bezierReference.transform.position.x, 10)
    expect(bezierPosition.y).toBeCloseTo(bezierReference.transform.position.y, 10)
  })

  it('普通小球可吸附布尔外轮廓和孔洞的空白侧', () => {
    const targetGeometry: BooleanMultiPolygon = [
      [
        [
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
          [-2, -2],
        ],
        [
          [-1, -1],
          [-1, 1],
          [1, 1],
          [1, -1],
          [-1, -1],
        ],
      ],
    ]
    const target = {
      kind: 'booleanResult' as const,
      id: '00000000-0000-4000-8000-000000000095',
      layerId,
      visible: true,
      centerOfMass: { x: 0, y: 0 },
      geometry: targetGeometry,
    }
    const outside = createBall(layerId, { x: 2.62, y: 0 }, 0.5, 1)
    const inHole = createBall(layerId, { x: 0.38, y: 0 }, 0.5, 2)

    expect(snapBodyToSurfaces(outside, [target], 0.2).transform.position).toEqual({ x: 2.5, y: 0 })
    expect(snapBodyToSurfaces(inHole, [target], 0.2).transform.position).toEqual({ x: 0.5, y: 0 })
  })

  it('两个根布尔结果可以互相吸附并排除自身树', () => {
    const target = {
      kind: 'booleanResult' as const,
      id: '00000000-0000-4000-8000-000000000094',
      layerId,
      visible: true,
      centerOfMass: { x: 0, y: 0 },
      geometry: [
        [
          [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
            [-1, -1],
          ],
        ],
      ] as BooleanMultiPolygon,
    }
    const movingGeometry: BooleanMultiPolygon = [
      [
        [
          [1.1, -0.5],
          [2.1, -0.5],
          [2.1, 0.5],
          [1.1, 0.5],
          [1.1, -0.5],
        ],
      ],
    ]
    const moving = {
      resultId: '00000000-0000-4000-8000-000000000093',
      centerOfMass: { x: 1.6, y: 0 },
      geometry: movingGeometry,
    }

    expect(snapBooleanBodyToSurfaces(moving, [target], 0.2)).toEqual({ x: 1.5, y: 0 })
    expect(snapBooleanBodyToSurfaces(moving, [target], 0.2, new Set([target.id]))).toEqual(
      moving.centerOfMass,
    )
  })

  it('排除自身、同组或隐藏目标，锁定但可见的目标仍可吸附', () => {
    const moving = createBlock(layerId, { x: 1.6, y: 0 }, 1, 1, 1)
    const hidden = {
      ...createBlock(layerId, { x: 0, y: 0 }, 2, 2, 2),
      visible: false,
    }
    const locked = {
      ...createBlock(layerId, { x: 0, y: 0 }, 2, 2, 3),
      locked: true,
    }

    expect(snapBodyToSurfaces(moving, [moving], 0.2)).toBe(moving)
    expect(snapBodyToSurfaces(moving, [hidden], 0.2)).toBe(moving)
    expect(snapBodyToSurfaces(moving, [locked], 0.2, new Set([locked.id]))).toBe(moving)
    expect(snapBodyToSurfaces(moving, [locked], 0.2)).not.toBe(moving)
  })

  it('屏幕阈值换算后在不同画布缩放下保持 12 px 语义', () => {
    const target = createBlock(layerId, { x: 0, y: 0 }, 2, 2, 1)
    const ball = createBall(layerId, { x: 1.65, y: 0 }, 0.5, 2)

    expect(snapBodyToSurfaces(ball, [target], 12 / 80)).not.toBe(ball)
    expect(snapBodyToSurfaces(ball, [target], 12 / 100)).toBe(ball)
  })

  it('连接件可以在画布中命中，并能在世界与局部锚点间换算', () => {
    const first = createBall(layerId, { x: -2, y: 0 }, 0.5, 1)
    const second = createBall(layerId, { x: 2, y: 0 }, 0.5, 2)
    const rope = createRope(layerId, first.id, second.id, 4, 1)
    const entities = [first, second, rope]

    expect(findTopEntity(entities, { x: 0, y: 0 }, 0.1)?.id).toBe(rope.id)
    const draggedWorld = { x: -1.5, y: 0.25 }
    const local = worldToLocalAnchor(first, draggedWorld)
    expect(
      resolveConnectorEndpoint(entities, { type: 'body', bodyId: first.id, localAnchor: local }),
    ).toEqual(draggedWorld)
  })

  it.each(['circle', 'box'] as const)('新建连接器命中 %s 物体时使用中心锚点', (shape) => {
    const body =
      shape === 'circle'
        ? createBall(layerId, { x: 3, y: -2 }, 0.75, 1)
        : createBlock(layerId, { x: 3, y: -2 }, 2, 1, 1)
    body.transform.angleRad = Math.PI / 3

    const endpoint = createBodyCenterConnectorEndpoint(body)

    expect(endpoint).toEqual({ type: 'body', bodyId: body.id, localAnchor: { x: 0, y: 0 } })
    expect(resolveConnectorEndpoint([body], endpoint)).toEqual(body.transform.position)
  })

  it('旋转扇形场会同步改变它的起始方向', () => {
    const base = createGravityField(layerId, { x: 0, y: 0 }, 2, 2, 1)
    const sector = {
      ...base,
      region: {
        type: 'circle' as const,
        center: { x: 0, y: 0 },
        radius: 2,
        startRad: 0,
        sweepRad: Math.PI / 2,
      },
    }
    const rotated = withEntityTransform(sector, {
      position: { x: 1, y: 2 },
      angleRad: Math.PI / 3,
    })
    expect(rotated.kind).toBe('field')
    if (rotated.kind !== 'field' || rotated.region.type !== 'circle') return
    expect(rotated.region.center).toEqual({ x: 1, y: 2 })
    expect(rotated.region.startRad).toBeCloseTo(Math.PI / 3)
  })

  it('围绕共同中心等比缩放物体和三种地面几何', () => {
    const ball = createBall(layerId, { x: -2, y: 1 }, 0.5, 1)
    const block = createBlock(layerId, { x: 2, y: -1 }, 2, 1, 2)
    const line = createLineGround(layerId, { x: -2, y: 0 }, { x: 2, y: 0 }, 1)
    const arc = createArcGround(layerId, { x: 1, y: 2 }, 3, 0.2, 1.8, 2)
    const bezier = createBezierGround(
      layerId,
      { x: -2, y: -1 },
      { x: -1, y: 2 },
      { x: 1, y: 2 },
      { x: 2, y: -1 },
      3,
    )
    const entities = [ball, block, line, arc, bezier]
    const { factor, replacements } = scaleEntitiesAroundPivot(
      entities,
      entities.map((entity) => entity.id),
      { x: 0, y: 0 },
      2,
    )
    const scaled = new Map(replacements.map((entity) => [entity.id, entity]))

    expect(factor).toBe(2)
    const scaledBall = scaled.get(ball.id)
    expect(scaledBall?.kind).toBe('body')
    if (scaledBall?.kind === 'body' && scaledBall.shape.type === 'circle') {
      expect(scaledBall.transform.position).toEqual({ x: -4, y: 2 })
      expect(scaledBall.shape.radius).toBe(1)
      expect(scaledBall.massKg).toBe(ball.massKg)
      expect(scaledBall.initialVelocity).toEqual(ball.initialVelocity)
    }
    const scaledBlock = scaled.get(block.id)
    if (scaledBlock?.kind === 'body' && scaledBlock.shape.type === 'box') {
      expect(scaledBlock.transform.position).toEqual({ x: 4, y: -2 })
      expect(scaledBlock.shape.width).toBe(4)
      expect(scaledBlock.shape.height).toBe(2)
    }
    const scaledLine = scaled.get(line.id)
    if (scaledLine?.kind === 'ground' && scaledLine.geometry.type === 'line') {
      expect(scaledLine.geometry.start).toEqual({ x: -4, y: 0 })
      expect(scaledLine.geometry.end).toEqual({ x: 4, y: 0 })
    }
    const scaledArc = scaled.get(arc.id)
    if (scaledArc?.kind === 'ground' && scaledArc.geometry.type === 'arc') {
      expect(scaledArc.geometry.center).toEqual({ x: 2, y: 4 })
      expect(scaledArc.geometry.radius).toBe(6)
      expect(scaledArc.geometry.startRad).toBe(0.2)
      expect(scaledArc.geometry.endRad).toBe(1.8)
    }
    const scaledBezier = scaled.get(bezier.id)
    if (scaledBezier?.kind === 'ground' && scaledBezier.geometry.type === 'cubicBezier') {
      expect(scaledBezier.geometry.p0).toEqual({ x: -4, y: -2 })
      expect(scaledBezier.geometry.p1).toEqual({ x: -2, y: 4 })
      expect(scaledBezier.geometry.p2).toEqual({ x: 2, y: 4 })
      expect(scaledBezier.geometry.p3).toEqual({ x: 4, y: -2 })
    }
  })

  it('缩放有限场范围但保持场强、方向和角度', () => {
    const rectangle = createGravityField(layerId, { x: 2, y: 2 }, 4, 2, 1)
    const sector: FieldEntity = {
      ...createGravityField(layerId, { x: -2, y: 0 }, 2, 2, 2),
      region: {
        type: 'circle',
        center: { x: -2, y: 0 },
        radius: 2,
        startRad: 0.3,
        sweepRad: 1.2,
      },
    }
    const polygon: FieldEntity = {
      ...createGravityField(layerId, { x: 0, y: 0 }, 2, 2, 3),
      region: {
        type: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
          { x: 1, y: 2 },
        ],
      },
    }
    const bezierPath: FieldEntity = {
      ...createGravityField(layerId, { x: 0, y: 0 }, 2, 2, 4),
      region: {
        type: 'bezierPath',
        nodes: [
          {
            anchor: { x: -1, y: -1 },
            inHandle: { x: -1.5, y: -1 },
            outHandle: { x: -0.5, y: -1 },
          },
          {
            anchor: { x: 1, y: -1 },
            inHandle: { x: 0.5, y: -1 },
            outHandle: { x: 1.5, y: -1 },
          },
          {
            anchor: { x: 0, y: 1 },
            inHandle: { x: 0.5, y: 1 },
            outHandle: { x: -0.5, y: 1 },
          },
        ],
      },
    }
    const fields = [rectangle, sector, polygon, bezierPath]
    const { replacements } = scaleEntitiesAroundPivot(
      fields,
      fields.map((field) => field.id),
      { x: 0, y: 0 },
      0.5,
    )
    const scaled = new Map(replacements.map((entity) => [entity.id, entity]))

    const scaledRectangle = scaled.get(rectangle.id)
    if (scaledRectangle?.kind === 'field' && scaledRectangle.region.type === 'rectangle') {
      expect(scaledRectangle.region.center).toEqual({ x: 1, y: 1 })
      expect(scaledRectangle.region.width).toBe(2)
      expect(scaledRectangle.region.height).toBe(1)
      expect(scaledRectangle.field).toEqual(rectangle.field)
    }
    const scaledSector = scaled.get(sector.id)
    if (scaledSector?.kind === 'field' && scaledSector.region.type === 'circle') {
      expect(scaledSector.region.center).toEqual({ x: -1, y: 0 })
      expect(scaledSector.region.radius).toBe(1)
      expect(scaledSector.region.startRad).toBe(0.3)
      expect(scaledSector.region.sweepRad).toBe(1.2)
    }
    const scaledPolygon = scaled.get(polygon.id)
    if (scaledPolygon?.kind === 'field' && scaledPolygon.region.type === 'polygon') {
      expect(scaledPolygon.region.points).toEqual([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0.5, y: 1 },
      ])
    }
    const scaledBezierPath = scaled.get(bezierPath.id)
    if (scaledBezierPath?.kind === 'field' && scaledBezierPath.region.type === 'bezierPath') {
      expect(scaledBezierPath.region.nodes[0]?.anchor).toEqual({ x: -0.5, y: -0.5 })
      expect(scaledBezierPath.region.nodes[0]?.inHandle).toEqual({ x: -0.75, y: -0.5 })
    }
  })

  it('多选缩放会改变物体间距和局部锚点，但不改变连接器参数', () => {
    const first = {
      ...createBall(layerId, { x: -2, y: 0 }, 0.5, 1),
      massKg: 3,
    }
    const second = createBall(layerId, { x: 2, y: 0 }, 0.5, 2)
    const rope = {
      ...createRope(layerId, first.id, second.id, 4, 1),
      a: { type: 'body' as const, bodyId: first.id, localAnchor: { x: 0.5, y: 0.25 } },
      b: { type: 'body' as const, bodyId: second.id, localAnchor: { x: -0.5, y: -0.25 } },
    }
    const { replacements } = scaleEntitiesAroundPivot(
      [first, second, rope],
      [first.id, second.id],
      { x: 0, y: 0 },
      2,
    )
    const scaled = new Map(replacements.map((entity) => [entity.id, entity]))
    const scaledFirst = scaled.get(first.id)
    const scaledSecond = scaled.get(second.id)
    const scaledRope = scaled.get(rope.id)

    if (scaledFirst?.kind === 'body') {
      expect(scaledFirst.transform.position.x).toBe(-4)
      expect(scaledFirst.massKg).toBe(3)
    }
    if (scaledSecond?.kind === 'body') expect(scaledSecond.transform.position.x).toBe(4)
    if (scaledRope?.kind === 'connector') {
      if (scaledRope.a.type !== 'body' || scaledRope.b.type !== 'body') {
        throw new Error('缩放后的绳端点类型错误')
      }
      expect(scaledRope.a.localAnchor).toEqual({ x: 1, y: 0.5 })
      expect(scaledRope.b.localAnchor).toEqual({ x: -1, y: -0.5 })
      expect(scaledRope.connector).toEqual(rope.connector)
    }
  })

  it('缩放不会翻转实体，并把最小物理尺寸限制为 0.001 m', () => {
    const ball = createBall(layerId, { x: 1, y: 0 }, 0.5, 1)
    const zero = scaleEntitiesAroundPivot([ball], [ball.id], { x: 0, y: 0 }, 0)
    const negative = scaleEntitiesAroundPivot([ball], [ball.id], { x: 0, y: 0 }, -10)
    const invalid = scaleEntitiesAroundPivot([ball], [ball.id], { x: 0, y: 0 }, Number.NaN)

    expect(zero.factor).toBeCloseTo(0.002)
    expect(negative.factor).toBeCloseTo(0.002)
    for (const result of [zero, negative]) {
      const scaledBall = result.replacements[0]
      if (scaledBall?.kind === 'body' && scaledBall.shape.type === 'circle') {
        expect(scaledBall.shape.radius).toBeCloseTo(0.001)
        expect(scaledBall.transform.position.x).toBeGreaterThan(0)
      }
    }
    expect(invalid.factor).toBe(1)

    const scene = createEmptyScene('缩放校验')
    scene.entities = zero.replacements
    scene.rootItems = scene.entities.map((entity) => ({ kind: 'entity', entityId: entity.id }))
    expect(() => validateSceneDocument(scene)).not.toThrow()
  })

  it('共同缩放框忽略连接器、无限场、隐藏和锁定实体', () => {
    const visible = createBall(layerId, { x: 0, y: 0 }, 1, 1)
    const hidden = { ...createBall(layerId, { x: 10, y: 0 }, 1, 2), visible: false }
    const locked = { ...createBall(layerId, { x: -10, y: 0 }, 1, 3), locked: true }
    const infinite: FieldEntity = {
      ...createGravityField(layerId, { x: 0, y: 0 }, 2, 2, 1),
      region: { type: 'infinite' },
    }
    const rope = createRope(layerId, visible.id, hidden.id, 10, 1)
    const entities = [visible, hidden, locked, infinite, rope]
    const bounds = getScalableSelectionBounds(
      entities,
      entities.map((entity) => entity.id),
    )

    expect(bounds).toEqual({ minX: -1, minY: -1, maxX: 1, maxY: 1 })
    const handles = createScaleHandleGeometry(bounds!, 0.25)
    expect(handles.center).toEqual({ x: 0, y: 0 })
    expect(handles.handles.map((handle) => handle.position)).toEqual([
      { x: -1.25, y: -1.25 },
      { x: -1.25, y: 1.25 },
      { x: 1.25, y: -1.25 },
      { x: 1.25, y: 1.25 },
    ])
  })

  it('把绳和杆的物体锚点夹紧在小球或物块碰撞轮廓内', () => {
    const ball = createBall(layerId, { x: 0, y: 0 }, 0.5, 1)
    const block = createBlock(layerId, { x: 0, y: 0 }, 2, 1, 2)
    const ballAnchor = clampBodyLocalAnchor(ball, { x: 3, y: 4 })
    const blockAnchor = clampBodyLocalAnchor(block, { x: -2, y: 3 })

    expect(ballAnchor.x).toBeCloseTo(0.3)
    expect(ballAnchor.y).toBeCloseTo(0.4)
    expect(blockAnchor).toEqual({ x: -1, y: 0.5 })
    expect(bodyLocalAnchorIsInside(ball, ballAnchor)).toBe(true)
    expect(bodyLocalAnchorIsInside(block, blockAnchor)).toBe(true)
    expect(bodyLocalAnchorIsInside(ball, { x: 0.6, y: 0 })).toBe(false)
  })

  it('钢笔物块参与命中、缩放、锚点投影和凹边界吸附', () => {
    const freeform = createBezierBlock(
      layerId,
      createSmoothBezierPathNodes([
        { x: -2, y: -1 },
        { x: 2, y: -1 },
        { x: 2, y: 1 },
        { x: 0, y: 0 },
        { x: -2, y: 1 },
      ]),
      1,
    )
    if (!freeform || freeform.shape.type !== 'bezierPath') throw new Error('钢笔物块创建失败')

    expect(findTopEntity([freeform], freeform.transform.position, 0.01)?.id).toBe(freeform.id)
    const scaled = scaleEntitiesAroundPivot(
      [freeform],
      [freeform.id],
      freeform.transform.position,
      2,
    ).replacements[0]
    expect(
      scaled?.kind === 'body' && scaled.shape.type === 'bezierPath'
        ? scaled.shape.nodes[0]!.anchor.x
        : 0,
    ).toBeCloseTo(freeform.shape.nodes[0]!.anchor.x * 2)
    const projected = clampBodyLocalAnchor(freeform, { x: 20, y: 20 })
    expect(bodyLocalAnchorIsInside(freeform, projected)).toBe(true)

    const top = sampleBezierBodyWorldPoints(freeform).reduce((highest, point) =>
      point.y > highest.y ? point : highest,
    )
    const ball = createBall(layerId, { x: top.x, y: top.y + 0.4 }, 0.25, 2)
    const snapped = snapBodyToSurfaces(ball, [freeform], 0.5)
    expect(distance(snapped.transform.position, ball.transform.position)).toBeGreaterThan(0)
  })

  it('解析普通地面、地面连接段和世界固定点端点', () => {
    const first = createLineGround(layerId, { x: -10, y: 0 }, { x: 0, y: 0 }, 1)
    const second = createLineGround(layerId, { x: 0, y: 0 }, { x: 0, y: 10 }, 2)
    const joint = createGroundJoint(
      layerId,
      { groundId: first.id, endpoint: 'end' },
      { groundId: second.id, endpoint: 'start' },
      1,
    )
    const entities = [first, second, joint]
    const network = buildGroundPathNetwork(entities)
    const groundPoint = resolveConnectorEndpoint(
      entities,
      { type: 'ground', groundId: first.id, pathRatio: 0.25 },
      network,
    )
    const transitionPoint = resolveConnectorEndpoint(
      entities,
      { type: 'groundJoint', groundJointId: joint.id, pathRatio: 0.5 },
      network,
    )
    const worldPoint = resolveConnectorEndpoint(
      entities,
      { type: 'world', position: { x: 7, y: -3 } },
      network,
    )

    expect(groundPoint).not.toBeNull()
    expect(groundPoint?.y).toBeCloseTo(0)
    expect(transitionPoint).not.toBeNull()
    expect(worldPoint).toEqual({ x: 7, y: -3 })
  })
})
