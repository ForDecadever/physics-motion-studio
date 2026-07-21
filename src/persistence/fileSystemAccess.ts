import type { SceneDocument } from '../scene/model/types'
import { downloadScene, readSceneFile, serializeScene, SceneFileError } from './sceneFile'

interface ScenePickerWindow extends Window {
  showOpenFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle[]>
  showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle>
}

export interface OpenedScene {
  scene: SceneDocument
  fileName: string
  handle: FileSystemFileHandle
}

export interface SavedScene {
  fileName: string
  handle: FileSystemFileHandle | null
  method: 'direct' | 'download'
  sha256: string
}

const pickerOptions = {
  types: [
    {
      description: 'Motion Studio 场景',
      accept: { 'application/json': ['.motion.json', '.json'] },
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
  return { scene: await readSceneFile(file), fileName: file.name, handle }
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
  existingHandle: FileSystemFileHandle | null,
  saveAs = false,
): Promise<SavedScene> {
  let handle = saveAs ? null : existingHandle
  const showSaveFilePicker = pickerWindow().showSaveFilePicker

  if (!handle && showSaveFilePicker) {
    handle = await showSaveFilePicker({
      ...pickerOptions,
      suggestedName: `${scene.metadata.name}.motion.json`,
    })
  }

  if (handle) {
    const result = await writeAndVerifyScene(handle, scene)
    return { ...result, handle, method: 'direct' }
  }

  const text = serializeScene(scene)
  return {
    fileName: downloadScene(scene),
    handle: null,
    method: 'download',
    sha256: await sha256(text),
  }
}
