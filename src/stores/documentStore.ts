import { create } from 'zustand'

import { HISTORY_LIMIT, type DocumentCommand } from '../editor/commands/types'
import { createEmptyScene } from '../scene/model/createEmptyScene'
import type { SceneDocument } from '../scene/model/types'

interface DocumentState {
  scene: SceneDocument
  fileName: string | null
  isDirty: boolean
  undoStack: DocumentCommand[]
  redoStack: DocumentCommand[]
  createNewScene: () => void
  replaceScene: (scene: SceneDocument, fileName: string | null) => void
  markSaved: (fileName: string) => void
  executeCommand: (command: DocumentCommand) => void
  undo: () => void
  redo: () => void
}

function touchScene(scene: SceneDocument): SceneDocument {
  return {
    ...scene,
    metadata: { ...scene.metadata, updatedAt: new Date().toISOString() },
  }
}

export const useDocumentStore = create<DocumentState>((set) => ({
  scene: createEmptyScene(),
  fileName: null,
  isDirty: false,
  undoStack: [],
  redoStack: [],
  createNewScene: () =>
    set({
      scene: createEmptyScene(),
      fileName: null,
      isDirty: false,
      undoStack: [],
      redoStack: [],
    }),
  replaceScene: (scene, fileName) =>
    set({ scene, fileName, isDirty: false, undoStack: [], redoStack: [] }),
  markSaved: (fileName) => set({ fileName, isDirty: false }),
  executeCommand: (command) =>
    set((state) => ({
      scene: touchScene(command.execute(state.scene)),
      isDirty: true,
      undoStack: [...state.undoStack, command].slice(-HISTORY_LIMIT),
      redoStack: [],
    })),
  undo: () =>
    set((state) => {
      const command = state.undoStack.at(-1)
      if (!command) return state
      return {
        scene: touchScene(command.undo(state.scene)),
        isDirty: true,
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, command],
      }
    }),
  redo: () =>
    set((state) => {
      const command = state.redoStack.at(-1)
      if (!command) return state
      return {
        scene: touchScene(command.execute(state.scene)),
        isDirty: true,
        undoStack: [...state.undoStack, command].slice(-HISTORY_LIMIT),
        redoStack: state.redoStack.slice(0, -1),
      }
    }),
}))
