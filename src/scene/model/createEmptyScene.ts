import { CURRENT_APP_VERSION, CURRENT_SCHEMA_VERSION, type SceneDocument } from './types'
import { createDefaultChart } from './chartDefaults'

export function createEmptyScene(name = '未命名场景', now = new Date()): SceneDocument {
  const timestamp = now.toISOString()

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appVersion: CURRENT_APP_VERSION,
    metadata: {
      name,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    settings: {
      fixedTimeStep: 1 / 120,
      gridStep: 5,
      snapStep: 0.1,
      pairwiseElectrostatics: false,
      recordingSampleRate: 60,
      recordingDurationSeconds: 300,
    },
    rootItems: [],
    entities: [],
    charts: [createDefaultChart()],
  }
}
