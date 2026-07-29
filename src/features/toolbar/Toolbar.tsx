import {
  Box,
  CircleDot,
  GitMerge,
  Hand,
  Link2,
  Magnet,
  MousePointer2,
  RotateCw,
  Scaling,
  Spline,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useEditorStore, type EditorTool } from '../../stores/editorStore'
import { isSimulationRuntimeLocked, useSimulationStore } from '../../stores/simulationStore'
import styles from './Toolbar.module.css'

interface ToolDefinition {
  id: EditorTool
  label: string
  shortcut: string
  icon: LucideIcon
  startsGroup?: boolean
}

const tools: ToolDefinition[] = [
  { id: 'select', label: '选择与移动', shortcut: 'V', icon: MousePointer2 },
  { id: 'rotate', label: '旋转', shortcut: 'R', icon: RotateCw },
  { id: 'scale', label: '对象缩放', shortcut: 'S', icon: Scaling },
  { id: 'hand', label: '抓手', shortcut: 'H', icon: Hand, startsGroup: true },
  { id: 'zoom', label: '画布缩放', shortcut: 'Z', icon: ZoomIn },
  { id: 'ground', label: '地面工具', shortcut: 'G', icon: Spline, startsGroup: true },
  { id: 'groundJoint', label: '地面连接点工具', shortcut: 'J', icon: GitMerge },
  { id: 'body', label: '物体工具', shortcut: 'O', icon: Box },
  { id: 'field', label: '场工具', shortcut: 'F', icon: Magnet },
  { id: 'connector', label: '连接工具', shortcut: 'L', icon: Link2 },
]

export function Toolbar({ orientation = 'vertical' }: { orientation?: 'vertical' | 'horizontal' }) {
  const activeTool = useEditorStore((state) => state.activeTool)
  const setActiveTool = useEditorStore((state) => state.setActiveTool)
  const groundToolShape = useEditorStore((state) => state.groundToolShape)
  const bodyToolPreset = useEditorStore((state) => state.bodyToolPreset)
  const fieldToolPreset = useEditorStore((state) => state.fieldToolPreset)
  const connectorToolPreset = useEditorStore((state) => state.connectorToolPreset)
  const setGroundToolShape = useEditorStore((state) => state.setGroundToolShape)
  const setBodyToolPreset = useEditorStore((state) => state.setBodyToolPreset)
  const setFieldToolPreset = useEditorStore((state) => state.setFieldToolPreset)
  const setConnectorToolPreset = useEditorStore((state) => state.setConnectorToolPreset)
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

  const activeDefinition = tools.find(({ id }) => id === openFlyout)
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
          {tools.map(({ id, label, shortcut, icon: Icon, startsGroup }) => (
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
