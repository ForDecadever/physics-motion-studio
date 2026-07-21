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

export function migrateScene(input: unknown): unknown {
  if (!isRecord(input)) {
    throw new SceneVersionError('场景文件的顶层必须是一个对象。')
  }

  const version = input.schemaVersion
  if (!Number.isInteger(version)) {
    throw new SceneVersionError('场景文件缺少有效的 schemaVersion。')
  }

  if (typeof version === 'number' && version > CURRENT_SCHEMA_VERSION) {
    throw new SceneVersionError(
      `该场景来自更新版本（格式 ${version}），当前程序只支持到格式 ${CURRENT_SCHEMA_VERSION}。`,
    )
  }

  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new SceneVersionError(`暂不支持格式版本 ${String(version)}。`)
  }

  return input
}
