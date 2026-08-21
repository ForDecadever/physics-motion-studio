import { CircleDot, Combine } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { createBooleanLayerCommand } from '../../editor/commands/booleanLayerCommands'
import { commitPendingEditorEdit } from '../../editor/editing/pendingEditorEdit'
import { useDocumentStore } from '../../stores/documentStore'
import { useEditorStore, type EditorTool } from '../../stores/editorStore'
import { isSimulationRuntimeLocked, useSimulationStore } from '../../stores/simulationStore'
import styles from './Toolbar.module.css'
import { toolDefinitions } from './toolDefinitions'

export function Toolbar({ orientation = 'vertical' }: { orientation?: 'vertical' | 'horizontal' }) {
  const activeTool = useEditorStore((state) => state.activeTool)
  const setActiveTool = useEditorStore((state) => state.setActiveTool)
  const groundToolShape = useEditorStore((state) => state.groundToolShape)
  const bodyToolPreset = useEditorStore((state) => state.bodyToolPreset)
  const fieldToolPreset = useEditorStore((state) => state.fieldToolPreset)
  const connectorToolPreset = useEditorStore((state) => state.connectorToolPreset)
  const particleSourceToolShape = useEditorStore((state) => state.particleSourceToolShape)
  const setGroundToolShape = useEditorStore((state) => state.setGroundToolShape)
  const setBodyToolPreset = useEditorStore((state) => state.setBodyToolPreset)
  const setFieldToolPreset = useEditorStore((state) => state.setFieldToolPreset)
  const setConnectorToolPreset = useEditorStore((state) => state.setConnectorToolPreset)
  const setParticleSourceToolShape = useEditorStore((state) => state.setParticleSourceToolShape)
  const runtimeLocked = useSimulationStore(isSimulationRuntimeLocked)
  const [openFlyout, setOpenFlyout] = useState<EditorTool | null>(null)
  const [flyoutAnchor, setFlyoutAnchor] = useState<DOMRect | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
      if (closeTimer.current) clearTimeout(closeTimer.current)
    },
    [],
  )

  const flyoutOptions: Partial<
    Record<EditorTool, Array<{ label: string; active: boolean; select: () => void }>>
  > = {
    ground: [
      {
        label: '直线地面',
        active: groundToolShape === 'line',
        select: () => setGroundToolShape('line'),
      },
      {
        label: '圆弧地面',
        active: groundToolShape === 'arc',
        select: () => setGroundToolShape('arc'),
      },
      {
        label: '贝塞尔钢笔地面',
        active: groundToolShape === 'cubicBezier',
        select: () => setGroundToolShape('cubicBezier'),
      },
    ],
    body: [
      { label: '小球', active: bodyToolPreset === 'ball', select: () => setBodyToolPreset('ball') },
      {
        label: '物块',
        active: bodyToolPreset === 'block',
        select: () => setBodyToolPreset('block'),
      },
    ],
    field: [
      {
        label: '匀强重力场',
        active: fieldToolPreset === 'uniformGravity',
        select: () => setFieldToolPreset('uniformGravity'),
      },
      {
        label: '匀强电场',
        active: fieldToolPreset === 'uniformElectric',
        select: () => setFieldToolPreset('uniformElectric'),
      },
      {
        label: '匀强磁场',
        active: fieldToolPreset === 'uniformMagnetic',
        select: () => setFieldToolPreset('uniformMagnetic'),
      },
    ],
    connector: [
      {
        label: '绳',
        active: connectorToolPreset === 'rope',
        select: () => setConnectorToolPreset('rope'),
      },
      {
        label: '杆',
        active: connectorToolPreset === 'rod',
        select: () => setConnectorToolPreset('rod'),
      },
      {
        label: '弹簧',
        active: connectorToolPreset === 'spring',
        select: () => setConnectorToolPreset('spring'),
      },
    ],
    particleSource: [
      {
        label: '点粒子源',
        active: particleSourceToolShape === 'point',
        select: () => setParticleSourceToolShape('point'),
      },
      {
        label: '线粒子源',
        active: particleSourceToolShape === 'line',
        select: () => setParticleSourceToolShape('line'),
      },
    ],
  }

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }

  const beginHover = (tool: EditorTool, anchor: HTMLElement) => {
    if (runtimeLocked || !flyoutOptions[tool]) return
    cancelClose()
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => {
      setFlyoutAnchor(anchor.getBoundingClientRect())
      setOpenFlyout(tool)
    }, 500)
  }

  const endHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    closeTimer.current = setTimeout(() => {
      setOpenFlyout(null)
      setFlyoutAnchor(null)
    }, 120)
  }

  const activeDefinition = toolDefinitions.find(({ id }) => id === openFlyout)
  const activeOptions = openFlyout ? flyoutOptions[openFlyout] : undefined
  const flyoutHeight = 48 + (activeOptions?.length ?? 0) * 30
  const flyoutPosition = (() => {
    if (!flyoutAnchor) return { left: 0, top: 0 }
    if (orientation === 'horizontal') {
      const top =
        flyoutAnchor.bottom + flyoutHeight + 8 <= window.innerHeight
          ? flyoutAnchor.bottom + 6
          : flyoutAnchor.top - flyoutHeight - 6
      return {
        left: Math.min(window.innerWidth - 180, Math.max(8, flyoutAnchor.left)),
        top: Math.min(window.innerHeight - flyoutHeight - 8, Math.max(8, top)),
      }
    }
    const opensRight = flyoutAnchor.right + 180 <= window.innerWidth
    return {
      left: opensRight ? flyoutAnchor.right + 6 : flyoutAnchor.left - 178,
      top: Math.min(window.innerHeight - flyoutHeight - 8, Math.max(8, flyoutAnchor.top - 5)),
    }
  })()

  return (
    <>
      <aside className={styles.toolbar} data-orientation={orientation} aria-label="工具栏">
        <div className={styles.toolbarTop}>
          {toolDefinitions.map(({ id, label, shortcut, icon: Icon, startsGroup }) => (
            <div
              className={`${styles.toolItem} ${startsGroup ? styles.toolGroup : ''}`}
              key={id}
              onMouseEnter={(event) => beginHover(id, event.currentTarget)}
              onMouseLeave={endHover}
            >
              <button
                type="button"
                className={styles.toolButton}
                data-active={activeTool === id}
                aria-pressed={activeTool === id}
                aria-label={`${label}（${shortcut}）`}
                title={`${label}  ${shortcut}`}
                disabled={runtimeLocked && !['select', 'hand', 'zoom'].includes(id)}
                onClick={() => setActiveTool(id)}
                aria-haspopup={flyoutOptions[id] ? 'menu' : undefined}
                aria-expanded={flyoutOptions[id] ? openFlyout === id : undefined}
              >
                <Icon size={20} strokeWidth={1.8} />
                {id === 'body' ? <CircleDot className={styles.cornerGlyph} size={8} /> : null}
                {['ground', 'body', 'field', 'connector'].includes(id) ? (
                  <span className={styles.flyoutMark} aria-hidden="true" />
                ) : null}
              </button>
            </div>
          ))}
          <div className={`${styles.toolItem} ${styles.toolGroup}`}>
            <button
              type="button"
              className={styles.toolButton}
              aria-label="布尔组合"
              title="布尔组合"
              disabled={runtimeLocked}
              onClick={() => {
                commitPendingEditorEdit()
                const document = useDocumentStore.getState()
                const result = createBooleanLayerCommand(
                  document.scene,
                  'union',
                  useEditorStore.getState().selectedIds,
                )
                document.executeCommand(result.command)
                useEditorStore.getState().setSelectedIds([result.resultId])
              }}
            >
              <Combine size={20} strokeWidth={1.8} />
            </button>
          </div>
        </div>

        <div className={styles.axisBadge} title="二维世界坐标：X 向右，Y 向上">
          <span className={styles.axisY}>Y</span>
          <span className={styles.axisX}>X</span>
        </div>
      </aside>
      {openFlyout && activeOptions && activeDefinition && flyoutAnchor
        ? createPortal(
            <div
              className={styles.toolFlyout}
              style={flyoutPosition}
              role="menu"
              aria-label={`${activeDefinition.label}选项`}
              onMouseEnter={cancelClose}
              onMouseLeave={endHover}
            >
              <div className={styles.toolFlyoutTitle}>{activeDefinition.label}</div>
              {activeOptions.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.active}
                  className={styles.toolFlyoutOption}
                  data-active={option.active}
                  onClick={() => {
                    option.select()
                    setActiveTool(openFlyout)
                    setOpenFlyout(null)
                    setFlyoutAnchor(null)
                  }}
                >
                  <span>{option.active ? '✓' : ''}</span>
                  {option.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
