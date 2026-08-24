import {
  compileScalarExpression,
  type CompiledScalarExpression,
} from '../expressions/scalarExpression'
import type { FieldDefinition, ScalarExpressionDefinition, Vec2 } from './types'

export function fieldDefinitionMagnitude(field: FieldDefinition): number {
  if (field.type === 'uniformMagnetic') return field.bzTesla
  const vector = field.type === 'uniformGravity' ? field.acceleration : field.strength
  return Math.hypot(vector.x, vector.y)
}

export function fieldDefinitionWithMagnitude(
  field: FieldDefinition,
  magnitude: number,
): FieldDefinition {
  if (field.type === 'uniformMagnetic') return { ...field, bzTesla: magnitude }
  const vector = field.type === 'uniformGravity' ? field.acceleration : field.strength
  const currentMagnitude = Math.hypot(vector.x, vector.y)
  const direction: Vec2 =
    currentMagnitude > Number.EPSILON
      ? { x: vector.x / currentMagnitude, y: vector.y / currentMagnitude }
      : field.type === 'uniformGravity'
        ? { x: 0, y: -1 }
        : { x: 1, y: 0 }
  const next = { x: direction.x * magnitude, y: direction.y * magnitude }
  return field.type === 'uniformGravity'
    ? { ...field, acceleration: next }
    : { ...field, strength: next }
}

export function fieldDefinitionWithExpression(
  field: FieldDefinition,
  magnitude: number,
  definition: ScalarExpressionDefinition | undefined,
): FieldDefinition {
  const next = fieldDefinitionWithMagnitude(field, magnitude)
  if (next.type === 'uniformMagnetic') {
    return definition
      ? { type: next.type, bzTesla: next.bzTesla, magnitudeExpression: definition }
      : { type: next.type, bzTesla: next.bzTesla }
  }
  if (next.type === 'uniformGravity') {
    return definition
      ? { type: next.type, acceleration: next.acceleration, magnitudeExpression: definition }
      : { type: next.type, acceleration: next.acceleration }
  }
  return { type: next.type, strength: next.strength }
}

export function electricFieldWithComponentExpression(
  field: Extract<FieldDefinition, { type: 'uniformElectric' }>,
  component: 'x' | 'y',
  value: number,
  definition: ScalarExpressionDefinition | undefined,
): Extract<FieldDefinition, { type: 'uniformElectric' }> {
  const componentExpressions = { ...field.componentExpressions }
  if (definition) componentExpressions[component] = definition
  else delete componentExpressions[component]
  return {
    type: 'uniformElectric',
    strength: { ...field.strength, [component]: value },
    ...(componentExpressions.x || componentExpressions.y ? { componentExpressions } : {}),
  }
}

export function compileScalarDefinition(
  definition: ScalarExpressionDefinition | undefined,
  variableNames: ReadonlySet<string>,
): CompiledScalarExpression | null {
  return definition
    ? compileScalarExpression(definition.expression, { allowTime: true, variableNames })
    : null
}

export interface CompiledFieldDefinitionExpressions {
  magnitude: CompiledScalarExpression | null
  x: CompiledScalarExpression | null
  y: CompiledScalarExpression | null
}

export function compileFieldDefinitionExpressions(
  field: FieldDefinition,
  variableNames: ReadonlySet<string>,
): CompiledFieldDefinitionExpressions {
  return field.type === 'uniformElectric'
    ? {
        magnitude: null,
        x: compileScalarDefinition(field.componentExpressions?.x, variableNames),
        y: compileScalarDefinition(field.componentExpressions?.y, variableNames),
      }
    : {
        magnitude: compileScalarDefinition(field.magnitudeExpression, variableNames),
        x: null,
        y: null,
      }
}

export function evaluateFieldDefinition(
  field: FieldDefinition,
  time: number,
  variables: Readonly<Record<string, number>>,
  compiled: CompiledFieldDefinitionExpressions = compileFieldDefinitionExpressions(
    field,
    new Set(Object.keys(variables)),
  ),
): FieldDefinition | null {
  if (field.type === 'uniformElectric') {
    if (!field.componentExpressions?.x && !field.componentExpressions?.y) return field
    const evaluateComponent = (
      component: 'x' | 'y',
      definition: ScalarExpressionDefinition | undefined,
    ): number | null => {
      if (!definition) return field.strength[component]
      return compiled[component]?.evaluate({ time, variables }) ?? null
    }
    const x = evaluateComponent('x', field.componentExpressions.x)
    const y = evaluateComponent('y', field.componentExpressions.y)
    return x === null || y === null ? null : { ...field, strength: { x, y } }
  }
  if (!field.magnitudeExpression) return field
  const magnitude = compiled.magnitude?.evaluate({ time, variables }) ?? null
  return magnitude === null ? null : fieldDefinitionWithMagnitude(field, magnitude)
}
