import { z } from 'zod'

import { compileChartAxis } from '../../features/charts/chartAxis'
import {
  MAX_CHARTS,
  MAX_CHART_SERIES,
  MAX_CHART_SERIES_PER_CHART,
  MAX_RECORDED_CHART_BODIES,
} from '../model/chartDefaults'
import { CURRENT_SCHEMA_VERSION, type ChartDefinition, type SceneDocument } from '../model/types'

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

const baseEntityShape = {
  id: entityId,
  name: z.string().trim().min(1).max(120),
  layerId: entityId,
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
])

const bodyEntitySchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('body'),
    preset: z.enum(['ball', 'block']),
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
      nodes: z
        .array(
          z
            .object({
              anchor: vec2Schema,
              inHandle: vec2Schema,
              outHandle: vec2Schema,
            })
            .passthrough(),
        )
        .min(3),
    })
    .passthrough(),
])

const fieldDefinitionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('uniformGravity'), acceleration: vec2Schema }).passthrough(),
  z.object({ type: z.literal('uniformElectric'), strength: vec2Schema }).passthrough(),
  z.object({ type: z.literal('uniformMagnetic'), bzTesla: finiteNumber }).passthrough(),
])

const fieldEntitySchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('field'),
    region: fieldRegionSchema,
    field: fieldDefinitionSchema,
  })
  .passthrough()

const endpointSchema = z
  .object({
    bodyId: entityId,
    localAnchor: vec2Schema,
  })
  .passthrough()

const connectorDefinitionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rope'), maxLength: positiveNumber }).passthrough(),
  z
    .object({
      type: z.literal('rod'),
      length: positiveNumber,
      freeRotation: z.boolean(),
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
  })
  .passthrough()

const sceneEntitySchema = z.discriminatedUnion('kind', [
  groundEntitySchema,
  groundJointEntitySchema,
  bodyEntitySchema,
  fieldEntitySchema,
  connectorEntitySchema,
])

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
    layers: z
      .array(
        z
          .object({
            id: entityId,
            name: z.string().trim().min(1).max(120),
            visible: z.boolean(),
            locked: z.boolean(),
          })
          .passthrough(),
      )
      .min(1),
    entities: z.array(sceneEntitySchema),
    charts: z.array(chartDefinitionSchema).max(MAX_CHARTS),
  })
  .passthrough()
  .superRefine((scene, context) => {
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
  return sceneDocumentSchema.parse(input) as SceneDocument
}
