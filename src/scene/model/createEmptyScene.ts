import { CURRENT_SCHEMA_VERSION, type SceneDocument } from './types'

const appVersion = '0.2.0'

export function createEmptyScene(name = '未命名场景', now = new Date()): SceneDocument {
  const timestamp = now.toISOString()

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appVersion,
    metadata: {
      name,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    settings: {
      fixedTimeStep: 1 / 120,
      gridStep: 1,
      snapStep: 0.1,
      pairwiseElectrostatics: true,
    },
    layers: [
      {
        id: crypto.randomUUID(),
        name: '物理场景',
        visible: true,
        locked: false,
      },
    ],
    entities: [],
  }
}
