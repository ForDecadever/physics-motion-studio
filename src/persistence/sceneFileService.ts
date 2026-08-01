import type { SceneDocument } from '../scene/model/types'
import type { RuntimePlatform } from '../platform/runtime'
import { isDesktopRuntime } from '../platform/runtime'
import { desktopSceneFileService } from './desktopFileAccess'
import { webSceneFileService } from './fileSystemAccess'
export {
  ensureMotionStudioFileName,
  isSupportedSceneFileName,
  LEGACY_SCENE_FILE_EXTENSIONS,
  SCENE_FILE_EXTENSION,
} from './sceneFileNames'

export type SceneFileToken =
  { kind: 'web'; handle: FileSystemFileHandle } | { kind: 'desktop'; value: string }

export interface OpenedScene {
  scene: SceneDocument
  fileName: string
  token: SceneFileToken
}

export interface SavedScene {
  fileName: string
  token: SceneFileToken | null
  method: 'direct' | 'download'
  sha256: string
}

export interface RecentSceneEntry {
  id: string
  fileName: string
  pathLabel: string
  lastOpenedAt: number
}

export interface SceneFileService {
  platform: RuntimePlatform
  supportsNativeOpen: () => boolean
  open: () => Promise<OpenedScene | null>
  save: (
    scene: SceneDocument,
    existingToken: SceneFileToken | null,
    saveAs?: boolean,
  ) => Promise<SavedScene>
  confirmOpened: (token: SceneFileToken) => Promise<void>
  listRecent: () => Promise<RecentSceneEntry[]>
  openRecent: (id: string) => Promise<OpenedScene>
  removeRecent: (id: string) => Promise<void>
  clearRecent: () => Promise<void>
  takePendingOpen: () => Promise<OpenedScene | null>
  subscribeOpenRequests: (listener: () => void) => Promise<() => void>
}

export function isSceneFileCancellation(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

export function selectSceneFileService(
  platform: RuntimePlatform,
  services: {
    web: SceneFileService
    desktop: SceneFileService
  } = { web: webSceneFileService, desktop: desktopSceneFileService },
): SceneFileService {
  return services[platform]
}

export const sceneFileService: SceneFileService = selectSceneFileService(
  isDesktopRuntime() ? 'desktop' : 'web',
)
