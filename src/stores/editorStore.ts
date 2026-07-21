import { create } from 'zustand'

import { defaultCamera, type Camera2D } from '../editor/camera/viewport'
import type { EntityId, LayerId, SceneEntity, Vec2 } from '../scene/model/types'

export type EditorTool =
  'select' | 'rotate' | 'hand' | 'zoom' | 'ground' | 'body' | 'field' | 'connector'
export type BodyToolPreset = 'particle' | 'ball' | 'block' | 'pointCharge'
export type FieldToolPreset = 'uniformGravity' | 'uniformElectric' | 'uniformMagnetic'
export type FieldRegionToolShape = 'rectangle' | 'circle' | 'polygon' | 'infinite'
export type ConnectorToolPreset = 'rope' | 'rod' | 'spring'

interface EditorState {
  activeTool: EditorTool
  groundToolShape: 'line' | 'arc' | 'cubicBezier'
  bodyToolPreset: BodyToolPreset
  fieldToolPreset: FieldToolPreset
  fieldRegionToolShape: FieldRegionToolShape
  connectorToolPreset: ConnectorToolPreset
  gridVisible: boolean
  snapEnabled: boolean
  camera: Camera2D
  cursorWorld: Vec2
  selectedIds: EntityId[]
  activeLayerId: LayerId | null
  previewEntities: Record<EntityId, SceneEntity>
  draftEntity: SceneEntity | null
  marquee: { start: Vec2; end: Vec2 } | null
  connectorStartBodyId: EntityId | null
  setActiveTool: (tool: EditorTool) => void
  setGroundToolShape: (shape: 'line' | 'arc' | 'cubicBezier') => void
  setBodyToolPreset: (preset: BodyToolPreset) => void
  setFieldToolPreset: (preset: FieldToolPreset) => void
  setFieldRegionToolShape: (shape: FieldRegionToolShape) => void
  setConnectorToolPreset: (preset: ConnectorToolPreset) => void
  toggleGrid: () => void
  toggleSnap: () => void
  setCamera: (camera: Camera2D) => void
  setCursorWorld: (cursorWorld: Vec2) => void
  setSelectedIds: (selectedIds: EntityId[]) => void
  setActiveLayerId: (layerId: LayerId | null) => void
  toggleSelectedId: (entityId: EntityId) => void
  clearSelection: () => void
  setPreviewEntities: (entities: SceneEntity[]) => void
  clearPreview: () => void
  setDraftEntity: (draftEntity: SceneEntity | null) => void
  setMarquee: (marquee: { start: Vec2; end: Vec2 } | null) => void
  setConnectorStartBodyId: (entityId: EntityId | null) => void
  resetForDocument: () => void
}

export const useEditorStore = create<EditorState>((set) => ({
  activeTool: 'select',
  groundToolShape: 'line',
  bodyToolPreset: 'ball',
  fieldToolPreset: 'uniformGravity',
  fieldRegionToolShape: 'rectangle',
  connectorToolPreset: 'rope',
  gridVisible: true,
  snapEnabled: true,
  camera: defaultCamera,
  cursorWorld: { x: 0, y: 0 },
  selectedIds: [],
  activeLayerId: null,
  previewEntities: {},
  draftEntity: null,
  marquee: null,
  connectorStartBodyId: null,
  setActiveTool: (activeTool) =>
    set((state) => ({
      activeTool,
      connectorStartBodyId: activeTool === 'connector' ? state.connectorStartBodyId : null,
      draftEntity: null,
      marquee: null,
      previewEntities: {},
    })),
  setGroundToolShape: (groundToolShape) => set({ groundToolShape }),
  setBodyToolPreset: (bodyToolPreset) => set({ bodyToolPreset }),
  setFieldToolPreset: (fieldToolPreset) => set({ fieldToolPreset }),
  setFieldRegionToolShape: (fieldRegionToolShape) => set({ fieldRegionToolShape }),
  setConnectorToolPreset: (connectorToolPreset) => set({ connectorToolPreset }),
  toggleGrid: () => set((state) => ({ gridVisible: !state.gridVisible })),
  toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),
  setCamera: (camera) => set({ camera }),
  setCursorWorld: (cursorWorld) => set({ cursorWorld }),
  setSelectedIds: (selectedIds) => set({ selectedIds }),
  setActiveLayerId: (activeLayerId) => set({ activeLayerId }),
  toggleSelectedId: (entityId) =>
    set((state) => ({
      selectedIds: state.selectedIds.includes(entityId)
        ? state.selectedIds.filter((id) => id !== entityId)
        : [...state.selectedIds, entityId],
    })),
  clearSelection: () => set({ selectedIds: [] }),
  setPreviewEntities: (entities) =>
    set({ previewEntities: Object.fromEntries(entities.map((entity) => [entity.id, entity])) }),
  clearPreview: () => set({ previewEntities: {} }),
  setDraftEntity: (draftEntity) => set({ draftEntity }),
  setMarquee: (marquee) => set({ marquee }),
  setConnectorStartBodyId: (connectorStartBodyId) => set({ connectorStartBodyId }),
  resetForDocument: () =>
    set({
      camera: defaultCamera,
      cursorWorld: { x: 0, y: 0 },
      selectedIds: [],
      activeLayerId: null,
      previewEntities: {},
      draftEntity: null,
      marquee: null,
      connectorStartBodyId: null,
    }),
}))
