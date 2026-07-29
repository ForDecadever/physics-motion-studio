import type {
  ChartDefinition,
  EntityId,
  Layer,
  SceneDocument,
  SceneEntity,
  SceneSettings,
} from '../../scene/model/types'
import type { DocumentCommand } from './types'

export class EntityListCommand implements DocumentCommand {
  constructor(
    readonly label: string,
    private readonly before: SceneEntity[],
    private readonly after: SceneEntity[],
    private readonly beforeCharts?: ChartDefinition[],
    private readonly afterCharts?: ChartDefinition[],
  ) {}

  execute(document: SceneDocument): SceneDocument {
    return {
      ...document,
      entities: this.after,
      charts: this.afterCharts ?? document.charts,
    }
  }

  undo(document: SceneDocument): SceneDocument {
    return {
      ...document,
      entities: this.before,
      charts: this.beforeCharts ?? document.charts,
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

export class SceneLayersCommand implements DocumentCommand {
  constructor(
    readonly label: string,
    private readonly before: Layer[],
    private readonly after: Layer[],
  ) {}

  execute(document: SceneDocument): SceneDocument {
    return { ...document, layers: this.after }
  }

  undo(document: SceneDocument): SceneDocument {
    return { ...document, layers: this.before }
  }
}

export function createReplaceSceneSettingsCommand(
  document: SceneDocument,
  settings: SceneSettings,
  label: string,
): SceneSettingsCommand {
  return new SceneSettingsCommand(label, document.settings, settings)
}

export function createReplaceLayersCommand(
  document: SceneDocument,
  layers: Layer[],
  label: string,
): SceneLayersCommand {
  return new SceneLayersCommand(label, document.layers, layers)
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
    if (
      entity.kind === 'groundJoint' &&
      (ids.has(entity.a.groundId) || ids.has(entity.b.groundId))
    ) {
      ids.add(entity.id)
    }
  }

  const after = document.entities.filter((entity) => !ids.has(entity.id))
  if (after.length === document.entities.length) return null

  const afterCharts = document.charts.map((chart) => ({
    ...chart,
    series: chart.series.filter((series) => !ids.has(series.entityId)),
  }))

  return new EntityListCommand('删除实体', document.entities, after, document.charts, afterCharts)
}
