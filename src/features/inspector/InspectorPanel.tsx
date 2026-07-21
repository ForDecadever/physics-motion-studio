import { BoxSelect, Gauge, Grid2X2, Timer } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { createReplaceEntitiesCommand } from '../../editor/commands/entityCommands'
import { getEntityTransform, withEntityTransform } from '../../editor/geometry/entityGeometry'
import type { SceneEntity } from '../../scene/model/types'
import { resolveRenderedEntity } from '../../renderer/pixi/renderEntityState'
import { useDocumentStore } from '../../stores/documentStore'
import { isSimulationRuntimeLocked, useSimulationStore } from '../../stores/simulationStore'
import { useEditorStore } from '../../stores/editorStore'
import styles from '../panels/Panels.module.css'

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
  onCommit,
}: {
  label: string
  value: number
  unit?: string
  min?: number
  max?: number
  step?: number | 'any'
  disabled: boolean
  onCommit: (value: number) => void
}) {
  const [edit, setEdit] = useState({ sourceValue: value, text: formatNumber(value, 5) })
  const draft = Object.is(edit.sourceValue, value) ? edit.text : formatNumber(value, 5)

  const commit = () => {
    const parsed = Number(draft)
    if (
      !Number.isFinite(parsed) ||
      (min !== undefined && parsed < min) ||
      (max !== undefined && parsed > max)
    ) {
      setEdit({ sourceValue: value, text: formatNumber(value, 5) })
      return
    }
    if (parsed !== value) onCommit(parsed)
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
          onChange={(event) => setEdit({ sourceValue: value, text: event.target.value })}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              setEdit({ sourceValue: value, text: formatNumber(value, 5) })
              event.currentTarget.blur()
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

const kindNames: Record<SceneEntity['kind'], string> = {
  ground: '地面',
  body: '运动物体',
  field: '物理场',
  connector: '连接器',
}

function formatNumber(value: number, digits = 2): string {
  return Number(value.toFixed(digits)).toString()
}

function EntityProperties({ entity, disabled }: { entity: SceneEntity; disabled: boolean }) {
  const transform = getEntityTransform(entity)
  const replace = (next: SceneEntity, label: string) => {
    if (disabled) return
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
      <section className={styles.propertyGroup}>
        <h3>基本信息</h3>
        <PropertyRow icon={<Gauge size={14} />} label="名称" value={entity.name} />
        <PropertyRow icon={<BoxSelect size={14} />} label="类型" value={kindNames[entity.kind]} />
      </section>

      {transform ? (
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

      <section className={styles.propertyGroup}>
        <h3>几何与物理</h3>
        {entity.kind === 'body' ? (
          <>
            <PropertyRow
              icon={<Gauge size={14} />}
              label="形状"
              value={
                entity.shape.type === 'circle'
                  ? '圆形'
                  : entity.shape.type === 'box'
                    ? '矩形'
                    : '质点'
              }
            />
            <NumberProperty
              label="质量"
              value={entity.massKg}
              unit="kg"
              min={0.000001}
              disabled={disabled}
              onCommit={(massKg) => replace({ ...entity, massKg }, '修改物体质量')}
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
            ) : null}
            {entity.shape.type === 'box' ? (
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
            ) : null}
            {entity.shape.type === 'particle' ? (
              <ToggleProperty
                label="质点碰撞"
                checked={entity.shape.collisionEnabled}
                disabled={disabled}
                onChange={(collisionEnabled) => {
                  if (entity.kind !== 'body' || entity.shape.type !== 'particle') return
                  replace(
                    { ...entity, shape: { ...entity.shape, collisionEnabled } },
                    '修改质点碰撞',
                  )
                }}
              />
            ) : null}
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
              disabled={disabled}
              onCommit={(initialAngularVelocityRad) =>
                replace({ ...entity, initialAngularVelocityRad }, '修改初角速度')
              }
            />
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

        {entity.kind === 'ground' ? (
          <>
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
                    replace({ ...entity, geometry: { ...entity.geometry, radius } }, '修改圆弧半径')
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

        {entity.kind === 'field' ? (
          <>
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
          </>
        ) : null}

        {entity.kind === 'connector' ? (
          <PropertyRow
            icon={<Gauge size={14} />}
            label="连接类型"
            value={
              entity.connector.type === 'rope'
                ? `绳 · ${formatNumber(entity.connector.maxLength)} m`
                : entity.connector.type === 'rod'
                  ? '杆'
                  : '弹簧'
            }
          />
        ) : null}
      </section>
      {disabled ? (
        <div className={styles.runtimeEditHint}>模拟已开始。重置到 0 秒后才能修改物理参数。</div>
      ) : null}
    </>
  )
}

export function InspectorPanel() {
  const scene = useDocumentStore((state) => state.scene)
  const selectedIds = useEditorStore((state) => state.selectedIds)
  const previewEntities = useEditorStore((state) => state.previewEntities)
  const runtimeBodies = useSimulationStore((state) => state.runtimeBodies)
  const runtimeLocked = useSimulationStore(isSimulationRuntimeLocked)
  const selectedEntities = scene.entities
    .filter((entity) => selectedIds.includes(entity.id))
    .map((entity) => resolveRenderedEntity(entity, runtimeBodies, previewEntities))
  const selectedEntity = selectedEntities.length === 1 ? selectedEntities[0] : null

  return (
    <section className={styles.panel} aria-labelledby="inspector-heading">
      <header className={styles.panelHeader}>
        <div>
          <span className={styles.eyebrow}>INSPECTOR</span>
          <h2 id="inspector-heading">属性</h2>
        </div>
        <BoxSelect size={17} />
      </header>

      <div className={styles.inspectorBody}>
        <div className={styles.selectionEmpty}>
          <span>
            {selectedEntity
              ? selectedEntity.name
              : selectedEntities.length > 1
                ? `已选择 ${selectedEntities.length} 个实体`
                : '当前未选择物体'}
          </span>
          <small>
            {selectedEntities.length > 0 ? '数值在失去焦点或按 Enter 后生效' : '下面显示场景级属性'}
          </small>
        </div>

        {selectedEntity ? (
          <EntityProperties entity={selectedEntity} disabled={runtimeLocked} />
        ) : (
          <>
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
            <section className={styles.propertyGroup}>
              <h3>物理世界</h3>
              <div className={styles.readonlyCallout}>
                内部统一使用米、千克、秒和弧度。阶段 2 采用固定 1/120
                秒计算步长；播放倍速只改变每秒执行的步数，不会放大单步误差。
              </div>
            </section>
          </>
        )}
      </div>
    </section>
  )
}
