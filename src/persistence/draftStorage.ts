import type { SceneDocument } from '../scene/model/types'
import { parseSceneText, serializeScene } from './sceneFile'

const DATABASE_NAME = 'motion-studio'
const STORE_NAME = 'drafts'
const LATEST_DRAFT_KEY = 'latest'

export interface SceneDraft {
  savedAt: string
  fileName: string | null
  scene: SceneDocument
}

interface StoredDraft {
  key: string
  savedAt: string
  fileName: string | null
  sceneText: string
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (!('indexedDB' in window)) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开草稿数据库。'))
  })
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('草稿数据库操作失败。'))
    transaction.onabort = () => reject(transaction.error ?? new Error('草稿数据库操作已中止。'))
  })
}

export async function saveSceneDraft(scene: SceneDocument, fileName: string | null): Promise<void> {
  const database = await openDatabase()
  if (!database) return
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const stored: StoredDraft = {
      key: LATEST_DRAFT_KEY,
      savedAt: new Date().toISOString(),
      fileName,
      sceneText: serializeScene(scene),
    }
    transaction.objectStore(STORE_NAME).put(stored)
    await waitForTransaction(transaction)
  } finally {
    database.close()
  }
}

export async function loadSceneDraft(): Promise<SceneDraft | null> {
  const database = await openDatabase()
  if (!database) return null
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).get(LATEST_DRAFT_KEY)
    const stored = await new Promise<StoredDraft | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as StoredDraft | undefined)
      request.onerror = () => reject(request.error ?? new Error('无法读取恢复草稿。'))
    })
    await waitForTransaction(transaction)
    if (!stored) return null
    return {
      savedAt: stored.savedAt,
      fileName: stored.fileName,
      scene: parseSceneText(stored.sceneText),
    }
  } finally {
    database.close()
  }
}

export async function clearSceneDraft(): Promise<void> {
  const database = await openDatabase()
  if (!database) return
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).delete(LATEST_DRAFT_KEY)
    await waitForTransaction(transaction)
  } finally {
    database.close()
  }
}
