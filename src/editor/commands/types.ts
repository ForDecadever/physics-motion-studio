import type { SceneDocument } from '../../scene/model/types'

export interface DocumentCommand {
  readonly label: string
  readonly runtimeSafe?: boolean
  execute(document: SceneDocument): SceneDocument
  undo(document: SceneDocument): SceneDocument
}

export const HISTORY_LIMIT = 200
