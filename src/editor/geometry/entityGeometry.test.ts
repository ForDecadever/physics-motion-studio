import { describe, expect, it } from 'vitest'

import {
  createArcGround,
  createBall,
  createBezierGround,
  createBlock,
  createGravityField,
  createLineGround,
  createRope,
} from '../../scene/model/entityFactories'
import { createEmptyScene } from '../../scene/model/createEmptyScene'
import type { FieldEntity } from '../../scene/model/types'
import { validateSceneDocument } from '../../scene/validation/sceneSchema'
import {
  createScaleHandleGeometry,
  distance,
  dot,
  getEntityTransform,
  getScalableSelectionBounds,
  resolveConnectorEndpoint,
  scaleEntitiesAroundPivot,
  snapBodyToGround,
  snapBodyToSurfaces,
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
    expect(resolveConnectorEndpoint(entities, { bodyId: first.id, localAnchor: local })).toEqual(
      draggedWorld,
    )
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
      a: { bodyId: first.id, localAnchor: { x: 0.5, y: 0.25 } },
      b: { bodyId: second.id, localAnchor: { x: -0.5, y: -0.25 } },
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
    const sceneLayerId = scene.layers[0]?.id
    if (!sceneLayerId) throw new Error('测试场景缺少图层')
    scene.entities = zero.replacements.map((entity) => ({ ...entity, layerId: sceneLayerId }))
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
})
