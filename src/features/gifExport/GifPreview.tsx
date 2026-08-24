import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'

import { panCamera, zoomCameraAtPoint, type Camera2D } from '../../editor/camera/viewport'
import { PixiSceneRenderer } from '../../renderer/pixi/PixiSceneRenderer'
import type { GifHistorySnapshot } from '../../physics/worker/messages'
import type { SceneDocument, Vec2 } from '../../scene/model/types'
import {
  fitGifPreviewDisplaySize,
  gifGuideColor,
  GifHistoryReader,
  type GifExportSettings,
} from './gifExportModel'
import styles from './GifExportDialog.module.css'

export interface GifPreviewHandle {
  capture: (time: number) => Uint8ClampedArray
}

interface GifPreviewProps {
  scene: SceneDocument
  snapshot: GifHistorySnapshot
  settings: GifExportSettings
  camera: Camera2D
  previewTime: number
  onCameraChange: (camera: Camera2D) => void
  onReadyChange: (ready: boolean) => void
}

export const GifPreview = forwardRef<GifPreviewHandle, GifPreviewProps>(function GifPreview(
  { scene, snapshot, settings, camera, previewTime, onCameraChange, onReadyChange },
  ref,
) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<PixiSceneRenderer | null>(null)
  const rendererSizeRef = useRef({ width: settings.width, height: settings.height })
  const onReadyChangeRef = useRef(onReadyChange)
  onReadyChangeRef.current = onReadyChange
  const [ready, setReady] = useState(false)
  const [displaySize, setDisplaySize] = useState({ width: 1, height: 1 })
  const reader = useMemo(() => new GifHistoryReader(snapshot), [snapshot])
  const stateRef = useRef({ scene, settings, camera, previewTime })
  stateRef.current = { scene, settings, camera, previewTime }

  const renderAt = useCallback(
    (time: number) => {
      const renderer = rendererRef.current
      if (!renderer) throw new Error('GIF 预览画布尚未准备好。')
      const current = stateRef.current
      const size = { width: current.settings.width, height: current.settings.height }
      const frame = reader.frameAt(time)
      const trajectoryIds = current.settings.guides.trajectoryIds
      const runtimeTrajectories = Object.fromEntries(
        trajectoryIds.map((entityId) => [
          entityId,
          reader.trajectory(
            entityId,
            current.settings.startTime,
            time,
            current.camera.pixelsPerMeter,
          ),
        ]),
      )
      const trajectoryColors = Object.fromEntries(
        trajectoryIds.map((entityId) => [
          entityId,
          gifGuideColor(entityId, reader.snapshot.bodyIds),
        ]),
      )
      const particleTrajectories = reader.particleTrajectories(
        current.settings.startTime,
        time,
        current.camera.pixelsPerMeter,
      )

      renderer.render({
        scene: current.scene,
        camera: current.camera,
        size,
        gridVisible: current.settings.gridVisible,
        selectedIds: [],
        previewEntities: {},
        draftEntity: null,
        marquee: null,
        connectorStartEndpoint: null,
        activeTool: 'select',
        groundJointStart: null,
        groundJointHover: null,
        pendingGroundEndpoint: null,
        runtimeBodies: frame.bodies,
        runtimeConnectors: frame.connectors,
        runtimeTrajectories,
        particleTrajectories,
        particleSources: frame.particleSources,
        simulationTime: frame.simulationTime,
        runtimeLocked: true,
        motionGuides: {
          ...current.settings.guides,
          trajectoryColors,
        },
        showOverlays: false,
        backgroundColor: current.settings.backgroundColor,
        transparentBackground: current.settings.transparent,
      })
    },
    [reader],
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    setReady(false)
    onReadyChangeRef.current(false)
    const renderer = new PixiSceneRenderer()

    void renderer
      .mount(host, {
        width: stateRef.current.settings.width,
        height: stateRef.current.settings.height,
        resolution: 1,
        interactive: false,
        ariaLabel: 'GIF 导出预览',
      })
      .then(() => {
        if (disposed) {
          renderer.destroy()
          return
        }
        rendererRef.current = renderer
        rendererSizeRef.current = {
          width: stateRef.current.settings.width,
          height: stateRef.current.settings.height,
        }
        setReady(true)
        onReadyChangeRef.current(true)
        renderAt(stateRef.current.previewTime)
      })
      .catch(() => {
        if (!disposed) {
          setReady(false)
          onReadyChangeRef.current(false)
        }
      })

    return () => {
      disposed = true
      if (rendererRef.current === renderer) rendererRef.current = null
      setReady(false)
      onReadyChangeRef.current(false)
      renderer.destroy()
    }
  }, [renderAt])

  useEffect(() => {
    const renderer = rendererRef.current
    if (!ready || !renderer) return
    if (
      rendererSizeRef.current.width !== settings.width ||
      rendererSizeRef.current.height !== settings.height
    ) {
      renderer.resize({ width: settings.width, height: settings.height })
      rendererSizeRef.current = { width: settings.width, height: settings.height }
    }
    renderAt(previewTime)
  }, [camera, previewTime, ready, renderAt, scene, settings])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const updateDisplaySize = () => {
      const rect = viewport.getBoundingClientRect()
      setDisplaySize(
        fitGifPreviewDisplaySize(rect.width, rect.height, settings.width, settings.height, 24),
      )
    }
    updateDisplaySize()
    const observer = new ResizeObserver(updateDisplaySize)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [settings.height, settings.width])

  useImperativeHandle(
    ref,
    () => ({
      capture: (time) => {
        const renderer = rendererRef.current
        if (!ready || !renderer) throw new Error('GIF 预览画布尚未准备好。')
        renderAt(time)
        return renderer.capturePixels({
          width: stateRef.current.settings.width,
          height: stateRef.current.settings.height,
        })
      },
    }),
    [ready, renderAt],
  )

  const panRef = useRef<{ pointerId: number; screen: Vec2; camera: Camera2D } | null>(null)

  const outputPoint = (
    event: ReactPointerEvent<HTMLDivElement> | ReactWheelEvent<HTMLDivElement>,
  ): Vec2 => {
    const rect =
      hostRef.current?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect()
    return {
      x:
        Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))) *
        settings.width,
      y:
        Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height))) *
        settings.height,
    }
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    panRef.current = { pointerId: event.pointerId, screen: outputPoint(event), camera }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    const point = outputPoint(event)
    onCameraChange(panCamera(pan.camera, { x: point.x - pan.screen.x, y: point.y - pan.screen.y }))
  }

  const finishPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    onCameraChange(
      zoomCameraAtPoint(
        camera,
        outputPoint(event),
        { width: settings.width, height: settings.height },
        Math.exp(-event.deltaY * 0.0012),
      ),
    )
  }

  return (
    <div
      ref={viewportRef}
      className={styles.previewViewport}
      data-testid="gif-preview-viewport"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPan}
      onPointerCancel={finishPan}
      onWheel={handleWheel}
      data-ready={ready}
    >
      <div
        className={styles.previewCanvasHost}
        ref={hostRef}
        data-testid="gif-export-frame"
        style={{
          width: `${displaySize.width}px`,
          height: `${displaySize.height}px`,
        }}
      />
      {!ready ? <div className={styles.previewLoading}>正在准备预览…</div> : null}
    </div>
  )
})
