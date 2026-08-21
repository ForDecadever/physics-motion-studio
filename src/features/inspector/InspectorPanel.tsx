import { BoxSelect, Gauge, Grid2X2, Pin, Timer, Unlink } from 'lucide-react'
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

import { createReplaceBooleanNodeCommand } from '../../editor/commands/booleanLayerCommands'
import {
  createReplaceEntitiesCommand,
  createReplaceSceneSettingsCommand,
} from '../../editor/commands/entityCommands'
import {
  bodyLocalAnchorIsInside,
  clampBodyLocalAnchor,
  getEntityTransform,
  resolveConnectorEndpoint,
  withEntityTransform,
} from '../../editor/geometry/entityGeometry'
import { resolveGroundJoint } from '../../scene/model/groundEndpoints'
import { buildGroundPathNetwork, type ResolvedGroundJointPath } from '../../scene/model/groundPath'
import {
  MIN_COLLIDING_ROPE_MASS_KG,
  minimumFixedRopeLength,
  setConnectorCollisionEnabled,
} from '../../scene/model/connectorRules'
import type {
  BodyEntity,
  BooleanNode,
  ConnectorEndpoint,
  SceneEntity,
  Vec2,
} from '../../scene/model/types'
import {
  resolveBooleanScene,
  type ResolvedBooleanBody,
  type ResolvedBooleanResult,
} from '../../scene/model/booleanGeometry'
import { findBooleanNode, isTreeItemEffectivelyLocked } from '../../scene/model/booleanLayerGraph'
import { resolveRenderedEntity } from '../../renderer/pixi/renderEntityState'
import { useDocumentStore } from '../../stores/documentStore'
import { isSimulationRuntimeLocked, useSimulationStore } from '../../stores/simulationStore'
import { useEditorStore } from '../../stores/editorStore'
import styles from '../panels/Panels.module.css'
import {
  cancelPendingEditorEdit,
  commitPendingEditorEdit,
  commitPendingEditorEditFromBlur,
  registerPendingEditorEdit,
} from '../../editor/editing/pendingEditorEdit'

function PropertyRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className={styles.propertyRow}>
      <span className={styles.propertyIcon}>{icon}</span>
      <span className={styles.propertyLabel}>{label}</span>
      <output>{value}</output>
    </div>
  )
}

function NumberProperty({
  label,
  value,
  unit,
  min,
  max,
  step = 'any',
  disabled,
  commitWhenEdited = false,
  onCommit,
}: {
  label: string
  value: number
  unit?: string
  min?: number
  max?: number
  step?: number | 'any'
  disabled: boolean
  commitWhenEdited?: boolean
  onCommit: (value: number) => void
}) {
  const [edit, setEdit] = useState({
    sourceValue: value,
    text: formatNumber(value, 5),
    dirty: false,
  })
  const draft = Object.is(edit.sourceValue, value) ? edit.text : formatNumber(value, 5)
  const dirty = Object.is(edit.sourceValue, value) && edit.dirty
  const latest = useRef({ draft, dirty, value, min, max, commitWhenEdited, onCommit })
  useEffect(() => {
    latest.current = { draft, dirty, value, min, max, commitWhenEdited, onCommit }
  }, [commitWhenEdited, dirty, draft, max, min, onCommit, value])

  const reset = () => {
    const current = latest.current
    setEdit({ sourceValue: current.value, text: formatNumber(current.value, 5), dirty: false })
  }

  const commit = () => {
    const current = latest.current
    const parsed = Number(current.draft)
    if (
      !Number.isFinite(parsed) ||
      (current.min !== undefined && parsed < current.min) ||
      (current.max !== undefined && parsed > current.max)
    ) {
      reset()
      return
    }
    if (parsed !== current.value || (current.commitWhenEdited && current.dirty)) {
      current.onCommit(parsed)
    }
    setEdit({ sourceValue: parsed, text: formatNumber(parsed, 5), dirty: false })
  }

  return (
    <label className={styles.editablePropertyRow}>
      <Gauge size={14} />
      <span>{label}</span>
      <span className={styles.numberInputWrap}>
        <input
          type="number"
          value={draft}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) =>
            setEdit({ sourceValue: value, text: event.target.value, dirty: true })
          }
          onFocus={(event) =>
            registerPendingEditorEdit({
              input: event.currentTarget,
              commit,
              cancel: reset,
            })
          }
          onBlur={(event) => commitPendingEditorEditFromBlur(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitPendingEditorEdit()
            if (event.key === 'Escape') {
              cancelPendingEditorEdit(event.currentTarget)
            }
          }}
        />
        {unit ? <small>{unit}</small> : null}
      </span>
    </label>
  )
}

function ToggleProperty({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className={styles.togglePropertyRow}>
      <Gauge size={14} />
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}

function PropertySubheading({ children }: { children: ReactNode }) {
  return <h4 className={styles.propertySubheading}>{children}</h4>
}

type InspectorCategory = 'basic' | 'transform' | 'geometry' | 'physics' | 'initial' | 'advanced'

const categoryLabels: Record<InspectorCategory, string> = {
  basic: '基本',
  transform: '变换',
  geometry: '几何',
  physics: '物理',
  initial: '初始状态',
  advanced: '高级',
}

function entityCategories(entity: SceneEntity): InspectorCategory[] {
  const categories: InspectorCategory[] = ['basic']
  if (getEntityTransform(entity)) categories.push('transform')
  categories.push('geometry')
  if (entity.kind !== 'groundJoint') categories.push('physics')
  if (entity.kind === 'body') categories.push('initial', 'advanced')
  return categories
}

function InspectorTabs({
  categories,
  activeCategory,
  onChange,
}: {
  categories: InspectorCategory[]
  activeCategory: InspectorCategory
  onChange: (category: InspectorCategory) => void
}) {
  const id = useId()
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = categories.indexOf(activeCategory)
    const requestedIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? categories.length - 1
          : event.key === 'ArrowLeft'
            ? (currentIndex - 1 + categories.length) % categories.length
            : event.key === 'ArrowRight'
              ? (currentIndex + 1) % categories.length
              : -1
    if (requestedIndex < 0) return
    event.preventDefault()
    const nextCategory = categories[requestedIndex]
    if (!nextCategory) return
    onChange(nextCategory)
    requestAnimationFrame(() => {
      document.getElementById(`${id}-tab-${nextCategory}`)?.focus()
    })
  }

  return (
    <div className={styles.inspectorTabs} role="tablist" aria-label="属性分类">
      {categories.map((category) => (
        <button
          id={`${id}-tab-${category}`}
          key={category}
          type="button"
          role="tab"
          aria-selected={activeCategory === category}
          tabIndex={activeCategory === category ? 0 : -1}
          onClick={() => onChange(category)}
          onKeyDown={handleKeyDown}
        >
          {categoryLabels[category]}
        </button>
      ))}
    </div>
  )
}

const kindNames: Record<SceneEntity['kind'], string> = {
  ground: '地面',
  groundJoint: '地面连接点',
  body: '运动物体',
  field: '物理场',
  connector: '连接器',
  particleSource: '粒子源',
}

function formatNumber(value: number, digits = 2): string {
  const absolute = Math.abs(value)
  if (absolute > 0 && (absolute < 10 ** -digits || absolute >= 1e6)) {
    return value.toExponential(Math.min(3, digits))
  }
  return Number(value.toFixed(digits)).toString()
}

function groundJointStatus(
  resolvedPath: ResolvedGroundJointPath | undefined,
  fallbackIssue: ResolvedGroundJointPath['issue'],
): string {
  const issue = resolvedPath?.issue ?? fallbackIssue
  if (!issue) {
    return resolvedPath?.kind === 'direct'
      ? '几何有效；使用无形直接接缝'
      : resolvedPath?.kind === 'linear'
        ? '几何有效；使用直线退化连接'
        : '几何有效；小球可沿圆滑过渡'
  }
  if (issue === 'transition-invalid') return '已失效：无法生成无自交且曲率有效的过渡'
  if (issue === 'angle-too-small') return '已失效：两块地面的方向几乎重合'
  if (issue === 'linear-zero-length') return '已失效：反向端点重合，直线长度为零'
  if (issue === 'same-ground') return '已失效：不能连接同一块地面'
  if (issue === 'endpoint-conflict') return '已失效：端点被重复占用'
  if (issue === 'degenerate-tangent') return '已失效：端点切线无法确定'
  return '已失效：引用的地面不存在'
}

function EntityProperties({
  entity,
  disabled,
  category,
}: {
  entity: SceneEntity
  disabled: boolean
  category: InspectorCategory
}) {
  const transform = getEntityTransform(entity)
  const allEntities = useDocumentStore.getState().scene.entities
  const connectorHasFreeEndpoint =
    entity.kind === 'connector' && (entity.a.type === 'free' || entity.b.type === 'free')
  const replace = (next: SceneEntity, label: string) => {
    if (disabled) return
    if (next.kind === 'connector' && next.connector.type === 'rope') {
      const candidateEntities = allEntities.map((candidate) =>
        candidate.id === next.id ? next : candidate,
      )
      const minimumLength = minimumFixedRopeLength(next, (endpoint) =>
        resolveConnectorEndpoint(candidateEntities, endpoint),
      )
      if (minimumLength !== null && next.connector.maxLength < minimumLength - 1e-6) {
        useSimulationStore
          .getState()
          .addWarning(`两个固定端点至少需要 ${formatNumber(minimumLength, 5)} m 的绳长。`)
        return
      }
    }
    const document = useDocumentStore.getState()
    document.executeCommand(createReplaceEntitiesCommand(document.scene, [next], label))
  }
  const updateTransform = (positionX: number, positionY: number, angleRad: number) => {
    if (!transform) return
    replace(
      withEntityTransform(entity, { position: { x: positionX, y: positionY }, angleRad }),
      '修改变换属性',
    )
  }

  return (
    <>
      {category === 'basic' ? (
        <section className={styles.propertyGroup}>
          <h3>基本信息</h3>
          <PropertyRow icon={<Gauge size={14} />} label="名称" value={entity.name} />
          <PropertyRow icon={<BoxSelect size={14} />} label="类型" value={kindNames[entity.kind]} />
          {entity.kind === 'body' && entity.shape.type === 'circle' ? (
            <PropertyRow
              icon={<Gauge size={14} />}
              label="画布标记"
              value={`${entity.shape.collisionEnabled ? '红色·碰撞开' : '蓝色·碰撞关'} · ${entity.chargeC > 0 ? '+' : entity.chargeC < 0 ? '−' : '无电荷符号'}`}
            />
          ) : null}
        </section>
      ) : null}

      {category === 'transform' && transform ? (
        <section className={styles.propertyGroup}>
          <h3>变换</h3>
          <NumberProperty
            label="位置 X"
            value={transform.position.x}
            unit="m"
            disabled={disabled}
            onCommit={(value) => updateTransform(value, transform.position.y, transform.angleRad)}
          />
          <NumberProperty
            label="位置 Y"
            value={transform.position.y}
            unit="m"
            disabled={disabled}
            onCommit={(value) => updateTransform(transform.position.x, value, transform.angleRad)}
          />
          <NumberProperty
            label="角度"
            value={(transform.angleRad * 180) / Math.PI}
            unit="°"
            disabled={disabled}
            onCommit={(value) =>
              updateTransform(transform.position.x, transform.position.y, (value * Math.PI) / 180)
            }
          />
        </section>
      ) : null}

      {category !== 'basic' && category !== 'transform' ? (
        <section className={styles.propertyGroup}>
          <h3>{categoryLabels[category]}</h3>
          {entity.kind === 'groundJoint' && category === 'geometry'
            ? (() => {
                const resolved = resolveGroundJoint(allEntities, entity)
                const resolvedPath = buildGroundPathNetwork(allEntities).jointPaths.get(entity.id)
                const transition = entity.transition ?? {
                  mode: 'auto' as const,
                  directionFlipped: false,
                }
                const smoothSettingsDisabled = disabled || resolvedPath?.kind !== 'quintic'
                const endpointLabel = (groundId: string, endpoint: 'start' | 'end') => {
                  const ground = allEntities.find(
                    (candidate) => candidate.kind === 'ground' && candidate.id === groundId,
                  )
                  return `${ground?.name ?? '缺失地面'} · ${endpoint === 'start' ? '起点' : '终点'}`
                }
                const angleDeg = resolvedPath?.angleRad
                  ? (resolvedPath.angleRad * 180) / Math.PI
                  : Number.isFinite(resolved.tangentAlignment)
                    ? (Math.acos(Math.max(-1, Math.min(1, resolved.tangentAlignment))) * 180) /
                      Math.PI
                    : null
                return (
                  <>
                    <PropertySubheading>连接关系</PropertySubheading>
                    <PropertyRow
                      icon={<Gauge size={14} />}
                      label="端点 A"
                      value={endpointLabel(entity.a.groundId, entity.a.endpoint)}
                    />
                    <PropertyRow
                      icon={<Gauge size={14} />}
                      label="端点 B"
                      value={endpointLabel(entity.b.groundId, entity.b.endpoint)}
                    />
                    <PropertyRow
                      icon={<Gauge size={14} />}
                      label="状态"
                      value={groundJointStatus(resolvedPath, resolved.issue)}
                    />
                    <PropertyRow
                      icon={<Gauge size={14} />}
                      label="端点间距"
                      value={
                        Number.isFinite(resolved.gapM) ? `${formatNumber(resolved.gapM, 5)} m` : '—'
                      }
                    />
                    <PropertyRow
                      icon={<Gauge size={14} />}
                      label="切线夹角"
                      value={angleDeg === null ? '—' : `${formatNumber(angleDeg, 2)}°`}
                    />
                    <PropertySubheading>圆滑过渡</PropertySubheading>
                    <ToggleProperty
                      label="手动长度"
                      checked={transition.mode === 'manual'}
                      disabled={smoothSettingsDisabled}
                      onChange={(manual) =>
                        replace(
                          {
                            ...entity,
                            transition: manual
                              ? {
                                  mode: 'manual',
                                  lengthM: Math.max(
                                    resolvedPath?.trimA ?? 0,
                                    resolvedPath?.trimB ?? 0,
                                  ),
                                  directionFlipped: transition.directionFlipped,
                                }
                              : {
                                  mode: 'auto',
                                  directionFlipped: transition.directionFlipped,
                                },
                          },
                          manual ? '改为手动过渡长度' : '改为自动过渡长度',
                        )
                      }
                    />
                    {transition.mode === 'manual' ? (
                      <NumberProperty
                        label="过渡长度"
                        value={transition.lengthM}
                        unit="m"
                        min={0}
                        disabled={smoothSettingsDisabled}
                        onCommit={(lengthM) =>
                          replace(
                            { ...entity, transition: { ...transition, lengthM } },
                            '修改地面过渡长度',
                          )
                        }
                      />
                    ) : null}
                    <PropertyRow
                      icon={<Gauge size={14} />}
                      label="实际裁剪 A"
                      value={resolvedPath ? `${formatNumber(resolvedPath.trimA, 4)} m` : '—'}
                    />
                    <PropertyRow
                      icon={<Gauge size={14} />}
                      label="实际裁剪 B"
                      value={resolvedPath ? `${formatNumber(resolvedPath.trimB, 4)} m` : '—'}
                    />
                    <PropertyRow
                      icon={<Gauge size={14} />}
                      label="过渡类型"
                      value={
                        resolvedPath?.kind === 'invalid'
                          ? '无效过渡'
                          : resolvedPath?.kind === 'direct'
                            ? '无形直接接缝'
                            : resolvedPath?.kind === 'linear'
                              ? '端点间直线'
                              : resolvedPath?.kind === 'quintic'
                                ? '五次贝塞尔曲线'
                                : '无效过渡'
                      }
                    />
                  </>
                )
              })()
            : null}
          {entity.kind === 'body' && category === 'geometry' ? (
            <>
              <PropertySubheading>形状与尺寸</PropertySubheading>
              <PropertyRow
                icon={<Gauge size={14} />}
                label="形状"
                value={
                  entity.shape.type === 'circle'
                    ? '小球'
                    : entity.shape.type === 'box'
                      ? '矩形物块'
                      : '钢笔物块'
                }
              />
              {entity.shape.type === 'circle' ? (
                <NumberProperty
                  label="半径"
                  value={entity.shape.radius}
                  unit="m"
                  min={0.001}
                  disabled={disabled}
                  onCommit={(radius) => {
                    if (entity.kind !== 'body' || entity.shape.type !== 'circle') return
                    replace({ ...entity, shape: { ...entity.shape, radius } }, '修改小球半径')
                  }}
                />
              ) : entity.shape.type === 'box' ? (
                <>
                  <NumberProperty
                    label="宽度"
                    value={entity.shape.width}
                    unit="m"
                    min={0.001}
                    disabled={disabled}
                    onCommit={(width) => {
                      if (entity.kind !== 'body' || entity.shape.type !== 'box') return
                      replace({ ...entity, shape: { ...entity.shape, width } }, '修改物块宽度')
                    }}
                  />
                  <NumberProperty
                    label="高度"
                    value={entity.shape.height}
                    unit="m"
                    min={0.001}
                    disabled={disabled}
                    onCommit={(height) => {
                      if (entity.kind !== 'body' || entity.shape.type !== 'box') return
                      replace({ ...entity, shape: { ...entity.shape, height } }, '修改物块高度')
                    }}
                  />
                </>
              ) : (
                <PropertyRow
                  icon={<Gauge size={14} />}
                  label="锚点数"
                  value={String(entity.shape.nodes.length)}
                />
              )}
            </>
          ) : null}
          {entity.kind === 'body' && category === 'physics' ? (
            <>
              <PropertySubheading>质量与电荷</PropertySubheading>
              <NumberProperty
                label="质量"
                value={entity.massKg}
                unit="kg"
                min={0.000001}
                disabled={disabled}
                onCommit={(massKg) => replace({ ...entity, massKg }, '修改物体质量')}
              />
              <NumberProperty
                label="电荷量"
                value={entity.chargeC}
                unit="C"
                disabled={disabled}
                onCommit={(chargeC) => replace({ ...entity, chargeC }, '修改物体电荷量')}
              />
              {entity.shape.type === 'circle' ? (
                <ToggleProperty
                  label="参与碰撞"
                  checked={entity.shape.collisionEnabled}
                  disabled={disabled}
                  onChange={(collisionEnabled) => {
                    if (entity.kind !== 'body' || entity.shape.type !== 'circle') return
                    replace(
                      { ...entity, shape: { ...entity.shape, collisionEnabled } },
                      '修改小球碰撞状态',
                    )
                  }}
                />
              ) : null}
              <PropertySubheading>运动约束</PropertySubheading>
              <ToggleProperty
                label="开启旋转"
                checked={entity.rotationEnabled}
                disabled={disabled}
                onChange={(rotationEnabled) =>
                  replace({ ...entity, rotationEnabled }, '修改物体旋转约束')
                }
              />
              <PropertySubheading>接触材质</PropertySubheading>
              <NumberProperty
                label="摩擦系数"
                value={entity.material.friction}
                min={0}
                max={5}
                disabled={disabled}
                onCommit={(friction) =>
                  replace({ ...entity, material: { ...entity.material, friction } }, '修改摩擦系数')
                }
              />
              <NumberProperty
                label="弹性系数"
                value={entity.material.restitution}
                min={0}
                max={1}
                disabled={disabled}
                onCommit={(restitution) =>
                  replace(
                    { ...entity, material: { ...entity.material, restitution } },
                    '修改弹性系数',
                  )
                }
              />
            </>
          ) : null}
          {entity.kind === 'body' && category === 'initial' ? (
            <>
              <PropertySubheading>初始运动</PropertySubheading>
              <NumberProperty
                label="初速度 X"
                value={entity.initialVelocity.x}
                unit="m/s"
                disabled={disabled}
                onCommit={(x) =>
                  replace(
                    { ...entity, initialVelocity: { ...entity.initialVelocity, x } },
                    '修改初速度',
                  )
                }
              />
              <NumberProperty
                label="初速度 Y"
                value={entity.initialVelocity.y}
                unit="m/s"
                disabled={disabled}
                onCommit={(y) =>
                  replace(
                    { ...entity, initialVelocity: { ...entity.initialVelocity, y } },
                    '修改初速度',
                  )
                }
              />
              <NumberProperty
                label="初角速度"
                value={entity.initialAngularVelocityRad}
                unit="rad/s"
                disabled={disabled || !entity.rotationEnabled}
                onCommit={(initialAngularVelocityRad) =>
                  replace({ ...entity, initialAngularVelocityRad }, '修改初角速度')
                }
              />
              {!entity.rotationEnabled ? (
                <div className={styles.readonlyCallout}>
                  初角速度已保留；关闭旋转时，模拟会按 0 rad/s 处理。
                </div>
              ) : null}
            </>
          ) : null}
          {entity.kind === 'body' && category === 'advanced' ? (
            <>
              <PropertySubheading>碰撞精度</PropertySubheading>
              <ToggleProperty
                label="连续碰撞 CCD"
                checked={entity.continuousCollisionDetection}
                disabled={disabled}
                onChange={(continuousCollisionDetection) =>
                  replace({ ...entity, continuousCollisionDetection }, '修改连续碰撞检测')
                }
              />
            </>
          ) : null}

          {entity.kind === 'ground' && category === 'geometry' ? (
            <>
              <PropertySubheading>地面几何</PropertySubheading>
              <PropertyRow
                icon={<Gauge size={14} />}
                label="曲线"
                value={
                  entity.geometry.type === 'line'
                    ? '直线'
                    : entity.geometry.type === 'arc'
                      ? '圆弧'
                      : '贝塞尔曲线'
                }
              />
              {entity.geometry.type === 'arc' ? (
                <>
                  <NumberProperty
                    label="圆弧半径"
                    value={entity.geometry.radius}
                    unit="m"
                    min={0.001}
                    disabled={disabled}
                    onCommit={(radius) => {
                      if (entity.kind !== 'ground' || entity.geometry.type !== 'arc') return
                      replace(
                        { ...entity, geometry: { ...entity.geometry, radius } },
                        '修改圆弧半径',
                      )
                    }}
                  />
                  <NumberProperty
                    label="起始角"
                    value={(entity.geometry.startRad * 180) / Math.PI}
                    unit="°"
                    disabled={disabled}
                    onCommit={(degrees) => {
                      if (entity.kind !== 'ground' || entity.geometry.type !== 'arc') return
                      replace(
                        {
                          ...entity,
                          geometry: { ...entity.geometry, startRad: (degrees * Math.PI) / 180 },
                        },
                        '修改圆弧角度',
                      )
                    }}
                  />
                  <NumberProperty
                    label="结束角"
                    value={(entity.geometry.endRad * 180) / Math.PI}
                    unit="°"
                    disabled={disabled}
                    onCommit={(degrees) => {
                      if (entity.kind !== 'ground' || entity.geometry.type !== 'arc') return
                      replace(
                        {
                          ...entity,
                          geometry: { ...entity.geometry, endRad: (degrees * Math.PI) / 180 },
                        },
                        '修改圆弧角度',
                      )
                    }}
                  />
                </>
              ) : null}
              {entity.geometry.type === 'cubicBezier'
                ? (['p0', 'p1', 'p2', 'p3'] as const).flatMap((pointKey, pointIndex) => {
                    const point =
                      entity.geometry.type === 'cubicBezier' ? entity.geometry[pointKey] : null
                    if (!point) return []
                    return [
                      <NumberProperty
                        key={`${pointKey}-x`}
                        label={`控制点 ${pointIndex} X`}
                        value={point.x}
                        unit="m"
                        disabled={disabled}
                        onCommit={(x) => {
                          if (entity.kind !== 'ground' || entity.geometry.type !== 'cubicBezier')
                            return
                          replace(
                            {
                              ...entity,
                              geometry: {
                                ...entity.geometry,
                                [pointKey]: { ...entity.geometry[pointKey], x },
                              },
                            },
                            '修改贝塞尔控制点',
                          )
                        }}
                      />,
                      <NumberProperty
                        key={`${pointKey}-y`}
                        label={`控制点 ${pointIndex} Y`}
                        value={point.y}
                        unit="m"
                        disabled={disabled}
                        onCommit={(y) => {
                          if (entity.kind !== 'ground' || entity.geometry.type !== 'cubicBezier')
                            return
                          replace(
                            {
                              ...entity,
                              geometry: {
                                ...entity.geometry,
                                [pointKey]: { ...entity.geometry[pointKey], y },
                              },
                            },
                            '修改贝塞尔控制点',
                          )
                        }}
                      />,
                    ]
                  })
                : null}
            </>
          ) : null}
          {entity.kind === 'ground' && category === 'physics' ? (
            <>
              <PropertySubheading>接触材质</PropertySubheading>
              <NumberProperty
                label="摩擦系数"
                value={entity.material.friction}
                min={0}
                max={5}
                disabled={disabled}
                onCommit={(friction) =>
                  replace({ ...entity, material: { ...entity.material, friction } }, '修改地面摩擦')
                }
              />
              <NumberProperty
                label="弹性系数"
                value={entity.material.restitution}
                min={0}
                max={1}
                disabled={disabled}
                onCommit={(restitution) =>
                  replace(
                    { ...entity, material: { ...entity.material, restitution } },
                    '修改地面弹性',
                  )
                }
              />
            </>
          ) : null}

          {entity.kind === 'field' && category === 'geometry' ? (
            <>
              <PropertySubheading>作用范围</PropertySubheading>
              <PropertyRow
                icon={<Gauge size={14} />}
                label="作用范围"
                value={
                  entity.region.type === 'rectangle'
                    ? '矩形'
                    : entity.region.type === 'circle'
                      ? Math.abs(entity.region.sweepRad) >= Math.PI * 2 - 1e-7
                        ? '圆形'
                        : '扇形'
                      : entity.region.type === 'polygon'
                        ? '旧版多边形'
                        : entity.region.type === 'bezierPath'
                          ? '钢笔自由形状'
                          : '无限范围'
                }
              />
              {entity.region.type === 'circle' ? (
                <>
                  <NumberProperty
                    label="范围半径"
                    value={entity.region.radius}
                    unit="m"
                    min={0.001}
                    disabled={disabled}
                    onCommit={(radius) => {
                      if (entity.kind !== 'field' || entity.region.type !== 'circle') return
                      replace({ ...entity, region: { ...entity.region, radius } }, '修改场范围半径')
                    }}
                  />
                  <NumberProperty
                    label="起始方向"
                    value={(entity.region.startRad * 180) / Math.PI}
                    unit="°"
                    disabled={disabled}
                    onCommit={(degrees) => {
                      if (entity.kind !== 'field' || entity.region.type !== 'circle') return
                      replace(
                        {
                          ...entity,
                          region: { ...entity.region, startRad: (degrees * Math.PI) / 180 },
                        },
                        '修改扇形场起始方向',
                      )
                    }}
                  />
                  <NumberProperty
                    label="圆心角"
                    value={(entity.region.sweepRad * 180) / Math.PI}
                    unit="°"
                    min={-360}
                    max={360}
                    disabled={disabled}
                    onCommit={(degrees) => {
                      if (entity.kind !== 'field' || entity.region.type !== 'circle') return
                      replace(
                        {
                          ...entity,
                          region: { ...entity.region, sweepRad: (degrees * Math.PI) / 180 },
                        },
                        '修改扇形场圆心角',
                      )
                    }}
                  />
                </>
              ) : null}
            </>
          ) : null}
          {entity.kind === 'field' && category === 'physics' ? (
            <>
              <PropertySubheading>场强与方向</PropertySubheading>
              <PropertyRow
                icon={<Gauge size={14} />}
                label="场类型"
                value={
                  entity.field.type === 'uniformGravity'
                    ? '匀强重力场'
                    : entity.field.type === 'uniformElectric'
                      ? '匀强电场'
                      : '匀强磁场'
                }
              />
              {entity.field.type === 'uniformGravity' ? (
                <>
                  <NumberProperty
                    label="重力 X"
                    value={entity.field.acceleration.x}
                    unit="m/s²"
                    disabled={disabled}
                    onCommit={(x) => {
                      if (entity.kind !== 'field' || entity.field.type !== 'uniformGravity') return
                      replace(
                        {
                          ...entity,
                          field: {
                            ...entity.field,
                            acceleration: { ...entity.field.acceleration, x },
                          },
                        },
                        '修改重力场',
                      )
                    }}
                  />
                  <NumberProperty
                    label="重力 Y"
                    value={entity.field.acceleration.y}
                    unit="m/s²"
                    disabled={disabled}
                    onCommit={(y) => {
                      if (entity.kind !== 'field' || entity.field.type !== 'uniformGravity') return
                      replace(
                        {
                          ...entity,
                          field: {
                            ...entity.field,
                            acceleration: { ...entity.field.acceleration, y },
                          },
                        },
                        '修改重力场',
                      )
                    }}
                  />
                </>
              ) : null}
              {entity.field.type === 'uniformElectric' ? (
                <>
                  <NumberProperty
                    label="电场强度 X"
                    value={entity.field.strength.x}
                    unit="N/C"
                    disabled={disabled}
                    onCommit={(x) => {
                      if (entity.kind !== 'field' || entity.field.type !== 'uniformElectric') return
                      replace(
                        {
                          ...entity,
                          field: { ...entity.field, strength: { ...entity.field.strength, x } },
                        },
                        '修改电场',
                      )
                    }}
                  />
                  <NumberProperty
                    label="电场强度 Y"
                    value={entity.field.strength.y}
                    unit="N/C"
                    disabled={disabled}
                    onCommit={(y) => {
                      if (entity.kind !== 'field' || entity.field.type !== 'uniformElectric') return
                      replace(
                        {
                          ...entity,
                          field: { ...entity.field, strength: { ...entity.field.strength, y } },
                        },
                        '修改电场',
                      )
                    }}
                  />
                </>
              ) : null}
              {entity.field.type === 'uniformMagnetic' ? (
                <>
                  <PropertyRow
                    icon={<Gauge size={14} />}
                    label="磁场方向"
                    value={entity.field.bzTesla >= 0 ? '⊙ 出屏' : '⊗ 入屏'}
                  />
                  <NumberProperty
                    label="磁感应强度 Bz"
                    value={entity.field.bzTesla}
                    unit="T"
                    disabled={disabled}
                    onCommit={(bzTesla) => {
                      if (entity.kind !== 'field' || entity.field.type !== 'uniformMagnetic') return
                      replace({ ...entity, field: { ...entity.field, bzTesla } }, '修改磁场')
                    }}
                  />
                </>
              ) : null}
            </>
          ) : null}

          {entity.kind === 'particleSource' && category === 'geometry' ? (
            <>
              <PropertySubheading>发射形态</PropertySubheading>
              <label className={styles.editablePropertyRow}>
                <Gauge size={14} />
                <span>形态</span>
                <select
                  value={entity.shape.type}
                  disabled={disabled}
                  onChange={(event) => {
                    if (entity.kind !== 'particleSource') return
                    const next = event.target.value as 'point' | 'line'
                    if (next === entity.shape.type) return
                    if (next === 'point') {
                      const start =
                        entity.shape.type === 'line' ? entity.shape.start : { x: 0, y: 0 }
                      const end = entity.shape.type === 'line' ? entity.shape.end : { x: 0, y: 0 }
                      replace(
                        {
                          ...entity,
                          shape: {
                            type: 'point',
                            position: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
                          },
                        },
                        '修改粒子源形态',
                      )
                    } else {
                      const p =
                        entity.shape.type === 'point' ? entity.shape.position : { x: 0, y: 0 }
                      replace(
                        {
                          ...entity,
                          shape: {
                            type: 'line',
                            start: { x: p.x - 1, y: p.y },
                            end: { x: p.x + 1, y: p.y },
                          },
                        },
                        '修改粒子源形态',
                      )
                    }
                  }}
                >
                  <option value="point">点</option>
                  <option value="line">线</option>
                </select>
              </label>
            </>
          ) : null}

          {entity.kind === 'particleSource' && category === 'physics' ? (
            <>
              <PropertySubheading>发射参数</PropertySubheading>
              {entity.shape.type === 'point' ? (
                <NumberProperty
                  label="发射方向"
                  value={(entity.directionRad * 180) / Math.PI}
                  unit="°"
                  disabled={disabled}
                  onCommit={(deg) =>
                    replace({ ...entity, directionRad: (deg * Math.PI) / 180 }, '修改发射方向')
                  }
                />
              ) : (
                <ToggleProperty
                  label="翻转发射侧"
                  checked={entity.flipEmission}
                  disabled={disabled}
                  onChange={(flipEmission) => replace({ ...entity, flipEmission }, '修改发射侧')}
                />
              )}
              <NumberProperty
                label="发射速率"
                value={entity.speedMps}
                unit="m/s"
                min={0}
                disabled={disabled}
                onCommit={(speedMps) => replace({ ...entity, speedMps }, '修改发射速率')}
              />
              <PropertySubheading>离子属性</PropertySubheading>
              <NumberProperty
                label="离子电荷量"
                value={entity.chargeC}
                unit="C"
                disabled={disabled}
                onCommit={(chargeC) => replace({ ...entity, chargeC }, '修改离子电荷量')}
              />
              <NumberProperty
                label="离子质量"
                value={entity.massKg}
                unit="kg"
                min={1e-6}
                disabled={disabled}
                onCommit={(massKg) => replace({ ...entity, massKg }, '修改离子质量')}
              />
              <ToggleProperty
                label="受物体库仑力"
                checked={entity.coulombEnabled}
                disabled={disabled}
                onChange={(coulombEnabled) => replace({ ...entity, coulombEnabled }, '修改库仑力')}
              />
            </>
          ) : null}

          {entity.kind === 'connector' && category === 'physics' ? (
            <>
              {entity.connector.type !== 'spring' ? (
                <PropertySubheading>碰撞与质量</PropertySubheading>
              ) : connectorHasFreeEndpoint ? (
                <PropertySubheading>自由端接触</PropertySubheading>
              ) : null}
              {entity.connector.type !== 'spring' ? (
                <ToggleProperty
                  label="开启连接体碰撞"
                  checked={entity.collisionEnabled}
                  disabled={disabled}
                  onChange={(collisionEnabled) =>
                    replace(
                      setConnectorCollisionEnabled(entity, collisionEnabled),
                      '修改连接体碰撞',
                    )
                  }
                />
              ) : null}
              {entity.connector.type !== 'spring' || connectorHasFreeEndpoint ? (
                <NumberProperty
                  label={entity.connector.type === 'spring' ? '自由端接触半径' : '半径 / 半厚度'}
                  value={entity.radiusM}
                  unit="m"
                  min={0.001}
                  disabled={disabled}
                  onCommit={(radiusM) => replace({ ...entity, radiusM }, '修改连接体半径')}
                />
              ) : null}
              {entity.connector.type !== 'spring' ? (
                <NumberProperty
                  label="连接体质量"
                  value={entity.massKg}
                  unit="kg"
                  min={
                    entity.connector.type === 'rope' && entity.collisionEnabled
                      ? MIN_COLLIDING_ROPE_MASS_KG
                      : 0
                  }
                  disabled={
                    disabled || (entity.connector.type === 'rope' && !entity.collisionEnabled)
                  }
                  onCommit={(massKg) => replace({ ...entity, massKg }, '修改连接体质量')}
                />
              ) : null}
              {entity.connector.type !== 'spring' ? (
                <>
                  <NumberProperty
                    label="摩擦系数"
                    value={entity.material.friction}
                    min={0}
                    disabled={disabled}
                    onCommit={(friction) =>
                      replace(
                        { ...entity, material: { ...entity.material, friction } },
                        '修改连接体摩擦系数',
                      )
                    }
                  />
                  <NumberProperty
                    label="弹性系数"
                    value={entity.material.restitution}
                    min={0}
                    max={1}
                    disabled={disabled}
                    onCommit={(restitution) =>
                      replace(
                        { ...entity, material: { ...entity.material, restitution } },
                        '修改连接体弹性系数',
                      )
                    }
                  />
                </>
              ) : null}
              <PropertySubheading>连接参数</PropertySubheading>
              <PropertyRow
                icon={<Gauge size={14} />}
                label="连接类型"
                value={
                  entity.connector.type === 'rope'
                    ? '绳'
                    : entity.connector.type === 'rod'
                      ? '杆'
                      : '弹簧'
                }
              />
              {entity.connector.type === 'rope' ? (
                <>
                  <NumberProperty
                    label="最大长度"
                    value={entity.connector.maxLength}
                    unit="m"
                    min={Math.max(
                      0.001,
                      minimumFixedRopeLength(entity, (endpoint) =>
                        resolveConnectorEndpoint(allEntities, endpoint),
                      ) ?? 0,
                    )}
                    disabled={disabled}
                    onCommit={(maxLength) => {
                      if (entity.kind !== 'connector' || entity.connector.type !== 'rope') return
                      replace(
                        { ...entity, connector: { ...entity.connector, maxLength } },
                        '修改绳长',
                      )
                    }}
                  />
                  {minimumFixedRopeLength(entity, (endpoint) =>
                    resolveConnectorEndpoint(allEntities, endpoint),
                  ) !== null ? (
                    <PropertyRow
                      icon={<Gauge size={14} />}
                      label="固定端最小长度"
                      value={`${formatNumber(
                        minimumFixedRopeLength(entity, (endpoint) =>
                          resolveConnectorEndpoint(allEntities, endpoint),
                        )!,
                        5,
                      )} m`}
                    />
                  ) : null}
                </>
              ) : null}
              {entity.connector.type === 'rod' ? (
                <>
                  <NumberProperty
                    label="杆长"
                    value={entity.connector.length}
                    unit="m"
                    min={0.001}
                    disabled={disabled}
                    onCommit={(length) => {
                      if (entity.kind !== 'connector' || entity.connector.type !== 'rod') return
                      replace({ ...entity, connector: { ...entity.connector, length } }, '修改杆长')
                    }}
                  />
                  <ToggleProperty
                    label="A 端自由转动"
                    checked={entity.connector.endpointRotation.a === 'free'}
                    disabled={disabled}
                    onChange={(freeRotation) => {
                      if (entity.kind !== 'connector' || entity.connector.type !== 'rod') return
                      replace(
                        {
                          ...entity,
                          connector: {
                            ...entity.connector,
                            endpointRotation: {
                              ...entity.connector.endpointRotation,
                              a: freeRotation ? 'free' : 'fixed',
                            },
                          },
                        },
                        '修改杆 A 端转动',
                      )
                    }}
                  />
                  <ToggleProperty
                    label="B 端自由转动"
                    checked={entity.connector.endpointRotation.b === 'free'}
                    disabled={disabled}
                    onChange={(freeRotation) => {
                      if (entity.kind !== 'connector' || entity.connector.type !== 'rod') return
                      replace(
                        {
                          ...entity,
                          connector: {
                            ...entity.connector,
                            endpointRotation: {
                              ...entity.connector.endpointRotation,
                              b: freeRotation ? 'free' : 'fixed',
                            },
                          },
                        },
                        '修改杆 B 端转动',
                      )
                    }}
                  />
                </>
              ) : null}
              {entity.connector.type === 'spring' ? (
                <>
                  <NumberProperty
                    label="弹簧原长"
                    value={entity.connector.restLength}
                    unit="m"
                    min={0.001}
                    disabled={disabled}
                    onCommit={(restLength) => {
                      if (entity.kind !== 'connector' || entity.connector.type !== 'spring') return
                      replace(
                        { ...entity, connector: { ...entity.connector, restLength } },
                        '修改弹簧原长',
                      )
                    }}
                  />
                  <NumberProperty
                    label="劲度系数"
                    value={entity.connector.stiffness}
                    unit="N/m"
                    min={0}
                    disabled={disabled}
                    onCommit={(stiffness) => {
                      if (entity.kind !== 'connector' || entity.connector.type !== 'spring') return
                      replace(
                        { ...entity, connector: { ...entity.connector, stiffness } },
                        '修改弹簧刚度',
                      )
                    }}
                  />
                  <NumberProperty
                    label="阻尼系数"
                    value={entity.connector.damping}
                    unit="N·s/m"
                    min={0}
                    disabled={disabled}
                    onCommit={(damping) => {
                      if (entity.kind !== 'connector' || entity.connector.type !== 'spring') return
                      replace(
                        { ...entity, connector: { ...entity.connector, damping } },
                        '修改弹簧阻尼',
                      )
                    }}
                  />
                </>
              ) : null}
            </>
          ) : null}
          {entity.kind === 'connector' && category === 'geometry' ? (
            <>
              <PropertySubheading>连接锚点</PropertySubheading>
              {(['a', 'b'] as const).map((endpointKey) => {
                const endpoint = entity[endpointKey]
                const label = endpointKey.toUpperCase()
                const endpointType =
                  endpoint.type === 'body'
                    ? '物体'
                    : endpoint.type === 'ground'
                      ? '地面'
                      : endpoint.type === 'groundJoint'
                        ? '地面连接段'
                        : endpoint.type === 'free'
                          ? '自由端点'
                          : '世界固定点'
                const detachSpringEndpoint = () => {
                  if (entity.connector.type !== 'spring' || endpoint.type === 'free') return
                  const position = resolveConnectorEndpoint(allEntities, endpoint)
                  if (!position) return
                  replace(
                    {
                      ...entity,
                      [endpointKey]: {
                        type: 'free',
                        position,
                      },
                      massKg: 0,
                      collisionEnabled: false,
                    },
                    `解除弹簧 ${label} 端点`,
                  )
                }
                const commitBodyAnchor = (localAnchor: Vec2) => {
                  if (endpoint.type !== 'body') return
                  const body = allEntities.find(
                    (candidate): candidate is BodyEntity =>
                      candidate.kind === 'body' && candidate.id === endpoint.bodyId,
                  )
                  if (!body) return
                  let nextEndpoint: ConnectorEndpoint
                  if (
                    entity.connector.type === 'spring' &&
                    !bodyLocalAnchorIsInside(body, localAnchor)
                  ) {
                    const worldPosition = resolveConnectorEndpoint(allEntities, {
                      ...endpoint,
                      localAnchor,
                    })
                    if (!worldPosition) return
                    nextEndpoint = { type: 'free', position: worldPosition }
                  } else {
                    nextEndpoint = {
                      ...endpoint,
                      localAnchor: clampBodyLocalAnchor(body, localAnchor),
                    }
                  }
                  replace(
                    {
                      ...entity,
                      [endpointKey]: nextEndpoint,
                      collisionEnabled:
                        entity.connector.type === 'spring' ? false : entity.collisionEnabled,
                      massKg: entity.connector.type === 'spring' ? 0 : entity.massKg,
                    },
                    '修改连接锚点',
                  )
                }
                return (
                  <Fragment key={endpointKey}>
                    <PropertyRow
                      icon={<Gauge size={14} />}
                      label={`${label} 端类型`}
                      value={endpointType}
                    />
                    {entity.connector.type === 'spring' && endpoint.type !== 'free' ? (
                      <button
                        type="button"
                        className={styles.endpointActionButton}
                        disabled={disabled}
                        onClick={detachSpringEndpoint}
                        aria-label={`解除弹簧 ${label} 端点`}
                      >
                        <Unlink size={14} />
                        解除端点
                      </button>
                    ) : null}
                    {endpoint.type === 'body' ? (
                      <>
                        <NumberProperty
                          label={`${label} 局部 X`}
                          value={endpoint.localAnchor.x}
                          unit="m"
                          disabled={disabled}
                          onCommit={(x) => commitBodyAnchor({ ...endpoint.localAnchor, x })}
                        />
                        <NumberProperty
                          label={`${label} 局部 Y`}
                          value={endpoint.localAnchor.y}
                          unit="m"
                          disabled={disabled}
                          onCommit={(y) => commitBodyAnchor({ ...endpoint.localAnchor, y })}
                        />
                      </>
                    ) : endpoint.type === 'world' || endpoint.type === 'free' ? (
                      <>
                        <NumberProperty
                          label={`${label} ${endpoint.type === 'free' ? '初始' : '世界'} X`}
                          value={endpoint.position.x}
                          unit="m"
                          disabled={disabled}
                          onCommit={(x) => {
                            replace(
                              {
                                ...entity,
                                [endpointKey]: {
                                  ...endpoint,
                                  position: { ...endpoint.position, x },
                                },
                              },
                              '修改连接锚点',
                            )
                          }}
                        />
                        <NumberProperty
                          label={`${label} ${endpoint.type === 'free' ? '初始' : '世界'} Y`}
                          value={endpoint.position.y}
                          unit="m"
                          disabled={disabled}
                          onCommit={(y) => {
                            replace(
                              {
                                ...entity,
                                [endpointKey]: {
                                  ...endpoint,
                                  position: { ...endpoint.position, y },
                                },
                              },
                              '修改连接锚点',
                            )
                          }}
                        />
                        {endpoint.type === 'free' ? (
                          <button
                            type="button"
                            className={styles.endpointActionButton}
                            disabled={disabled}
                            onClick={() =>
                              replace(
                                {
                                  ...entity,
                                  [endpointKey]: { type: 'world', position: endpoint.position },
                                },
                                `固定弹簧 ${label} 端点`,
                              )
                            }
                            aria-label={`把弹簧 ${label} 端点固定到当前位置`}
                          >
                            <Pin size={14} />
                            固定到当前位置
                          </button>
                        ) : null}
                      </>
                    ) : (
                      <NumberProperty
                        label={`${label} 路径位置`}
                        value={endpoint.pathRatio * 100}
                        unit="%"
                        min={0}
                        max={100}
                        disabled={disabled}
                        onCommit={(value) =>
                          replace(
                            {
                              ...entity,
                              [endpointKey]: {
                                ...endpoint,
                                pathRatio: Math.min(1, Math.max(0, value / 100)),
                              },
                            },
                            '修改连接锚点',
                          )
                        }
                      />
                    )}
                  </Fragment>
                )
              })}
            </>
          ) : null}
        </section>
      ) : null}
      {disabled ? (
        <div className={styles.runtimeEditHint}>模拟已开始。重置到 0 秒后才能修改物理参数。</div>
      ) : null}
    </>
  )
}

function BooleanResultProperties({
  layer,
  result,
  disabled,
  category,
}: {
  layer: BooleanNode
  result: ResolvedBooleanResult
  disabled: boolean
  category: InspectorCategory
}) {
  const replaceLayer = (replacement: BooleanNode, label: string) => {
    if (disabled) return
    commitPendingEditorEdit()
    const document = useDocumentStore.getState()
    document.executeCommand(createReplaceBooleanNodeCommand(document.scene, replacement, label))
  }
  const replaceBodyTransform = (body: ResolvedBooleanBody, position: Vec2, angleRad: number) => {
    if (disabled) return
    const document = useDocumentStore.getState()
    const sourceIds = new Set(body.sourceEntityIds)
    const angleDelta = angleRad - body.angleRad
    const cosine = Math.cos(angleDelta)
    const sine = Math.sin(angleDelta)
    const replacements = document.scene.entities.flatMap((entity) => {
      if (!sourceIds.has(entity.id)) return []
      const transform = getEntityTransform(entity)
      if (!transform) return []
      const offsetX = transform.position.x - body.centerOfMass.x
      const offsetY = transform.position.y - body.centerOfMass.y
      return [
        withEntityTransform(entity, {
          position: {
            x: position.x + offsetX * cosine - offsetY * sine,
            y: position.y + offsetX * sine + offsetY * cosine,
          },
          angleRad: transform.angleRad + angleDelta,
        }),
      ]
    })
    if (replacements.length === 0) return
    commitPendingEditorEdit()
    const isRootResult = document.scene.rootItems.some(
      (item) => item.kind === 'boolean' && item.resultId === body.resultId,
    )
    document.executeCommand(
      createReplaceEntitiesCommand(
        document.scene,
        replacements,
        '修改布尔结果变换',
        isRootResult ? 'follow-result' : 'preserve-world',
      ),
    )
  }

  if (category === 'basic') {
    return (
      <section className={styles.propertyGroup}>
        <h3>{layer.name}</h3>
        <label className={styles.editablePropertyRow}>
          <Gauge size={14} />
          <span>布尔运算</span>
          <select
            value={layer.operation}
            disabled={disabled}
            onChange={(event) =>
              replaceLayer(
                { ...layer, operation: event.target.value as BooleanNode['operation'] },
                '修改布尔运算',
              )
            }
          >
            <option value="union">加法（并集）</option>
            <option value="difference">减法（上减下）</option>
          </select>
        </label>
        <PropertyRow
          icon={<BoxSelect size={14} />}
          label="输入"
          value={`${layer.operands.length} / 2`}
        />
        <PropertyRow
          icon={<Gauge size={14} />}
          label="状态"
          value={result.valid ? '有效' : '已停用'}
        />
        {!result.valid ? (
          <div className={styles.readonlyCallout}>{result.diagnostics.join('；')}</div>
        ) : null}
      </section>
    )
  }

  if (category === 'physics') {
    if (!result.valid) {
      return (
        <section className={styles.propertyGroup}>
          <h3>派生物理量</h3>
          <div className={styles.readonlyCallout}>
            修复两个输入后，质量、场作用和图表会自动恢复。
          </div>
        </section>
      )
    }
    if (result.kind === 'field') {
      return (
        <section className={styles.propertyGroup}>
          <h3>派生场</h3>
          <PropertyRow icon={<Gauge size={14} />} label="场类型" value={result.fieldType} />
          <PropertyRow
            icon={<Gauge size={14} />}
            label="有效面积"
            value={`${formatNumber(
              result.regions.reduce((sum, region) => sum + region.area, 0),
              6,
            )} m²`}
          />
          <PropertyRow
            icon={<Gauge size={14} />}
            label="属性区域"
            value={String(result.regions.length)}
          />
        </section>
      )
    }
    return (
      <section className={styles.propertyGroup}>
        <h3>结果物理量</h3>
        <NumberProperty
          label="总质量"
          value={result.massKg}
          unit="kg"
          min={1e-9}
          disabled={disabled}
          commitWhenEdited={layer.massDistribution.mode === 'source'}
          onCommit={(totalMassKg) =>
            replaceLayer(
              { ...layer, massDistribution: { mode: 'uniform', totalMassKg } },
              '修改布尔总质量',
            )
          }
        />
        <NumberProperty
          label="总电荷"
          value={result.chargeC}
          unit="C"
          disabled={disabled}
          commitWhenEdited={layer.chargeDistribution.mode === 'source'}
          onCommit={(totalChargeC) =>
            replaceLayer(
              { ...layer, chargeDistribution: { mode: 'uniform', totalChargeC } },
              '修改布尔总电荷',
            )
          }
        />
        <NumberProperty
          label="摩擦系数"
          value={result.materialRegions[0]?.material.friction ?? 0}
          min={0}
          max={5}
          disabled={disabled}
          commitWhenEdited={layer.frictionDistribution.mode === 'source'}
          onCommit={(friction) =>
            replaceLayer(
              { ...layer, frictionDistribution: { mode: 'uniform', value: friction } },
              '修改布尔结果摩擦系数',
            )
          }
        />
        <NumberProperty
          label="弹性系数"
          value={result.materialRegions[0]?.material.restitution ?? 0}
          min={0}
          max={1}
          disabled={disabled}
          commitWhenEdited={layer.restitutionDistribution.mode === 'source'}
          onCommit={(restitution) =>
            replaceLayer(
              { ...layer, restitutionDistribution: { mode: 'uniform', value: restitution } },
              '修改布尔结果弹性系数',
            )
          }
        />
        <div className={styles.readonlyCallout}>
          修改质量、电荷、摩擦或弹性后，仅对应项目改为按整个布尔结果统一处理。
        </div>
        <PropertyRow
          icon={<Gauge size={14} />}
          label="质量中心"
          value={`(${formatNumber(result.centerOfMass.x, 6)}, ${formatNumber(result.centerOfMass.y, 6)}) m`}
        />
        <PropertyRow
          icon={<Gauge size={14} />}
          label="转动惯量"
          value={`${formatNumber(result.inertiaKgM2, 7)} kg·m²`}
        />
        <PropertyRow
          icon={<Gauge size={14} />}
          label="质量分布"
          value={
            layer.massDistribution.mode === 'source'
              ? `来源分布（${result.massRegions.length} 区）`
              : '整体均匀'
          }
        />
        <PropertyRow
          icon={<Gauge size={14} />}
          label="电荷分布"
          value={
            layer.chargeDistribution.mode === 'source'
              ? `来源分布（${result.chargeRegions.length} 区）`
              : '整体均匀'
          }
        />
        <PropertyRow
          icon={<Gauge size={14} />}
          label="摩擦分布"
          value={layer.frictionDistribution.mode === 'source' ? '来源分区' : '整体统一'}
        />
        <PropertyRow
          icon={<Gauge size={14} />}
          label="弹性分布"
          value={layer.restitutionDistribution.mode === 'source' ? '来源分区' : '整体统一'}
        />
      </section>
    )
  }

  if (category === 'transform' && result.valid && result.kind === 'body') {
    return (
      <section className={styles.propertyGroup}>
        <h3>变换</h3>
        <NumberProperty
          label="位置 X"
          value={result.centerOfMass.x}
          unit="m"
          disabled={disabled}
          onCommit={(x) =>
            replaceBodyTransform(result, { x, y: result.centerOfMass.y }, result.angleRad)
          }
        />
        <NumberProperty
          label="位置 Y"
          value={result.centerOfMass.y}
          unit="m"
          disabled={disabled}
          onCommit={(y) =>
            replaceBodyTransform(result, { x: result.centerOfMass.x, y }, result.angleRad)
          }
        />
        <NumberProperty
          label="角度"
          value={(result.angleRad * 180) / Math.PI}
          unit="°"
          disabled={disabled}
          onCommit={(angleDeg) =>
            replaceBodyTransform(result, result.centerOfMass, (angleDeg * Math.PI) / 180)
          }
        />
        <div className={styles.readonlyCallout}>
          修改位置或角度会整体变换全部来源，并保持布尔组合内部的相对位置。
        </div>
      </section>
    )
  }

  if (category === 'initial' && result.valid && result.kind === 'body') {
    return (
      <section className={styles.propertyGroup}>
        <h3>初始状态</h3>
        <NumberProperty
          label="初速度 X"
          value={result.initialVelocity.x}
          unit="m/s"
          disabled={disabled}
          commitWhenEdited={layer.initialVelocity.mode === 'source'}
          onCommit={(x) =>
            replaceLayer(
              {
                ...layer,
                initialVelocity: {
                  mode: 'override',
                  value: { x, y: result.initialVelocity.y },
                },
              },
              '修改布尔结果初速度',
            )
          }
        />
        <NumberProperty
          label="初速度 Y"
          value={result.initialVelocity.y}
          unit="m/s"
          disabled={disabled}
          commitWhenEdited={layer.initialVelocity.mode === 'source'}
          onCommit={(y) =>
            replaceLayer(
              {
                ...layer,
                initialVelocity: {
                  mode: 'override',
                  value: { x: result.initialVelocity.x, y },
                },
              },
              '修改布尔结果初速度',
            )
          }
        />
        <NumberProperty
          label="初角速度"
          value={result.initialAngularVelocityRad}
          unit="rad/s"
          disabled={disabled}
          commitWhenEdited={layer.initialAngularVelocity.mode === 'source'}
          onCommit={(valueRadPerSecond) =>
            replaceLayer(
              {
                ...layer,
                initialAngularVelocity: { mode: 'override', valueRadPerSecond },
              },
              '修改布尔结果初角速度',
            )
          }
        />
        <div className={styles.readonlyCallout}>
          初次修改线速度或角速度后，对应项目改为布尔结果的整体初始状态。
        </div>
        <PropertyRow
          icon={<Gauge size={14} />}
          label="线速度来源"
          value={layer.initialVelocity.mode === 'source' ? '递归上方输入' : '结果整体'}
        />
        <PropertyRow
          icon={<Gauge size={14} />}
          label="角速度来源"
          value={layer.initialAngularVelocity.mode === 'source' ? '递归上方输入' : '结果整体'}
        />
      </section>
    )
  }

  return (
    <section className={styles.propertyGroup}>
      <h3>结果级开关</h3>
      <ToggleProperty
        label="参与模拟"
        checked={layer.simulationEnabled}
        disabled={disabled}
        onChange={(simulationEnabled) =>
          replaceLayer({ ...layer, simulationEnabled }, '修改布尔结果模拟开关')
        }
      />
      <ToggleProperty
        label="允许旋转"
        checked={layer.rotationEnabled}
        disabled={disabled || (result.valid && result.kind === 'field')}
        onChange={(rotationEnabled) =>
          replaceLayer({ ...layer, rotationEnabled }, '修改布尔结果旋转约束')
        }
      />
      <ToggleProperty
        label="连续碰撞检测"
        checked={layer.continuousCollisionDetection}
        disabled={disabled || (result.valid && result.kind === 'field')}
        onChange={(continuousCollisionDetection) =>
          replaceLayer({ ...layer, continuousCollisionDetection }, '修改布尔结果连续碰撞检测')
        }
      />
    </section>
  )
}

export function InspectorPanel({ embedded = false }: { embedded?: boolean }) {
  const scene = useDocumentStore((state) => state.scene)
  const selectedIds = useEditorStore((state) => state.selectedIds)
  const selectionKey = selectedIds.join('\u0000')
  const previousSelectionKey = useRef(selectionKey)
  const previewEntities = useEditorStore((state) => state.previewEntities)
  const runtimeBodies = useSimulationStore((state) => state.runtimeBodies)
  const runtimeLocked = useSimulationStore(isSimulationRuntimeLocked)
  const selectedEntities = scene.entities
    .filter((entity) => selectedIds.includes(entity.id))
    .map((entity) => resolveRenderedEntity(entity, runtimeBodies, previewEntities))
  const selectedEntity = selectedEntities.length === 1 ? selectedEntities[0] : null
  const selectedBooleanResult =
    selectedIds.length === 1
      ? resolveBooleanScene(scene).byResultId.get(selectedIds[0]!)
      : undefined
  const selectedBooleanLayer = selectedBooleanResult
    ? (findBooleanNode(scene.rootItems, selectedBooleanResult.resultId) ?? undefined)
    : undefined
  const [activeCategory, setActiveCategory] = useState<InspectorCategory>('basic')
  const categories: InspectorCategory[] = selectedBooleanResult
    ? selectedBooleanResult.valid && selectedBooleanResult.kind === 'body'
      ? ['basic', 'transform', 'physics', 'initial', 'advanced']
      : ['basic', 'physics', 'advanced']
    : selectedEntity
      ? entityCategories(selectedEntity)
      : selectedEntities.length === 0
        ? ['basic', 'physics']
        : ['basic']
  const resolvedCategory = categories.includes(activeCategory) ? activeCategory : 'basic'

  useEffect(() => {
    if (previousSelectionKey.current === selectionKey) return
    previousSelectionKey.current = selectionKey
    commitPendingEditorEdit()
  }, [selectionKey])

  return (
    <section
      className={styles.panel}
      data-embedded={embedded}
      aria-label={embedded ? '属性内容' : undefined}
      aria-labelledby={embedded ? undefined : 'inspector-heading'}
    >
      {embedded ? null : (
        <header className={styles.panelHeader}>
          <div>
            <span className={styles.eyebrow}>INSPECTOR</span>
            <h2 id="inspector-heading">属性</h2>
          </div>
          <BoxSelect size={17} />
        </header>
      )}

      <div className={styles.inspectorBody}>
        <div className={styles.selectionEmpty}>
          <span>
            {selectedBooleanLayer
              ? selectedBooleanLayer.name
              : selectedEntity
                ? selectedEntity.name
                : selectedEntities.length > 1
                  ? `已选择 ${selectedEntities.length} 个实体`
                  : '当前未选择物体'}
          </span>
          <small>
            {selectedBooleanResult || selectedEntities.length > 0
              ? '数值在失去焦点或按 Enter 后生效'
              : '下面显示场景级属性'}
          </small>
        </div>
        <InspectorTabs
          categories={categories}
          activeCategory={resolvedCategory}
          onChange={setActiveCategory}
        />

        <div
          className={styles.inspectorTabPanel}
          role="tabpanel"
          aria-label={`${categoryLabels[resolvedCategory]}属性`}
        >
          {selectedBooleanResult && selectedBooleanLayer ? (
            <BooleanResultProperties
              key={selectedBooleanResult.resultId}
              layer={selectedBooleanLayer}
              result={selectedBooleanResult}
              disabled={
                runtimeLocked ||
                isTreeItemEffectivelyLocked(scene.rootItems, selectedBooleanLayer.id)
              }
              category={resolvedCategory}
            />
          ) : selectedEntity ? (
            <EntityProperties
              key={selectedEntity.id}
              entity={selectedEntity}
              disabled={
                runtimeLocked ||
                selectedEntity.locked ||
                isTreeItemEffectivelyLocked(scene.rootItems, selectedEntity.id)
              }
              category={resolvedCategory}
            />
          ) : selectedEntities.length > 1 ? (
            <section className={styles.propertyGroup}>
              <h3>多选</h3>
              <div className={styles.readonlyCallout}>
                多选共同属性编辑尚未开放，请选择一个对象。
              </div>
            </section>
          ) : resolvedCategory === 'basic' ? (
            <section className={styles.propertyGroup}>
              <h3>场景</h3>
              <PropertyRow icon={<Gauge size={14} />} label="名称" value={scene.metadata.name} />
              <PropertyRow
                icon={<Timer size={14} />}
                label="固定步长"
                value={`1 / ${Math.round(1 / scene.settings.fixedTimeStep)} s`}
              />
              <PropertyRow
                icon={<Grid2X2 size={14} />}
                label="主网格"
                value={`${scene.settings.gridStep} m`}
              />
            </section>
          ) : (
            <section className={styles.propertyGroup}>
              <h3>物理世界</h3>
              <ToggleProperty
                label="物体间静电作用"
                checked={scene.settings.pairwiseElectrostatics}
                disabled={runtimeLocked}
                onChange={(pairwiseElectrostatics) => {
                  const document = useDocumentStore.getState()
                  document.executeCommand(
                    createReplaceSceneSettingsCommand(
                      document.scene,
                      { ...document.scene.settings, pairwiseElectrostatics },
                      '修改物体间静电作用',
                    ),
                  )
                }}
              />
              <div className={styles.readonlyCallout}>
                内部统一使用米、千克、秒和弧度。阶段 3 采用固定 1/120
                秒计算步长；播放倍速只改变每秒执行的步数，不会放大单步误差。
              </div>
            </section>
          )}
        </div>
      </div>
    </section>
  )
}
