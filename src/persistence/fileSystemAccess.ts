import type { SceneDocument } from '../scene/model/types'
import { downloadScene, readSceneFile, serializeScene, SceneFileError } from './sceneFile'
import type { OpenedScene, SavedScene, SceneFileService, SceneFileToken } from './sceneFileService'
import { SCENE_FILE_EXTENSION } from './sceneFileNames'

interface ScenePickerWindow extends Window {
  showOpenFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle[]>
  showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle>
}

const pickerOptions = {
  types: [
    {
      description: 'Motion Studio 场景',
      accept: {
        'application/vnd.motion-studio.scene+json': [SCENE_FILE_EXTENSION],
        'application/json': ['.motion.json', '.json'],
      },
    },
  ],
  excludeAcceptAllOption: false,
}

function pickerWindow(): ScenePickerWindow {
  return window as ScenePickerWindow
}

export function supportsDirectFileAccess(): boolean {
  const target = pickerWindow()
  return (
    typeof target.showOpenFilePicker === 'function' &&
    typeof target.showSaveFilePicker === 'function'
  )
}

export function isFilePickerCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function openSceneWithPicker(): Promise<OpenedScene | null> {
  const showOpenFilePicker = pickerWindow().showOpenFilePicker
  if (!showOpenFilePicker) return null
  const [handle] = await showOpenFilePicker(pickerOptions)
  if (!handle) return null
  const file = await handle.getFile()
  return {
    scene: await readSceneFile(file),
    fileName: file.name,
    token: { kind: 'web', handle },
  }
}

async function writeAndVerifyScene(
  handle: FileSystemFileHandle,
  scene: SceneDocument,
): Promise<{ fileName: string; sha256: string }> {
  const text = serializeScene(scene)
  const expectedDigest = await sha256(text)
  let writable: FileSystemWritableFileStream | null = null

  try {
    writable = await handle.createWritable()
    await writable.write(text)
    await writable.close()
  } catch (error) {
    try {
      await writable?.abort(error)
    } catch {
      // 原始写入错误更有帮助；关闭失败不覆盖它。
    }
    throw new SceneFileError('写入场景文件失败，原文件未被标记为已保存。', { cause: error })
  }

  const savedFile = await handle.getFile()
  const actualDigest = await sha256(await savedFile.text())
  if (actualDigest !== expectedDigest) {
    throw new SceneFileError('保存后的内容校验失败，请改用“另存为”保留当前场景。')
  }
  return { fileName: savedFile.name, sha256: actualDigest }
}

export async function saveScene(
  scene: SceneDocument,
  existingToken: SceneFileToken | null,
  saveAs = false,
): Promise<SavedScene> {
  let handle = !saveAs && existingToken?.kind === 'web' ? existingToken.handle : null
  const showSaveFilePicker = pickerWindow().showSaveFilePicker

  if (!handle && showSaveFilePicker) {
    handle = await showSaveFilePicker({
      ...pickerOptions,
      suggestedName: `${scene.metadata.name}${SCENE_FILE_EXTENSION}`,
    })
  }

  if (handle) {
    const result = await writeAndVerifyScene(handle, scene)
    return { ...result, token: { kind: 'web', handle }, method: 'direct' }
  }

  const text = serializeScene(scene)
  return {
    fileName: downloadScene(scene),
    token: null,
    method: 'download',
    sha256: await sha256(text),
  }
}

export const webSceneFileService: SceneFileService = {
  platform: 'web',
  supportsNativeOpen: supportsDirectFileAccess,
  open: openSceneWithPicker,
  save: saveScene,
  confirmOpened: async () => undefined,
  listRecent: async () => [],
  openRecent: async () => {
    throw new SceneFileError('Web 版不提供最近文件列表。')
  },
  removeRecent: async () => undefined,
  clearRecent: async () => undefined,
  takePendingOpen: async () => null,
  subscribeOpenRequests: async () => () => undefined,
}
