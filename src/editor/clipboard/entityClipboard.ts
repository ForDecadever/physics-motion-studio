import {
  collectSceneTreeEntityIds,
  findSceneTreeLocation,
  sceneTreeItemTargetId,
} from '../../scene/model/booleanLayerGraph'
import type {
  ConnectorEndpoint,
  EntityId,
  SceneDocument,
  SceneEntity,
  SceneTreeItem,
  Vec2,
} from '../../scene/model/types'

export interface SceneClipboardPayload {
  entities: SceneEntity[]
  rootItems: SceneTreeItem[]
}

export interface DuplicatedSceneClipboard {
  entities: SceneEntity[]
  rootItems: SceneTreeItem[]
  selectedIds: EntityId[]
}

function offsetPoint(point: Vec2, offset: Vec2): Vec2 {
  return { x: point.x + offset.x, y: point.y + offset.y }
}

export function collectClipboardEntities(
  entities: readonly SceneEntity[],
  selectedIds: readonly EntityId[],
): SceneEntity[] {
  const selected = new Set(selectedIds)
  const endpointEntityId = (endpoint: ConnectorEndpoint): EntityId | null => {
    if (endpoint.type === 'body') return endpoint.bodyId
    if (endpoint.type === 'ground') return endpoint.groundId
    if (endpoint.type === 'groundJoint') return endpoint.groundJointId
    return null
  }
  return entities.filter((entity) => {
    if (entity.kind === 'connector') {
      const targetIds = [endpointEntityId(entity.a), endpointEntityId(entity.b)].filter(
        (id): id is EntityId => id !== null,
      )
      return (
        targetIds.every((id) => selected.has(id)) &&
        (targetIds.length > 0 || selected.has(entity.id))
      )
    }
    if (entity.kind === 'groundJoint') {
      return selected.has(entity.a.groundId) && selected.has(entity.b.groundId)
    }
    return selected.has(entity.id)
  })
}

export function collectSceneClipboard(
  scene: SceneDocument,
  selectedIds: readonly EntityId[],
): SceneClipboardPayload {
  const selectedItems: SceneTreeItem[] = selectedIds.flatMap((id) => {
    const location = findSceneTreeLocation(scene.rootItems, id)
    if (!location) return []
    if (!location.parent) return [location.item]
    return location.item.kind === 'entity' ? [{ kind: 'entity', entityId: id }] : []
  })
  const ordinary = collectClipboardEntities(scene.entities, selectedIds)
  const copiedTargetIds = new Set(selectedItems.map(sceneTreeItemTargetId))
  for (const entity of ordinary) {
    if (copiedTargetIds.has(entity.id)) continue
    const location = findSceneTreeLocation(scene.rootItems, entity.id)
    if (!location?.parent) {
      selectedItems.push(location?.item ?? { kind: 'entity', entityId: entity.id })
      copiedTargetIds.add(entity.id)
    }
  }
  const sourceIds = new Set(selectedItems.flatMap(collectSceneTreeEntityIds))
  for (const entity of ordinary) sourceIds.add(entity.id)
  return {
    entities: scene.entities.filter((entity) => sourceIds.has(entity.id)),
    rootItems: selectedItems,
  }
}

function offsetEntity(entity: SceneEntity, offset: Vec2): SceneEntity {
  if (entity.kind === 'body') {
    return {
      ...entity,
      transform: { ...entity.transform, position: offsetPoint(entity.transform.position, offset) },
    }
  }
  if (entity.kind === 'ground') {
    const geometry = entity.geometry
    if (geometry.type === 'line') {
      return {
        ...entity,
        geometry: {
          ...geometry,
          start: offsetPoint(geometry.start, offset),
          end: offsetPoint(geometry.end, offset),
        },
      }
    }
    if (geometry.type === 'arc')
      return { ...entity, geometry: { ...geometry, center: offsetPoint(geometry.center, offset) } }
    return {
      ...entity,
      geometry: {
        ...geometry,
        p0: offsetPoint(geometry.p0, offset),
        p1: offsetPoint(geometry.p1, offset),
        p2: offsetPoint(geometry.p2, offset),
        p3: offsetPoint(geometry.p3, offset),
      },
    }
  }
  if (entity.kind === 'field') {
    const region = entity.region
    if (region.type === 'infinite') return entity
    if (region.type === 'polygon')
      return {
        ...entity,
        region: { ...region, points: region.points.map((point) => offsetPoint(point, offset)) },
      }
    if (region.type === 'bezierPath') {
      return {
        ...entity,
        region: {
          ...region,
          nodes: region.nodes.map((node) => ({
            anchor: offsetPoint(node.anchor, offset),
            inHandle: offsetPoint(node.inHandle, offset),
            outHandle: offsetPoint(node.outHandle, offset),
          })),
        },
      }
    }
    return { ...entity, region: { ...region, center: offsetPoint(region.center, offset) } }
  }
  return entity
}

export function duplicateEntities(
  source: readonly SceneEntity[],
  createId: () => EntityId = () => crypto.randomUUID(),
  offset: Vec2 = { x: 0.2, y: -0.2 },
): SceneEntity[] {
  return duplicateSceneClipboard(
    {
      entities: [...source],
      rootItems: source.map((entity) => ({ kind: 'entity', entityId: entity.id })),
    },
    createId,
    offset,
  ).entities
}

export function duplicateSceneClipboard(
  source: SceneClipboardPayload,
  createId: () => EntityId = () => crypto.randomUUID(),
  offset: Vec2 = { x: 0.2, y: -0.2 },
): DuplicatedSceneClipboard {
  const entityIdMap = new Map(source.entities.map((entity) => [entity.id, createId()]))
  const nodeIdMap = new Map<string, string>()
  const resultIdMap = new Map<string, string>()
  const collectNodeIds = (item: SceneTreeItem): void => {
    if (item.kind !== 'boolean') return
    nodeIdMap.set(item.id, createId())
    resultIdMap.set(item.resultId, createId())
    item.operands.forEach(collectNodeIds)
  }
  source.rootItems.forEach(collectNodeIds)
  const targetIdMap = new Map<EntityId, EntityId>([...entityIdMap, ...resultIdMap])

  const remapEndpoint = (endpoint: ConnectorEndpoint): ConnectorEndpoint | null => {
    if (endpoint.type === 'world' || endpoint.type === 'free')
      return { ...endpoint, position: offsetPoint(endpoint.position, offset) }
    if (endpoint.type === 'body') {
      const bodyId = targetIdMap.get(endpoint.bodyId)
      return bodyId ? { ...endpoint, bodyId } : null
    }
    if (endpoint.type === 'ground') {
      const groundId = entityIdMap.get(endpoint.groundId)
      return groundId ? { ...endpoint, groundId } : null
    }
    const groundJointId = entityIdMap.get(endpoint.groundJointId)
    return groundJointId ? { ...endpoint, groundJointId } : null
  }

  const entities: SceneEntity[] = []
  for (const original of source.entities) {
    const id = entityIdMap.get(original.id)!
    if (original.kind === 'groundJoint') {
      const firstGroundId = entityIdMap.get(original.a.groundId)
      const secondGroundId = entityIdMap.get(original.b.groundId)
      if (!firstGroundId || !secondGroundId) continue
      entities.push({
        ...structuredClone(original),
        id,
        name: `${original.name} 副本`,
        a: { ...original.a, groundId: firstGroundId },
        b: { ...original.b, groundId: secondGroundId },
      })
      continue
    }
    if (original.kind === 'connector') {
      const a = remapEndpoint(original.a)
      const b = remapEndpoint(original.b)
      if (!a || !b) continue
      entities.push({ ...structuredClone(original), id, name: `${original.name} 副本`, a, b })
      continue
    }
    entities.push(
      offsetEntity(
        { ...structuredClone(original), id, name: `${original.name} 副本` } as SceneEntity,
        offset,
      ),
    )
  }

  const remapItem = (item: SceneTreeItem): SceneTreeItem =>
    item.kind === 'entity'
      ? { kind: 'entity', entityId: entityIdMap.get(item.entityId)! }
      : {
          ...structuredClone(item),
          id: nodeIdMap.get(item.id)!,
          resultId: resultIdMap.get(item.resultId)!,
          name: `${item.name} 副本`,
          operands: item.operands.map(remapItem),
        }
  const rootItems = source.rootItems.map(remapItem)
  return {
    entities,
    rootItems,
    selectedIds: rootItems.map(sceneTreeItemTargetId),
  }
}
