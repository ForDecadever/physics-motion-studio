import type { RuntimeBodyState } from '../../physics/worker/messages'
import {
  resolveBooleanScene,
  transformBooleanBodyGeometry,
  type BooleanMultiPolygon,
  type ResolvedBooleanResult,
} from '../../scene/model/booleanGeometry'
import {
  findBooleanNode,
  isTreeItemEffectivelyLocked,
  isTreeItemEffectivelyVisible,
} from '../../scene/model/booleanLayerGraph'
import type { EntityId, SceneDocument, SceneEntity, Vec2 } from '../../scene/model/types'
import {
  getEntityBounds,
  getEntityTransform,
  isScalableEntity,
  type EntityBounds,
} from './entityGeometry'

export interface EditingSelectionTarget {
  id: EntityId
  kind: 'entity' | 'booleanResult'
  bounds: EntityBounds
  sourceEntityIds: EntityId[]
  scalable: boolean
}

function geometryBounds(geometry: BooleanMultiPolygon): EntityBounds | null {
  const points = geometry.flatMap((polygon) => polygon.flatMap((ring) => ring))
  if (points.length === 0) return null
  return {
    minX: Math.min(...points.map((point) => point[0])),
    minY: Math.min(...points.map((point) => point[1])),
    maxX: Math.max(...points.map((point) => point[0])),
    maxY: Math.max(...points.map((point) => point[1])),
  }
}

function resolvedGeometry(
  result: ResolvedBooleanResult,
  runtimeBody: RuntimeBodyState | undefined,
  previewed: boolean,
): BooleanMultiPolygon {
  if (!result.valid) return result.sourceOutlines.flatMap((outline) => outline)
  if (result.kind !== 'body' || previewed) return result.geometry
  return transformBooleanBodyGeometry(result, runtimeBody?.position, runtimeBody?.angleRad)
}

function rigidPreviewGeometry(
  result: Extract<ResolvedBooleanResult, { valid: true; kind: 'body' }>,
  originalById: ReadonlyMap<EntityId, SceneEntity>,
  renderedById: ReadonlyMap<EntityId, SceneEntity>,
  previewEntityIds: ReadonlySet<EntityId>,
): BooleanMultiPolygon | null {
  if (
    result.sourceEntityIds.length === 0 ||
    !result.sourceEntityIds.every((id) => previewEntityIds.has(id))
  ) {
    return null
  }
  const firstId = result.sourceEntityIds[0]!
  const firstOriginal = originalById.get(firstId)
  const firstRendered = renderedById.get(firstId)
  const originalTransform = firstOriginal ? getEntityTransform(firstOriginal) : null
  const renderedTransform = firstRendered ? getEntityTransform(firstRendered) : null
  if (!originalTransform || !renderedTransform) return null
  const angleDelta = renderedTransform.angleRad - originalTransform.angleRad
  const cosine = Math.cos(angleDelta)
  const sine = Math.sin(angleDelta)
  const translation = {
    x:
      renderedTransform.position.x -
      (originalTransform.position.x * cosine - originalTransform.position.y * sine),
    y:
      renderedTransform.position.y -
      (originalTransform.position.x * sine + originalTransform.position.y * cosine),
  }
  for (const id of result.sourceEntityIds) {
    const original = originalById.get(id)
    const rendered = renderedById.get(id)
    const before = original ? getEntityTransform(original) : null
    const after = rendered ? getEntityTransform(rendered) : null
    if (!before || !after) return null
    const expected = {
      x: before.position.x * cosine - before.position.y * sine + translation.x,
      y: before.position.x * sine + before.position.y * cosine + translation.y,
    }
    if (
      Math.abs(after.angleRad - before.angleRad - angleDelta) > 1e-9 ||
      Math.hypot(after.position.x - expected.x, after.position.y - expected.y) > 1e-8
    ) {
      return null
    }
  }
  return transformBooleanBodyGeometry(
    result,
    {
      x: result.centerOfMass.x * cosine - result.centerOfMass.y * sine + translation.x,
      y: result.centerOfMass.x * sine + result.centerOfMass.y * cosine + translation.y,
    },
    result.angleRad + angleDelta,
  )
}

export function listEditingSelectionTargets(
  scene: SceneDocument,
  renderedEntities: readonly SceneEntity[],
  runtimeBodies: Record<EntityId, RuntimeBodyState> = {},
  previewEntityIds: ReadonlySet<EntityId> = new Set(),
  explicitSourceIds: ReadonlySet<EntityId> = new Set(),
): EditingSelectionTarget[] {
  const booleanScene = resolveBooleanScene(scene)
  const booleanSourceIds = new Set(booleanScene.roots.flatMap((result) => result.sourceEntityIds))
  const entityById = new Map(renderedEntities.map((entity) => [entity.id, entity]))
  const originalById = new Map(scene.entities.map((entity) => [entity.id, entity]))
  const targets: EditingSelectionTarget[] = []

  for (const item of scene.rootItems) {
    if (item.kind === 'entity') {
      const entity = entityById.get(item.entityId)
      if (
        !entity ||
        booleanSourceIds.has(entity.id) ||
        !entity.visible ||
        entity.locked ||
        !isTreeItemEffectivelyVisible(scene.rootItems, entity.id) ||
        isTreeItemEffectivelyLocked(scene.rootItems, entity.id)
      )
        continue
      const bounds = getEntityBounds(entity)
      if (!bounds) continue
      targets.push({
        id: entity.id,
        kind: 'entity',
        bounds,
        sourceEntityIds: [entity.id],
        scalable: isScalableEntity(entity),
      })
      continue
    }
    const result = booleanScene.byResultId.get(item.resultId)
    const node = findBooleanNode(scene.rootItems, item.id)
    if (!result || !node?.visible || node.locked) continue
    const previewed = result.sourceEntityIds.some((id) => previewEntityIds.has(id))
    const previewGeometry =
      previewed && result.valid && result.kind === 'body'
        ? rigidPreviewGeometry(result, originalById, entityById, previewEntityIds)
        : null
    const bounds = geometryBounds(
      previewGeometry ?? resolvedGeometry(result, runtimeBodies[result.resultId], previewed),
    )
    if (!bounds) continue
    targets.push({
      id: result.resultId,
      kind: 'booleanResult',
      bounds,
      sourceEntityIds: result.sourceEntityIds,
      scalable: result.valid,
    })
  }

  const existingTargetIds = new Set(targets.map((target) => target.id))
  for (const sourceId of explicitSourceIds) {
    if (existingTargetIds.has(sourceId)) continue
    const rootResultId = booleanScene.rootResultIdBySourceId.get(sourceId)
    if (!rootResultId || explicitSourceIds.has(rootResultId)) continue
    const entity = entityById.get(sourceId)
    if (
      !entity ||
      !entity.visible ||
      entity.locked ||
      !isTreeItemEffectivelyVisible(scene.rootItems, sourceId) ||
      isTreeItemEffectivelyLocked(scene.rootItems, sourceId)
    ) {
      continue
    }
    const bounds = getEntityBounds(entity)
    if (!bounds) continue
    targets.push({
      id: sourceId,
      kind: 'entity',
      bounds,
      sourceEntityIds: [sourceId],
      scalable: isScalableEntity(entity),
    })
  }
  return targets
}

export function selectionTargetBounds(
  targets: readonly EditingSelectionTarget[],
  selectedIds: readonly EntityId[],
  scalableOnly = false,
): EntityBounds | null {
  const selected = new Set(selectedIds)
  const matches = targets.filter(
    (target) => selected.has(target.id) && (!scalableOnly || target.scalable),
  )
  if (matches.length === 0) return null
  return {
    minX: Math.min(...matches.map((target) => target.bounds.minX)),
    minY: Math.min(...matches.map((target) => target.bounds.minY)),
    maxX: Math.max(...matches.map((target) => target.bounds.maxX)),
    maxY: Math.max(...matches.map((target) => target.bounds.maxY)),
  }
}

export function selectionSourceEntityIds(
  targets: readonly EditingSelectionTarget[],
  selectedIds: readonly EntityId[],
): EntityId[] {
  const selected = new Set(selectedIds)
  return [
    ...new Set(
      targets
        .filter((target) => selected.has(target.id))
        .flatMap((target) => target.sourceEntityIds),
    ),
  ]
}

export function selectionTargetsInsideBounds(
  targets: readonly EditingSelectionTarget[],
  start: Vec2,
  end: Vec2,
): EditingSelectionTarget[] {
  const selection = {
    minX: Math.min(start.x, end.x),
    minY: Math.min(start.y, end.y),
    maxX: Math.max(start.x, end.x),
    maxY: Math.max(start.y, end.y),
  }
  return targets.filter(
    (target) =>
      target.bounds.minX >= selection.minX &&
      target.bounds.minY >= selection.minY &&
      target.bounds.maxX <= selection.maxX &&
      target.bounds.maxY <= selection.maxY,
  )
}
