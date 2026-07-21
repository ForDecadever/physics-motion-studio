import {
  Box,
  CircleDot,
  Hand,
  Link2,
  Magnet,
  MousePointer2,
  RotateCw,
  Spline,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react'

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
  { id: 'body', label: '物体工具', shortcut: 'O', icon: Box },
  { id: 'field', label: '场工具', shortcut: 'F', icon: Magnet },
  { id: 'connector', label: '连接工具', shortcut: 'L', icon: Link2 },
]

export function Toolbar() {
  const activeTool = useEditorStore((state) => state.activeTool)
  const setActiveTool = useEditorStore((state) => state.setActiveTool)
  const runtimeLocked = useSimulationStore(isSimulationRuntimeLocked)

  return (
    <aside className={styles.toolbar} aria-label="工具栏">
      <div className={styles.toolbarTop}>
        {tools.map(({ id, label, shortcut, icon: Icon, startsGroup }) => (
          <div className={startsGroup ? styles.toolGroup : undefined} key={id}>
            <button
              type="button"
              className={styles.toolButton}
              data-active={activeTool === id}
              aria-pressed={activeTool === id}
              aria-label={`${label}（${shortcut}）`}
              title={`${label}  ${shortcut}`}
              disabled={runtimeLocked && !['select', 'hand', 'zoom'].includes(id)}
              onClick={() => setActiveTool(id)}
            >
              <Icon size={20} strokeWidth={1.8} />
              {id === 'body' ? <CircleDot className={styles.cornerGlyph} size={8} /> : null}
              {['ground', 'field', 'connector'].includes(id) ? (
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
  )
}
