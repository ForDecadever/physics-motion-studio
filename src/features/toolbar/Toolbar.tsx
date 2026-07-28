import {
  Box,
  CircleDot,
  GitMerge,
  Hand,
  Link2,
  Magnet,
  MousePointer2,
  RotateCw,
  Spline,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

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
  { id: 'hand', label: '抓手', shortcut: 'H', icon: Hand, startsGroup: true },
  { id: 'zoom', label: '缩放', shortcut: 'Z', icon: ZoomIn },
  { id: 'ground', label: '地面工具', shortcut: 'G', icon: Spline, startsGroup: true },
  { id: 'groundJoint', label: '地面连接点工具', shortcut: 'J', icon: GitMerge },
  { id: 'body', label: '物体工具', shortcut: 'O', icon: Box },
  { id: 'field', label: '场工具', shortcut: 'F', icon: Magnet },
  { id: 'connector', label: '连接工具', shortcut: 'L', icon: Link2 },
]

export function Toolbar() {
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
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
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

  const beginHover = (tool: EditorTool) => {
    if (runtimeLocked || !flyoutOptions[tool]) return
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setOpenFlyout(tool), 500)
  }

  const endHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    setOpenFlyout(null)
  }

  return (
    <aside className={styles.toolbar} aria-label="工具栏">
      <div className={styles.toolbarTop}>
        {tools.map(({ id, label, shortcut, icon: Icon, startsGroup }) => (
          <div
            className={`${styles.toolItem} ${startsGroup ? styles.toolGroup : ''}`}
            key={id}
            onMouseEnter={() => beginHover(id)}
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
            {openFlyout === id && flyoutOptions[id] ? (
              <div className={styles.toolFlyout} role="menu" aria-label={`${label}选项`}>
                <div className={styles.toolFlyoutTitle}>{label}</div>
                {flyoutOptions[id]?.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    role="menuitemradio"
                    aria-checked={option.active}
                    className={styles.toolFlyoutOption}
                    data-active={option.active}
                    onClick={() => {
                      option.select()
                      setActiveTool(id)
                      setOpenFlyout(null)
                    }}
                  >
                    <span>{option.active ? '✓' : ''}</span>
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className={styles.axisBadge} title="二维世界坐标：X 向右，Y 向上">
        <span className={styles.axisY}>Y</span>
        <span className={styles.axisX}>X</span>
      </div>
    </aside>
  )
}
