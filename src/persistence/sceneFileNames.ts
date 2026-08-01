export const SCENE_FILE_EXTENSION = '.motionstudio'
export const LEGACY_SCENE_FILE_EXTENSIONS = ['.motion.json', '.json'] as const

export function isSupportedSceneFileName(fileName: string): boolean {
  const normalized = fileName.trim().toLocaleLowerCase('en-US')
  return (
    normalized.endsWith(SCENE_FILE_EXTENSION) ||
    LEGACY_SCENE_FILE_EXTENSIONS.some((extension) => normalized.endsWith(extension))
  )
}

export function ensureMotionStudioFileName(fileName: string): string {
  const trimmed = fileName.trim()
  if (!trimmed) return `未命名场景${SCENE_FILE_EXTENSION}`
  if (isSupportedSceneFileName(trimmed)) return trimmed
  return `${trimmed}${SCENE_FILE_EXTENSION}`
}
