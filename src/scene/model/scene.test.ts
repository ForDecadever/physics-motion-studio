import { describe, expect, it } from 'vitest'

import { parseSceneText, serializeScene } from '../../persistence/sceneFile'
import { createEmptyScene } from './createEmptyScene'

describe('场景文档', () => {
  it('创建符合规范的空场景', () => {
    const scene = createEmptyScene('测试场景', new Date('2026-07-21T00:00:00.000Z'))
    const parsed = parseSceneText(serializeScene(scene))

    expect(parsed.metadata.name).toBe('测试场景')
    expect(parsed.layers).toHaveLength(1)
    expect(parsed.entities).toEqual([])
    expect(parsed.settings.fixedTimeStep).toBeCloseTo(1 / 120)
  })

  it('拒绝来自未来版本的场景', () => {
    const scene = createEmptyScene()
    const futureScene = { ...scene, schemaVersion: 99 }

    expect(() => parseSceneText(JSON.stringify(futureScene))).toThrow('该场景来自更新版本')
  })

  it('把格式 1 逐级迁移到格式 2，并保留未知字段', () => {
    const scene = createEmptyScene()
    const oldSettings: Record<string, unknown> = { ...scene.settings }
    delete oldSettings.recordingSampleRate
    delete oldSettings.recordingDurationSeconds
    const oldScene = {
      ...scene,
      schemaVersion: 1,
      settings: { ...oldSettings, futurePreference: 'preserve-me' },
      futureTopLevel: { enabled: true },
    }

    const migrated = parseSceneText(JSON.stringify(oldScene))

    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.settings.recordingSampleRate).toBe(60)
    expect(migrated.settings.recordingDurationSeconds).toBe(300)
    expect(migrated).toMatchObject({ futureTopLevel: { enabled: true } })
    expect(migrated.settings).toMatchObject({ futurePreference: 'preserve-me' })
  })

  it('拒绝非法物理参数', () => {
    const scene = createEmptyScene()
    const invalidScene = {
      ...scene,
      settings: { ...scene.settings, fixedTimeStep: 0 },
    }

    expect(() => parseSceneText(JSON.stringify(invalidScene))).toThrow('场景内容不完整')
  })
})
