import type { SceneEntity } from '../model/types'

export interface EntityDefinition<TEntity extends SceneEntity = SceneEntity> {
  kind: TEntity['kind']
  displayName: string
  createDefault: () => TEntity
}

const definitions = new Map<SceneEntity['kind'], EntityDefinition>()

export function registerEntityDefinition(definition: EntityDefinition): void {
  if (definitions.has(definition.kind)) {
    throw new Error(`实体类型 ${definition.kind} 已经注册。`)
  }
  definitions.set(definition.kind, definition)
}

export function getEntityDefinition(kind: SceneEntity['kind']): EntityDefinition | undefined {
  return definitions.get(kind)
}
