import { CURRENT_APP_VERSION, CURRENT_SCHEMA_VERSION } from '../model/types'
import { createDefaultChart } from '../model/chartDefaults'

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

function migrateEntityV2ToV3(value: unknown): unknown {
  if (!isRecord(value)) return value

  if (value.kind === 'body') {
    const shape = isRecord(value.shape) ? value.shape : {}
    if (shape.type === 'particle') {
      return {
        ...value,
        preset: 'ball',
        shape: {
          ...shape,
          type: 'circle',
          radius:
            typeof shape.collisionRadius === 'number' && shape.collisionRadius > 0
              ? shape.collisionRadius
              : 0.12,
          collisionEnabled: shape.collisionEnabled === true,
        },
      }
    }
    if (shape.type === 'circle') {
      return {
        ...value,
        preset: 'ball',
        shape: {
          ...shape,
          collisionEnabled:
            typeof shape.collisionEnabled === 'boolean' ? shape.collisionEnabled : true,
        },
      }
    }
    return { ...value, preset: 'block' }
  }

  if (value.kind === 'field') {
    const region = isRecord(value.region) ? value.region : {}
    if (region.type === 'circle') {
      return {
        ...value,
        region: { ...region, startRad: 0, sweepRad: Math.PI * 2 },
      }
    }
  }
  return value
}

export function migrateSceneV2ToV3(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    schemaVersion: 3,
    appVersion: CURRENT_APP_VERSION,
    entities: Array.isArray(input.entities)
      ? input.entities.map((entity) => migrateEntityV2ToV3(entity))
      : input.entities,
  }
}

function migrateEntityV3ToV4(value: unknown): unknown {
  if (!isRecord(value) || value.kind !== 'ground') return value
  return { ...value, collisionSide: 'both', normalFlipped: false }
}

export function migrateSceneV3ToV4(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    schemaVersion: 4,
    appVersion: CURRENT_APP_VERSION,
    entities: Array.isArray(input.entities)
      ? input.entities.map((entity) => migrateEntityV3ToV4(entity))
      : input.entities,
  }
}

function migrateEntityV4ToV5(value: unknown): unknown {
  if (!isRecord(value) || value.kind !== 'groundJoint') return value
  return {
    ...value,
    transition: { mode: 'auto', directionFlipped: false },
  }
}

export function migrateSceneV4ToV5(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    schemaVersion: 5,
    appVersion: CURRENT_APP_VERSION,
    entities: Array.isArray(input.entities)
      ? input.entities.map((entity) => migrateEntityV4ToV5(entity))
      : input.entities,
  }
}

function migrateEntityV5ToV6(value: unknown): unknown {
  if (!isRecord(value) || value.kind !== 'body') return value
  return {
    ...value,
    rotationEnabled: typeof value.rotationEnabled === 'boolean' ? value.rotationEnabled : true,
  }
}

export function migrateSceneV5ToV6(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    schemaVersion: 6,
    appVersion: CURRENT_APP_VERSION,
    entities: Array.isArray(input.entities)
      ? input.entities.map((entity) => migrateEntityV5ToV6(entity))
      : input.entities,
  }
}

export function migrateSceneV6ToV7(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    schemaVersion: 7,
    appVersion: CURRENT_APP_VERSION,
    charts: [createDefaultChart('chart-1')],
  }
}

const migrations: Record<number, (scene: Record<string, unknown>) => Record<string, unknown>> = {
  1: migrateSceneV1ToV2,
  2: migrateSceneV2ToV3,
  3: migrateSceneV3ToV4,
  4: migrateSceneV4ToV5,
  5: migrateSceneV5ToV6,
  6: migrateSceneV6ToV7,
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
