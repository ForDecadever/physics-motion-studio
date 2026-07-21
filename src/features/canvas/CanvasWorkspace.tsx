import { MousePointer2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { getAdaptiveGridStep } from '../../editor/camera/viewport'
import { useDocumentStore } from '../../stores/documentStore'
import { useEditorStore } from '../../stores/editorStore'
import { PixiCanvas } from './PixiCanvas'
import styles from './CanvasWorkspace.module.css'

export function CanvasWorkspace() {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 1, height: 1 })
  const gridVisible = useEditorStore((state) => state.gridVisible)
  const snapEnabled = useEditorStore((state) => state.snapEnabled)
  const camera = useEditorStore((state) => state.camera)
  const cursorWorld = useEditorStore((state) => state.cursorWorld)
  const selectedCount = useEditorStore((state) => state.selectedIds.length)
  const gridStep = useDocumentStore((state) => state.scene.settings.gridStep)
  const visualGridStep = getAdaptiveGridStep(gridStep / 10, camera.pixelsPerMeter, 14) * 5

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      setSize({
        width: Math.max(1, Math.round(entry.contentRect.width)),
        height: Math.max(1, Math.round(entry.contentRect.height)),
      })
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  return (
    <main className={styles.canvasWorkspace} aria-label="物理场景画布">
      <div className={styles.canvasTopline}>
        <span>二维场景</span>
        <span className={styles.toplineSeparator} />
        <span>sRGB</span>
        <span className={styles.toplineSeparator} />
        <span>{Math.round(camera.pixelsPerMeter)} px/m</span>
        {selectedCount > 0 ? (
          <>
            <span className={styles.toplineSeparator} />
            <span>{selectedCount} 个实体已选择</span>
          </>
        ) : null}
      </div>

      <div className={styles.canvasViewport} ref={viewportRef}>
        <PixiCanvas size={size} />

        <div className={styles.canvasBadges} aria-hidden="true">
          <span>
            {gridVisible ? `1 大格 = ${Number(visualGridStep.toPrecision(4))} m` : '网格已隐藏'}
          </span>
          <span>{snapEnabled ? '吸附已开启' : '自由定位'}</span>
        </div>

        <div className={styles.cursorReadout}>
          <MousePointer2 size={12} />
          <span>X {cursorWorld.x.toFixed(2)} m</span>
          <span>Y {cursorWorld.y.toFixed(2)} m</span>
        </div>
      </div>
    </main>
  )
}
