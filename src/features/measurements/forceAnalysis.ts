import { regionContainsPoint } from '../../physics/core/fieldRegions'
import {
  addForce,
  coulombForceOnFirst,
  electricForce,
  magneticForce,
  scaleForce,
} from '../../physics/core/forces'
import type { RuntimeBodyState, RuntimeConnectorState } from '../../physics/worker/messages'
import {
  pointInBooleanGeometry,
  resolveBooleanScene,
  type ResolvedBooleanBody,
} from '../../scene/model/booleanGeometry'
import { findBooleanNode } from '../../scene/model/booleanLayerGraph'
import { compileScalarExpression } from '../../scene/expressions/scalarExpression'
import { evaluateFieldDefinition } from '../../scene/model/fieldExpressions'
import { globalVariableValues } from '../../scene/model/propertyExpressions'
import type {
  BodyEntity,
  ConnectorEntity,
  FieldDefinition,
  SceneDocument,
  Vec2,
} from '../../scene/model/types'

export type ForceAnalysisCategory =
  | 'gravity'
  | 'electric'
  | 'magnetic'
  | 'coulomb'
  | 'external'
  | 'connector'
  | 'contact'
  | 'constraint'
  | 'net'

export interface ForceAnalysisEntry {
  key: string
  category: ForceAnalysisCategory
  label: string
  force: Vec2
  derived?: boolean
}

interface ConstraintSourceCandidate {
  key: string
  category: 'connector' | 'contact'
  label: string
  direction: Vec2
  tensileOnly: boolean
}

function bodyProperties(
  scene: SceneDocument,
  bodyId: string,
): { massKg: number; chargeC: number; position: Vec2 } | null {
  const ordinary = scene.entities.find(
    (entity): entity is BodyEntity => entity.kind === 'body' && entity.id === bodyId,
  )
  if (ordinary) {
    return {
      massKg: ordinary.massKg,
      chargeC: ordinary.chargeC,
      position: ordinary.transform.position,
    }
  }
  const result = resolveBooleanScene(scene).byResultId.get(bodyId)
  return result?.valid && result.kind === 'body'
    ? { massKg: result.massKg, chargeC: result.chargeC, position: result.centerOfMass }
    : null
}

function fieldsAtPoint(scene: SceneDocument, point: Vec2, time: number): FieldDefinition[] {
  const variables = globalVariableValues(scene)
  const definitions = scene.entities.flatMap((entity) => {
    if (entity.kind !== 'field' || !entity.simulationEnabled) return []
    if (!regionContainsPoint(entity.region, point)) return []
    const field = evaluateFieldDefinition(entity.field, time, variables)
    return field ? [field] : []
  })
  for (const result of resolveBooleanScene(scene).roots) {
    if (!result.valid || result.kind !== 'field' || !result.simulationEnabled) continue
    for (const region of result.regions) {
      if (!pointInBooleanGeometry(point, region.geometry)) continue
      const field = evaluateFieldDefinition(region.field, time, variables)
      if (field) definitions.push(field)
    }
  }
  return definitions
}

function externalForce(scene: SceneDocument, bodyId: string, time: number): Vec2 {
  const variables = globalVariableValues(scene)
  const variableNames = new Set(Object.keys(variables))
  let total = { x: 0, y: 0 }
  for (const entity of scene.entities) {
    if (entity.kind !== 'force' || !entity.simulationEnabled || entity.bodyId !== bodyId) continue
    const evaluate = (expression: string | undefined, fallback: number): number | null => {
      if (!expression) return fallback
      try {
        return compileScalarExpression(expression, { allowTime: true, variableNames }).evaluate({
          time,
          variables,
        })
      } catch {
        return null
      }
    }
    const magnitude = evaluate(entity.magnitudeExpression?.expression, entity.magnitudeN)
    const directionDegrees = evaluate(
      entity.directionDegreesExpression?.expression,
      (entity.directionRad * 180) / Math.PI,
    )
    if (magnitude === null || directionDegrees === null) continue
    const direction = (directionDegrees * Math.PI) / 180
    total = addForce(total, {
      x: Math.cos(direction) * magnitude,
      y: Math.sin(direction) * magnitude,
    })
  }
  return total
}

function bodyTargets(scene: SceneDocument): Array<BodyEntity | ResolvedBooleanBody> {
  const ordinary = scene.entities.filter((entity): entity is BodyEntity => entity.kind === 'body')
  const results = resolveBooleanScene(scene).roots.filter(
    (result): result is ResolvedBooleanBody => result.valid && result.kind === 'body',
  )
  return [...ordinary, ...results]
}

function targetId(target: BodyEntity | ResolvedBooleanBody): string {
  return 'resultId' in target ? target.resultId : target.id
}

function targetCharge(target: BodyEntity | ResolvedBooleanBody): number {
  return target.chargeC
}

function coulombForce(
  scene: SceneDocument,
  bodyId: string,
  position: Vec2,
  runtimeBodies: Record<string, RuntimeBodyState>,
): Vec2 {
  if (!scene.settings.pairwiseElectrostatics) return { x: 0, y: 0 }
  const own = bodyProperties(scene, bodyId)
  if (!own || own.chargeC === 0) return { x: 0, y: 0 }
  let total = { x: 0, y: 0 }
  for (const target of bodyTargets(scene)) {
    const id = targetId(target)
    if (id === bodyId || targetCharge(target) === 0) continue
    const otherPosition =
      runtimeBodies[id]?.position ??
      ('resultId' in target ? target.centerOfMass : target.transform.position)
    total = addForce(
      total,
      coulombForceOnFirst(own.chargeC, targetCharge(target), position, otherPosition, 1e-6),
    )
  }
  return total
}

function normalizedDirection(from: Vec2, to: Vec2): Vec2 | null {
  const delta = { x: to.x - from.x, y: to.y - from.y }
  const length = Math.hypot(delta.x, delta.y)
  return length > Number.EPSILON ? { x: delta.x / length, y: delta.y / length } : null
}

function connectorLabel(connector: ConnectorEntity): string {
  const kind =
    connector.connector.type === 'rope' ? '绳' : connector.connector.type === 'rod' ? '杆' : '弹簧'
  return `${kind}「${connector.name}」${connector.connector.type === 'rope' ? '拉力' : '作用力'}`
}

function sourceName(scene: SceneDocument, sourceId: string): string {
  const entity = scene.entities.find((candidate) => candidate.id === sourceId)
  if (entity) return entity.name
  return findBooleanNode(scene.rootItems, sourceId)?.name ?? sourceId
}

function constraintSourceCandidates(
  scene: SceneDocument,
  bodyId: string,
  body: RuntimeBodyState | undefined,
  runtimeConnectors: Record<string, RuntimeConnectorState>,
): ConstraintSourceCandidate[] {
  const candidates = new Map<string, ConstraintSourceCandidate>()
  for (const entity of scene.entities) {
    if (entity.kind !== 'connector' || !entity.simulationEnabled) continue
    const attachedAtStart = entity.a.type === 'body' && entity.a.bodyId === bodyId
    const attachedAtEnd = entity.b.type === 'body' && entity.b.bodyId === bodyId
    if (!attachedAtStart && !attachedAtEnd) continue
    const points = runtimeConnectors[entity.id]?.points
    if (!points || points.length < 2) continue
    const direction = attachedAtStart
      ? normalizedDirection(points[0]!, points[1]!)
      : normalizedDirection(points.at(-1)!, points.at(-2)!)
    if (!direction) continue
    candidates.set(`connector:${entity.id}`, {
      key: `connector:${entity.id}`,
      category: 'connector',
      label: connectorLabel(entity),
      direction,
      tensileOnly: entity.connector.type === 'rope',
    })
  }

  for (const source of body?.contactSources ?? []) {
    const connector = scene.entities.find(
      (entity): entity is ConnectorEntity =>
        entity.kind === 'connector' && entity.id === source.sourceEntityId,
    )
    const isConnector = source.sourceKind === 'connector' && Boolean(connector)
    const key = isConnector
      ? `connector:${source.sourceEntityId}`
      : `contact:${source.sourceKind}:${source.sourceEntityId}`
    if (candidates.has(key)) continue
    const direction = normalizedDirection({ x: 0, y: 0 }, source.direction)
    if (!direction) continue
    const label = isConnector
      ? connectorLabel(connector!)
      : `${source.sourceKind === 'ground' ? '地面' : source.sourceKind === 'body' ? '物体' : '连接器'}「${sourceName(scene, source.sourceEntityId)}」接触力`
    candidates.set(key, {
      key,
      category: isConnector ? 'connector' : 'contact',
      label,
      direction,
      tensileOnly: true,
    })
  }
  return [...candidates.values()]
}

function attributedConstraintForces(
  residual: Vec2,
  candidates: readonly ConstraintSourceCandidate[],
): { entries: ForceAnalysisEntry[]; remainder: Vec2 } {
  if (candidates.length === 0) return { entries: [], remainder: residual }
  if (candidates.length === 1) {
    const candidate = candidates[0]!
    const projection = residual.x * candidate.direction.x + residual.y * candidate.direction.y
    const coefficient = candidate.tensileOnly && projection < -1e-9 ? 0 : projection
    const force = {
      x: candidate.direction.x * coefficient,
      y: candidate.direction.y * coefficient,
    }
    return {
      entries: [
        {
          key: candidate.key,
          category: candidate.category,
          label: candidate.label,
          force,
          derived: true,
        },
      ],
      remainder: { x: residual.x - force.x, y: residual.y - force.y },
    }
  }

  let active = [...candidates]
  let coefficients = new Map<string, number>()
  while (active.length > 0) {
    const xx = active.reduce((sum, candidate) => sum + candidate.direction.x ** 2, 0)
    const xy = active.reduce(
      (sum, candidate) => sum + candidate.direction.x * candidate.direction.y,
      0,
    )
    const yy = active.reduce((sum, candidate) => sum + candidate.direction.y ** 2, 0)
    const determinant = xx * yy - xy * xy
    coefficients = new Map<string, number>()
    if (Math.abs(determinant) > 1e-10) {
      const projected = {
        x: (yy * residual.x - xy * residual.y) / determinant,
        y: (-xy * residual.x + xx * residual.y) / determinant,
      }
      for (const candidate of active) {
        coefficients.set(
          candidate.key,
          candidate.direction.x * projected.x + candidate.direction.y * projected.y,
        )
      }
    } else {
      const basis = active[0]!.direction
      const projections = active.map(
        (candidate) => candidate.direction.x * basis.x + candidate.direction.y * basis.y,
      )
      const denominator = projections.reduce((sum, value) => sum + value ** 2, 0)
      const target = residual.x * basis.x + residual.y * basis.y
      active.forEach((candidate, index) =>
        coefficients.set(candidate.key, (target * projections[index]!) / denominator),
      )
    }
    const rejected = active.filter(
      (candidate) => candidate.tensileOnly && (coefficients.get(candidate.key) ?? 0) < -1e-9,
    )
    if (rejected.length === 0) break
    const rejectedKeys = new Set(rejected.map((candidate) => candidate.key))
    active = active.filter((candidate) => !rejectedKeys.has(candidate.key))
  }

  const activeKeys = new Set(active.map((candidate) => candidate.key))
  let attributed = { x: 0, y: 0 }
  const entries = candidates.map((candidate) => {
    const coefficient = activeKeys.has(candidate.key) ? (coefficients.get(candidate.key) ?? 0) : 0
    const force = {
      x: candidate.direction.x * coefficient,
      y: candidate.direction.y * coefficient,
    }
    attributed = addForce(attributed, force)
    return {
      key: candidate.key,
      category: candidate.category,
      label: candidate.label,
      force,
      derived: true,
    }
  })
  return {
    entries,
    remainder: { x: residual.x - attributed.x, y: residual.y - attributed.y },
  }
}

export function analyzeBodyForces(
  scene: SceneDocument,
  bodyId: string,
  runtimeBodies: Record<string, RuntimeBodyState>,
  time: number,
  runtimeConnectors: Record<string, RuntimeConnectorState> = {},
): ForceAnalysisEntry[] | null {
  const body = runtimeBodies[bodyId]
  const properties = bodyProperties(scene, bodyId)
  if (!properties) return null
  const position = body?.position ?? properties.position
  const velocity = body?.linearVelocity ?? { x: 0, y: 0 }
  let gravity = { x: 0, y: 0 }
  let electric = { x: 0, y: 0 }
  let magnetic = { x: 0, y: 0 }
  for (const field of fieldsAtPoint(scene, position, time)) {
    if (field.type === 'uniformGravity') {
      gravity = addForce(gravity, scaleForce(field.acceleration, properties.massKg))
    } else if (field.type === 'uniformElectric') {
      electric = addForce(electric, electricForce(properties.chargeC, field.strength))
    } else {
      magnetic = addForce(magnetic, magneticForce(properties.chargeC, velocity, field.bzTesla))
    }
  }
  const coulomb = coulombForce(scene, bodyId, position, runtimeBodies)
  const external = externalForce(scene, bodyId, time)
  const known = [gravity, electric, magnetic, coulomb, external].reduce(addForce, { x: 0, y: 0 })
  const net = body?.netForce ?? known
  const residual = { x: net.x - known.x, y: net.y - known.y }
  const attributed = attributedConstraintForces(
    residual,
    constraintSourceCandidates(scene, bodyId, body, runtimeConnectors),
  )
  const remainderMagnitude = Math.hypot(attributed.remainder.x, attributed.remainder.y)
  const showRemainder =
    attributed.entries.length === 0 ||
    remainderMagnitude > Math.max(1e-8, Math.hypot(residual.x, residual.y) * 1e-8)
  return [
    { key: 'gravity', category: 'gravity', label: '重力', force: gravity },
    { key: 'electric', category: 'electric', label: '电场力', force: electric },
    { key: 'magnetic', category: 'magnetic', label: '磁场力', force: magnetic },
    { key: 'coulomb', category: 'coulomb', label: '物体库仑力', force: coulomb },
    { key: 'external', category: 'external', label: '外加力', force: external },
    ...attributed.entries,
    ...(showRemainder
      ? [
          {
            key: 'constraint',
            category: 'constraint' as const,
            label: '其他约束合力',
            force: attributed.remainder,
            derived: true,
          },
        ]
      : []),
    { key: 'net', category: 'net', label: '最终合力', force: net },
  ]
}
