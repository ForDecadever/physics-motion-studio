import type { EntityId, SceneEntity, Vec2 } from '../../scene/model/types'

function offsetPoint(point: Vec2, offset: Vec2): Vec2 {
  return { x: point.x + offset.x, y: point.y + offset.y }
}

export function collectClipboardEntities(
  entities: readonly SceneEntity[],
  selectedIds: readonly EntityId[],
): SceneEntity[] {
  const selected = new Set(selectedIds)
  return entities.filter((entity) => {
    if (entity.kind === 'connector') {
      return selected.has(entity.a.bodyId) && selected.has(entity.b.bodyId)
    }
    if (entity.kind === 'groundJoint') {
      return selected.has(entity.a.groundId) && selected.has(entity.b.groundId)
    }
    return selected.has(entity.id)
  })
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
    if (geometry.type === 'arc') {
      return { ...entity, geometry: { ...geometry, center: offsetPoint(geometry.center, offset) } }
    }
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
    if (region.type === 'polygon') {
      return {
        ...entity,
        region: { ...region, points: region.points.map((point) => offsetPoint(point, offset)) },
      }
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
  const idMap = new Map(source.map((entity) => [entity.id, createId()]))
  const duplicated: SceneEntity[] = []

  for (const original of source) {
    const id = idMap.get(original.id)
    if (!id) continue
    if (original.kind === 'groundJoint') {
      const firstGroundId = idMap.get(original.a.groundId)
      const secondGroundId = idMap.get(original.b.groundId)
      if (!firstGroundId || !secondGroundId) continue
      duplicated.push({
        ...structuredClone(original),
        id,
        name: `${original.name} 副本`,
        a: { ...original.a, groundId: firstGroundId },
        b: { ...original.b, groundId: secondGroundId },
      })
      continue
    }
    if (original.kind === 'connector') {
      const firstBodyId = idMap.get(original.a.bodyId)
      const secondBodyId = idMap.get(original.b.bodyId)
      if (!firstBodyId || !secondBodyId) continue
      duplicated.push({
        ...structuredClone(original),
        id,
        name: `${original.name} 副本`,
        a: { ...original.a, bodyId: firstBodyId },
        b: { ...original.b, bodyId: secondBodyId },
      })
      continue
    }
    duplicated.push(
      offsetEntity(
        { ...structuredClone(original), id, name: `${original.name} 副本` } as SceneEntity,
        offset,
      ),
    )
  }
  return duplicated
}
