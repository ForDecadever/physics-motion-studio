import { BoxSelect, Check, Focus, GitMerge, Grid2X2, Magnet, MousePointer2 } from 'lucide-react'

import { defaultCamera, getVisibleSnapStep } from '../../editor/camera/viewport'
import { useDocumentStore } from '../../stores/documentStore'
import {
  useEditorStore,
  type BodyToolPreset,
  type ConnectorToolPreset,
  type EditorTool,
  type FieldToolPreset,
  type FieldRegionToolShape,
} from '../../stores/editorStore'
import styles from './Toolbar.module.css'

const toolNames: Record<EditorTool, string> = {
  select: '选择与移动',
  rotate: '旋转',
  hand: '抓手',
  zoom: '缩放',
  ground: '地面工具',
  groundJoint: '地面连接点工具',
  body: '物体工具',
  field: '场工具',
  connector: '连接工具',
}

export function ToolOptionsBar() {
  const activeTool = useEditorStore((state) => state.activeTool)
  const gridVisible = useEditorStore((state) => state.gridVisible)
  const snapEnabled = useEditorStore((state) => state.snapEnabled)
  const wallSnapEnabled = useEditorStore((state) => state.wallSnapEnabled)
  const autoGroundJointEnabled = useEditorStore((state) => state.autoGroundJointEnabled)
  const toggleGrid = useEditorStore((state) => state.toggleGrid)
  const toggleSnap = useEditorStore((state) => state.toggleSnap)
  const toggleWallSnap = useEditorStore((state) => state.toggleWallSnap)
  const toggleAutoGroundJoint = useEditorStore((state) => state.toggleAutoGroundJoint)
  const camera = useEditorStore((state) => state.camera)
  const gridStep = useDocumentStore((state) => state.scene.settings.gridStep)
  const connectorStartBodyId = useEditorStore((state) => state.connectorStartBodyId)
  const groundJointStart = useEditorStore((state) => state.groundJointStart)
  const groundJointMessage = useEditorStore((state) => state.groundJointMessage)
  const setCamera = useEditorStore((state) => state.setCamera)
  const groundToolShape = useEditorStore((state) => state.groundToolShape)
  const bodyToolPreset = useEditorStore((state) => state.bodyToolPreset)
  const fieldToolPreset = useEditorStore((state) => state.fieldToolPreset)
  const fieldRegionToolShape = useEditorStore((state) => state.fieldRegionToolShape)
  const connectorToolPreset = useEditorStore((state) => state.connectorToolPreset)
  const setGroundToolShape = useEditorStore((state) => state.setGroundToolShape)
  const setBodyToolPreset = useEditorStore((state) => state.setBodyToolPreset)
  const setFieldToolPreset = useEditorStore((state) => state.setFieldToolPreset)
  const setFieldRegionToolShape = useEditorStore((state) => state.setFieldRegionToolShape)
  const setConnectorToolPreset = useEditorStore((state) => state.setConnectorToolPreset)

  const toolDetail: Record<EditorTool, string> = {
    select: '拖动移动 · Shift 多选',
    rotate: '拖动旋转 · 15° 吸附',
    hand: '拖动画布 · 空格临时启用',
    zoom: '点击放大 · Alt 点击缩小',
    ground:
      groundToolShape === 'cubicBezier' ? '依次点击两个端点；选中后拖动控制柄' : '拖动生成地面曲线',
    groundJoint:
      groundJointMessage ??
      (groundJointStart ? '请选择另一块地面的端点' : '依次点击两块地面的端点'),
    body: '拖动设置物体尺寸',
    field:
      fieldRegionToolShape === 'infinite'
        ? '点击创建覆盖整个空间的场'
        : fieldRegionToolShape === 'freeform'
          ? '逐点绘制；点首节点、双击或 Enter 完成'
          : `拖动绘制${fieldRegionToolShape === 'circle' ? '圆形' : '矩形'}作用范围`,
    connector: connectorStartBodyId ? '请选择第二个物体' : '依次选择两个物体',
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
            onChange={(event) => setBodyToolPreset(event.target.value as BodyToolPreset)}
          >
            <option value="ball">小球</option>
            <option value="block">物块</option>
          </select>
        </label>
      ) : null}
      {activeTool === 'field' ? (
        <>
          <label className={styles.toolSelect}>
            <span>场类型</span>
            <select
              value={fieldToolPreset}
              onChange={(event) => setFieldToolPreset(event.target.value as FieldToolPreset)}
            >
              <option value="uniformGravity">匀强重力场</option>
              <option value="uniformElectric">匀强电场</option>
              <option value="uniformMagnetic">匀强磁场</option>
            </select>
          </label>
          <label className={styles.toolSelect}>
            <span>范围</span>
            <select
              aria-label="场范围形状"
              value={fieldRegionToolShape}
              onChange={(event) =>
                setFieldRegionToolShape(event.target.value as FieldRegionToolShape)
              }
            >
              <option value="rectangle">矩形</option>
              <option value="circle">圆形</option>
              <option value="freeform">钢笔自由形状</option>
              <option value="infinite">无限范围</option>
            </select>
          </label>
        </>
      ) : null}
      {activeTool === 'connector' ? (
        <label className={styles.toolSelect}>
          <span>连接</span>
          <select
            value={connectorToolPreset}
            onChange={(event) => setConnectorToolPreset(event.target.value as ConnectorToolPreset)}
          >
            <option value="rope">绳</option>
            <option value="rod">杆</option>
            <option value="spring">弹簧</option>
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
        网格吸附 {Number(getVisibleSnapStep(gridStep, camera.pixelsPerMeter).toPrecision(3))} m
        {snapEnabled ? <Check size={13} /> : null}
      </button>
      <button
        type="button"
        className={styles.optionToggle}
        aria-pressed={wallSnapEnabled}
        onClick={toggleWallSnap}
        title="让物体的外轮廓自动贴合最近的地面或墙面"
      >
        <BoxSelect size={15} />
        墙面吸附{wallSnapEnabled ? <Check size={13} /> : null}
      </button>
      {activeTool === 'ground' ? (
        <button
          type="button"
          className={styles.optionToggle}
          aria-pressed={autoGroundJointEnabled}
          onClick={toggleAutoGroundJoint}
          title="新地面的起点靠近未占用端点时，自动吸附并创建圆滑连接"
        >
          <GitMerge size={15} />
          自动连接地面{autoGroundJointEnabled ? <Check size={13} /> : null}
        </button>
      ) : null}
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
