import type { RuntimeBodyState } from '../../physics/worker/messages'
import type { EntityId, SceneEntity, Vec2 } from '../../scene/model/types'

export function resolveBooleanBodyRenderTransform(
  result: { centerOfMass: Vec2; angleRad: number },
  runtime: RuntimeBodyState | undefined,
  hasSourcePreview: boolean,
): { position: Vec2; angleRad: number } {
  if (hasSourcePreview || !runtime) {
    return { position: result.centerOfMass, angleRad: result.angleRad }
  }
  return { position: runtime.position, angleRad: runtime.angleRad }
}

export function resolveRenderedEntity(
  entity: SceneEntity,
  runtimeBodies: Record<EntityId, RuntimeBodyState>,
  previewEntities: Record<EntityId, SceneEntity>,
): SceneEntity {
  const runtime = runtimeBodies[entity.id]
  const runtimeEntity =
    entity.kind === 'body' && runtime
      ? {
          ...entity,
          transform: { position: runtime.position, angleRad: runtime.angleRad },
        }
      : entity

  return previewEntities[entity.id] ?? runtimeEntity
}
