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

function migrateEntityTo17(entity: unknown): unknown {
  if (!isRecord(entity)) return entity
  if (entity.kind === 'body') {
    const shape = isRecord(entity.shape) ? entity.shape : undefined
    const legacyColor =
      shape?.type === 'circle' && shape.collisionEnabled === true ? '#e45d68' : '#4e9eeb'
    return { ...entity, color: legacyColor }
  }
  if (entity.kind === 'particleSource') {
    return { ...entity, spreadRad: 0 }
  }
  return entity
}

function migrateBooleanNodeTo17(item: unknown): unknown {
  if (!isRecord(item) || item.kind !== 'boolean') return item
  return {
    ...item,
    operands: Array.isArray(item.operands)
      ? item.operands.map((operand) => migrateBooleanNodeTo17(operand))
      : item.operands,
    fieldDistribution: { mode: 'source' },
  }
}

function migrate16To17(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    schemaVersion: 17,
    entities: Array.isArray(input.entities)
      ? input.entities.map((entity) => migrateEntityTo17(entity))
      : input.entities,
    rootItems: Array.isArray(input.rootItems)
      ? input.rootItems.map((item) => migrateBooleanNodeTo17(item))
      : input.rootItems,
  }
}

function migrateEntityTo18(entity: unknown): unknown {
  if (!isRecord(entity) || entity.kind !== 'ground') return entity
  return {
    ...entity,
    conveyor: { enabled: false, direction: 'forward', speedMps: 1 },
  }
}

function migrate17To18(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    schemaVersion: 18,
    entities: Array.isArray(input.entities)
      ? input.entities.map((entity) => migrateEntityTo18(entity))
      : input.entities,
  }
}

function migrate18To19(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    schemaVersion: 19,
    globalVariables: [],
    propertyExpressions: [],
  }
}

function migrate19To20(input: Record<string, unknown>): Record<string, unknown> {
  return { ...input, schemaVersion: 20 }
}

function migratedElectricFieldTo21(field: unknown): unknown {
  if (!isRecord(field) || field.type !== 'uniformElectric') return field
  const { magnitudeExpression, ...rest } = field
  if (!isRecord(magnitudeExpression) || typeof magnitudeExpression.expression !== 'string') {
    return rest
  }
  const strength = isRecord(field.strength) ? field.strength : undefined
  const x = typeof strength?.x === 'number' && Number.isFinite(strength.x) ? strength.x : 0
  const y = typeof strength?.y === 'number' && Number.isFinite(strength.y) ? strength.y : 0
  const magnitude = Math.hypot(x, y)
  const directionX = magnitude > Number.EPSILON ? x / magnitude : 1
  const directionY = magnitude > Number.EPSILON ? y / magnitude : 0
  const fallback =
    typeof magnitudeExpression.fallbackValue === 'number' &&
    Number.isFinite(magnitudeExpression.fallbackValue)
      ? magnitudeExpression.fallbackValue
      : magnitude
  const component = (scale: number) => ({
    expression: `(${magnitudeExpression.expression})*(${scale.toPrecision(17)})`,
    fallbackValue: fallback * scale,
  })
  return {
    ...rest,
    componentExpressions: { x: component(directionX), y: component(directionY) },
  }
}

function migrateEntityTo21(entity: unknown): unknown {
  if (!isRecord(entity)) return entity
  if (entity.kind === 'particleSource') {
    return {
      ...entity,
      densityPerDegree: 3,
      continuousEmission: { enabled: false, intervalSeconds: 1, lifetimeSeconds: 60 },
    }
  }
  if (entity.kind === 'field') {
    return { ...entity, field: migratedElectricFieldTo21(entity.field) }
  }
  if (entity.kind === 'force') {
    const { directionExpression, ...rest } = entity
    if (!isRecord(directionExpression) || typeof directionExpression.expression !== 'string') {
      return rest
    }
    const fallback =
      typeof directionExpression.fallbackValue === 'number' &&
      Number.isFinite(directionExpression.fallbackValue)
        ? directionExpression.fallbackValue
        : 0
    return {
      ...rest,
      directionDegreesExpression: {
        expression: `(${directionExpression.expression})*180/pi`,
        fallbackValue: (fallback * 180) / Math.PI,
      },
    }
  }
  return entity
}

function migrateBooleanNodeTo21(item: unknown): unknown {
  if (!isRecord(item) || item.kind !== 'boolean') return item
  const fieldDistribution = isRecord(item.fieldDistribution) ? item.fieldDistribution : undefined
  return {
    ...item,
    operands: Array.isArray(item.operands)
      ? item.operands.map((operand) => migrateBooleanNodeTo21(operand))
      : item.operands,
    fieldDistribution:
      fieldDistribution?.mode === 'uniform'
        ? { ...fieldDistribution, field: migratedElectricFieldTo21(fieldDistribution.field) }
        : fieldDistribution,
  }
}

function migrate20To21(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    schemaVersion: 21,
    entities: Array.isArray(input.entities)
      ? input.entities.map((entity) => migrateEntityTo21(entity))
      : input.entities,
    rootItems: Array.isArray(input.rootItems)
      ? input.rootItems.map((item) => migrateBooleanNodeTo21(item))
      : input.rootItems,
  }
}

function migrateEntityTo22(entity: unknown): unknown {
  if (!isRecord(entity) || entity.kind !== 'particleSource') return entity
  const continuousEmission = isRecord(entity.continuousEmission)
    ? entity.continuousEmission
    : undefined
  return {
    ...entity,
    continuousEmission: continuousEmission
      ? { ...continuousEmission, simultaneous: false }
      : continuousEmission,
  }
}

function migrate21To22(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    schemaVersion: 22,
    entities: Array.isArray(input.entities)
      ? input.entities.map((entity) => migrateEntityTo22(entity))
      : input.entities,
  }
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
  if (version < 12) {
    throw new SceneVersionError(
      `当前版本只接受格式 ${CURRENT_SCHEMA_VERSION}，该场景使用格式 ${String(version)}。`,
    )
  }

  let migrated = input
  if (version <= 12) migrated = migrate12To13(migrated)
  if (version <= 13) migrated = migrate13To14(migrated)
  if (version <= 14) migrated = migrate14To15(migrated)
  if (version <= 15) migrated = migrate15To16(migrated)
  if (version <= 16) migrated = migrate16To17(migrated)
  if (version <= 17) migrated = migrate17To18(migrated)
  if (version <= 18) migrated = migrate18To19(migrated)
  if (version <= 19) migrated = migrate19To20(migrated)
  if (version <= 20) migrated = migrate20To21(migrated)
  if (version <= 21) migrated = migrate21To22(migrated)
  return migrated
}
