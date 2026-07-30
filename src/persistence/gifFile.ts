interface GifPickerWindow extends Window {
  showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle>
}

export interface SavedGif {
  fileName: string
  method: 'direct' | 'download'
}

function pickerWindow(): GifPickerWindow {
  return window as GifPickerWindow
}

export function supportsGifFilePicker(): boolean {
  return typeof pickerWindow().showSaveFilePicker === 'function'
}

export function normalizedGifFileName(fileName: string): string {
  const trimmed = fileName.trim() || 'motion-studio.gif'
  return trimmed.toLowerCase().endsWith('.gif') ? trimmed : `${trimmed}.gif`
}

export async function chooseGifFile(suggestedName: string): Promise<FileSystemFileHandle | null> {
  const showSaveFilePicker = pickerWindow().showSaveFilePicker
  if (!showSaveFilePicker) return null
  return showSaveFilePicker({
    suggestedName: normalizedGifFileName(suggestedName),
    types: [
      {
        description: 'GIF 动图',
        accept: { 'image/gif': ['.gif'] },
      },
    ],
    excludeAcceptAllOption: false,
  })
}

export async function saveGif(
  bytes: Uint8Array,
  fileName: string,
  handle: FileSystemFileHandle | null,
): Promise<SavedGif> {
  const normalizedName = normalizedGifFileName(fileName)
  const arrayBuffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(arrayBuffer).set(bytes)
  const blob = new Blob([arrayBuffer], { type: 'image/gif' })

  if (handle) {
    let writable: FileSystemWritableFileStream | null = null
    try {
      writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return { fileName: handle.name, method: 'direct' }
    } catch (error) {
      try {
        await writable?.abort(error)
      } catch {
        // Preserve the original write error.
      }
      throw new Error('写入 GIF 文件失败，请重新选择保存位置。', { cause: error })
    }
  }

  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = normalizedName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  return { fileName: normalizedName, method: 'download' }
}
