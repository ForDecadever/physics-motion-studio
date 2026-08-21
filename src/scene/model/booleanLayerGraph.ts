import type { BooleanNode, FieldEntity, SceneDocument, SceneEntity, SceneTreeItem } from './types'

export const MAX_BOOLEAN_TREE_DEPTH = 64
export const MAX_BOOLEAN_OPERANDS = 2

export interface BooleanGraphIssue {
  path: (string | number)[]
  message: string
}

export type BooleanOperandClass =
  | { kind: 'body' }
  | { kind: 'field'; fieldType: FieldEntity['field']['type'] }
  | { kind: 'unsupported' }
  | { kind: 'missing' }

export interface SceneTreeLocation {
  item: SceneTreeItem
  parent: BooleanNode | null
  index: number
  rootIndex: number
  ancestors: BooleanNode[]
}

export function isBooleanLayer(item: SceneTreeItem): item is BooleanNode {
  return item.kind === 'boolean'
}

export const isBooleanNode = isBooleanLayer

export function isFiniteFieldEntity(entity: SceneEntity): entity is FieldEntity {
  return entity.kind === 'field' && entity.region.type !== 'infinite'
}

export function classifyBooleanEntity(entity: SceneEntity | undefined): BooleanOperandClass {
  if (!entity) return { kind: 'missing' }
  if (entity.kind === 'body') return { kind: 'body' }
  if (isFiniteFieldEntity(entity)) return { kind: 'field', fieldType: entity.field.type }
  return { kind: 'unsupported' }
}

export function sceneTreeItemTargetId(item: SceneTreeItem): string {
  return item.kind === 'entity' ? item.entityId : item.resultId
}

export function walkSceneTree(
  rootItems: readonly SceneTreeItem[],
  visit: (location: SceneTreeLocation) => void,
): void {
  const walk = (
    items: readonly SceneTreeItem[],
    parent: BooleanNode | null,
    rootIndex: number,
    ancestors: BooleanNode[],
  ): void => {
    items.forEach((item, index) => {
      const nextRootIndex = parent ? rootIndex : index
      visit({ item, parent, index, rootIndex: nextRootIndex, ancestors })
      if (item.kind === 'boolean') {
        walk(item.operands, item, nextRootIndex, [...ancestors, item])
      }
    })
  }
  walk(rootItems, null, -1, [])
}

export function findSceneTreeLocation(
  rootItems: readonly SceneTreeItem[],
  targetId: string,
): SceneTreeLocation | null {
  let found: SceneTreeLocation | null = null
  walkSceneTree(rootItems, (location) => {
    if (found) return
    const { item } = location
    if (
      (item.kind === 'entity' && item.entityId === targetId) ||
      (item.kind === 'boolean' && (item.id === targetId || item.resultId === targetId))
    ) {
      found = location
    }
  })
  return found
}

export function findBooleanNode(
  rootItems: readonly SceneTreeItem[],
  targetId: string,
): BooleanNode | null {
  const item = findSceneTreeLocation(rootItems, targetId)?.item
  return item?.kind === 'boolean' ? item : null
}

export function findRootBooleanLayers(rootItems: readonly SceneTreeItem[]): BooleanNode[] {
  return rootItems.filter(isBooleanLayer)
}

export function collectSceneTreeEntityIds(item: SceneTreeItem): string[] {
  if (item.kind === 'entity') return [item.entityId]
  return item.operands.flatMap(collectSceneTreeEntityIds)
}

export function collectSceneTreeTargetIds(item: SceneTreeItem): string[] {
  if (item.kind === 'entity') return [item.entityId]
  return [item.resultId, ...item.operands.flatMap(collectSceneTreeTargetIds)]
}

export function isTreeItemEffectivelyVisible(
  rootItems: readonly SceneTreeItem[],
  targetId: string,
): boolean {
  const location = findSceneTreeLocation(rootItems, targetId)
  if (!location) return false
  return [...location.ancestors, location.item].every(
    (item) => item.kind !== 'boolean' || item.visible,
  )
}

export function isTreeItemEffectivelyLocked(
  rootItems: readonly SceneTreeItem[],
  targetId: string,
): boolean {
  const location = findSceneTreeLocation(rootItems, targetId)
  if (!location) return false
  return [...location.ancestors, location.item].some(
    (item) => item.kind === 'boolean' && item.locked,
  )
}

export const isLayerEffectivelyVisible = isTreeItemEffectivelyVisible
export const isLayerEffectivelyLocked = isTreeItemEffectivelyLocked

export function mapSceneTreeItems(
  items: readonly SceneTreeItem[],
  mapItem: (item: SceneTreeItem) => SceneTreeItem,
): SceneTreeItem[] {
  return items.map((item) => {
    const withMappedChildren =
      item.kind === 'boolean'
        ? { ...item, operands: mapSceneTreeItems(item.operands, mapItem) }
        : item
    return mapItem(withMappedChildren)
  })
}

function classForItem(
  item: SceneTreeItem,
  entityById: ReadonlyMap<string, SceneEntity>,
): BooleanOperandClass {
  if (item.kind === 'entity') return classifyBooleanEntity(entityById.get(item.entityId))
  if (item.operands.length === 0) return { kind: 'missing' }
  const classes = item.operands.map((operand) => classForItem(operand, entityById))
  const first = classes[0]
  if (!first || first.kind === 'missing') return { kind: 'missing' }
  if (classes.some((candidate) => candidate.kind === 'unsupported')) return { kind: 'unsupported' }
  if (classes.some((candidate) => candidate.kind === 'missing')) return { kind: 'missing' }
  if (first.kind === 'body' && classes.every((candidate) => candidate.kind === 'body')) {
    return { kind: 'body' }
  }
  if (
    first.kind === 'field' &&
    classes.every(
      (candidate) => candidate.kind === 'field' && candidate.fieldType === first.fieldType,
    )
  ) {
    return first
  }
  return { kind: 'unsupported' }
}

export function classifySceneTreeItem(
  scene: Pick<SceneDocument, 'entities'>,
  item: SceneTreeItem,
): BooleanOperandClass {
  return classForItem(item, new Map(scene.entities.map((entity) => [entity.id, entity])))
}

export function validateBooleanLayerGraph(
  scene: Pick<SceneDocument, 'rootItems' | 'entities'>,
): BooleanGraphIssue[] {
  const issues: BooleanGraphIssue[] = []
  const entityById = new Map(scene.entities.map((entity) => [entity.id, entity]))
  const entityIndexes = new Map(scene.entities.map((entity, index) => [entity.id, index]))
  const seenEntityIds = new Set<string>()
  const seenNodeIds = new Set<string>()
  const seenResultIds = new Set<string>()
  const activeObjects = new Set<object>()

  const visit = (item: SceneTreeItem, path: (string | number)[], depth: number): void => {
    if (depth > MAX_BOOLEAN_TREE_DEPTH) {
      issues.push({ path, message: `布尔树深度不能超过 ${MAX_BOOLEAN_TREE_DEPTH} 层。` })
      return
    }
    if (activeObjects.has(item)) {
      issues.push({ path, message: '场景树不能形成循环。' })
      return
    }
    activeObjects.add(item)
    if (item.kind === 'entity') {
      if (!entityById.has(item.entityId)) {
        issues.push({ path: [...path, 'entityId'], message: '场景树引用了不存在的实体。' })
      } else if (seenEntityIds.has(item.entityId)) {
        issues.push({ path: [...path, 'entityId'], message: '同一实体只能在场景树中出现一次。' })
      }
      seenEntityIds.add(item.entityId)
      activeObjects.delete(item)
      return
    }

    if (seenNodeIds.has(item.id)) {
      issues.push({ path: [...path, 'id'], message: '布尔节点 ID 不能重复。' })
    }
    seenNodeIds.add(item.id)
    if (
      seenResultIds.has(item.resultId) ||
      entityById.has(item.resultId) ||
      seenNodeIds.has(item.resultId)
    ) {
      issues.push({ path: [...path, 'resultId'], message: '布尔结果 ID 必须在全场景唯一。' })
    }
    seenResultIds.add(item.resultId)
    if (item.operands.length > MAX_BOOLEAN_OPERANDS) {
      issues.push({ path: [...path, 'operands'], message: '布尔节点最多只能包含两个输入。' })
    }
    item.operands.forEach((operand, index) =>
      visit(operand, [...path, 'operands', index], depth + 1),
    )
    if (item.operands.length === 2 && classForItem(item, entityById).kind === 'unsupported') {
      issues.push({ path: [...path, 'operands'], message: '布尔节点的两个输入类型不兼容。' })
    }
    activeObjects.delete(item)
  }

  scene.rootItems.forEach((item, index) => visit(item, ['rootItems', index], 1))
  for (const entity of scene.entities) {
    if (!seenEntityIds.has(entity.id)) {
      issues.push({
        path: ['entities', entityIndexes.get(entity.id) ?? 0, 'id'],
        message: '每个实体必须在场景树中恰好出现一次。',
      })
    }
  }
  return issues
}
