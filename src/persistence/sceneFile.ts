import {
  CURRENT_APP_VERSION,
  CURRENT_SCHEMA_VERSION,
  type SceneDocument,
} from '../scene/model/types'
import { migrateScene, SceneVersionError } from '../scene/migrations/migrateScene'
import { validateSceneDocument } from '../scene/validation/sceneSchema'

const maxSceneFileBytes = 10 * 1024 * 1024

export class SceneFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SceneFileError'
  }
}

export function parseSceneText(text: string): SceneDocument {
  let source: unknown

  try {
    source = JSON.parse(text) as unknown
  } catch (error) {
    throw new SceneFileError('文件不是有效的 JSON 场景。', { cause: error })
  }

  try {
    return validateSceneDocument(migrateScene(source))
  } catch (error) {
    if (error instanceof SceneFileError) {
      throw error
    }
    if (error instanceof SceneVersionError) {
      throw new SceneFileError(error.message, { cause: error })
    }
    throw new SceneFileError('场景内容不完整或包含无效属性。', { cause: error })
  }
}

export function serializeScene(scene: SceneDocument): string {
  const validated = validateSceneDocument({
    ...scene,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appVersion: CURRENT_APP_VERSION,
  })
  return `${JSON.stringify(validated, null, 2)}\n`
}

export async function readSceneFile(file: File): Promise<SceneDocument> {
  if (file.size > maxSceneFileBytes) {
    throw new SceneFileError('场景文件超过 10 MB，已停止读取。')
  }

  return parseSceneText(await file.text())
}

function safeFileStem(name: string): string {
  const withoutControlCharacters = [...name]
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('')
  const sanitized = withoutControlCharacters
    .trim()
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/[. ]+$/g, '')
  return sanitized || '未命名场景'
}

export function downloadScene(scene: SceneDocument): string {
  const fileName = `${safeFileStem(scene.metadata.name)}.motion.json`
  const blob = new Blob([serializeScene(scene)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')

  anchor.href = url
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)

  return fileName
}
