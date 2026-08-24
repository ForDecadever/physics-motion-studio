import type {
  ChartDefinition,
  ConnectorEntity,
  EntityId,
  SceneDocument,
  SceneEntity,
  SceneSettings,
  SceneTreeItem,
} from '../../scene/model/types'
import {
  booleanBodyLocalToWorld,
  booleanBodyWorldToLocal,
  closestPointOnBooleanBoundary,
  pointInBooleanGeometry,
  resolveBooleanScene,
} from '../../scene/model/booleanGeometry'
import {
  collectSceneTreeEntityIds,
  collectSceneTreeTargetIds,
  findSceneTreeLocation,
} from '../../scene/model/booleanLayerGraph'
import type { DocumentCommand } from './types'
import { removeChangedNumericBindings } from '../../scene/model/numericPropertyRegistry'

export class EntityListCommand implements DocumentCommand {
  constructor(
    readonly label: string,
    private readonly before: SceneEntity[],
    private readonly after: SceneEntity[],
    private readonly beforeCharts?: ChartDefinition[],
    private readonly afterCharts?: ChartDefinition[],
    private readonly beforeRootItems?: SceneTreeItem[],
    private readonly afterRootItems?: SceneTreeItem[],
    readonly runtimeSafe = false,
  ) {}

  execute(document: SceneDocument): SceneDocument {
    return {
      ...document,
      entities: this.after,
      charts: this.afterCharts ?? document.charts,
      rootItems: this.afterRootItems ?? document.rootItems,
    }
  }

  undo(document: SceneDocument): SceneDocument {
    return {
      ...document,
      entities: this.before,
      charts: this.beforeCharts ?? document.charts,
      rootItems: this.beforeRootItems ?? document.rootItems,
    }
  }
}

export class SceneChartsCommand implements DocumentCommand {
  constructor(
    readonly label: string,
    private readonly before: ChartDefinition[],
    private readonly after: ChartDefinition[],
  ) {}

  execute(document: SceneDocument): SceneDocument {
    return { ...document, charts: this.after }
  }

  undo(document: SceneDocument): SceneDocument {
    return { ...document, charts: this.before }
  }
}

export class SceneSettingsCommand implements DocumentCommand {
  constructor(
    readonly label: string,
    private readonly before: SceneSettings,
    private readonly after: SceneSettings,
  ) {}

  execute(document: SceneDocument): SceneDocument {
    return { ...document, settings: this.after }
  }

  undo(document: SceneDocument): SceneDocument {
    return { ...document, settings: this.before }
  }
}

export class SceneTreeCommand implements DocumentCommand {
  constructor(
    readonly label: string,
    private readonly before: SceneTreeItem[],
    private readonly after: SceneTreeItem[],
  ) {}

  execute(document: SceneDocument): SceneDocument {
    return { ...document, rootItems: this.after }
  }

  undo(document: SceneDocument): SceneDocument {
    return { ...document, rootItems: this.before }
  }
}

export class SceneGraphCommand implements DocumentCommand {
  constructor(
    readonly label: string,
    private readonly before: SceneDocument,
    private readonly after: SceneDocument,
    readonly runtimeSafe = false,
  ) {}

  execute(document: SceneDocument): SceneDocument {
    void document
    return this.after
  }

  undo(document: SceneDocument): SceneDocument {
    void document
    return this.before
  }
}

export function createReplaceSceneCommand(
  document: SceneDocument,
  next: SceneDocument,
  label: string,
): SceneGraphCommand {
  return new SceneGraphCommand(label, document, next)
}

export function createReplaceSceneSettingsCommand(
  document: SceneDocument,
  settings: SceneSettings,
  label: string,
): SceneGraphCommand {
  const provisional = { ...document, settings }
  const next = removeChangedNumericBindings(
    document,
    provisional,
    (binding) => binding.target.type === 'scene',
  )
  return new SceneGraphCommand(label, document, next)
}

export function createReplaceSceneTreeCommand(
  document: SceneDocument,
  rootItems: SceneTreeItem[],
  label: string,
): SceneGraphCommand {
  const next = preserveBooleanConnectorWorldAnchors(document, { ...document, rootItems })
  return new SceneGraphCommand(label, document, next)
}

export function createReplaceChartsCommand(
  document: SceneDocument,
  charts: ChartDefinition[],
  label: string,
): SceneChartsCommand {
  return new SceneChartsCommand(label, document.charts, charts)
}

export function createAddEntityCommand(
  document: SceneDocument,
  entities: SceneEntity | SceneEntity[],
): EntityListCommand {
  const additions = Array.isArray(entities) ? entities : [entities]
  return new EntityListCommand(
    '创建实体',
    document.entities,
    [...document.entities, ...additions],
    undefined,
    undefined,
    document.rootItems,
    [
      ...document.rootItems,
      ...additions.map((entity): SceneTreeItem => ({ kind: 'entity', entityId: entity.id })),
    ],
    additions.every((entity) => entity.kind === 'measurement'),
  )
}

export function createReplaceEntitiesCommand(
  document: SceneDocument,
  replacements: SceneEntity[],
  label: string,
  booleanAnchorBehavior: 'preserve-world' | 'follow-result' = 'preserve-world',
): SceneGraphCommand {
  const replacementMap = new Map(replacements.map((entity) => [entity.id, entity]))
  const replaced = document.entities.map((entity) => replacementMap.get(entity.id) ?? entity)
  const anchored =
    booleanAnchorBehavior === 'preserve-world'
      ? preserveBooleanConnectorWorldAnchors(document, { ...document, entities: replaced })
      : { ...document, entities: replaced }
  const replacedIds = new Set(replacements.map((entity) => entity.id))
  const next = removeChangedNumericBindings(
    document,
    anchored,
    (binding) =>
      binding.target.type === 'boolean' ||
      (binding.target.type === 'entity' && replacedIds.has(binding.target.entityId)),
  )
  return new SceneGraphCommand(
    label,
    document,
    next,
    replacements.every((entity) => entity.kind === 'measurement'),
  )
}

export function preserveBooleanConnectorWorldAnchors(
  beforeScene: SceneDocument,
  nextScene: SceneDocument,
): SceneDocument {
  const beforeBoolean = resolveBooleanScene(beforeScene)
  const afterBoolean = resolveBooleanScene(nextScene)
  const entities = nextScene.entities.map((entity) => {
    if (entity.kind !== 'connector') return entity
    const reanchor = (endpoint: typeof entity.a) => {
      if (endpoint.type !== 'body') return endpoint
      const before = beforeBoolean.byResultId.get(endpoint.bodyId)
      const next = afterBoolean.byResultId.get(endpoint.bodyId)
      if (!before?.valid || before.kind !== 'body' || !next?.valid || next.kind !== 'body') {
        return endpoint
      }
      const worldAnchor = booleanBodyLocalToWorld(before, endpoint.localAnchor)
      const retainedAnchor = pointInBooleanGeometry(worldAnchor, next.geometry)
        ? worldAnchor
        : closestPointOnBooleanBoundary(worldAnchor, next.geometry)
      return retainedAnchor
        ? { ...endpoint, localAnchor: booleanBodyWorldToLocal(next, retainedAnchor) }
        : endpoint
    }
    return { ...entity, a: reanchor(entity.a), b: reanchor(entity.b) }
  })
  return { ...nextScene, entities }
}

export function createDeleteEntitiesCommand(
  document: SceneDocument,
  requestedIds: EntityId[],
): DocumentCommand | null {
  const ids = new Set(requestedIds)
  const deletedReferenceIds = new Set<EntityId>()
  const selectedBooleanIds = new Set<string>()
  for (const requestedId of requestedIds) {
    const item = findSceneTreeLocation(document.rootItems, requestedId)?.item
    if (item?.kind !== 'boolean') continue
    selectedBooleanIds.add(item.id)
    for (const entityId of collectSceneTreeEntityIds(item)) ids.add(entityId)
    for (const targetId of collectSceneTreeTargetIds(item)) deletedReferenceIds.add(targetId)
  }
  for (const id of ids) deletedReferenceIds.add(id)

  const connectorReferencesDeletedEntity = (entity: ConnectorEntity): boolean =>
    [entity.a, entity.b].some((endpoint) => {
      if (endpoint.type === 'body') return ids.has(endpoint.bodyId)
      if (endpoint.type === 'ground') return ids.has(endpoint.groundId)
      if (endpoint.type === 'groundJoint') return ids.has(endpoint.groundJointId)
      return false
    })

  const forceReferencesDeletedEntity = (entity: SceneEntity): boolean =>
    entity.kind === 'force' && deletedReferenceIds.has(entity.bodyId)

  let addedDependency = true
  while (addedDependency) {
    addedDependency = false
    for (const entity of document.entities) {
      if (ids.has(entity.id)) continue
      if (entity.kind === 'connector' && connectorReferencesDeletedEntity(entity)) {
        ids.add(entity.id)
        addedDependency = true
      }
      if (forceReferencesDeletedEntity(entity)) {
        ids.add(entity.id)
        addedDependency = true
      }
      if (
        entity.kind === 'groundJoint' &&
        (ids.has(entity.a.groundId) || ids.has(entity.b.groundId))
      ) {
        ids.add(entity.id)
        addedDependency = true
      }
    }
  }

  const after = document.entities.filter((entity) => !ids.has(entity.id))
  const removeTreeItems = (items: readonly SceneTreeItem[]): SceneTreeItem[] =>
    items.flatMap((item): SceneTreeItem[] => {
      if (item.kind === 'entity') return ids.has(item.entityId) ? [] : [item]
      if (selectedBooleanIds.has(item.id)) return []
      return [{ ...item, operands: removeTreeItems(item.operands) }]
    })
  const afterRootItems = removeTreeItems(document.rootItems)
  if (
    after.length === document.entities.length &&
    afterRootItems.length === document.rootItems.length &&
    selectedBooleanIds.size === 0
  ) {
    return null
  }

  const afterCharts = document.charts.map((chart) => ({
    ...chart,
    bindings: chart.bindings.filter((binding) => !deletedReferenceIds.has(binding.entityId)),
    series: chart.series.filter((series) => !deletedReferenceIds.has(series.entityId)),
  }))
  const afterPropertyExpressions = document.propertyExpressions.filter((binding) => {
    if (binding.target.type === 'entity') return !ids.has(binding.target.entityId)
    if (binding.target.type === 'boolean') return !selectedBooleanIds.has(binding.target.nodeId)
    return true
  })

  return new SceneGraphCommand(
    selectedBooleanIds.size > 0 ? '删除布尔组合' : '删除实体',
    document,
    {
      ...document,
      rootItems: afterRootItems,
      entities: after,
      charts: afterCharts,
      propertyExpressions: afterPropertyExpressions,
    },
    selectedBooleanIds.size === 0 &&
      [...ids].every(
        (id) => document.entities.find((entity) => entity.id === id)?.kind === 'measurement',
      ),
  )
}
