import { useState, type ReactNode } from 'react'

import styles from '../../app/App.module.css'
import type { AppPreferences } from '../../app/preferences'

interface SettingsDialogProps {
  preferences: AppPreferences
  onApply: (preferences: AppPreferences) => void
  onClose: () => void
}

function NumberSetting({
  label,
  value,
  unit,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  unit?: string
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <label className={styles.settingsField}>
      <span>{label}</span>
      <span>
        <input
          aria-label={label}
          type="number"
          value={Number.isNaN(value) ? '' : value}
          min={min}
          max={max}
          onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
        />
        {unit ? <small>{unit}</small> : null}
      </span>
    </label>
  )
}

function ToggleSetting({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className={styles.settingsToggle}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className={styles.settingsGroup}>
      <legend>{title}</legend>
      {children}
    </fieldset>
  )
}

function validate(preferences: AppPreferences): string | null {
  const values = preferences.creation
  const checks: Array<[number, number, number, string]> = [
    [values.body.massKg, 1e-9, 1e12, '新建物体质量'],
    [values.body.friction, 0, 5, '新建物体摩擦系数'],
    [values.body.restitution, 0, 1, '新建物体弹性系数'],
    [values.ground.friction, 0, 5, '新建地面摩擦系数'],
    [values.ground.restitution, 0, 1, '新建地面弹性系数'],
    [values.ground.conveyorSpeedMps, 0, 1e6, '传送带速度'],
    [values.field.gravityMps2, 0, 1e9, '重力场强'],
    [values.field.electricNPerC, -1e15, 1e15, '电场强度'],
    [values.field.magneticTesla, -1e12, 1e12, '磁感应强度'],
    [values.particleSource.speedMps, 0, 1e9, '粒子发射速度'],
    [values.particleSource.chargeC, -1e12, 1e12, '粒子电荷量'],
    [values.particleSource.massKg, 1e-12, 1e12, '粒子质量'],
    [values.force.magnitudeN, -1e15, 1e15, '外加力大小'],
    [values.force.directionRad, -1e9, 1e9, '外加力方向'],
    [values.recording.sampleRate, 1, 120, '记录频率'],
    [values.recording.durationSeconds, 1, 3600, '记录时长'],
  ]
  for (const [value, minimum, maximum, label] of checks) {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      return `${label}必须是 ${minimum} 到 ${maximum} 之间的有限数值。`
    }
  }
  if (!Number.isInteger(values.recording.sampleRate)) return '记录频率必须是整数。'
  if (!Number.isInteger(values.recording.durationSeconds)) return '记录时长必须是整数秒。'
  return null
}

export function SettingsDialog({ preferences, onApply, onClose }: SettingsDialogProps) {
  const [draft, setDraft] = useState(() => structuredClone(preferences))
  const [error, setError] = useState<string | null>(null)
  const update = (mutate: (next: AppPreferences) => void) => {
    setDraft((current) => {
      const next = structuredClone(current)
      mutate(next)
      return next
    })
  }
  const apply = () => {
    const issue = validate(draft)
    if (issue) {
      setError(issue)
      return
    }
    onApply(draft)
  }

  return (
    <div className={styles.modalBackdrop}>
      <section
        className={`${styles.modal} ${styles.settingsModal}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className={styles.settingsHeader}>
          <div>
            <h2 id="settings-title">设置与新建默认值</h2>
            <p>这些偏好保存在本机；不会写入当前场景或撤销栈。</p>
          </div>
        </header>
        <div className={styles.settingsGrid}>
          <SettingsGroup title="外观与编辑">
            <ToggleSetting
              label="显示网格"
              checked={draft.editor.gridVisible}
              onChange={(checked) => update((next) => void (next.editor.gridVisible = checked))}
            />
            <ToggleSetting
              label="网格吸附"
              checked={draft.editor.snapEnabled}
              onChange={(checked) => update((next) => void (next.editor.snapEnabled = checked))}
            />
            <ToggleSetting
              label="墙面吸附"
              checked={draft.editor.wallSnapEnabled}
              onChange={(checked) => update((next) => void (next.editor.wallSnapEnabled = checked))}
            />
            <ToggleSetting
              label="物块吸附"
              checked={draft.editor.blockSnapEnabled}
              onChange={(checked) =>
                update((next) => void (next.editor.blockSnapEnabled = checked))
              }
            />
          </SettingsGroup>

          <SettingsGroup title="新建物体">
            <NumberSetting
              label="默认质量"
              value={draft.creation.body.massKg}
              unit="kg"
              min={1e-9}
              max={1e12}
              onChange={(value) => update((next) => void (next.creation.body.massKg = value))}
            />
            <label className={styles.settingsField}>
              <span>小球颜色</span>
              <input
                aria-label="默认小球颜色"
                type="color"
                value={draft.creation.body.ballColor}
                onChange={(event) =>
                  update((next) => void (next.creation.body.ballColor = event.target.value))
                }
              />
            </label>
            <label className={styles.settingsField}>
              <span>物块颜色</span>
              <input
                aria-label="默认物块颜色"
                type="color"
                value={draft.creation.body.blockColor}
                onChange={(event) =>
                  update((next) => void (next.creation.body.blockColor = event.target.value))
                }
              />
            </label>
            <ToggleSetting
              label="小球参与碰撞"
              checked={draft.creation.body.ballCollisionEnabled}
              onChange={(checked) =>
                update((next) => void (next.creation.body.ballCollisionEnabled = checked))
              }
            />
            <NumberSetting
              label="物体摩擦系数"
              value={draft.creation.body.friction}
              min={0}
              max={5}
              onChange={(value) => update((next) => void (next.creation.body.friction = value))}
            />
            <NumberSetting
              label="物体弹性系数"
              value={draft.creation.body.restitution}
              min={0}
              max={1}
              onChange={(value) => update((next) => void (next.creation.body.restitution = value))}
            />
          </SettingsGroup>

          <SettingsGroup title="新建地面">
            <NumberSetting
              label="地面摩擦系数"
              value={draft.creation.ground.friction}
              min={0}
              max={5}
              onChange={(value) => update((next) => void (next.creation.ground.friction = value))}
            />
            <NumberSetting
              label="地面弹性系数"
              value={draft.creation.ground.restitution}
              min={0}
              max={1}
              onChange={(value) =>
                update((next) => void (next.creation.ground.restitution = value))
              }
            />
            <ToggleSetting
              label="默认开启传送带"
              checked={draft.creation.ground.conveyorEnabled}
              onChange={(checked) =>
                update((next) => void (next.creation.ground.conveyorEnabled = checked))
              }
            />
            <label className={styles.settingsField}>
              <span>传送带方向</span>
              <select
                aria-label="默认传送带方向"
                value={draft.creation.ground.conveyorDirection}
                onChange={(event) =>
                  update(
                    (next) =>
                      void (next.creation.ground.conveyorDirection = event.target.value as
                        'forward' | 'reverse'),
                  )
                }
              >
                <option value="forward">沿地面正向</option>
                <option value="reverse">沿地面反向</option>
              </select>
            </label>
            <NumberSetting
              label="默认传送带速度"
              value={draft.creation.ground.conveyorSpeedMps}
              unit="m/s"
              min={0}
              max={1e6}
              onChange={(value) =>
                update((next) => void (next.creation.ground.conveyorSpeedMps = value))
              }
            />
          </SettingsGroup>

          <SettingsGroup title="新建场、粒子源与力">
            <NumberSetting
              label="默认重力场强"
              value={draft.creation.field.gravityMps2}
              unit="m/s²"
              min={0}
              max={1e9}
              onChange={(value) => update((next) => void (next.creation.field.gravityMps2 = value))}
            />
            <NumberSetting
              label="默认电场强度"
              value={draft.creation.field.electricNPerC}
              unit="N/C"
              min={-1e15}
              max={1e15}
              onChange={(value) =>
                update((next) => void (next.creation.field.electricNPerC = value))
              }
            />
            <NumberSetting
              label="默认磁感应强度"
              value={draft.creation.field.magneticTesla}
              unit="T"
              min={-1e12}
              max={1e12}
              onChange={(value) =>
                update((next) => void (next.creation.field.magneticTesla = value))
              }
            />
            <NumberSetting
              label="默认粒子速度"
              value={draft.creation.particleSource.speedMps}
              unit="m/s"
              min={0}
              max={1e9}
              onChange={(value) =>
                update((next) => void (next.creation.particleSource.speedMps = value))
              }
            />
            <NumberSetting
              label="默认粒子电荷"
              value={draft.creation.particleSource.chargeC}
              unit="C"
              min={-1e12}
              max={1e12}
              onChange={(value) =>
                update((next) => void (next.creation.particleSource.chargeC = value))
              }
            />
            <NumberSetting
              label="默认粒子质量"
              value={draft.creation.particleSource.massKg}
              unit="kg"
              min={1e-12}
              max={1e12}
              onChange={(value) =>
                update((next) => void (next.creation.particleSource.massKg = value))
              }
            />
            <NumberSetting
              label="默认外加力大小"
              value={draft.creation.force.magnitudeN}
              unit="N"
              min={-1e15}
              max={1e15}
              onChange={(value) => update((next) => void (next.creation.force.magnitudeN = value))}
            />
            <NumberSetting
              label="默认外加力方向"
              value={(draft.creation.force.directionRad * 180) / Math.PI}
              unit="°"
              min={-1e9}
              max={1e9}
              onChange={(value) =>
                update((next) => void (next.creation.force.directionRad = (value * Math.PI) / 180))
              }
            />
          </SettingsGroup>

          <SettingsGroup title="新场景记录">
            <NumberSetting
              label="默认记录频率"
              value={draft.creation.recording.sampleRate}
              unit="Hz"
              min={1}
              max={120}
              onChange={(value) =>
                update((next) => void (next.creation.recording.sampleRate = value))
              }
            />
            <NumberSetting
              label="默认记录时长"
              value={draft.creation.recording.durationSeconds}
              unit="s"
              min={1}
              max={3600}
              onChange={(value) =>
                update((next) => void (next.creation.recording.durationSeconds = value))
              }
            />
          </SettingsGroup>
        </div>
        {error ? <p className={styles.modalError}>{error}</p> : null}
        <div className={styles.modalActions}>
          <button type="button" onClick={apply}>
            应用
          </button>
          <button type="button" onClick={onClose} autoFocus>
            取消
          </button>
        </div>
      </section>
    </div>
  )
}
