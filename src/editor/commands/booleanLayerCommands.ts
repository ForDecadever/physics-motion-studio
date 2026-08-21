import { resolveBooleanScene } from '../../scene/model/booleanGeometry'
import {
  classifySceneTreeItem,
  findBooleanNode,
  findSceneTreeLocation,
  sceneTreeItemTargetId,
} from '../../scene/model/booleanLayerGraph'
import { createBooleanLayer } from '../../scene/model/layerFactories'
import type {
  BodyEntity,
  BooleanNode,
  BooleanOperation,
  ChartDefinition,
  ConnectorEndpoint,
  ConnectorEntity,
  EntityId,
  SceneDocument,
  SceneEntity,
  SceneTreeItem,
  Vec2,
} from '../../scene/model/types'
import { preserveBooleanConnectorWorldAnchors, SceneGraphCommand } from './entityCommands'

interface BooleanCommandResult {
  command: SceneGraphCommand
  nodeId: string
  resultId: EntityId
}

interface TargetDescriptor {
  id: EntityId
  item: SceneTreeItem
  rootIndex: number
  classification: 'body' | `field:${string}` | 'unsupported'
  simulationEnabled: boolean
  rotationEnabled: boolean
  continuousCollisionDetection: boolean
}

function classificationFor(
  scene: SceneDocument,
  item: SceneTreeItem,
): TargetDescriptor['classification'] {
  const classification = classifySceneTreeItem(scene, item)
  if (classification.kind === 'body') return 'body'
  if (classification.kind === 'field') return `field:${classification.fieldType}`
  return 'unsupported'
}

function descriptorForRootTarget(scene: SceneDocument, id: EntityId): TargetDescriptor | null {
  const location = findSceneTreeLocation(scene.rootItems, id)
  if (!location || location.parent) return null
  const item = location.item
  const entity =
    item.kind === 'entity'
      ? scene.entities.find((candidate) => candidate.id === item.entityId)
      : null
  return {
    id: sceneTreeItemTargetId(item),
    item,
    rootIndex: location.rootIndex,
    classification: classificationFor(scene, item),
    simulationEnabled:
      item.kind === 'boolean' ? item.simulationEnabled : (entity?.simulationEnabled ?? true),
    rotationEnabled:
      item.kind === 'boolean'
        ? item.rotationEnabled
        : entity?.kind === 'body'
          ? entity.rotationEnabled
          : true,
    continuousCollisionDetection:
      item.kind === 'boolean'
        ? item.continuousCollisionDetection
        : entity?.kind === 'body'
          ? entity.continuousCollisionDetection
          : false,
  }
}

function endpointWorldPosition(endpoint: ConnectorEndpoint, scene: SceneDocument): Vec2 | null {
  if (endpoint.type !== 'body') return null
  const body = scene.entities.find(
    (entity): entity is BodyEntity => entity.kind === 'body' && entity.id === endpoint.bodyId,
  )
  if (body) {
    const cosine = Math.cos(body.transform.angleRad)
    const sine = Math.sin(body.transform.angleRad)
    return {
      x:
        body.transform.position.x + endpoint.localAnchor.x * cosine - endpoint.localAnchor.y * sine,
      y:
        body.transform.position.y + endpoint.localAnchor.x * sine + endpoint.localAnchor.y * cosine,
    }
  }
  const result = resolveBooleanScene(scene).byResultId.get(endpoint.bodyId)
  if (!result?.valid || result.kind !== 'body') return null
  const cosine = Math.cos(result.angleRad)
  const sine = Math.sin(result.angleRad)
  return {
    x: result.centerOfMass.x + endpoint.localAnchor.x * cosine - endpoint.localAnchor.y * sine,
    y: result.centerOfMass.y + endpoint.localAnchor.x * sine + endpoint.localAnchor.y * cosine,
  }
}

function localAnchorForResult(world: Vec2, scene: SceneDocument, resultId: EntityId): Vec2 {
  const result = resolveBooleanScene(scene).byResultId.get(resultId)
  if (!result?.valid || result.kind !== 'body') return { x: 0, y: 0 }
  const cosine = Math.cos(-result.angleRad)
  const sine = Math.sin(-result.angleRad)
  const x = world.x - result.centerOfMass.x
  const y = world.y - result.centerOfMass.y
  return { x: x * cosine - y * sine, y: x * sine + y * cosine }
}

function remapEndpoint(
  endpoint: ConnectorEndpoint,
  targetIds: Set<EntityId>,
  resultId: EntityId,
  before: SceneDocument,
  after: SceneDocument,
): ConnectorEndpoint {
  if (endpoint.type !== 'body' || !targetIds.has(endpoint.bodyId)) return endpoint
  const world = endpointWorldPosition(endpoint, before)
  return {
    type: 'body',
    bodyId: resultId,
    localAnchor: world ? localAnchorForResult(world, after, resultId) : { x: 0, y: 0 },
  }
}

function remapConnectors(
  entities: SceneEntity[],
  targetIds: Set<EntityId>,
  resultId: EntityId,
  before: SceneDocument,
  provisional: SceneDocument,
): SceneEntity[] {
  return entities.flatMap((entity): SceneEntity[] => {
    if (entity.kind !== 'connector') return [entity]
    const a = remapEndpoint(entity.a, targetIds, resultId, before, provisional)
    const b = remapEndpoint(entity.b, targetIds, resultId, before, provisional)
    if (a.type === 'body' && b.type === 'body' && a.bodyId === resultId && b.bodyId === resultId) {
      return []
    }
    return [{ ...entity, a, b } satisfies ConnectorEntity]
  })
}

function remapCharts(
  charts: ChartDefinition[],
  targetIds: EntityId[],
  resultId: EntityId,
): ChartDefinition[] {
  const targets = new Set(targetIds)
  return charts.map((chart) => {
    const orderedSeries = [
      ...targetIds.flatMap((targetId) =>
        chart.series.filter((series) => series.entityId === targetId),
      ),
      ...chart.series.filter((series) => !targets.has(series.entityId)),
    ]
    const seenSeries = new Set<EntityId>()
    const series = orderedSeries.flatMap((candidate) => {
      const next = targets.has(candidate.entityId)
        ? { ...candidate, entityId: resultId }
        : candidate
      if (seenSeries.has(next.entityId)) return []
      seenSeries.add(next.entityId)
      return [next]
    })
    const orderedBindings = [
      ...targetIds.flatMap((targetId) =>
        chart.bindings.filter((binding) => binding.entityId === targetId),
      ),
      ...chart.bindings.filter((binding) => !targets.has(binding.entityId)),
    ]
    const seenBindings = new Set<EntityId>()
    const bindings = orderedBindings.flatMap((candidate) => {
      const next = targets.has(candidate.entityId)
        ? { ...candidate, entityId: resultId }
        : candidate
      if (seenBindings.has(next.entityId)) return []
      seenBindings.add(next.entityId)
      return [next]
    })
    return { ...chart, series, bindings }
  })
}

function applyReferenceRemap(
  before: SceneDocument,
  provisional: SceneDocument,
  targetIds: EntityId[],
  resultId: EntityId,
): SceneDocument {
  const targetSet = new Set(targetIds)
  return {
    ...provisional,
    entities: remapConnectors(provisional.entities, targetSet, resultId, before, provisional),
    charts: remapCharts(provisional.charts, targetIds, resultId),
  }
}

function mapNode(
  items: readonly SceneTreeItem[],
  nodeId: string,
  update: (node: BooleanNode) => BooleanNode,
): SceneTreeItem[] {
  return items.map((item) => {
    if (item.kind !== 'boolean') return item
    if (item.id === nodeId) return update(item)
    return { ...item, operands: mapNode(item.operands, nodeId, update) }
  })
}

function removeRootTargets(
  rootItems: readonly SceneTreeItem[],
  targetIds: ReadonlySet<string>,
): SceneTreeItem[] {
  return rootItems.filter((item) => !targetIds.has(sceneTreeItemTargetId(item)))
}

function removeItem(
  items: readonly SceneTreeItem[],
  targetId: string,
): { items: SceneTreeItem[]; removed: SceneTreeItem | null } {
  let removed: SceneTreeItem | null = null
  const next = items.flatMap((item): SceneTreeItem[] => {
    if (
      sceneTreeItemTargetId(item) === targetId ||
      (item.kind === 'boolean' && item.id === targetId)
    ) {
      removed = item
      return []
    }
    if (item.kind !== 'boolean') return [item]
    const childResult = removeItem(item.operands, targetId)
    if (childResult.removed) removed = childResult.removed
    return [{ ...item, operands: childResult.items }]
  })
  return { items: next, removed }
}

export function createBooleanLayerCommand(
  scene: SceneDocument,
  operation: BooleanOperation,
  selectedIds: EntityId[],
): BooleanCommandResult {
  const selected = selectedIds
    .map((id) => descriptorForRootTarget(scene, id))
    .filter((descriptor): descriptor is TargetDescriptor => descriptor !== null)
    .sort((a, b) => a.rootIndex - b.rootIndex)
  const compatible =
    selected.length === 2 &&
    selected[0]!.classification !== 'unsupported' &&
    selected[0]!.classification === selected[1]!.classification
  const inputs = compatible ? selected : []
  const upper = inputs[0]
  const node = createBooleanLayer(
    operation,
    operation === 'union' ? '布尔加法' : '布尔减法',
    inputs.map((descriptor) => descriptor.item),
  )
  if (upper) {
    node.simulationEnabled = upper.simulationEnabled
    node.rotationEnabled = upper.rotationEnabled
    node.continuousCollisionDetection = upper.continuousCollisionDetection
  }
  const selectedTargets = new Set(inputs.map((input) => input.id))
  const insertionIndex = upper?.rootIndex ?? scene.rootItems.length
  const rootItems = removeRootTargets(scene.rootItems, selectedTargets)
  rootItems.splice(Math.min(insertionIndex, rootItems.length), 0, node)
  const provisional = { ...scene, rootItems }
  const after = compatible
    ? applyReferenceRemap(
        scene,
        provisional,
        inputs.map((input) => input.id),
        node.resultId,
      )
    : provisional
  return {
    command: new SceneGraphCommand(
      operation === 'union' ? '新建布尔加法' : '新建布尔减法',
      scene,
      after,
    ),
    nodeId: node.id,
    resultId: node.resultId,
  }
}

export function createSwapBooleanOperandsCommand(
  scene: SceneDocument,
  nodeId: string,
): SceneGraphCommand | null {
  const node = findBooleanNode(scene.rootItems, nodeId)
  if (!node || node.operands.length !== 2) return null
  const provisional = {
    ...scene,
    rootItems: mapNode(scene.rootItems, node.id, (candidate) => ({
      ...candidate,
      operands: [candidate.operands[1]!, candidate.operands[0]!],
    })),
  }
  return new SceneGraphCommand(
    '交换布尔输入顺序',
    scene,
    preserveBooleanConnectorWorldAnchors(scene, provisional),
  )
}

export function createAddBooleanOperandCommand(
  scene: SceneDocument,
  nodeId: string,
  targetId: EntityId,
): SceneGraphCommand | null {
  const node = findBooleanNode(scene.rootItems, nodeId)
  const target = descriptorForRootTarget(scene, targetId)
  if (!node || !target || target.classification === 'unsupported' || node.operands.length >= 2) {
    return null
  }
  const nodeLocation = findSceneTreeLocation(scene.rootItems, node.id)
  if (!nodeLocation || target.item === node || target.id === node.resultId) return null
  const first = node.operands[0]
  if (first && classificationFor(scene, first) !== target.classification) return null
  const rootItemsWithoutTarget = removeRootTargets(scene.rootItems, new Set([target.id]))
  const rootItems = mapNode(rootItemsWithoutTarget, node.id, (candidate) => ({
    ...candidate,
    operands: [...candidate.operands, target.item],
    ...(candidate.operands.length === 0
      ? {
          simulationEnabled: target.simulationEnabled,
          rotationEnabled: target.rotationEnabled,
          continuousCollisionDetection: target.continuousCollisionDetection,
        }
      : {}),
  }))
  const provisional = { ...scene, rootItems }
  const completed = findBooleanNode(rootItems, node.id)
  const targetIds = completed?.operands.map(sceneTreeItemTargetId) ?? []
  const after =
    completed?.operands.length === 2
      ? applyReferenceRemap(scene, provisional, targetIds, completed.resultId)
      : provisional
  return new SceneGraphCommand('添加布尔输入', scene, after)
}

export function createRemoveBooleanOperandCommand(
  scene: SceneDocument,
  nodeId: string,
  operandIndex: number,
): SceneGraphCommand | null {
  const node = findBooleanNode(scene.rootItems, nodeId)
  const operand = node?.operands[operandIndex]
  if (!node || !operand) return null
  const rootLocation = findSceneTreeLocation(scene.rootItems, node.id)
  const rootIndex = rootLocation?.rootIndex ?? scene.rootItems.length - 1
  const rootItems = mapNode(scene.rootItems, node.id, (candidate) => ({
    ...candidate,
    operands: candidate.operands.filter((_, index) => index !== operandIndex),
  }))
  rootItems.splice(Math.min(rootIndex + 1, rootItems.length), 0, operand)
  return new SceneGraphCommand('移出布尔输入', scene, { ...scene, rootItems })
}

export function createDissolveBooleanLayerCommand(
  scene: SceneDocument,
  nodeId: string,
): SceneGraphCommand | null {
  const node = findBooleanNode(scene.rootItems, nodeId)
  if (!node) return null
  const location = findSceneTreeLocation(scene.rootItems, node.id)
  const upper = node.operands[0] ?? null
  const lower = node.operands[1] ?? null
  const removed = removeItem(scene.rootItems, node.id)
  let rootItems = removed.items
  if (upper) {
    if (location?.parent) {
      rootItems = mapNode(rootItems, location.parent.id, (parent) => {
        const operands = [...parent.operands]
        operands.splice(location.index, 0, upper)
        return { ...parent, operands }
      })
    } else {
      rootItems.splice(Math.min(location?.rootIndex ?? 0, rootItems.length), 0, upper)
    }
  }
  if (lower) {
    const promoteAfter = Math.min(
      (location?.rootIndex ?? rootItems.length - 1) + 1,
      rootItems.length,
    )
    rootItems.splice(promoteAfter, 0, lower)
  }
  const replacementId = upper ? sceneTreeItemTargetId(upper) : null
  let entities = scene.entities
  let charts = scene.charts
  if (replacementId) {
    entities = entities.map((entity) => {
      if (entity.kind !== 'connector') return entity
      const remap = (endpoint: ConnectorEndpoint): ConnectorEndpoint =>
        endpoint.type === 'body' && endpoint.bodyId === node.resultId
          ? { ...endpoint, bodyId: replacementId }
          : endpoint
      return { ...entity, a: remap(entity.a), b: remap(entity.b) }
    })
    charts = remapCharts(charts, [node.resultId], replacementId)
  }
  return new SceneGraphCommand('解散布尔组合', scene, {
    ...scene,
    rootItems,
    entities,
    charts,
  })
}

export function createMoveRootItemCommand(
  scene: SceneDocument,
  targetId: string,
  direction: -1 | 1,
): SceneGraphCommand | null {
  const index = scene.rootItems.findIndex((item) => sceneTreeItemTargetId(item) === targetId)
  const nextIndex = index + direction
  if (index < 0 || nextIndex < 0 || nextIndex >= scene.rootItems.length) return null
  const rootItems = [...scene.rootItems]
  const [item] = rootItems.splice(index, 1)
  rootItems.splice(nextIndex, 0, item!)
  return new SceneGraphCommand(direction < 0 ? '上移场景项' : '下移场景项', scene, {
    ...scene,
    rootItems,
  })
}

export function createMoveTreeItemToRootCommand(
  scene: SceneDocument,
  targetId: string,
  anchorTargetId: string,
  placement: 'before' | 'after',
): SceneGraphCommand | null {
  if (targetId === anchorTargetId) return null
  const target = findSceneTreeLocation(scene.rootItems, targetId)
  const anchor = findSceneTreeLocation(scene.rootItems, anchorTargetId)
  if (!target || !anchor || anchor.parent) return null

  const removed = removeItem(scene.rootItems, targetId)
  if (!removed.removed) return null
  const anchorIndex = removed.items.findIndex(
    (item) => sceneTreeItemTargetId(item) === anchorTargetId,
  )
  if (anchorIndex < 0) return null

  const rootItems = [...removed.items]
  rootItems.splice(anchorIndex + (placement === 'after' ? 1 : 0), 0, removed.removed)
  return new SceneGraphCommand('移动场景树项目', scene, { ...scene, rootItems })
}

export function createReplaceBooleanNodeCommand(
  scene: SceneDocument,
  replacement: BooleanNode,
  label: string,
): SceneGraphCommand {
  const provisional = {
    ...scene,
    rootItems: mapNode(scene.rootItems, replacement.id, () => replacement),
  }
  return new SceneGraphCommand(
    label,
    scene,
    preserveBooleanConnectorWorldAnchors(scene, provisional),
  )
}
