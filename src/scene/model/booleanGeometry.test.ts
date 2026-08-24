import { describe, expect, it } from 'vitest'

import { createEmptyScene } from './createEmptyScene'
import { createBall, createBlock, createGravityField } from './entityFactories'
import {
  pointInBooleanGeometry,
  polygonMetrics,
  resolveBooleanScene,
  type ResolvedBooleanBody,
  type ResolvedBooleanField,
} from './booleanGeometry'
import type { BodyEntity, BooleanNode, SceneDocument, SceneEntity, SceneTreeItem } from './types'

const uuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`

function entityItem(entity: SceneEntity): SceneTreeItem {
  return { kind: 'entity', entityId: entity.id }
}

function booleanNode(
  operation: BooleanNode['operation'],
  operands: SceneTreeItem[],
  suffix = 10,
): BooleanNode {
  return {
    kind: 'boolean',
    id: uuid(suffix),
    resultId: uuid(suffix + 1),
    name:
      operation === 'union' ? '布尔加法' : operation === 'intersection' ? '布尔交集' : '布尔减法',
    visible: true,
    locked: false,
    operation,
    operands,
    simulationEnabled: true,
    rotationEnabled: true,
    continuousCollisionDetection: false,
    massDistribution: { mode: 'source' },
    chargeDistribution: { mode: 'source' },
    fieldDistribution: { mode: 'source' },
    frictionDistribution: { mode: 'source' },
    restitutionDistribution: { mode: 'source' },
    initialVelocity: { mode: 'source' },
    initialAngularVelocity: { mode: 'source' },
  }
}

function bodyScene(
  operation: BooleanNode['operation'],
  upper: BodyEntity,
  lower: BodyEntity,
): { scene: SceneDocument; node: BooleanNode } {
  const scene = createEmptyScene()
  upper.id = uuid(1)
  lower.id = uuid(2)
  const node = booleanNode(operation, [entityItem(upper), entityItem(lower)])
  scene.entities = [upper, lower]
  scene.rootItems = [node]
  return { scene, node }
}

function resolvedBody(scene: SceneDocument): ResolvedBooleanBody {
  const result = resolveBooleanScene(scene).roots[0]
  expect(result?.valid).toBe(true)
  expect(result?.valid && result.kind).toBe('body')
  return result as ResolvedBooleanBody
}

function convexPartArea(points: readonly { x: number; y: number }[]): number {
  return Math.abs(
    points.reduce((area, point, index) => {
      const next = points[(index + 1) % points.length]!
      return area + point.x * next.y - next.x * point.y
    }, 0) / 2,
  )
}

function oldFloat32AreaCheckWouldReject(result: ResolvedBooleanBody): boolean {
  return result.materialRegions.some((region) => {
    const points = region.geometry.flat(2)
    const width =
      Math.max(...points.map((point) => point[0])) - Math.min(...points.map((point) => point[0]))
    const height =
      Math.max(...points.map((point) => point[1])) - Math.min(...points.map((point) => point[1]))
    const featureSize = Math.max(width, height, 1e-6)
    const tolerance = Math.min(5e-4, Math.max(1e-6, featureSize * 1e-4))
    const allowedAreaError = Math.max(tolerance ** 2, region.area * 1e-7)
    const acceptedArea = result.convexParts
      .filter((part) => part.sourceEntityId === region.sourceEntityId)
      .reduce((area, part) => area + convexPartArea(part.localPoints), 0)
    return Math.abs(region.area - acceptedArea) > allowedAreaError
  })
}

describe('布尔几何和属性区域', () => {
  it('交集只保留共同区域并采用上方来源属性', () => {
    const upper = {
      ...createBlock('', { x: 0, y: 0 }, 2, 2, 1),
      massKg: 4,
      material: { friction: 0.2, restitution: 0.3 },
    }
    const lower = {
      ...createBlock('', { x: 1, y: 0 }, 2, 2, 2),
      massKg: 20,
      material: { friction: 0.8, restitution: 0.1 },
    }
    const result = resolvedBody(bodyScene('intersection', upper, lower).scene)

    expect(polygonMetrics(result.geometry).area).toBeCloseTo(2, 10)
    expect(result.massKg).toBeCloseTo(2, 10)
    expect(result.materialRegions).toHaveLength(1)
    expect(result.materialRegions[0]?.material).toEqual(upper.material)
    expect(result.materialRegions[0]?.color).toBe(upper.color)
  })

  it('场布尔覆盖场强后在整个真实结果区域使用同一个均匀场', () => {
    const scene = createEmptyScene()
    const upper = createGravityField('', { x: 0, y: 0 }, 2, 2, 1)
    const lower = createGravityField('', { x: 1, y: 0 }, 2, 2, 2)
    const node = booleanNode('intersection', [entityItem(upper), entityItem(lower)])
    node.fieldDistribution = {
      mode: 'uniform',
      field: { type: 'uniformGravity', acceleration: { x: 3, y: -4 } },
    }
    scene.entities = [upper, lower]
    scene.rootItems = [node]

    const result = resolveBooleanScene(scene).roots[0] as ResolvedBooleanField
    expect(result.valid).toBe(true)
    expect(result.kind).toBe('field')
    expect(result.regions).toHaveLength(1)
    expect(result.regions[0]?.area).toBeCloseTo(2, 10)
    expect(result.regions[0]?.field).toEqual({
      type: 'uniformGravity',
      acceleration: { x: 3, y: -4 },
    })
  })

  it('并集重叠区域使用上方材料，并保留来源质量和电荷密度', () => {
    const upper = {
      ...createBlock('', { x: 0, y: 0 }, 2, 2, 1),
      massKg: 4,
      chargeC: 8,
      material: { friction: 0.2, restitution: 0.3 },
    }
    const lower = {
      ...createBlock('', { x: 1, y: 0 }, 2, 2, 2),
      massKg: 8,
      chargeC: -4,
      material: { friction: 0.8, restitution: 0.1 },
    }
    const result = resolvedBody(bodyScene('union', upper, lower).scene)

    expect(polygonMetrics(result.geometry).area).toBeCloseTo(6, 10)
    expect(result.massKg).toBeCloseTo(8, 10)
    expect(result.chargeC).toBeCloseTo(6, 10)
    expect(result.centerOfMass).toEqual({ x: 0.75, y: 0 })
    expect(result.materialRegions).toHaveLength(2)
    expect(result.materialRegions[0]?.material).toEqual(upper.material)
    expect(result.massRegions).toHaveLength(2)
    expect(result.chargeRegions).toHaveLength(2)
  })

  it('材料未编辑时保留来源分区，编辑单项后只统一对应材料属性', () => {
    const upper = {
      ...createBlock('', { x: -0.5, y: 0 }, 2, 2, 1),
      material: { friction: 0.2, restitution: 0.3 },
    }
    const lower = {
      ...createBlock('', { x: 1, y: 0 }, 1, 2, 2),
      material: { friction: 0.8, restitution: 0.9 },
    }
    const { scene, node } = bodyScene('union', upper, lower)

    expect(resolvedBody(scene).materialRegions.map((region) => region.material)).toEqual([
      upper.material,
      lower.material,
    ])

    node.frictionDistribution = { mode: 'uniform', value: 0.45 }
    const frictionOverridden = resolvedBody(structuredClone(scene))
    expect(frictionOverridden.materialRegions.map((region) => region.material)).toEqual([
      { friction: 0.45, restitution: 0.3 },
      { friction: 0.45, restitution: 0.9 },
    ])

    node.restitutionDistribution = { mode: 'uniform', value: 0.1 }
    expect(
      resolvedBody(structuredClone(scene)).materialRegions.map((region) => region.material),
    ).toEqual([
      { friction: 0.45, restitution: 0.1 },
      { friction: 0.45, restitution: 0.1 },
    ])
  })

  it('初始状态未编辑时继承上方输入，编辑后按结果整体覆盖并向父节点传播', () => {
    const upper = {
      ...createBlock('', { x: -1, y: 0 }, 1, 1, 1),
      initialVelocity: { x: 2, y: 3 },
      initialAngularVelocityRad: 0.4,
    }
    const lower = createBlock('', { x: 0, y: 0 }, 1, 1, 2)
    const extra = createBlock('', { x: 1, y: 0 }, 1, 1, 3)
    upper.id = uuid(1)
    lower.id = uuid(2)
    extra.id = uuid(3)
    const child = booleanNode('union', [entityItem(upper), entityItem(lower)], 20)
    const root = booleanNode('union', [child, entityItem(extra)], 30)
    const scene = createEmptyScene()
    scene.entities = [upper, lower, extra]
    scene.rootItems = [root]

    expect(resolvedBody(scene).initialVelocity).toEqual({ x: 2, y: 3 })
    expect(resolvedBody(scene).initialAngularVelocityRad).toBe(0.4)

    child.initialVelocity = { mode: 'override', value: { x: -5, y: 6 } }
    child.initialAngularVelocity = { mode: 'override', valueRadPerSecond: -0.7 }
    const childOverridden = resolvedBody(structuredClone(scene))
    expect(childOverridden.initialVelocity).toEqual({ x: -5, y: 6 })
    expect(childOverridden.initialAngularVelocityRad).toBe(-0.7)

    root.initialVelocity = { mode: 'override', value: { x: 8, y: 9 } }
    expect(resolvedBody(structuredClone(scene)).initialVelocity).toEqual({ x: 8, y: 9 })
    expect(resolvedBody(structuredClone(scene)).initialAngularVelocityRad).toBe(-0.7)
  })

  it('减法同步裁掉来源质量与电荷，并保留可穿过孔洞', () => {
    const upper = { ...createBlock('', { x: 0, y: 0 }, 4, 4, 1), massKg: 16, chargeC: 8 }
    const lower = createBlock('', { x: 0, y: 0 }, 2, 2, 2)
    const result = resolvedBody(bodyScene('difference', upper, lower).scene)

    expect(polygonMetrics(result.geometry).area).toBeCloseTo(12, 10)
    expect(result.massKg).toBeCloseTo(12, 10)
    expect(result.chargeC).toBeCloseTo(6, 10)
    expect(result.centerOfMass).toEqual({ x: 0, y: 0 })
    expect(pointInBooleanGeometry({ x: 0, y: 0 }, result.geometry)).toBe(false)
    expect(pointInBooleanGeometry({ x: 1.5, y: 0 }, result.geometry)).toBe(true)
    expect(result.collisionMeshes.length).toBeGreaterThan(0)
  })

  it.each([
    { blockSize: 1, radius: 0.1, offsetRatio: 0, exposesOldFalsePositive: false },
    { blockSize: 2, radius: 0.5, offsetRatio: 0, exposesOldFalsePositive: false },
    { blockSize: 6.5, radius: 0.5, offsetRatio: 0, exposesOldFalsePositive: true },
    { blockSize: 6.5, radius: 0.5, offsetRatio: 0.8, exposesOldFalsePositive: true },
    { blockSize: 10, radius: 2, offsetRatio: 0.25, exposesOldFalsePositive: false },
  ])(
    '块—球边界相交在 Float32 下保持有效：$blockSize m / $radius m / $offsetRatio',
    ({ blockSize, radius, offsetRatio, exposesOldFalsePositive }) => {
      const block = createBlock('', { x: 20, y: 5 }, blockSize, blockSize, 1)
      const ball = createBall(
        '',
        {
          x: 20 + blockSize / 2,
          y: 5 + radius * offsetRatio,
        },
        radius,
        2,
      )
      const result = resolvedBody(bodyScene('union', block, ball).scene)

      expect(result.convexParts.length).toBeGreaterThan(0)
      expect(result.collisionMeshes.length).toBeGreaterThan(0)
      expect(oldFloat32AreaCheckWouldReject(result)).toBe(exposesOldFalsePositive)
    },
  )

  it('只修改质量时采用真实结果面积均匀分布，电荷仍沿用来源分布', () => {
    const upper = { ...createBlock('', { x: -0.5, y: 0 }, 2, 2, 1), massKg: 2, chargeC: 8 }
    const lower = { ...createBlock('', { x: 1, y: 0 }, 1, 2, 2), massKg: 10, chargeC: -2 }
    const { scene, node } = bodyScene('union', upper, lower)
    node.massDistribution = { mode: 'uniform', totalMassKg: 30 }
    const result = resolvedBody(scene)

    expect(result.massKg).toBeCloseTo(30, 10)
    expect(result.massRegions).toHaveLength(1)
    expect(result.massRegions[0]?.sourceEntityId).toBe(node.resultId)
    expect(result.chargeC).toBeCloseTo(6, 10)
    expect(result.chargeRegions).toHaveLength(2)
    expect(result.centerOfMass.x).toBeCloseTo(0, 10)
  })

  it('只修改电荷不会改变来源质量分布', () => {
    const upper = { ...createBlock('', { x: -1, y: 0 }, 1, 1, 1), massKg: 1, chargeC: 4 }
    const lower = { ...createBlock('', { x: 1, y: 0 }, 1, 1, 2), massKg: 3, chargeC: -1 }
    const { scene, node } = bodyScene('union', upper, lower)
    node.chargeDistribution = { mode: 'uniform', totalChargeC: 12 }
    const result = resolvedBody(scene)

    expect(result.chargeC).toBeCloseTo(12, 10)
    expect(result.chargeRegions).toHaveLength(1)
    expect(result.massKg).toBeCloseTo(4, 10)
    expect(result.massRegions).toHaveLength(2)
    expect(result.centerOfMass.x).toBeCloseTo(0.5, 10)
  })

  it('子布尔均匀覆盖向父节点传播，父节点再次覆盖时以父节点为准', () => {
    const a = { ...createBall('', { x: -1, y: 0 }, 0.5, 1), massKg: 1 }
    const b = { ...createBall('', { x: 0, y: 0 }, 0.5, 2), massKg: 3 }
    const c = { ...createBall('', { x: 1, y: 0 }, 0.5, 3), massKg: 2 }
    a.id = uuid(1)
    b.id = uuid(2)
    c.id = uuid(3)
    const child = booleanNode('union', [entityItem(a), entityItem(b)], 20)
    child.massDistribution = { mode: 'uniform', totalMassKg: 8 }
    const root = booleanNode('union', [child, entityItem(c)], 30)
    const scene = createEmptyScene()
    scene.entities = [a, b, c]
    scene.rootItems = [root]
    expect(resolvedBody(scene).massKg).toBeCloseTo(10, 8)

    root.massDistribution = { mode: 'uniform', totalMassKg: 25 }
    const overridden = resolvedBody(structuredClone(scene))
    expect(overridden.massKg).toBeCloseTo(25, 8)
    expect(overridden.massRegions).toHaveLength(1)
  })

  it('完全覆盖的差集立即返回明确的上减下诊断', () => {
    const upper = createBlock('', { x: 0, y: 0 }, 2, 2, 1)
    const lower = createBlock('', { x: 0, y: 0 }, 4, 4, 2)
    const result = resolveBooleanScene(bodyScene('difference', upper, lower).scene).roots[0]

    expect(result?.valid).toBe(false)
    expect(result?.valid ? [] : result?.diagnostics).toContain(
      '上方输入已被下方完全覆盖；减法按上方减下方执行。',
    )
  })

  it('跨不可变场景复用未变化子树，只重算被修改来源的祖先', () => {
    const firstUpper = createBlock('', { x: -4, y: 0 }, 2, 2, 1)
    const firstLower = createBall('', { x: -4, y: 0 }, 0.5, 2)
    const secondUpper = createBlock('', { x: 4, y: 0 }, 2, 2, 3)
    const secondLower = createBall('', { x: 4, y: 0 }, 0.5, 4)
    ;[firstUpper.id, firstLower.id, secondUpper.id, secondLower.id] = [
      uuid(101),
      uuid(102),
      uuid(103),
      uuid(104),
    ]
    const first = booleanNode('difference', [entityItem(firstUpper), entityItem(firstLower)], 110)
    const second = booleanNode(
      'difference',
      [entityItem(secondUpper), entityItem(secondLower)],
      120,
    )
    const scene = createEmptyScene()
    scene.entities = [firstUpper, firstLower, secondUpper, secondLower]
    scene.rootItems = [first, second]
    const before = resolveBooleanScene(scene)
    const nextScene = {
      ...scene,
      entities: scene.entities.map((entity) =>
        entity.id === firstLower.id && entity.kind === 'body'
          ? {
              ...entity,
              transform: {
                ...entity.transform,
                position: { x: entity.transform.position.x + 0.25, y: entity.transform.position.y },
              },
            }
          : entity,
      ),
    }
    const after = resolveBooleanScene(nextScene)

    expect(after.byResultId.get(first.resultId)).not.toBe(before.byResultId.get(first.resultId))
    expect(after.byResultId.get(second.resultId)).toBe(before.byResultId.get(second.resultId))
  })

  it('跨深克隆复用稳定修订，整棵树刚体平移时复用局部网格', () => {
    const upper = createBlock('', { x: -0.5, y: 0 }, 3, 2, 1)
    const lower = createBall('', { x: 0.5, y: 0.4 }, 0.8, 2)
    const { scene } = bodyScene('difference', upper, lower)
    const before = resolvedBody(scene)
    expect(resolvedBody(structuredClone(scene))).toBe(before)

    const movedScene = structuredClone(scene)
    for (const entity of movedScene.entities) {
      if (entity.kind !== 'body') continue
      entity.transform.position.x += 4
      entity.transform.position.y -= 3
    }
    const moved = resolvedBody(movedScene)
    expect(moved.centerOfMass.x).toBeCloseTo(before.centerOfMass.x + 4, 10)
    expect(moved.centerOfMass.y).toBeCloseTo(before.centerOfMass.y - 3, 10)
    expect(moved.massKg).toBeCloseTo(before.massKg, 12)
    expect(moved.inertiaKgM2).toBeCloseTo(before.inertiaKgM2, 12)
    expect(moved.collisionMeshes[0]).toBe(before.collisionMeshes[0])
    expect(moved.convexParts[0]!.localPoints).toBe(before.convexParts[0]!.localPoints)
  })

  it('整棵树绕同一枢轴旋转时复用网格并只变换世界凸片', () => {
    const upper = createBlock('', { x: 1, y: 0 }, 3, 2, 1)
    const lower = createBall('', { x: 1.4, y: 0.3 }, 0.7, 2)
    const { scene } = bodyScene('union', upper, lower)
    const before = resolvedBody(scene)
    const rotatedScene = structuredClone(scene)
    const angle = Math.PI / 3
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    for (const entity of rotatedScene.entities) {
      if (entity.kind !== 'body') continue
      const { x, y } = entity.transform.position
      entity.transform.position = { x: x * cosine - y * sine, y: x * sine + y * cosine }
      entity.transform.angleRad += angle
    }
    const rotated = resolvedBody(rotatedScene)
    expect(rotated.angleRad).toBeCloseTo(before.angleRad + angle, 12)
    expect(rotated.centerOfMass.x).toBeCloseTo(
      before.centerOfMass.x * cosine - before.centerOfMass.y * sine,
      10,
    )
    expect(rotated.centerOfMass.y).toBeCloseTo(
      before.centerOfMass.x * sine + before.centerOfMass.y * cosine,
      10,
    )
    expect(rotated.collisionMeshes[0]).toBe(before.collisionMeshes[0])
    expect(rotated.convexParts[0]!.worldPoints).not.toEqual(before.convexParts[0]!.worldPoints)
  })
})
