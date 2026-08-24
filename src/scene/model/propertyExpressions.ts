import {
  compileScalarExpression,
  scalarExpressionReservedNames,
  ScalarExpressionError,
} from '../expressions/scalarExpression'
import { applyNumericPropertyTarget } from './numericPropertyRegistry'
import type {
  GlobalVariableDefinition,
  PropertyExpressionBinding,
  PropertyExpressionTarget,
  SceneDocument,
} from './types'

const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/
const NUMERIC_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const OFFSET_EXPRESSION = /^\(([\s\S]+)\)([+-])((?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/

export function propertyExpressionTargetKey(target: PropertyExpressionTarget): string {
  if (target.type === 'scene') return `scene:${target.property}`
  return `${target.type}:${target.type === 'entity' ? target.entityId : target.nodeId}:${target.property}`
}

export function resolveGlobalVariables(definitions: readonly GlobalVariableDefinition[]): {
  definitions: GlobalVariableDefinition[]
  values: Record<string, number>
} {
  const values: Record<string, number> = {}
  const resolved: GlobalVariableDefinition[] = []
  const seen = new Set<string>()
  for (const definition of definitions) {
    const name = definition.name.trim()
    const expression = definition.expression.trim()
    if (!VARIABLE_NAME.test(name)) {
      throw new ScalarExpressionError(`全局变量“${name || '（空）'}”必须以英文字母开头。`)
    }
    if (scalarExpressionReservedNames.has(name)) {
      throw new ScalarExpressionError(`“${name}”是时间、常量或内置函数名，不能作为全局变量。`)
    }
    if (seen.has(name)) throw new ScalarExpressionError(`全局变量“${name}”重复。`)
    const compiled = compileScalarExpression(expression, { variableNames: seen })
    const value = compiled.evaluate({ time: 0, variables: values })
    if (value === null) throw new ScalarExpressionError(`全局变量“${name}”的结果不是有限值。`)
    seen.add(name)
    values[name] = value
    resolved.push({ name, expression: compiled.source, value })
  }
  return { definitions: resolved, values }
}

export function globalVariableValues(
  scene: Pick<SceneDocument, 'globalVariables'>,
): Record<string, number> {
  return Object.fromEntries(
    scene.globalVariables.map((variable) => [variable.name, variable.value]),
  )
}

export function applyPropertyExpressionTarget(
  scene: SceneDocument,
  target: PropertyExpressionTarget,
  value: number,
): SceneDocument {
  return applyNumericPropertyTarget(scene, target, value)
}

export function recomputePropertyExpressions(
  scene: SceneDocument,
  globalDefinitions: readonly GlobalVariableDefinition[] = scene.globalVariables,
  bindings: readonly PropertyExpressionBinding[] = scene.propertyExpressions,
): SceneDocument {
  const globals = resolveGlobalVariables(globalDefinitions)
  let next: SceneDocument = {
    ...scene,
    globalVariables: globals.definitions,
    propertyExpressions: [],
  }
  const resolvedBindings: PropertyExpressionBinding[] = []
  const names = new Set(Object.keys(globals.values))
  for (const binding of bindings) {
    const compiled = compileScalarExpression(binding.expression, { variableNames: names })
    const value = compiled.evaluate({ time: 0, variables: globals.values })
    if (value === null) throw new ScalarExpressionError('属性表达式的结果不是有限值。')
    next = applyNumericPropertyTarget(next, binding.target, value)
    resolvedBindings.push({
      ...binding,
      expression: compiled.source,
      fallbackValue: value,
    })
  }
  return { ...next, propertyExpressions: resolvedBindings }
}

export function setPropertyExpression(
  scene: SceneDocument,
  target: PropertyExpressionTarget,
  source: string,
): SceneDocument {
  const normalized = source.trim()
  const targetKey = propertyExpressionTargetKey(target)
  const remaining = scene.propertyExpressions.filter(
    (binding) => propertyExpressionTargetKey(binding.target) !== targetKey,
  )
  if (NUMERIC_LITERAL.test(normalized)) {
    const value = Number(normalized)
    return {
      ...applyNumericPropertyTarget(scene, target, value),
      propertyExpressions: remaining,
    }
  }
  const globals = globalVariableValues(scene)
  const compiled = compileScalarExpression(normalized, {
    variableNames: new Set(Object.keys(globals)),
  })
  const value = compiled.evaluate({ time: 0, variables: globals })
  if (value === null) throw new ScalarExpressionError('属性表达式的结果不是有限值。')
  const existing = scene.propertyExpressions.find(
    (binding) => propertyExpressionTargetKey(binding.target) === targetKey,
  )
  const binding: PropertyExpressionBinding = {
    id: existing?.id ?? crypto.randomUUID(),
    target,
    expression: compiled.source,
    fallbackValue: value,
  }
  return {
    ...applyNumericPropertyTarget(scene, target, value),
    propertyExpressions: [...remaining, binding],
  }
}

function offsetText(value: number): string {
  return Number(value.toPrecision(12)).toString()
}

export function stepPropertyExpressionSource(source: string, delta: number): string {
  const normalized = source.trim()
  const match = OFFSET_EXPRESSION.exec(normalized)
  const base = match?.[1] ?? normalized
  const offset = match ? Number(match[3]) * (match[2] === '-' ? -1 : 1) : 0
  const nextOffset = offset + delta
  if (Math.abs(nextOffset) <= 1e-12) return base
  return `(${base})${nextOffset >= 0 ? '+' : '-'}${offsetText(Math.abs(nextOffset))}`
}
