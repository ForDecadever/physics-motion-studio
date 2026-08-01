import { describe, expect, it, vi } from 'vitest'

import type { SceneFileService } from './sceneFileService'
import { selectSceneFileService } from './sceneFileService'
import {
  ensureMotionStudioFileName,
  isSupportedSceneFileName,
  SCENE_FILE_EXTENSION,
} from './sceneFileNames'

function service(platform: 'web' | 'desktop'): SceneFileService {
  return {
    platform,
    supportsNativeOpen: () => false,
    open: vi.fn(),
    save: vi.fn(),
    confirmOpened: vi.fn(),
    listRecent: vi.fn(),
    openRecent: vi.fn(),
    removeRecent: vi.fn(),
    clearRecent: vi.fn(),
    takePendingOpen: vi.fn(),
    subscribeOpenRequests: vi.fn(),
  } as SceneFileService
}

describe('场景文件服务', () => {
  it('按运行平台分派 Web 与桌面实现', () => {
    const web = service('web')
    const desktop = service('desktop')
    expect(selectSceneFileService('web', { web, desktop })).toBe(web)
    expect(selectSceneFileService('desktop', { web, desktop })).toBe(desktop)
  })

  it('新文件默认使用 .motionstudio，旧扩展仍可打开和覆盖', () => {
    expect(SCENE_FILE_EXTENSION).toBe('.motionstudio')
    expect(ensureMotionStudioFileName('双摆')).toBe('双摆.motionstudio')
    expect(ensureMotionStudioFileName('旧场景.motion.json')).toBe('旧场景.motion.json')
    expect(isSupportedSceneFileName('实验.MOTIONSTUDIO')).toBe(true)
    expect(isSupportedSceneFileName('实验.json')).toBe(true)
    expect(isSupportedSceneFileName('实验.txt')).toBe(false)
  })
})
