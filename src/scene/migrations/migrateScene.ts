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

function migrateBooleanNodeTo13(item: unknown): unknown {
  if (!isRecord(item) || item.kind !== 'boolean') return item
  const operands = Array.isArray(item.operands)
    ? item.operands.map((operand) => migrateBooleanNodeTo13(operand))
    : item.operands
  return {
    ...item,
    operands,
    frictionDistribution: { mode: 'source' },
    restitutionDistribution: { mode: 'source' },
    initialVelocity: { mode: 'source' },
    initialAngularVelocity: { mode: 'source' },
  }
}

function migrate12To13(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    schemaVersion: 13,
    rootItems: Array.isArray(input.rootItems)
      ? input.rootItems.map((item) => migrateBooleanNodeTo13(item))
      : input.rootItems,
  }
}

function migrate13To14(input: Record<string, unknown>): Record<string, unknown> {
  return { ...input, schemaVersion: 14 }
}

function migrate14To15(input: Record<string, unknown>): Record<string, unknown> {
  return { ...input, schemaVersion: 15 }
}

function migrate15To16(input: Record<string, unknown>): Record<string, unknown> {
  return { ...input, schemaVersion: 16 }
}

/** 格式 12 已有递归场景树；格式 13 只为布尔结果补充整体覆盖设置。 */
export function migrateScene(input: unknown): unknown {
  if (!isRecord(input)) {
    throw new SceneVersionError('场景文件的顶层必须是一个对象。')
  }

  const version = input.schemaVersion
  if (!Number.isInteger(version) || typeof version !== 'number') {
    throw new SceneVersionError('场景文件缺少有效的 schemaVersion。')
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new SceneVersionError(
      `该场景来自更新版本（格式 ${version}），当前程序只支持到格式 ${CURRENT_SCHEMA_VERSION}。`,
    )
  }
  if (version === 12) return migrate15To16(migrate14To15(migrate13To14(migrate12To13(input))))
  if (version === 13) return migrate15To16(migrate14To15(migrate13To14(input)))
  if (version === 14) return migrate15To16(migrate14To15(input))
  if (version === 15) return migrate15To16(input)
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new SceneVersionError(
      `当前版本只接受格式 ${CURRENT_SCHEMA_VERSION}，该场景使用格式 ${String(version)}。`,
    )
  }
  return input
}
