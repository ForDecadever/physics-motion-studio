import { useEffect, useRef, useState } from 'react'

import {
  panCamera,
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
  distance,
  getEntityById,
  getEntityTransform,
  subtract,
  withEntityTransform,
} from '../../editor/geometry/entityGeometry'
import { entitiesInsideBounds, findTopEntity } from '../../editor/geometry/hitTest'
import { PixiSceneRenderer } from '../../renderer/pixi/PixiSceneRenderer'
import { resolveRenderedEntity } from '../../renderer/pixi/renderEntityState'
import {
  createArcGround,
  createBall,
  createBezierGround,
  createBlock,
  createElectricField,
  createGravityField,
  createLineGround,
  createMagneticField,
  createParticle,
  createPointCharge,
  createRod,
  createRope,
  createSpring,
} from '../../scene/model/entityFactories'
import type { EntityId, LayerId, SceneEntity, Vec2 } from '../../scene/model/types'
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
    }

function localPoint(event: PointerEvent | WheelEvent, canvas: HTMLCanvasElement): Vec2 {
  const bounds = canvas.getBoundingClientRect()
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
}

function toolCursor(tool: EditorTool): string {
  if (tool === 'hand') return 'grab'
  if (tool === 'zoom') return 'zoom-in'
  if (['rotate', 'ground', 'body', 'field', 'connector'].includes(tool)) return 'crosshair'
  return 'default'
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
    if (interaction.bodyPreset === 'particle') {
      return { ...createParticle(layerId, start, 0.12, index), id: draftId }
    }
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
    if (interaction.bodyPreset === 'pointCharge') {
      return { ...createPointCharge(layerId, start, 0.15, index), id: draftId }
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
    return { ...field, id: draftId, region: { type: 'circle', center: start, radius } }
  }
  if (interaction.fieldRegionShape === 'polygon') {
    const radius =
      useDefaultSize && distance(start, end) < 0.05 ? 2 : Math.max(0.1, distance(start, end))
    const startAngle = Math.atan2(end.y - start.y, end.x - start.x)
    const points = Array.from({ length: 6 }, (_, pointIndex) => {
      const angle = startAngle + (pointIndex * Math.PI) / 3
      return { x: start.x + radius * Math.cos(angle), y: start.y + radius * Math.sin(angle) }
    })
    return { ...field, id: draftId, region: { type: 'polygon', points } }
  }
  return { ...field, id: draftId }
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
  const runtimeBodies = useSimulationStore((state) => state.runtimeBodies)
  const runtimeTrajectories = useSimulationStore((state) => state.runtimeTrajectories)

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
      } else if (['ground', 'body', 'field', 'connector'].includes(tool)) {
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
      return editor.snapEnabled && !event.altKey
        ? snapPoint(world, useDocumentStore.getState().scene.settings.snapStep)
        : world
    }

    const startCreation = (tool: 'ground' | 'body' | 'field', world: Vec2) => {
      const layerId = activeLayerId()
      if (!layerId) return
      const editor = useEditorStore.getState()
      const kind = tool === 'ground' ? 'ground' : tool === 'body' ? 'body' : 'field'
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
      }
      interactionRef.current = interaction
      useEditorStore.getState().setDraftEntity(getDraft(interaction, world))
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
        startCreation(tool, world)
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

      if (interaction.type === 'pan') {
        editor.setCamera(
          panCamera(interaction.startCamera, subtract(screen, interaction.startScreen)),
        )
      } else if (interaction.type === 'marquee') {
        editor.setMarquee({ start: interaction.startWorld, end: unsnappedWorld })
      } else if (interaction.type === 'create') {
        editor.setDraftEntity(getDraft(interaction, world))
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
            useDocumentStore.getState().scene.settings.snapStep,
          )
          delta = subtract(snappedAnchor, anchorTransform.position)
        }
        editor.setPreviewEntities(
          interaction.originals.map((entity) => {
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
          }),
        )
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
      }
    }

    const finishInteraction = (event: PointerEvent) => {
      const editor = useEditorStore.getState()
      const document = useDocumentStore.getState()
      const interaction = interactionRef.current
      const rawWorld = rawWorldPoint(event)
      const world = resolvedWorldPoint(event)

      if (interaction.type === 'move' || interaction.type === 'rotate') {
        const replacements = Object.values(editor.previewEntities)
        if (replacements.length > 0) {
          document.executeCommand(
            createReplaceEntitiesCommand(
              document.scene,
              replacements,
              interaction.type === 'move' ? '移动实体' : '旋转实体',
            ),
          )
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
        const entity = getDraft(interaction, world, true)
        document.executeCommand(createAddEntityCommand(document.scene, entity))
        editor.setDraftEntity(null)
        editor.setSelectedIds([entity.id])
      }

      interactionRef.current = { type: 'idle' }
      updateCursor(editor.activeTool)
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    }

    const cancelInteraction = () => {
      const editor = useEditorStore.getState()
      editor.clearPreview()
      editor.setDraftEntity(null)
      editor.setMarquee(null)
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
      if (event.key === 'Escape') cancelInteraction()
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        spacePressedRef.current = false
        updateCursor(useEditorStore.getState().activeTool)
      }
    }

    const handleContextMenu = (event: MouseEvent) => event.preventDefault()

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
