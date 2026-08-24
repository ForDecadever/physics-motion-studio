import { CURRENT_APP_VERSION, CURRENT_SCHEMA_VERSION, type SceneDocument } from './types'
import { createDefaultChart } from './chartDefaults'
import { getEntityCreationDefaults } from './creationDefaults'

export function createEmptyScene(name = '未命名场景', now = new Date()): SceneDocument {
  const timestamp = now.toISOString()
  const recording = getEntityCreationDefaults().recording

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
      recordingSampleRate: recording.sampleRate,
      recordingDurationSeconds: recording.durationSeconds,
    },
    globalVariables: [],
    propertyExpressions: [],
    rootItems: [],
    entities: [],
    charts: [createDefaultChart()],
  }
}
