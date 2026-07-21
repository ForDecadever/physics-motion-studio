import { z } from 'zod'

import { CURRENT_SCHEMA_VERSION, type SceneDocument } from '../model/types'

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
    collisionSide: z.enum(['normal', 'both']),
    normalFlipped: z.boolean(),
  })
  .passthrough()

const bodyShapeSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('particle'),
      collisionRadius: positiveNumber,
      collisionEnabled: z.boolean(),
    })
    .passthrough(),
  z.object({ type: z.literal('circle'), radius: positiveNumber }).passthrough(),
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
    preset: z.enum(['particle', 'ball', 'block', 'pointCharge']),
    shape: bodyShapeSchema,
    transform: transformSchema,
    massKg: positiveNumber,
    chargeC: finiteNumber,
    material: materialSchema,
    initialVelocity: vec2Schema,
    initialAngularVelocityRad: finiteNumber,
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
  z.object({ type: z.literal('circle'), center: vec2Schema, radius: positiveNumber }).passthrough(),
  z
    .object({
      type: z.literal('polygon'),
      points: z.array(vec2Schema).min(3),
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
  bodyEntitySchema,
  fieldEntitySchema,
  connectorEntitySchema,
])

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
  })
  .passthrough()

export function validateSceneDocument(input: unknown): SceneDocument {
  return sceneDocumentSchema.parse(input) as SceneDocument
}
