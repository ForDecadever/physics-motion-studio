import type { RuntimeBodyState } from '../../physics/worker/messages'
import type { EntityId, SceneEntity } from '../../scene/model/types'

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
