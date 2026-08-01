import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { parseSceneText, serializeScene } from './sceneFile'
import type {
  OpenedScene,
  RecentSceneEntry,
  SavedScene,
  SceneFileService,
  SceneFileToken,
} from './sceneFileService'
import { ensureMotionStudioFileName } from './sceneFileNames'

interface DesktopOpenedPayload {
  contents: string
  fileName: string
  token: string
}

interface DesktopSavedPayload {
  fileName: string
  token: string
  sha256: string
}

function toOpenedScene(payload: DesktopOpenedPayload): OpenedScene {
  return {
    scene: parseSceneText(payload.contents),
    fileName: payload.fileName,
    token: { kind: 'desktop', value: payload.token },
  }
}

function desktopToken(token: SceneFileToken | null): string | null {
  return token?.kind === 'desktop' ? token.value : null
}

export const desktopSceneFileService: SceneFileService = {
  platform: 'desktop',
  supportsNativeOpen: () => true,
  open: async () => {
    const payload = await invoke<DesktopOpenedPayload | null>('desktop_open_scene')
    return payload ? toOpenedScene(payload) : null
  },
  save: async (scene, existingToken, saveAs = false): Promise<SavedScene> => {
    const payload = await invoke<DesktopSavedPayload | null>('desktop_save_scene', {
      existingToken: desktopToken(existingToken),
      saveAs,
      suggestedName: ensureMotionStudioFileName(scene.metadata.name),
      contents: serializeScene(scene),
    })
    if (!payload) {
      const cancellation = new Error('已取消文件选择')
      cancellation.name = 'AbortError'
      throw cancellation
    }
    return {
      fileName: payload.fileName,
      token: { kind: 'desktop', value: payload.token },
      method: 'direct',
      sha256: payload.sha256,
    }
  },
  confirmOpened: async (token) => {
    if (token.kind !== 'desktop') return
    await invoke('desktop_confirm_scene_opened', { token: token.value })
  },
  listRecent: () => invoke<RecentSceneEntry[]>('desktop_list_recent_scenes'),
  openRecent: async (id) =>
    toOpenedScene(await invoke<DesktopOpenedPayload>('desktop_open_recent_scene', { id })),
  removeRecent: (id) => invoke('desktop_remove_recent_scene', { id }),
  clearRecent: () => invoke('desktop_clear_recent_scenes'),
  takePendingOpen: async () => {
    const payload = await invoke<DesktopOpenedPayload | null>('desktop_take_pending_scene')
    return payload ? toOpenedScene(payload) : null
  },
  subscribeOpenRequests: async (listener) => {
    const unlisten = await listen('desktop-open-requested', listener)
    return unlisten
  },
}
