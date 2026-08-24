import { z } from 'zod'

import { compileChartAxis } from '../../features/charts/chartAxis'
import {
  MAX_CHARTS,
  MAX_CHART_SERIES,
  MAX_CHART_SERIES_PER_CHART,
  MAX_RECORDED_CHART_BODIES,
} from '../model/chartDefaults'
import { MAX_BOOLEAN_OPERANDS, validateBooleanLayerGraph } from '../model/booleanLayerGraph'
import { analyzeBezierBodyPath } from '../model/bodyPath'
import { compileScalarExpression } from '../expressions/scalarExpression'
import { recomputePropertyExpressions, resolveGlobalVariables } from '../model/propertyExpressions'
import {
  isBooleanNumericProperty,
  isEntityNumericProperty,
  isSceneNumericProperty,
} from '../model/numericPropertyRegistry'
import { resolveBooleanScene } from '../model/booleanGeometry'
import {
  CURRENT_SCHEMA_VERSION,
  type BezierPathNode,
  type ChartDefinition,
  type SceneDocument,
  type SceneTreeItem,
} from '../model/types'

const finiteNumber = z.number().finite()
const positiveNumber = finiteNumber.positive()
const entityId = z.string().uuid()

const vec2Schema = z
  .object({
    x: finiteNumber,
    y: finiteNumber,
  })
  .passthrough()

const transformSchema = z
  .object({
    position: vec2Schema,
    angleRad: finiteNumber,
  })
  .passthrough()

const materialSchema = z
  .object({
    friction: finiteNumber.min(0).max(5),
    restitution: finiteNumber.min(0).max(1),
  })
  .passthrough()

const scalarExpressionDefinitionSchema = z
  .object({
    expression: z.string().trim().min(1).max(256),
    fallbackValue: finiteNumber,
  })
  .passthrough()

const bezierPathNodeSchema = z
  .object({
    anchor: vec2Schema,
    inHandle: vec2Schema,
    outHandle: vec2Schema,
    collapsedHandles: z
      .object({
        inOffset: vec2Schema,
        outOffset: vec2Schema,
      })
      .optional(),
  })
  .passthrough()
  .superRefine((node, context) => {
    if (
      node.collapsedHandles &&
      (node.inHandle.x !== node.anchor.x ||
        node.inHandle.y !== node.anchor.y ||
        node.outHandle.x !== node.anchor.x ||
        node.outHandle.y !== node.anchor.y)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '折叠贝塞尔节点的可见控制棒必须与锚点重合。',
      })
    }
  })

const baseEntityShape = {
  id: entityId,
  name: z.string().trim().min(1).max(120),
  visible: z.boolean(),
  locked: z.boolean(),
  simulationEnabled: z.boolean(),
}

const groundGeometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('line'), start: vec2Schema, end: vec2Schema }).passthrough(),
  z
    .object({
      type: z.literal('arc'),
      center: vec2Schema,
      radius: positiveNumber,
      startRad: finiteNumber,
      endRad: finiteNumber,
    })
    .passthrough(),
  z
    .object({
      type: z.literal('cubicBezier'),
      p0: vec2Schema,
      p1: vec2Schema,
      p2: vec2Schema,
      p3: vec2Schema,
    })
    .passthrough(),
])

const groundEntitySchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('ground'),
    geometry: groundGeometrySchema,
    material: materialSchema,
    conveyor: z
      .object({
        enabled: z.boolean(),
        direction: z.enum(['forward', 'reverse']),
        speedMps: finiteNumber.min(0),
      })
      .passthrough(),
    collisionSide: z.literal('both'),
    normalFlipped: z.literal(false),
  })
  .passthrough()

const groundEndpointSchema = z
  .object({
    groundId: entityId,
    endpoint: z.enum(['start', 'end']),
  })
  .passthrough()

const groundJointTransitionSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('auto'),
      directionFlipped: z.boolean(),
    })
    .passthrough(),
  z
    .object({
      mode: z.literal('manual'),
      lengthM: finiteNumber.min(0),
      directionFlipped: z.boolean(),
    })
    .passthrough(),
])

const groundJointEntitySchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('groundJoint'),
    a: groundEndpointSchema,
    b: groundEndpointSchema,
    transition: groundJointTransitionSchema,
  })
  .passthrough()

const bodyShapeSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('circle'), radius: positiveNumber, collisionEnabled: z.boolean() })
    .passthrough(),
  z
    .object({
      type: z.literal('box'),
      width: positiveNumber,
      height: positiveNumber,
    })
    .passthrough(),
  z
    .object({
      type: z.literal('bezierPath'),
      nodes: z.array(bezierPathNodeSchema).min(3).max(2_048),
    })
    .passthrough(),
])

const bodyEntitySchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('body'),
    preset: z.enum(['ball', 'block']),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    shape: bodyShapeSchema,
    transform: transformSchema,
    massKg: positiveNumber,
    chargeC: finiteNumber,
    material: materialSchema,
    initialVelocity: vec2Schema,
    initialAngularVelocityRad: finiteNumber,
    rotationEnabled: z.boolean(),
    continuousCollisionDetection: z.boolean(),
  })
  .passthrough()

const fieldRegionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('infinite') }).passthrough(),
  z
    .object({
      type: z.literal('rectangle'),
      center: vec2Schema,
      width: positiveNumber,
      height: positiveNumber,
      angleRad: finiteNumber,
    })
    .passthrough(),
  z
    .object({
      type: z.literal('circle'),
      center: vec2Schema,
      radius: positiveNumber,
      startRad: finiteNumber,
      sweepRad: finiteNumber.min(-Math.PI * 2).max(Math.PI * 2),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('polygon'),
      points: z.array(vec2Schema).min(3),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('bezierPath'),
      nodes: z.array(bezierPathNodeSchema).min(3),
    })
    .passthrough(),
])

const fieldDefinitionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('uniformGravity'),
      acceleration: vec2Schema,
      magnitudeExpression: scalarExpressionDefinitionSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('uniformElectric'),
      strength: vec2Schema,
      componentExpressions: z
        .object({
          x: scalarExpressionDefinitionSchema.optional(),
          y: scalarExpressionDefinitionSchema.optional(),
        })
        .optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('uniformMagnetic'),
      bzTesla: finiteNumber,
      magnitudeExpression: scalarExpressionDefinitionSchema.optional(),
    })
    .passthrough(),
])

const fieldEntitySchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('field'),
    region: fieldRegionSchema,
    field: fieldDefinitionSchema,
  })
  .passthrough()

const endpointSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('body'), bodyId: entityId, localAnchor: vec2Schema }).passthrough(),
  z
    .object({
      type: z.literal('ground'),
      groundId: entityId,
      pathRatio: finiteNumber.min(0).max(1),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('groundJoint'),
      groundJointId: entityId,
      pathRatio: finiteNumber.min(0).max(1),
    })
    .passthrough(),
  z.object({ type: z.literal('world'), position: vec2Schema }).passthrough(),
  z.object({ type: z.literal('free'), position: vec2Schema }).passthrough(),
])

const connectorDefinitionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rope'), maxLength: positiveNumber }).passthrough(),
  z
    .object({
      type: z.literal('rod'),
      length: positiveNumber,
      endpointRotation: z
        .object({ a: z.enum(['free', 'fixed']), b: z.enum(['free', 'fixed']) })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('spring'),
      restLength: positiveNumber,
      stiffness: finiteNumber.min(0),
      damping: finiteNumber.min(0),
    })
    .passthrough(),
])

const connectorEntitySchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('connector'),
    a: endpointSchema,
    b: endpointSchema,
    connector: connectorDefinitionSchema,
    collisionEnabled: z.boolean(),
    radiusM: positiveNumber,
    massKg: finiteNumber.min(0),
    material: materialSchema,
  })
  .passthrough()

const particleSourceShapeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('point'), position: vec2Schema }).passthrough(),
  z.object({ type: z.literal('line'), start: vec2Schema, end: vec2Schema }).passthrough(),
])

const particleSourceEntitySchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('particleSource'),
    shape: particleSourceShapeSchema,
    directionRad: finiteNumber,
    spreadRad: finiteNumber.min(0).max(Math.PI * 2),
    densityPerDegree: finiteNumber.min(0.01).max(10),
    flipEmission: z.boolean(),
    continuousEmission: z
      .object({
        enabled: z.boolean(),
        simultaneous: z.boolean(),
        intervalSeconds: finiteNumber.min(1 / 120).max(3600),
        lifetimeSeconds: finiteNumber.min(1 / 120).max(86400),
      })
      .passthrough(),
    speedMps: finiteNumber.min(0),
    chargeC: finiteNumber,
    massKg: positiveNumber,
    coulombEnabled: z.boolean(),
  })
  .passthrough()

const forceEntitySchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('force'),
    bodyId: entityId,
    localAnchor: vec2Schema,
    magnitudeN: finiteNumber,
    directionRad: finiteNumber,
    magnitudeExpression: scalarExpressionDefinitionSchema.optional(),
    directionDegreesExpression: scalarExpressionDefinitionSchema.optional(),
  })
  .passthrough()

const measurementDefinitionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('marker'),
      points: z.array(vec2Schema).min(2).max(4096),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      lineWidthM: finiteNumber.min(0.001).max(1),
    })
    .passthrough(),
  z.object({ type: z.literal('ruler'), a: vec2Schema, b: vec2Schema }).passthrough(),
  z
    .object({ type: z.literal('protractor'), a: vec2Schema, vertex: vec2Schema, b: vec2Schema })
    .passthrough(),
])

const measurementEntitySchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('measurement'),
    simulationEnabled: z.literal(false),
    measurement: measurementDefinitionSchema,
  })
  .passthrough()

const sceneEntitySchema = z.discriminatedUnion('kind', [
  groundEntitySchema,
  groundJointEntitySchema,
  bodyEntitySchema,
  fieldEntitySchema,
  connectorEntitySchema,
  particleSourceEntitySchema,
  forceEntitySchema,
  measurementEntitySchema,
])

const entityNumericPropertySchema = z.string().refine(isEntityNumericProperty, {
  message: '不支持的实体数值属性目标。',
})
const propertyExpressionTargetSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('entity'), entityId, property: entityNumericPropertySchema })
    .passthrough(),
  z
    .object({
      type: z.literal('boolean'),
      nodeId: entityId,
      property: z.string().refine(isBooleanNumericProperty, {
        message: '不支持的布尔数值属性目标。',
      }),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('scene'),
      property: z.string().refine(isSceneNumericProperty, {
        message: '不支持的场景数值属性目标。',
      }),
    })
    .passthrough(),
])

const globalVariableSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
    expression: z.string().trim().min(1).max(256),
    value: finiteNumber,
  })
  .passthrough()

const propertyExpressionBindingSchema = z
  .object({
    id: entityId,
    target: propertyExpressionTargetSchema,
    expression: z.string().trim().min(1).max(256),
    fallbackValue: finiteNumber,
  })
  .passthrough()

const sourceDistributionSchema = z.object({ mode: z.literal('source') }).passthrough()
const massDistributionSchema = z.discriminatedUnion('mode', [
  sourceDistributionSchema,
  z.object({ mode: z.literal('uniform'), totalMassKg: positiveNumber }).passthrough(),
])
const chargeDistributionSchema = z.discriminatedUnion('mode', [
  sourceDistributionSchema,
  z.object({ mode: z.literal('uniform'), totalChargeC: finiteNumber }).passthrough(),
])
const fieldDistributionSchema = z.discriminatedUnion('mode', [
  sourceDistributionSchema,
  z.object({ mode: z.literal('uniform'), field: fieldDefinitionSchema }).passthrough(),
])
const scalarDistributionSchema = z.discriminatedUnion('mode', [
  sourceDistributionSchema,
  z.object({ mode: z.literal('uniform'), value: finiteNumber }).passthrough(),
])
const initialVelocitySchema = z.discriminatedUnion('mode', [
  sourceDistributionSchema,
  z.object({ mode: z.literal('override'), value: vec2Schema }).passthrough(),
])
const initialAngularVelocitySchema = z.discriminatedUnion('mode', [
  sourceDistributionSchema,
  z.object({ mode: z.literal('override'), valueRadPerSecond: finiteNumber }).passthrough(),
])
const sceneTreeItemSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('entity'), entityId }).passthrough(),
    z
      .object({
        kind: z.literal('boolean'),
        id: entityId,
        resultId: entityId,
        name: z.string().trim().min(1).max(120),
        visible: z.boolean(),
        locked: z.boolean(),
        operation: z.enum(['union', 'intersection', 'difference']),
        operands: z.array(sceneTreeItemSchema).max(MAX_BOOLEAN_OPERANDS),
        simulationEnabled: z.boolean(),
        rotationEnabled: z.boolean(),
        continuousCollisionDetection: z.boolean(),
        massDistribution: massDistributionSchema,
        chargeDistribution: chargeDistributionSchema,
        fieldDistribution: fieldDistributionSchema,
        frictionDistribution: scalarDistributionSchema.refine(
          (distribution) =>
            distribution.mode === 'source' || (distribution.value >= 0 && distribution.value <= 5),
          '摩擦系数必须在 0 到 5 之间。',
        ),
        restitutionDistribution: scalarDistributionSchema.refine(
          (distribution) =>
            distribution.mode === 'source' || (distribution.value >= 0 && distribution.value <= 1),
          '弹性系数必须在 0 到 1 之间。',
        ),
        initialVelocity: initialVelocitySchema,
        initialAngularVelocity: initialAngularVelocitySchema,
      })
      .passthrough(),
  ]),
)

const chartMetricIdSchema = z.enum([
  'time',
  'positionX',
  'positionY',
  'velocityX',
  'velocityY',
  'speed',
  'acceleration',
  'angle',
  'angularVelocity',
  'netForce',
  'kineticEnergy',
  'translationalKineticEnergy',
  'rotationalKineticEnergy',
])

const chartAxisSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('metric'), metricId: chartMetricIdSchema }).passthrough(),
  z
    .object({
      type: z.literal('expression'),
      expression: z.string().trim().min(1).max(256),
    })
    .passthrough(),
])

const chartBindingSchema = z
  .object({
    alias: z.string().regex(/^[A-Z]$/),
    entityId,
  })
  .passthrough()

const chartSeriesSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    entityId,
    visible: z.boolean(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    lineStyle: z.enum(['solid', 'dashed', 'dotted']),
    lineWidth: finiteNumber.min(1).max(6),
  })
  .passthrough()

const chartDefinitionSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(80),
    xAxis: chartAxisSchema,
    yAxis: chartAxisSchema,
    bindings: z.array(chartBindingSchema).max(26),
    series: z.array(chartSeriesSchema).max(MAX_CHART_SERIES_PER_CHART),
  })
  .passthrough()
  .superRefine((chart, context) => {
    if (new Set(chart.bindings.map((binding) => binding.alias)).size !== chart.bindings.length) {
      context.addIssue({ code: 'custom', message: '同一坐标系中的物体引用别名不能重复。' })
    }
    if (new Set(chart.series.map((series) => series.entityId)).size !== chart.series.length) {
      context.addIssue({ code: 'custom', message: '同一坐标系不能重复添加同一个物体。' })
    }
    for (const [axisName, axis] of [
      ['xAxis', chart.xAxis],
      ['yAxis', chart.yAxis],
    ] as const) {
      try {
        compileChartAxis(chart as ChartDefinition, axis)
      } catch (error) {
        context.addIssue({
          code: 'custom',
          path: [axisName],
          message: error instanceof Error ? error.message : '坐标轴公式无效。',
        })
      }
    }
  })

export const sceneDocumentSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    appVersion: z.string().min(1),
    metadata: z
      .object({
        name: z.string().trim().min(1).max(120),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
      })
      .passthrough(),
    settings: z
      .object({
        fixedTimeStep: positiveNumber.max(1),
        gridStep: positiveNumber,
        snapStep: positiveNumber,
        pairwiseElectrostatics: z.boolean(),
        recordingSampleRate: finiteNumber.int().min(1).max(120),
        recordingDurationSeconds: finiteNumber.int().min(1).max(3600),
      })
      .passthrough(),
    globalVariables: z.array(globalVariableSchema).max(64),
    propertyExpressions: z.array(propertyExpressionBindingSchema).max(512),
    rootItems: z.array(sceneTreeItemSchema),
    entities: z.array(sceneEntitySchema),
    charts: z.array(chartDefinitionSchema).max(MAX_CHARTS),
  })
  .passthrough()
  .superRefine((scene, context) => {
    for (const issue of validateBooleanLayerGraph(scene as SceneDocument)) {
      context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
    }
    let globalNames = new Set<string>()
    try {
      const resolved = resolveGlobalVariables(scene.globalVariables)
      globalNames = new Set(Object.keys(resolved.values))
      recomputePropertyExpressions(scene as SceneDocument)
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['globalVariables'],
        message: error instanceof Error ? error.message : '全局变量或属性表达式无效。',
      })
    }
    const booleanBodyIds = new Set(
      resolveBooleanScene(scene as SceneDocument).roots.flatMap((result) =>
        result.valid && result.kind === 'body' ? [result.resultId] : [],
      ),
    )
    const ordinaryBodyIds = new Set(
      scene.entities.flatMap((entity) => (entity.kind === 'body' ? [entity.id] : [])),
    )
    scene.entities.forEach((entity, index) => {
      if (entity.kind === 'field') {
        const definitions: Array<{
          path: string[]
          definition: { expression: string; fallbackValue: number } | undefined
        }> =
          entity.field.type === 'uniformElectric'
            ? [
                {
                  path: ['componentExpressions', 'x'],
                  definition: entity.field.componentExpressions?.x,
                },
                {
                  path: ['componentExpressions', 'y'],
                  definition: entity.field.componentExpressions?.y,
                },
              ]
            : [
                {
                  path: ['magnitudeExpression'],
                  definition: entity.field.magnitudeExpression,
                },
              ]
        for (const { path, definition } of definitions) {
          if (!definition) continue
          try {
            compileScalarExpression(definition.expression, {
              allowTime: true,
              variableNames: globalNames,
            })
          } catch (error) {
            context.addIssue({
              code: 'custom',
              path: ['entities', index, 'field', ...path],
              message: error instanceof Error ? error.message : '场强表达式无效。',
            })
          }
        }
      }
      if (entity.kind === 'force') {
        if (!ordinaryBodyIds.has(entity.bodyId) && !booleanBodyIds.has(entity.bodyId)) {
          context.addIssue({
            code: 'custom',
            path: ['entities', index, 'bodyId'],
            message: '力工具必须锚定有效的普通刚体或根布尔刚体。',
          })
        }
        for (const [property, definition] of [
          ['magnitudeExpression', entity.magnitudeExpression],
          ['directionDegreesExpression', entity.directionDegreesExpression],
        ] as const) {
          if (!definition) continue
          try {
            compileScalarExpression(definition.expression, {
              allowTime: true,
              variableNames: globalNames,
            })
          } catch (error) {
            context.addIssue({
              code: 'custom',
              path: ['entities', index, property],
              message: error instanceof Error ? error.message : '力表达式无效。',
            })
          }
        }
      }
      if (entity.kind === 'body' && entity.shape.type === 'bezierPath') {
        for (const diagnostic of analyzeBezierBodyPath(entity.shape.nodes as BezierPathNode[])
          .diagnostics) {
          context.addIssue({
            code: 'custom',
            path: ['entities', index, 'shape', 'nodes'],
            message: diagnostic,
          })
        }
      }
      if (entity.kind !== 'connector') return
      const hasFreeEndpoint = entity.a.type === 'free' || entity.b.type === 'free'
      if (hasFreeEndpoint && entity.connector.type !== 'spring') {
        context.addIssue({
          code: 'custom',
          path: ['entities', index],
          message: '只有弹簧可以使用自由端点。',
        })
      }
      if (entity.connector.type === 'rope') {
        const validMass = entity.collisionEnabled ? entity.massKg >= 0.001 : entity.massKg === 0
        if (!validMass) {
          context.addIssue({
            code: 'custom',
            path: ['entities', index, 'massKg'],
            message: entity.collisionEnabled
              ? '开启碰撞的绳质量不得低于 0.001 kg。'
              : '关闭碰撞的绳质量必须为 0 kg。',
          })
        }
      }
      if (entity.connector.type === 'spring' && entity.massKg !== 0) {
        context.addIssue({
          code: 'custom',
          path: ['entities', index, 'massKg'],
          message: '弹簧质量固定为 0 kg。',
        })
      }
      if (entity.connector.type === 'spring' && entity.collisionEnabled) {
        context.addIssue({
          code: 'custom',
          path: ['entities', index, 'collisionEnabled'],
          message: '弹簧的普通碰撞必须关闭。',
        })
      }
    })
    const validateBooleanFieldExpressions = (
      items: readonly SceneTreeItem[],
      path: (string | number)[],
    ): void => {
      items.forEach((item, index) => {
        if (item.kind !== 'boolean') return
        const field =
          item.fieldDistribution.mode === 'uniform' ? item.fieldDistribution.field : undefined
        const definitions: Array<{
          path: string[]
          definition: { expression: string; fallbackValue: number } | undefined
        }> = field
          ? field.type === 'uniformElectric'
            ? [
                {
                  path: ['componentExpressions', 'x'],
                  definition: field.componentExpressions?.x,
                },
                {
                  path: ['componentExpressions', 'y'],
                  definition: field.componentExpressions?.y,
                },
              ]
            : [{ path: ['magnitudeExpression'], definition: field.magnitudeExpression }]
          : []
        for (const { path: definitionPath, definition } of definitions) {
          if (!definition) continue
          try {
            compileScalarExpression(definition.expression, {
              allowTime: true,
              variableNames: globalNames,
            })
          } catch (error) {
            context.addIssue({
              code: 'custom',
              path: [...path, index, 'fieldDistribution', 'field', ...definitionPath],
              message: error instanceof Error ? error.message : '布尔场强表达式无效。',
            })
          }
        }
        validateBooleanFieldExpressions(item.operands, [...path, index, 'operands'])
      })
    }
    validateBooleanFieldExpressions(scene.rootItems as SceneTreeItem[], ['rootItems'])
    const totalSeries = scene.charts.reduce((total, chart) => total + chart.series.length, 0)
    if (totalSeries > MAX_CHART_SERIES) {
      context.addIssue({
        code: 'custom',
        path: ['charts'],
        message: `全部坐标系最多包含 ${MAX_CHART_SERIES} 条曲线。`,
      })
    }
    const referencedBodies = new Set(
      scene.charts.flatMap((chart) => [
        ...chart.series.map((series) => series.entityId),
        ...chart.bindings.map((binding) => binding.entityId),
      ]),
    )
    if (referencedBodies.size > MAX_RECORDED_CHART_BODIES) {
      context.addIssue({
        code: 'custom',
        path: ['charts'],
        message: `图表最多引用 ${MAX_RECORDED_CHART_BODIES} 个物体。`,
      })
    }
  })

export function validateSceneDocument(input: unknown): SceneDocument {
  const parsed = sceneDocumentSchema.parse(input) as SceneDocument
  const variables = resolveGlobalVariables(parsed.globalVariables)
  return recomputePropertyExpressions(parsed, variables.definitions)
}
