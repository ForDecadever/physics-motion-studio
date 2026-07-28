import { useEffect, useRef, useState } from 'react'

import {
  panCamera,
  getVisibleSnapStep,
  screenToWorld,
  snapAngle,
  snapPoint,
  zoomCameraAtPoint,
  type Camera2D,
  type ViewportSize,
} from '../../editor/camera/viewport'
import {
  createAddEntityCommand,
  createReplaceEntitiesCommand,
} from '../../editor/commands/entityCommands'
import {
  createGroundWithAutoJoint,
  resolveGroundCreationStart,
} from '../../editor/ground/autoGroundJoint'
import {
  distance,
  getEntityById,
  getEntityTransform,
  resolveConnectorEndpoint,
  snapBodyToGround,
  subtract,
  worldToLocalAnchor,
  withEntityTransform,
} from '../../editor/geometry/entityGeometry'
import {
  entitiesInsideBounds,
  findNearestGroundEndpoint,
  findTopEntity,
} from '../../editor/geometry/hitTest'
import { PixiSceneRenderer } from '../../renderer/pixi/PixiSceneRenderer'
import { resolveRenderedEntity } from '../../renderer/pixi/renderEntityState'
import {
  createArcGround,
  createBall,
  createBezierGround,
  createBlock,
  createElectricField,
  createGravityField,
  createGroundJoint,
  createLineGround,
  createMagneticField,
  createRod,
  createRope,
  createSpring,
} from '../../scene/model/entityFactories'
import { createSmoothBezierPathNodes, moveBezierPathPoint } from '../../scene/model/bezierPath'
import { sameGroundEndpoint } from '../../scene/model/groundEndpoints'
import {
  buildGroundPathNetwork,
  type GroundJointPathIssue,
  type ResolvedGroundJointPath,
} from '../../scene/model/groundPath'
import type {
  BezierPathNode,
  ConnectorEntity,
  EntityId,
  FieldEntity,
  GroundEndpointRef,
  GroundEntity,
  LayerId,
  SceneEntity,
  Vec2,
} from '../../scene/model/types'
import { useDocumentStore } from '../../stores/documentStore'
import {
  useEditorStore,
  type BodyToolPreset,
  type EditorTool,
  type FieldToolPreset,
  type FieldRegionToolShape,
} from '../../stores/editorStore'
import { isSimulationRuntimeLocked, useSimulationStore } from '../../stores/simulationStore'
import styles from './CanvasWorkspace.module.css'

type Interaction =
  | { type: 'idle' }
  | { type: 'pan'; startScreen: Vec2; startCamera: Camera2D }
  | { type: 'marquee'; startWorld: Vec2 }
  | { type: 'move'; startWorld: Vec2; originals: SceneEntity[]; anchorId: EntityId }
  | {
      type: 'rotate'
      pivot: Vec2
      startPointerAngle: number
      originals: SceneEntity[]
    }
  | {
      type: 'create'
      tool: 'ground' | 'body' | 'field'
      startWorld: Vec2
      draftId: EntityId
      layerId: LayerId
      index: number
      groundShape: 'line' | 'arc' | 'cubicBezier'
      bodyPreset: BodyToolPreset
      fieldPreset: FieldToolPreset
      fieldRegionShape: FieldRegionToolShape
      pendingGroundEndpoint: GroundEndpointRef | null
    }
  | {
      type: 'groundPen'
      startWorld: Vec2
      draftId: EntityId
      layerId: LayerId
      index: number
      pendingGroundEndpoint: GroundEndpointRef | null
    }
  | {
      type: 'fieldPen'
      points: Vec2[]
      draftId: EntityId
      layerId: LayerId
      index: number
      fieldPreset: FieldToolPreset
    }
  | {
      type: 'editBezierPoint'
      original: GroundEntity
      pointKey: 'p0' | 'p1' | 'p2' | 'p3'
    }
  | {
      type: 'editFieldPoint'
      original: FieldEntity
      pointIndex: number
    }
  | {
      type: 'editFieldPathPoint'
      original: FieldEntity
      nodeIndex: number
      pointKey: keyof BezierPathNode
    }
  | {
      type: 'editConnectorAnchor'
      original: ConnectorEntity
      endpointKey: 'a' | 'b'
    }

function localPoint(event: PointerEvent | WheelEvent, canvas: HTMLCanvasElement): Vec2 {
  const bounds = canvas.getBoundingClientRect()
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
}

function toolCursor(tool: EditorTool): string {
  if (tool === 'hand') return 'grab'
  if (tool === 'zoom') return 'zoom-in'
  if (['rotate', 'ground', 'groundJoint', 'body', 'field', 'connector'].includes(tool))
    return 'crosshair'
  return 'default'
}

function endpointIsOccupied(
  entities: readonly SceneEntity[],
  endpoint: GroundEndpointRef,
): boolean {
  return entities.some(
    (entity) =>
      entity.kind === 'groundJoint' &&
      (sameGroundEndpoint(entity.a, endpoint) || sameGroundEndpoint(entity.b, endpoint)),
  )
}

function groundJointIssueMessage(issue: GroundJointPathIssue): string {
  if (issue === 'same-ground') return '地面连接点必须连接两块不同的地面。'
  if (issue === 'endpoint-conflict') return '至少一个端点已被其他地面连接点占用。'
  if (issue === 'angle-too-small') return '两块地面的方向几乎重合，无需创建连接线。'
  if (issue === 'linear-zero-length') return '反向地面的两个端点重合，无法生成直线连接。'
  if (issue === 'transition-invalid') return '无法生成有限、无自交的安全过渡，请重新选择端点。'
  if (issue === 'degenerate-tangent') return '端点切线无法确定，请检查零长度地面或控制点。'
  if (issue === 'missing-ground') return '找不到端点对应的地面，请重新选择。'
  return ''
}

function sameEndpointOrNull(
  first: GroundEndpointRef | null,
  second: GroundEndpointRef | null,
): boolean {
  return first === second || (!!first && !!second && sameGroundEndpoint(first, second))
}

function resolveGroundJointPath(
  entities: readonly SceneEntity[],
  joint: ReturnType<typeof createGroundJoint>,
): ResolvedGroundJointPath | null {
  return buildGroundPathNetwork([...entities, joint]).jointPaths.get(joint.id) ?? null
}

function activeLayerId(): LayerId | null {
  const scene = useDocumentStore.getState().scene
  const requestedId = useEditorStore.getState().activeLayerId
  const requestedLayer = scene.layers.find((layer) => layer.id === requestedId)
  if (requestedLayer?.visible && !requestedLayer.locked) return requestedLayer.id
  return (
    scene.layers.find((layer) => layer.visible && !layer.locked)?.id ?? scene.layers[0]?.id ?? null
  )
}

function nextEntityIndex(kind: SceneEntity['kind']): number {
  return (
    useDocumentStore.getState().scene.entities.filter((entity) => entity.kind === kind).length + 1
  )
}

function getDraft(
  interaction: Extract<Interaction, { type: 'create' }>,
  end: Vec2,
  useDefaultSize = false,
): SceneEntity {
  const { startWorld: start, draftId, layerId, index, tool } = interaction

  if (tool === 'ground') {
    const resolvedEnd =
      useDefaultSize && distance(start, end) < 0.05 ? { x: start.x + 3, y: start.y } : end
    if (interaction.groundShape === 'line') {
      return { ...createLineGround(layerId, start, resolvedEnd, index), id: draftId }
    }

    const span = subtract(resolvedEnd, start)
    const length = Math.max(0.2, distance(start, resolvedEnd))
    const center = { x: (start.x + resolvedEnd.x) / 2, y: (start.y + resolvedEnd.y) / 2 }
    const directionAngle = Math.atan2(span.y, span.x)
    if (interaction.groundShape === 'arc') {
      return {
        ...createArcGround(
          layerId,
          center,
          length / 2,
          directionAngle + Math.PI,
          directionAngle + 2 * Math.PI,
          index,
        ),
        id: draftId,
      }
    }

    const normal = { x: span.y / length, y: -span.x / length }
    const depth = length * 0.28
    return {
      ...createBezierGround(
        layerId,
        start,
        {
          x: start.x + span.x / 3 + normal.x * depth,
          y: start.y + span.y / 3 + normal.y * depth,
        },
        {
          x: start.x + (span.x * 2) / 3 + normal.x * depth,
          y: start.y + (span.y * 2) / 3 + normal.y * depth,
        },
        resolvedEnd,
        index,
      ),
      id: draftId,
    }
  }

  if (tool === 'body') {
    if (interaction.bodyPreset === 'block') {
      const defaultEnd = { x: start.x + 0.5, y: start.y + 0.5 }
      const resolvedEnd = useDefaultSize && distance(start, end) < 0.05 ? defaultEnd : end
      return {
        ...createBlock(
          layerId,
          start,
          Math.max(0.2, Math.abs(resolvedEnd.x - start.x) * 2),
          Math.max(0.2, Math.abs(resolvedEnd.y - start.y) * 2),
          index,
        ),
        id: draftId,
      }
    }
    const radius =
      useDefaultSize && distance(start, end) < 0.05 ? 0.5 : Math.max(0.15, distance(start, end))
    return { ...createBall(layerId, start, radius, index), id: draftId }
  }

  const defaultEnd = { x: start.x + 4, y: start.y + 3 }
  const resolvedEnd = useDefaultSize && distance(start, end) < 0.05 ? defaultEnd : end
  const width = Math.max(0.2, Math.abs(resolvedEnd.x - start.x))
  const height = Math.max(0.2, Math.abs(resolvedEnd.y - start.y))
  const center = {
    x: (start.x + resolvedEnd.x) / 2,
    y: (start.y + resolvedEnd.y) / 2,
  }
  const field =
    interaction.fieldPreset === 'uniformElectric'
      ? createElectricField(layerId, center, width, height, index)
      : interaction.fieldPreset === 'uniformMagnetic'
        ? createMagneticField(layerId, center, width, height, index)
        : createGravityField(layerId, center, width, height, index)
  if (interaction.fieldRegionShape === 'infinite') {
    return { ...field, id: draftId, region: { type: 'infinite' } }
  }
  if (interaction.fieldRegionShape === 'circle') {
    const radius =
      useDefaultSize && distance(start, end) < 0.05 ? 2 : Math.max(0.1, distance(start, end))
    return {
      ...field,
      id: draftId,
      region: { type: 'circle', center: start, radius, startRad: 0, sweepRad: Math.PI * 2 },
    }
  }
  return { ...field, id: draftId }
}

function createGroundPenDraft(
  interaction: Extract<Interaction, { type: 'groundPen' }>,
  end: Vec2,
  useDefaultSize = false,
): GroundEntity {
  return getDraft(
    {
      type: 'create',
      tool: 'ground',
      startWorld: interaction.startWorld,
      draftId: interaction.draftId,
      layerId: interaction.layerId,
      index: interaction.index,
      groundShape: 'cubicBezier',
      bodyPreset: 'ball',
      fieldPreset: 'uniformGravity',
      fieldRegionShape: 'rectangle',
      pendingGroundEndpoint: interaction.pendingGroundEndpoint,
    },
    end,
    useDefaultSize,
  ) as GroundEntity
}

function createFieldPenDraft(
  interaction: Extract<Interaction, { type: 'fieldPen' }>,
  points: Vec2[],
): FieldEntity {
  const safePoints = points.length >= 3 ? points : [...points, ...points.slice(-1)]
  const xValues = safePoints.map((point) => point.x)
  const yValues = safePoints.map((point) => point.y)
  const center = {
    x: (Math.min(...xValues) + Math.max(...xValues)) / 2,
    y: (Math.min(...yValues) + Math.max(...yValues)) / 2,
  }
  const width = Math.max(0.2, Math.max(...xValues) - Math.min(...xValues))
  const height = Math.max(0.2, Math.max(...yValues) - Math.min(...yValues))
  const field =
    interaction.fieldPreset === 'uniformElectric'
      ? createElectricField(interaction.layerId, center, width, height, interaction.index)
      : interaction.fieldPreset === 'uniformMagnetic'
        ? createMagneticField(interaction.layerId, center, width, height, interaction.index)
        : createGravityField(interaction.layerId, center, width, height, interaction.index)
  return {
    ...field,
    id: interaction.draftId,
    region: { type: 'bezierPath', nodes: createSmoothBezierPathNodes(safePoints) },
  }
}

type EditableHandle =
  | { type: 'bezier'; entity: GroundEntity; pointKey: 'p0' | 'p1' | 'p2' | 'p3' }
  | { type: 'fieldPoint'; entity: FieldEntity; pointIndex: number }
  | {
      type: 'fieldPathPoint'
      entity: FieldEntity
      nodeIndex: number
      pointKey: keyof BezierPathNode
    }
  | { type: 'connectorAnchor'; entity: ConnectorEntity; endpointKey: 'a' | 'b' }

function findEditableHandle(
  entities: SceneEntity[],
  selectedIds: EntityId[],
  point: Vec2,
  tolerance: number,
): EditableHandle | null {
  for (let index = entities.length - 1; index >= 0; index -= 1) {
    const entity = entities[index]
    if (!entity || !selectedIds.includes(entity.id)) continue
    if (entity.kind === 'ground' && entity.geometry.type === 'cubicBezier') {
      for (const pointKey of ['p0', 'p1', 'p2', 'p3'] as const) {
        if (distance(entity.geometry[pointKey], point) <= tolerance) {
          return { type: 'bezier', entity, pointKey }
        }
      }
    }
    if (entity.kind === 'field' && entity.region.type === 'polygon') {
      const pointIndex = entity.region.points.findIndex(
        (candidate) => distance(candidate, point) <= tolerance,
      )
      if (pointIndex >= 0) return { type: 'fieldPoint', entity, pointIndex }
    }
    if (entity.kind === 'field' && entity.region.type === 'bezierPath') {
      for (let nodeIndex = 0; nodeIndex < entity.region.nodes.length; nodeIndex += 1) {
        const node = entity.region.nodes[nodeIndex]
        if (!node) continue
        for (const pointKey of ['inHandle', 'outHandle', 'anchor'] as const) {
          if (distance(node[pointKey], point) <= tolerance) {
            return { type: 'fieldPathPoint', entity, nodeIndex, pointKey }
          }
        }
      }
    }
    if (entity.kind === 'connector') {
      for (const endpointKey of ['a', 'b'] as const) {
        const endpoint = resolveConnectorEndpoint(entities, entity[endpointKey])
        if (endpoint && distance(endpoint, point) <= tolerance) {
          return { type: 'connectorAnchor', entity, endpointKey }
        }
      }
    }
  }
  return null
}

function editableEntities(entities: SceneEntity[]): SceneEntity[] {
  const layers = useDocumentStore.getState().scene.layers
  const lockedLayers = new Set(layers.filter((layer) => layer.locked).map((layer) => layer.id))
  const hiddenLayers = new Set(layers.filter((layer) => !layer.visible).map((layer) => layer.id))
  return entities
    .filter((entity) => !hiddenLayers.has(entity.layerId))
    .map((entity) => (lockedLayers.has(entity.layerId) ? { ...entity, locked: true } : entity))
}

function renderEntities(): SceneEntity[] {
  const { scene } = useDocumentStore.getState()
  const { previewEntities } = useEditorStore.getState()
  const { runtimeBodies } = useSimulationStore.getState()
  return scene.entities.map((entity) =>
    resolveRenderedEntity(entity, runtimeBodies, previewEntities),
  )
}

export function PixiCanvas({ size }: { size: ViewportSize }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<PixiSceneRenderer | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sizeRef = useRef(size)
  const interactionRef = useRef<Interaction>({ type: 'idle' })
  const spacePressedRef = useRef(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scene = useDocumentStore((state) => state.scene)
  const activeTool = useEditorStore((state) => state.activeTool)
  const camera = useEditorStore((state) => state.camera)
  const gridVisible = useEditorStore((state) => state.gridVisible)
  const selectedIds = useEditorStore((state) => state.selectedIds)
  const previewEntities = useEditorStore((state) => state.previewEntities)
  const draftEntity = useEditorStore((state) => state.draftEntity)
  const marquee = useEditorStore((state) => state.marquee)
  const connectorStartBodyId = useEditorStore((state) => state.connectorStartBodyId)
  const groundJointStart = useEditorStore((state) => state.groundJointStart)
  const groundJointHover = useEditorStore((state) => state.groundJointHover)
  const pendingGroundEndpoint = useEditorStore((state) => state.pendingGroundEndpoint)
  const runtimeBodies = useSimulationStore((state) => state.runtimeBodies)
  const runtimeTrajectories = useSimulationStore((state) => state.runtimeTrajectories)

  useEffect(() => {
    const interaction = interactionRef.current
    const penStillActive =
      (interaction.type === 'groundPen' && activeTool === 'ground') ||
      (interaction.type === 'fieldPen' && activeTool === 'field')
    if (interaction.type !== 'idle' && !penStillActive) {
      interactionRef.current = { type: 'idle' }
      useEditorStore.getState().clearPreview()
      useEditorStore.getState().setDraftEntity(null)
      useEditorStore.getState().setMarquee(null)
    }
  }, [activeTool])

  useEffect(() => {
    if (
      groundJointStart &&
      !scene.entities.some(
        (entity) => entity.kind === 'ground' && entity.id === groundJointStart.groundId,
      )
    ) {
      const editor = useEditorStore.getState()
      editor.setGroundJointStart(null)
      editor.setGroundJointHover(null)
      editor.setGroundJointMessage('第一个端点已不存在，请重新选择。')
    }
  }, [groundJointStart, scene.entities])

  useEffect(() => {
    sizeRef.current = size
  }, [size])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    const renderer = new PixiSceneRenderer()

    void renderer
      .mount(host)
      .then((canvas) => {
        if (disposed) {
          renderer.destroy()
          return
        }
        rendererRef.current = renderer
        canvasRef.current = canvas
        setReady(true)
      })
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : 'PixiJS 初始化失败。'
        setError(message)
      })

    return () => {
      disposed = true
      if (rendererRef.current === renderer) {
        rendererRef.current = null
        canvasRef.current = null
        renderer.destroy()
      }
    }
  }, [])

  useEffect(() => {
    if (!ready || !rendererRef.current) return
    rendererRef.current.resize(size)
    rendererRef.current.render({
      scene,
      camera,
      size,
      gridVisible,
      selectedIds,
      previewEntities,
      draftEntity,
      marquee,
      connectorStartBodyId,
      activeTool,
      groundJointStart,
      groundJointHover,
      pendingGroundEndpoint,
      runtimeBodies,
      runtimeTrajectories,
    })
    if (canvasRef.current && interactionRef.current.type === 'idle' && !spacePressedRef.current) {
      canvasRef.current.style.cursor = toolCursor(activeTool)
    }
  }, [
    activeTool,
    camera,
    connectorStartBodyId,
    draftEntity,
    gridVisible,
    groundJointHover,
    groundJointStart,
    pendingGroundEndpoint,
    marquee,
    previewEntities,
    ready,
    runtimeBodies,
    runtimeTrajectories,
    scene,
    selectedIds,
    size,
  ])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!ready || !canvas) return

    const updateCursor = (tool: EditorTool, interacting = false) => {
      if (interacting && interactionRef.current.type === 'pan') {
        canvas.style.cursor = 'grabbing'
      } else if (tool === 'hand' || spacePressedRef.current) {
        canvas.style.cursor = 'grab'
      } else if (tool === 'zoom') {
        canvas.style.cursor = 'zoom-in'
      } else if (tool === 'rotate') {
        canvas.style.cursor = 'crosshair'
      } else if (['ground', 'groundJoint', 'body', 'field', 'connector'].includes(tool)) {
        canvas.style.cursor = 'crosshair'
      } else {
        canvas.style.cursor = toolCursor(tool)
      }
    }

    const rawWorldPoint = (event: PointerEvent): Vec2 => {
      const editor = useEditorStore.getState()
      return screenToWorld(localPoint(event, canvas), editor.camera, sizeRef.current)
    }

    const resolvedWorldPoint = (event: PointerEvent): Vec2 => {
      const editor = useEditorStore.getState()
      const world = rawWorldPoint(event)
      const scene = useDocumentStore.getState().scene
      return editor.snapEnabled && !event.altKey
        ? snapPoint(
            world,
            getVisibleSnapStep(scene.settings.gridStep, editor.camera.pixelsPerMeter),
          )
        : world
    }

    const applyWallSnap = (entity: SceneEntity): SceneEntity => {
      const editor = useEditorStore.getState()
      if (!editor.wallSnapEnabled || entity.kind !== 'body') return entity
      const grounds = editableEntities(renderEntities()).filter(
        (candidate): candidate is GroundEntity => candidate.kind === 'ground',
      )
      return snapBodyToGround(entity, grounds, 12 / editor.camera.pixelsPerMeter)
    }

    const startCreation = (
      tool: 'ground' | 'body' | 'field',
      world: Vec2,
      pendingGroundEndpoint: GroundEndpointRef | null = null,
    ) => {
      const layerId = activeLayerId()
      if (!layerId) return
      const editor = useEditorStore.getState()
      editor.setPendingGroundEndpoint(tool === 'ground' ? pendingGroundEndpoint : null)
      const kind = tool === 'ground' ? 'ground' : tool === 'body' ? 'body' : 'field'
      if (tool === 'ground' && editor.groundToolShape === 'cubicBezier') {
        const interaction: Extract<Interaction, { type: 'groundPen' }> = {
          type: 'groundPen',
          startWorld: world,
          draftId: crypto.randomUUID(),
          layerId,
          index: nextEntityIndex('ground'),
          pendingGroundEndpoint,
        }
        interactionRef.current = interaction
        editor.setDraftEntity(createGroundPenDraft(interaction, world))
        return
      }
      if (tool === 'field' && editor.fieldRegionToolShape === 'freeform') {
        const interaction: Extract<Interaction, { type: 'fieldPen' }> = {
          type: 'fieldPen',
          points: [world],
          draftId: crypto.randomUUID(),
          layerId,
          index: nextEntityIndex('field'),
          fieldPreset: editor.fieldToolPreset,
        }
        interactionRef.current = interaction
        editor.setDraftEntity(createFieldPenDraft(interaction, [world, world]))
        return
      }
      const interaction: Extract<Interaction, { type: 'create' }> = {
        type: 'create',
        tool,
        startWorld: world,
        draftId: crypto.randomUUID(),
        layerId,
        index: nextEntityIndex(kind),
        groundShape: editor.groundToolShape,
        bodyPreset: editor.bodyToolPreset,
        fieldPreset: editor.fieldToolPreset,
        fieldRegionShape: editor.fieldRegionToolShape,
        pendingGroundEndpoint,
      }
      interactionRef.current = interaction
      useEditorStore.getState().setDraftEntity(applyWallSnap(getDraft(interaction, world)))
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 1) return
      canvas.focus()
      canvas.setPointerCapture(event.pointerId)
      const screen = localPoint(event, canvas)
      const editor = useEditorStore.getState()
      const rawWorld = rawWorldPoint(event)
      const world = resolvedWorldPoint(event)
      const tool = editor.activeTool

      if (event.button === 1 || tool === 'hand' || spacePressedRef.current) {
        interactionRef.current = { type: 'pan', startScreen: screen, startCamera: editor.camera }
        updateCursor(tool, true)
        event.preventDefault()
        return
      }

      if (tool === 'zoom') {
        editor.setCamera(
          zoomCameraAtPoint(editor.camera, screen, sizeRef.current, event.altKey ? 0.8 : 1.25),
        )
        return
      }

      const entities = editableEntities(renderEntities())
      const hit = findTopEntity(entities, rawWorld, 8 / editor.camera.pixelsPerMeter)

      if (isSimulationRuntimeLocked(useSimulationStore.getState())) {
        if (!hit) {
          if (!event.shiftKey) editor.clearSelection()
        } else if (event.shiftKey) {
          editor.toggleSelectedId(hit.id)
        } else {
          editor.setSelectedIds([hit.id])
        }
        return
      }

      const pending = interactionRef.current
      if (pending.type === 'groundPen' && tool === 'ground') {
        const entity = createGroundPenDraft(pending, world, true)
        const document = useDocumentStore.getState()
        document.executeCommand(
          createAddEntityCommand(
            document.scene,
            createGroundWithAutoJoint(document.scene, entity, pending.pendingGroundEndpoint),
          ),
        )
        editor.setDraftEntity(null)
        editor.setPendingGroundEndpoint(null)
        editor.setSelectedIds([entity.id])
        interactionRef.current = { type: 'idle' }
        return
      }
      if (pending.type === 'fieldPen' && tool === 'field') {
        const closeToStart =
          distance(world, pending.points[0] ?? world) <= 10 / editor.camera.pixelsPerMeter
        if (pending.points.length >= 3 && (closeToStart || event.detail >= 2)) {
          const entity = createFieldPenDraft(pending, pending.points)
          const document = useDocumentStore.getState()
          document.executeCommand(createAddEntityCommand(document.scene, entity))
          editor.setDraftEntity(null)
          editor.setSelectedIds([entity.id])
          interactionRef.current = { type: 'idle' }
        } else {
          const points = [...pending.points, world]
          interactionRef.current = { ...pending, points }
          editor.setDraftEntity(createFieldPenDraft(pending, [...points, world]))
        }
        return
      }

      if (tool === 'select') {
        const handle = findEditableHandle(
          entities,
          editor.selectedIds,
          rawWorld,
          9 / editor.camera.pixelsPerMeter,
        )
        if (handle?.type === 'bezier') {
          interactionRef.current = {
            type: 'editBezierPoint',
            original: handle.entity,
            pointKey: handle.pointKey,
          }
          return
        }
        if (handle?.type === 'fieldPoint') {
          interactionRef.current = {
            type: 'editFieldPoint',
            original: handle.entity,
            pointIndex: handle.pointIndex,
          }
          return
        }
        if (handle?.type === 'fieldPathPoint') {
          interactionRef.current = {
            type: 'editFieldPathPoint',
            original: handle.entity,
            nodeIndex: handle.nodeIndex,
            pointKey: handle.pointKey,
          }
          return
        }
        if (handle?.type === 'connectorAnchor') {
          interactionRef.current = {
            type: 'editConnectorAnchor',
            original: handle.entity,
            endpointKey: handle.endpointKey,
          }
          return
        }
      }

      if (tool === 'groundJoint') {
        const first = editor.groundJointStart
        const sceneEntities = useDocumentStore.getState().scene.entities
        const excludedGroundIds = first ? new Set([first.groundId]) : new Set<EntityId>()
        const endpointHit = findNearestGroundEndpoint(
          entities,
          rawWorld,
          9 / editor.camera.pixelsPerMeter,
          excludedGroundIds,
        )

        if (!endpointHit) {
          const sameGroundHit = first
            ? findNearestGroundEndpoint(entities, rawWorld, 9 / editor.camera.pixelsPerMeter)
            : null
          editor.setGroundJointMessage(
            sameGroundHit?.ground.id === first?.groundId
              ? '请选择另一块地面的端点，不能连接同一块地面。'
              : '请在地面端点 9 像素范围内点击。',
          )
          return
        }

        if (endpointIsOccupied(sceneEntities, endpointHit.reference)) {
          editor.setGroundJointMessage('这个端点已经有地面连接点，请选择其他端点。')
          return
        }

        if (!first) {
          editor.setGroundJointStart(endpointHit.reference)
          editor.setGroundJointHover(null)
          editor.setGroundJointMessage('已选择第一个端点，请选择另一块地面的端点。')
          editor.setSelectedIds([endpointHit.ground.id])
          return
        }

        const layerId = activeLayerId()
        if (!layerId) return
        const joint = createGroundJoint(
          layerId,
          first,
          endpointHit.reference,
          nextEntityIndex('groundJoint'),
        )
        const resolvedPath = resolveGroundJointPath(sceneEntities, joint)
        if (!resolvedPath || resolvedPath.issue) {
          editor.setGroundJointMessage(
            resolvedPath?.issue
              ? groundJointIssueMessage(resolvedPath.issue)
              : '无法解析地面连接，请重新选择端点。',
          )
          return
        }

        const document = useDocumentStore.getState()
        document.executeCommand(createAddEntityCommand(document.scene, joint))
        editor.setSelectedIds([joint.id])
        editor.setGroundJointStart(null)
        editor.setGroundJointHover(null)
        editor.setGroundJointMessage('地面连接点已创建。')
        return
      }

      if (tool === 'connector') {
        if (!hit || hit.kind !== 'body') return
        if (!editor.connectorStartBodyId) {
          editor.setConnectorStartBodyId(hit.id)
          editor.setSelectedIds([hit.id])
          return
        }
        if (editor.connectorStartBodyId === hit.id) {
          editor.setConnectorStartBodyId(null)
          return
        }
        const first = getEntityById(entities, editor.connectorStartBodyId)
        const layerId = activeLayerId()
        if (first?.kind === 'body' && layerId) {
          const length = distance(first.transform.position, hit.transform.position)
          const index = nextEntityIndex('connector')
          const connector =
            editor.connectorToolPreset === 'rod'
              ? createRod(layerId, first.id, hit.id, length, index)
              : editor.connectorToolPreset === 'spring'
                ? createSpring(layerId, first.id, hit.id, length, index)
                : createRope(layerId, first.id, hit.id, length, index)
          useDocumentStore
            .getState()
            .executeCommand(createAddEntityCommand(useDocumentStore.getState().scene, connector))
          editor.setSelectedIds([connector.id])
          editor.setConnectorStartBodyId(null)
        }
        return
      }

      if (tool === 'ground' || tool === 'body' || tool === 'field') {
        if (tool === 'ground') {
          const start = resolveGroundCreationStart({
            entities,
            rawWorld,
            fallbackWorld: world,
            pixelsPerMeter: editor.camera.pixelsPerMeter,
            enabled: editor.autoGroundJointEnabled,
            bypassSnap: event.altKey,
          })
          startCreation(tool, start.startWorld, start.pendingEndpoint)
        } else {
          startCreation(tool, world)
        }
        return
      }

      if (tool === 'select') {
        if (!hit) {
          if (!event.shiftKey) editor.clearSelection()
          interactionRef.current = { type: 'marquee', startWorld: rawWorld }
          editor.setMarquee({ start: rawWorld, end: rawWorld })
          return
        }

        let nextSelection = editor.selectedIds
        if (event.shiftKey) {
          nextSelection = editor.selectedIds.includes(hit.id)
            ? editor.selectedIds.filter((id) => id !== hit.id)
            : [...editor.selectedIds, hit.id]
        } else if (!editor.selectedIds.includes(hit.id)) {
          nextSelection = [hit.id]
        }
        editor.setSelectedIds(nextSelection)
        const originals = entities.filter(
          (entity) => nextSelection.includes(entity.id) && getEntityTransform(entity),
        )
        if (originals.length > 0 && nextSelection.includes(hit.id)) {
          interactionRef.current = {
            type: 'move',
            startWorld: rawWorld,
            originals,
            anchorId: hit.id,
          }
        }
        return
      }

      if (tool === 'rotate') {
        if (!hit) return
        if (!editor.selectedIds.includes(hit.id)) editor.setSelectedIds([hit.id])
        const transform = getEntityTransform(hit)
        if (!transform) return
        const ids = editor.selectedIds.includes(hit.id) ? editor.selectedIds : [hit.id]
        interactionRef.current = {
          type: 'rotate',
          pivot: transform.position,
          startPointerAngle: Math.atan2(
            rawWorld.y - transform.position.y,
            rawWorld.x - transform.position.x,
          ),
          originals: entities.filter(
            (entity) => ids.includes(entity.id) && getEntityTransform(entity),
          ),
        }
      }
    }

    const handlePointerMove = (event: PointerEvent) => {
      const screen = localPoint(event, canvas)
      const editor = useEditorStore.getState()
      const unsnappedWorld = screenToWorld(screen, editor.camera, sizeRef.current)
      editor.setCursorWorld(unsnappedWorld)
      const world = resolvedWorldPoint(event)
      const interaction = interactionRef.current

      if (editor.activeTool === 'groundJoint' && interaction.type === 'idle') {
        const entities = editableEntities(renderEntities())
        const sceneEntities = useDocumentStore.getState().scene.entities
        const hover =
          findNearestGroundEndpoint(entities, unsnappedWorld, 9 / editor.camera.pixelsPerMeter)
            ?.reference ?? null
        const hoverChanged = !sameEndpointOrNull(editor.groundJointHover, hover)
        if (hoverChanged) {
          editor.setGroundJointHover(hover)

          let message: string | null = null
          if (editor.groundJointStart) {
            if (!hover) {
              message = '已选择第一个端点，请选择另一块地面的端点。'
            } else {
              const firstGround = entities.find(
                (entity): entity is GroundEntity =>
                  entity.kind === 'ground' && entity.id === editor.groundJointStart?.groundId,
              )
              if (!firstGround) {
                editor.setGroundJointStart(null)
                editor.setGroundJointHover(null)
                message = '第一个端点已不存在，请重新选择。'
              } else {
                const preview = createGroundJoint(
                  firstGround.layerId,
                  editor.groundJointStart,
                  hover,
                  0,
                )
                const resolvedPath = resolveGroundJointPath(sceneEntities, preview)
                message = resolvedPath?.issue
                  ? groundJointIssueMessage(resolvedPath.issue)
                  : resolvedPath?.kind === 'linear'
                    ? '预览：将生成端点间直线连接。'
                    : '预览：将生成平滑连接线。'
              }
            }
          } else if (hover) {
            message = endpointIsOccupied(sceneEntities, hover)
              ? '这个端点已经被地面连接点占用。'
              : '点击高亮端点作为第一个端点。'
          }
          if (editor.groundJointMessage !== message) editor.setGroundJointMessage(message)
        }
      }

      if (interaction.type === 'pan') {
        editor.setCamera(
          panCamera(interaction.startCamera, subtract(screen, interaction.startScreen)),
        )
      } else if (interaction.type === 'marquee') {
        editor.setMarquee({ start: interaction.startWorld, end: unsnappedWorld })
      } else if (interaction.type === 'create') {
        editor.setDraftEntity(applyWallSnap(getDraft(interaction, world)))
      } else if (interaction.type === 'groundPen') {
        editor.setDraftEntity(createGroundPenDraft(interaction, world))
      } else if (interaction.type === 'fieldPen') {
        editor.setDraftEntity(createFieldPenDraft(interaction, [...interaction.points, world]))
      } else if (interaction.type === 'move') {
        const anchor = interaction.originals.find((entity) => entity.id === interaction.anchorId)
        const anchorTransform = anchor ? getEntityTransform(anchor) : null
        if (!anchorTransform) return
        let delta = subtract(unsnappedWorld, interaction.startWorld)
        if (editor.snapEnabled && !event.altKey) {
          const snappedAnchor = snapPoint(
            {
              x: anchorTransform.position.x + delta.x,
              y: anchorTransform.position.y + delta.y,
            },
            getVisibleSnapStep(
              useDocumentStore.getState().scene.settings.gridStep,
              editor.camera.pixelsPerMeter,
            ),
          )
          delta = subtract(snappedAnchor, anchorTransform.position)
        }
        let moved = interaction.originals.map((entity) => {
          const transform = getEntityTransform(entity)
          return transform
            ? withEntityTransform(entity, {
                ...transform,
                position: {
                  x: transform.position.x + delta.x,
                  y: transform.position.y + delta.y,
                },
              })
            : entity
        })
        if (editor.wallSnapEnabled) {
          const movedAnchor = moved.find(
            (entity): entity is Extract<SceneEntity, { kind: 'body' }> =>
              entity.id === interaction.anchorId && entity.kind === 'body',
          )
          if (movedAnchor) {
            const snappedAnchor = applyWallSnap(movedAnchor)
            if (snappedAnchor.kind === 'body') {
              const correction = subtract(
                snappedAnchor.transform.position,
                movedAnchor.transform.position,
              )
              moved = moved.map((entity) => {
                const transform = getEntityTransform(entity)
                return transform
                  ? withEntityTransform(entity, {
                      ...transform,
                      position: {
                        x: transform.position.x + correction.x,
                        y: transform.position.y + correction.y,
                      },
                    })
                  : entity
              })
            }
          }
        }
        editor.setPreviewEntities(moved)
      } else if (interaction.type === 'rotate') {
        const pointerAngle = Math.atan2(
          unsnappedWorld.y - interaction.pivot.y,
          unsnappedWorld.x - interaction.pivot.x,
        )
        const angleDelta = pointerAngle - interaction.startPointerAngle
        editor.setPreviewEntities(
          interaction.originals.map((entity) => {
            const transform = getEntityTransform(entity)
            if (!transform) return entity
            const angleRad =
              editor.snapEnabled && !event.altKey
                ? snapAngle(transform.angleRad + angleDelta)
                : transform.angleRad + angleDelta
            return withEntityTransform(entity, { ...transform, angleRad })
          }),
        )
      } else if (interaction.type === 'editBezierPoint') {
        const geometry = interaction.original.geometry
        if (geometry.type !== 'cubicBezier') return
        editor.setPreviewEntities([
          {
            ...interaction.original,
            geometry: { ...geometry, [interaction.pointKey]: world },
          },
        ])
      } else if (interaction.type === 'editFieldPoint') {
        const region = interaction.original.region
        if (region.type !== 'polygon') return
        editor.setPreviewEntities([
          {
            ...interaction.original,
            region: {
              ...region,
              points: region.points.map((point, index) =>
                index === interaction.pointIndex ? world : point,
              ),
            },
          },
        ])
      } else if (interaction.type === 'editFieldPathPoint') {
        const region = interaction.original.region
        if (region.type !== 'bezierPath') return
        const nodes = moveBezierPathPoint(
          region.nodes,
          interaction.nodeIndex,
          interaction.pointKey,
          world,
        )
        editor.setPreviewEntities([{ ...interaction.original, region: { ...region, nodes } }])
      } else if (interaction.type === 'editConnectorAnchor') {
        const endpoint = interaction.original[interaction.endpointKey]
        const body = getEntityById(editableEntities(renderEntities()), endpoint.bodyId)
        if (body?.kind !== 'body') return
        editor.setPreviewEntities([
          {
            ...interaction.original,
            [interaction.endpointKey]: {
              ...endpoint,
              localAnchor: worldToLocalAnchor(body, world),
            },
          },
        ])
      }
    }

    const finishInteraction = (event: PointerEvent) => {
      const editor = useEditorStore.getState()
      const document = useDocumentStore.getState()
      const interaction = interactionRef.current
      const rawWorld = rawWorldPoint(event)
      const world = resolvedWorldPoint(event)

      if (
        interaction.type === 'move' ||
        interaction.type === 'rotate' ||
        interaction.type === 'editBezierPoint' ||
        interaction.type === 'editFieldPoint' ||
        interaction.type === 'editFieldPathPoint' ||
        interaction.type === 'editConnectorAnchor'
      ) {
        const replacements = Object.values(editor.previewEntities)
        if (replacements.length > 0) {
          const label =
            interaction.type === 'move'
              ? '移动实体'
              : interaction.type === 'rotate'
                ? '旋转实体'
                : interaction.type === 'editBezierPoint'
                  ? '拖动贝塞尔控制点'
                  : interaction.type === 'editFieldPoint'
                    ? '拖动场范围节点'
                    : interaction.type === 'editFieldPathPoint'
                      ? '拖动场范围贝塞尔控制点'
                      : '拖动连接锚点'
          document.executeCommand(createReplaceEntitiesCommand(document.scene, replacements, label))
        }
        editor.clearPreview()
      } else if (interaction.type === 'marquee') {
        const additions = entitiesInsideBounds(
          editableEntities(renderEntities()),
          interaction.startWorld,
          rawWorld,
        )
        editor.setSelectedIds(
          event.shiftKey
            ? [...new Set([...editor.selectedIds, ...additions.map((entity) => entity.id)])]
            : additions.map((entity) => entity.id),
        )
        editor.setMarquee(null)
      } else if (interaction.type === 'create') {
        const entity = applyWallSnap(getDraft(interaction, world, true))
        const additions =
          entity.kind === 'ground'
            ? createGroundWithAutoJoint(document.scene, entity, interaction.pendingGroundEndpoint)
            : [entity]
        document.executeCommand(createAddEntityCommand(document.scene, additions))
        editor.setDraftEntity(null)
        editor.setPendingGroundEndpoint(null)
        editor.setSelectedIds([entity.id])
      } else if (interaction.type === 'groundPen' || interaction.type === 'fieldPen') {
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
        return
      }

      interactionRef.current = { type: 'idle' }
      updateCursor(editor.activeTool)
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    }

    const cancelInteraction = () => {
      const editor = useEditorStore.getState()
      editor.clearPreview()
      editor.setDraftEntity(null)
      editor.setPendingGroundEndpoint(null)
      editor.setMarquee(null)
      if (editor.activeTool === 'groundJoint') {
        editor.setGroundJointStart(null)
        editor.setGroundJointHover(null)
        editor.setGroundJointMessage(null)
      }
      interactionRef.current = { type: 'idle' }
      updateCursor(editor.activeTool)
    }

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const editor = useEditorStore.getState()
      const factor = Math.exp(-event.deltaY * 0.0012)
      editor.setCamera(
        zoomCameraAtPoint(editor.camera, localPoint(event, canvas), sizeRef.current, factor),
      )
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !event.repeat) {
        spacePressedRef.current = true
        updateCursor(useEditorStore.getState().activeTool)
        event.preventDefault()
      }
      if (event.key === 'Enter') {
        const interaction = interactionRef.current
        if (interaction.type === 'fieldPen' && interaction.points.length >= 3) {
          const editor = useEditorStore.getState()
          const document = useDocumentStore.getState()
          const entity = createFieldPenDraft(interaction, interaction.points)
          document.executeCommand(createAddEntityCommand(document.scene, entity))
          editor.setDraftEntity(null)
          editor.setSelectedIds([entity.id])
          interactionRef.current = { type: 'idle' }
          event.preventDefault()
        }
      }
      if (event.key === 'Escape') cancelInteraction()
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        spacePressedRef.current = false
        updateCursor(useEditorStore.getState().activeTool)
      }
    }

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      const editor = useEditorStore.getState()
      if (editor.activeTool !== 'groundJoint') return
      editor.setGroundJointStart(null)
      editor.setGroundJointHover(null)
      editor.setGroundJointMessage(null)
    }

    updateCursor(useEditorStore.getState().activeTool)
    canvas.addEventListener('pointerdown', handlePointerDown)
    canvas.addEventListener('pointermove', handlePointerMove)
    canvas.addEventListener('pointerup', finishInteraction)
    canvas.addEventListener('pointercancel', cancelInteraction)
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    canvas.addEventListener('contextmenu', handleContextMenu)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown)
      canvas.removeEventListener('pointermove', handlePointerMove)
      canvas.removeEventListener('pointerup', finishInteraction)
      canvas.removeEventListener('pointercancel', cancelInteraction)
      canvas.removeEventListener('wheel', handleWheel)
      canvas.removeEventListener('contextmenu', handleContextMenu)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [ready])

  return (
    <div className={styles.pixiHost} ref={hostRef} data-ready={ready}>
      {!ready && !error ? (
        <div className={styles.canvasLoading}>正在初始化 PixiJS 画布…</div>
      ) : null}
      {error ? <div className={styles.canvasError}>画布初始化失败：{error}</div> : null}
    </div>
  )
}
