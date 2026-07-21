import { Check, Focus, Grid2X2, Magnet, MousePointer2 } from 'lucide-react'

import { defaultCamera } from '../../editor/camera/viewport'
import { useEditorStore, type EditorTool } from '../../stores/editorStore'
import styles from './Toolbar.module.css'

const toolNames: Record<EditorTool, string> = {
  select: '选择与移动',
  rotate: '旋转',
  hand: '抓手',
  zoom: '缩放',
  ground: '地面工具',
  body: '物体工具',
  field: '场工具',
  connector: '连接工具',
}

export function ToolOptionsBar() {
  const activeTool = useEditorStore((state) => state.activeTool)
  const gridVisible = useEditorStore((state) => state.gridVisible)
  const snapEnabled = useEditorStore((state) => state.snapEnabled)
  const toggleGrid = useEditorStore((state) => state.toggleGrid)
  const toggleSnap = useEditorStore((state) => state.toggleSnap)
  const connectorStartBodyId = useEditorStore((state) => state.connectorStartBodyId)
  const setCamera = useEditorStore((state) => state.setCamera)
  const groundToolShape = useEditorStore((state) => state.groundToolShape)
  const bodyToolPreset = useEditorStore((state) => state.bodyToolPreset)
  const setGroundToolShape = useEditorStore((state) => state.setGroundToolShape)
  const setBodyToolPreset = useEditorStore((state) => state.setBodyToolPreset)

  const toolDetail: Record<EditorTool, string> = {
    select: '拖动移动 · Shift 多选',
    rotate: '拖动旋转 · 15° 吸附',
    hand: '拖动画布 · 空格临时启用',
    zoom: '点击放大 · Alt 点击缩小',
    ground: '拖动生成地面曲线',
    body: '拖动设置物体尺寸',
    field: '矩形重力场',
    connector: connectorStartBodyId ? '请选择第二个物体' : '绳：依次选择两个物体',
  }

  return (
    <section className={styles.optionsBar} aria-label="当前工具选项">
      <div className={styles.activeToolLabel}>
        <MousePointer2 size={15} />
        <span>{toolNames[activeTool]}</span>
      </div>
      <div className={styles.optionsDivider} />
      <span className={styles.toolDetail}>{toolDetail[activeTool]}</span>
      {activeTool === 'ground' ? (
        <label className={styles.toolSelect}>
          <span>形状</span>
          <select
            value={groundToolShape}
            onChange={(event) =>
              setGroundToolShape(event.target.value as 'line' | 'arc' | 'cubicBezier')
            }
          >
            <option value="line">直线</option>
            <option value="arc">圆弧凹面</option>
            <option value="cubicBezier">贝塞尔凹面</option>
          </select>
        </label>
      ) : null}
      {activeTool === 'body' ? (
        <label className={styles.toolSelect}>
          <span>物体</span>
          <select
            value={bodyToolPreset}
            onChange={(event) =>
              setBodyToolPreset(event.target.value as 'particle' | 'ball' | 'block')
            }
          >
            <option value="particle">质点</option>
            <option value="ball">小球</option>
            <option value="block">物块</option>
          </select>
        </label>
      ) : null}
      <div className={styles.optionsDivider} />
      <button
        type="button"
        className={styles.optionToggle}
        aria-pressed={gridVisible}
        onClick={toggleGrid}
      >
        <Grid2X2 size={15} />
        网格
        {gridVisible ? <Check size={13} /> : null}
      </button>
      <button
        type="button"
        className={styles.optionToggle}
        aria-pressed={snapEnabled}
        onClick={toggleSnap}
      >
        <Magnet size={15} />
        吸附 0.1 m{snapEnabled ? <Check size={13} /> : null}
      </button>
      <button
        type="button"
        className={styles.optionToggle}
        onClick={() => setCamera(defaultCamera)}
        title="将世界原点移回画布中央并恢复默认缩放"
      >
        <Focus size={15} />
        回到原点
      </button>
      <div className={styles.optionsHint}>按住 Alt 临时关闭吸附</div>
    </section>
  )
}
