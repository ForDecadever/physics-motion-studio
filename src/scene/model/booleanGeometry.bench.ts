import { bench, describe } from 'vitest'

import { createEmptyScene } from './createEmptyScene'
import { createBlock } from './entityFactories'
import { createBooleanLayer } from './layerFactories'
import { resolveBooleanScene, transformBooleanBodyGeometry } from './booleanGeometry'
import type { BooleanNode, SceneTreeItem } from './types'

const scene = createEmptyScene('32 叶布尔树基准', new Date('2026-08-11T00:00:00.000Z'))
let leafIndex = 0

function buildNode(depth: number): BooleanNode {
  const layer = createBooleanLayer('union', `布尔节点 ${depth}-${leafIndex}`)
  const operands: SceneTreeItem[] = []
  if (depth === 1) {
    for (let index = 0; index < 2; index += 1) {
      const current = leafIndex++
      const block = createBlock(
        layer.id,
        { x: (current % 8) * 1.1, y: Math.floor(current / 8) * 1.1 },
        1.2,
        1.2,
        current + 1,
      )
      block.transform.angleRad = ((current % 7) * Math.PI) / 36
      scene.entities.push(block)
      operands.push({ kind: 'entity', entityId: block.id })
    }
  } else {
    const upper = buildNode(depth - 1)
    const lower = buildNode(depth - 1)
    operands.push(upper, lower)
  }
  layer.operands = operands
  return layer
}

scene.rootItems = [buildNode(5)]
resolveBooleanScene(scene)

const independentScene = createEmptyScene('32 个独立布尔预览')
for (let index = 0; index < 32; index += 1) {
  const upper = createBlock('', { x: index * 3, y: 0 }, 2, 1, index * 2 + 1)
  const lower = createBlock('', { x: index * 3 + 0.5, y: 0 }, 1, 2, index * 2 + 2)
  independentScene.entities.push(upper, lower)
  independentScene.rootItems.push(
    createBooleanLayer('union', `独立布尔 ${index + 1}`, [
      { kind: 'entity', entityId: upper.id },
      { kind: 'entity', entityId: lower.id },
    ]),
  )
}
const independentResults = resolveBooleanScene(independentScene).roots.flatMap((result) =>
  result.valid && result.kind === 'body' ? [result] : [],
)

const emptyUpper = createBlock('', { x: 0, y: 0 }, 2, 2, 1)
const emptyLower = createBlock('', { x: 0, y: 0 }, 4, 4, 2)
const emptyNode = createBooleanLayer('difference', '空差集', [
  { kind: 'entity', entityId: emptyUpper.id },
  { kind: 'entity', entityId: emptyLower.id },
])
let revision = 0
let fullRecomputeRevision = 0

describe('布尔解析编辑性能', () => {
  bench(
    '32 个叶节点统一平移后的提交解析（刚体快速路径）',
    () => {
      revision += 1
      const delta = revision * 1e-7
      resolveBooleanScene({
        ...scene,
        entities: scene.entities.map((entity) =>
          entity.kind === 'body'
            ? {
                ...entity,
                transform: {
                  ...entity.transform,
                  position: {
                    x: entity.transform.position.x + delta,
                    y: entity.transform.position.y - delta,
                  },
                },
              }
            : entity,
        ),
      })
    },
    { time: 1000, warmupTime: 200 },
  )

  bench(
    '32 个独立布尔结果统一移动后的主线程提交解析',
    () => {
      revision += 1
      const delta = revision * 1e-7
      resolveBooleanScene({
        ...independentScene,
        entities: independentScene.entities.map((entity) =>
          entity.kind === 'body'
            ? {
                ...entity,
                transform: {
                  ...entity.transform,
                  position: {
                    x: entity.transform.position.x + delta,
                    y: entity.transform.position.y + delta,
                  },
                },
              }
            : entity,
        ),
      })
    },
    { time: 1000, warmupTime: 200 },
  )

  bench(
    '32 个叶节点的嵌套树完整重算',
    () => {
      fullRecomputeRevision += 1
      const sizeDelta = (fullRecomputeRevision % 10_000) * 1e-9
      resolveBooleanScene({
        ...scene,
        entities: scene.entities.map((entity) =>
          entity.kind === 'body' && entity.shape.type === 'box'
            ? {
                ...entity,
                shape: { ...entity.shape, width: entity.shape.width + sizeDelta },
              }
            : entity,
        ),
      })
    },
    { time: 1000, warmupTime: 200 },
  )

  bench(
    '32 个独立两输入布尔结果连续移动预览（不执行 CSG）',
    () => {
      revision += 1
      const delta = revision * 1e-6
      for (const result of independentResults) {
        transformBooleanBodyGeometry(result, {
          x: result.centerOfMass.x + delta,
          y: result.centerOfMass.y - delta,
        })
      }
    },
    { time: 1000, warmupTime: 200 },
  )

  bench(
    '两输入空差集提前终止',
    () => {
      revision += 1
      resolveBooleanScene({
        ...independentScene,
        entities: [
          { ...emptyUpper, transform: { ...emptyUpper.transform } },
          { ...emptyLower, transform: { ...emptyLower.transform } },
        ],
        rootItems: [{ ...emptyNode, id: `${emptyNode.id}:${revision}` }],
      })
    },
    { time: 1000, warmupTime: 200 },
  )
})
