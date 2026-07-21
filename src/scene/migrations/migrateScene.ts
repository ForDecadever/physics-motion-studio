import { CURRENT_SCHEMA_VERSION } from '../model/types'

export class SceneVersionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SceneVersionError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function migrateSceneV1ToV2(input: Record<string, unknown>): Record<string, unknown> {
  const settings = isRecord(input.settings) ? input.settings : {}
  return {
    ...input,
    schemaVersion: 2,
    settings: {
      ...settings,
      recordingSampleRate: 60,
      recordingDurationSeconds: 300,
    },
  }
}

const migrations: Record<number, (scene: Record<string, unknown>) => Record<string, unknown>> = {
  1: migrateSceneV1ToV2,
}

export function migrateScene(input: unknown): unknown {
  if (!isRecord(input)) {
    throw new SceneVersionError('场景文件的顶层必须是一个对象。')
  }

  const version = input.schemaVersion
  if (!Number.isInteger(version)) {
    throw new SceneVersionError('场景文件缺少有效的 schemaVersion。')
  }
  if (typeof version !== 'number') {
    throw new SceneVersionError('场景文件缺少有效的 schemaVersion。')
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new SceneVersionError(
      `该场景来自更新版本（格式 ${version}），当前程序只支持到格式 ${CURRENT_SCHEMA_VERSION}。`,
    )
  }
  if (version < 1) {
    throw new SceneVersionError(`暂不支持格式版本 ${String(version)}。`)
  }

  let current = input
  let currentVersion = version
  while (currentVersion < CURRENT_SCHEMA_VERSION) {
    const migration = migrations[currentVersion]
    if (!migration) {
      throw new SceneVersionError(`缺少格式 ${currentVersion} 到 ${currentVersion + 1} 的迁移。`)
    }
    current = migration(current)
    currentVersion += 1
  }
  return current
}
