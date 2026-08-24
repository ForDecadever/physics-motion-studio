import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_APP_PREFERENCES,
  loadAppPreferences,
  saveAppPreferences,
  type AppPreferences,
} from './preferences'

function installStorage() {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  })
  return values
}

afterEach(() => vi.unstubAllGlobals())

describe('本机应用偏好', () => {
  it('新安装默认使用 1 C 粒子电荷', () => {
    installStorage()

    expect(loadAppPreferences().creation.particleSource.chargeC).toBe(1)
  })

  it('保存并读取编辑偏好和新建默认值', () => {
    installStorage()
    const preferences: AppPreferences = structuredClone(DEFAULT_APP_PREFERENCES)
    preferences.editor.gridVisible = false
    preferences.creation.body.massKg = 8
    preferences.creation.ground.conveyorDirection = 'reverse'

    saveAppPreferences(preferences)

    expect(loadAppPreferences()).toEqual(preferences)
  })

  it('损坏或越界的本机值回退到安全默认值', () => {
    const storage = installStorage()
    storage.set(
      'motion-studio-preferences-v2',
      JSON.stringify({
        version: 2,
        editor: { gridVisible: false },
        creation: {
          body: { massKg: -1, ballColor: 'red', friction: 99 },
          particleSource: { massKg: 0 },
          recording: { sampleRate: 1.5, durationSeconds: 99999 },
        },
      }),
    )

    const loaded = loadAppPreferences()
    expect(loaded.editor.gridVisible).toBe(false)
    expect(loaded.creation.body).toMatchObject({
      massKg: DEFAULT_APP_PREFERENCES.creation.body.massKg,
      ballColor: DEFAULT_APP_PREFERENCES.creation.body.ballColor,
      friction: DEFAULT_APP_PREFERENCES.creation.body.friction,
    })
    expect(loaded.creation.particleSource.massKg).toBe(
      DEFAULT_APP_PREFERENCES.creation.particleSource.massKg,
    )
    expect(loaded.creation.recording.durationSeconds).toBe(
      DEFAULT_APP_PREFERENCES.creation.recording.durationSeconds,
    )
    expect(loaded.creation.recording.sampleRate).toBe(
      DEFAULT_APP_PREFERENCES.creation.recording.sampleRate,
    )
  })

  it('从旧版偏好保留其他新建参数、丢弃主题并把粒子源默认电荷修正为 1 C', () => {
    const storage = installStorage()
    storage.set(
      'motion-studio-preferences-v1',
      JSON.stringify({
        version: 1,
        theme: 'light',
        editor: { gridVisible: false },
        creation: { body: { massKg: 7 }, particleSource: { chargeC: 0 } },
      }),
    )

    expect(loadAppPreferences()).toMatchObject({
      version: 3,
      editor: { gridVisible: false },
      creation: { body: { massKg: 7 }, particleSource: { chargeC: 1 } },
    })
  })

  it('新版偏好仍保留用户主动设置的零电荷', () => {
    const storage = installStorage()
    storage.set(
      'motion-studio-preferences-v3',
      JSON.stringify({
        version: 3,
        creation: { particleSource: { chargeC: 0 } },
      }),
    )

    expect(loadAppPreferences().creation.particleSource.chargeC).toBe(0)
  })
})
