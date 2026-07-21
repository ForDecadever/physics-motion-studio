import type { EntityId, SceneDocument, SceneEntity } from '../../scene/model/types'
import type { DocumentCommand } from './types'

export class EntityListCommand implements DocumentCommand {
  constructor(
    readonly label: string,
    private readonly before: SceneEntity[],
    private readonly after: SceneEntity[],
  ) {}

  execute(document: SceneDocument): SceneDocument {
    return { ...document, entities: this.after }
  }

  undo(document: SceneDocument): SceneDocument {
    return { ...document, entities: this.before }
  }
}

export function createAddEntityCommand(
  document: SceneDocument,
  entities: SceneEntity | SceneEntity[],
): EntityListCommand {
  const additions = Array.isArray(entities) ? entities : [entities]
  return new EntityListCommand('创建实体', document.entities, [...document.entities, ...additions])
}

export function createReplaceEntitiesCommand(
  document: SceneDocument,
  replacements: SceneEntity[],
  label: string,
): EntityListCommand {
  const replacementMap = new Map(replacements.map((entity) => [entity.id, entity]))
  const after = document.entities.map((entity) => replacementMap.get(entity.id) ?? entity)
  return new EntityListCommand(label, document.entities, after)
}

export function createDeleteEntitiesCommand(
  document: SceneDocument,
  requestedIds: EntityId[],
): EntityListCommand | null {
  const ids = new Set(requestedIds)

  for (const entity of document.entities) {
    if (entity.kind === 'connector' && (ids.has(entity.a.bodyId) || ids.has(entity.b.bodyId))) {
      ids.add(entity.id)
    }
  }

  const after = document.entities.filter((entity) => !ids.has(entity.id))
  if (after.length === document.entities.length) return null

  return new EntityListCommand('删除实体', document.entities, after)
}
