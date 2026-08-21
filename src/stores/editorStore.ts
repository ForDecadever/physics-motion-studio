import { create } from 'zustand'

import { defaultCamera, type Camera2D } from '../editor/camera/viewport'
import type {
  ConnectorEndpoint,
  EntityId,
  GroundEndpointRef,
  SceneEntity,
  Vec2,
} from '../scene/model/types'

export type EditorTool =
  | 'select'
  | 'rotate'
  | 'scale'
  | 'hand'
  | 'zoom'
  | 'ground'
  | 'groundJoint'
  | 'body'
  | 'field'
  | 'connector'
  | 'particleSource'
export type BodyToolPreset = 'ball' | 'block'
export type BlockToolShape =
  'rectangle' | 'freeform' | 'quarterRamp' | 'semicircleCutout' | 'quarterCircleCutout' | 'triangle'
export type FieldToolPreset = 'uniformGravity' | 'uniformElectric' | 'uniformMagnetic'
export type FieldRegionToolShape = 'rectangle' | 'circle' | 'freeform' | 'infinite'
export type ConnectorToolPreset = 'rope' | 'rod' | 'spring'
export type ParticleSourceToolShape = 'point' | 'line'

interface EditorState {
  activeTool: EditorTool
  groundToolShape: 'line' | 'arc' | 'cubicBezier'
  bodyToolPreset: BodyToolPreset
  blockToolShape: BlockToolShape
  triangleAngleDeg: number
  fieldToolPreset: FieldToolPreset
  fieldRegionToolShape: FieldRegionToolShape
  connectorToolPreset: ConnectorToolPreset
  particleSourceToolShape: ParticleSourceToolShape
  gridVisible: boolean
  snapEnabled: boolean
  wallSnapEnabled: boolean
  blockSnapEnabled: boolean
  autoGroundJointEnabled: boolean
  camera: Camera2D
  cursorWorld: Vec2
  selectedIds: EntityId[]
  previewEntities: Record<EntityId, SceneEntity>
  draftEntity: SceneEntity | null
  marquee: { start: Vec2; end: Vec2 } | null
  connectorStartEndpoint: ConnectorEndpoint | null
  groundJointStart: GroundEndpointRef | null
  groundJointHover: GroundEndpointRef | null
  pendingGroundEndpoint: GroundEndpointRef | null
  groundJointMessage: string | null
  setActiveTool: (tool: EditorTool) => void
  setGroundToolShape: (shape: 'line' | 'arc' | 'cubicBezier') => void
  setBodyToolPreset: (preset: BodyToolPreset) => void
  setBlockToolShape: (shape: BlockToolShape) => void
  setTriangleAngleDeg: (angleDeg: number) => void
  setFieldToolPreset: (preset: FieldToolPreset) => void
  setFieldRegionToolShape: (shape: FieldRegionToolShape) => void
  setConnectorToolPreset: (preset: ConnectorToolPreset) => void
  setParticleSourceToolShape: (shape: ParticleSourceToolShape) => void
  toggleGrid: () => void
  toggleSnap: () => void
  toggleWallSnap: () => void
  toggleBlockSnap: () => void
  toggleAutoGroundJoint: () => void
  setCamera: (camera: Camera2D) => void
  setCursorWorld: (cursorWorld: Vec2) => void
  setSelectedIds: (selectedIds: EntityId[]) => void
  toggleSelectedId: (entityId: EntityId) => void
  clearSelection: () => void
  setPreviewEntities: (entities: SceneEntity[]) => void
  clearPreview: () => void
  setDraftEntity: (draftEntity: SceneEntity | null) => void
  setMarquee: (marquee: { start: Vec2; end: Vec2 } | null) => void
  setConnectorStartEndpoint: (endpoint: ConnectorEndpoint | null) => void
  setGroundJointStart: (endpoint: GroundEndpointRef | null) => void
  setGroundJointHover: (endpoint: GroundEndpointRef | null) => void
  setPendingGroundEndpoint: (endpoint: GroundEndpointRef | null) => void
  setGroundJointMessage: (message: string | null) => void
  resetForDocument: () => void
}

export const useEditorStore = create<EditorState>((set) => ({
  activeTool: 'select',
  groundToolShape: 'line',
  bodyToolPreset: 'ball',
  blockToolShape: 'rectangle',
  triangleAngleDeg: 30,
  fieldToolPreset: 'uniformGravity',
  fieldRegionToolShape: 'rectangle',
  connectorToolPreset: 'rope',
  particleSourceToolShape: 'point',
  gridVisible: true,
  snapEnabled: true,
  wallSnapEnabled: true,
  blockSnapEnabled: true,
  autoGroundJointEnabled: true,
  camera: defaultCamera,
  cursorWorld: { x: 0, y: 0 },
  selectedIds: [],
  previewEntities: {},
  draftEntity: null,
  marquee: null,
  connectorStartEndpoint: null,
  groundJointStart: null,
  groundJointHover: null,
  pendingGroundEndpoint: null,
  groundJointMessage: null,
  setActiveTool: (activeTool) =>
    set((state) => ({
      activeTool,
      connectorStartEndpoint: activeTool === 'connector' ? state.connectorStartEndpoint : null,
      groundJointStart: activeTool === 'groundJoint' ? state.groundJointStart : null,
      groundJointHover: activeTool === 'groundJoint' ? state.groundJointHover : null,
      pendingGroundEndpoint: null,
      groundJointMessage: activeTool === 'groundJoint' ? state.groundJointMessage : null,
      draftEntity: null,
      marquee: null,
      previewEntities: {},
    })),
  setGroundToolShape: (groundToolShape) => set({ groundToolShape }),
  setBodyToolPreset: (bodyToolPreset) => set({ bodyToolPreset }),
  setBlockToolShape: (blockToolShape) => set({ blockToolShape }),
  setTriangleAngleDeg: (triangleAngleDeg) =>
    set({ triangleAngleDeg: Math.min(85, Math.max(5, triangleAngleDeg)) }),
  setFieldToolPreset: (fieldToolPreset) => set({ fieldToolPreset }),
  setFieldRegionToolShape: (fieldRegionToolShape) => set({ fieldRegionToolShape }),
  setConnectorToolPreset: (connectorToolPreset) => set({ connectorToolPreset }),
  setParticleSourceToolShape: (particleSourceToolShape) => set({ particleSourceToolShape }),
  toggleGrid: () => set((state) => ({ gridVisible: !state.gridVisible })),
  toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),
  toggleWallSnap: () => set((state) => ({ wallSnapEnabled: !state.wallSnapEnabled })),
  toggleBlockSnap: () => set((state) => ({ blockSnapEnabled: !state.blockSnapEnabled })),
  toggleAutoGroundJoint: () =>
    set((state) => ({ autoGroundJointEnabled: !state.autoGroundJointEnabled })),
  setCamera: (camera) => set({ camera }),
  setCursorWorld: (cursorWorld) => set({ cursorWorld }),
  setSelectedIds: (selectedIds) => set({ selectedIds }),
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
  setConnectorStartEndpoint: (connectorStartEndpoint) => set({ connectorStartEndpoint }),
  setGroundJointStart: (groundJointStart) => set({ groundJointStart }),
  setGroundJointHover: (groundJointHover) => set({ groundJointHover }),
  setPendingGroundEndpoint: (pendingGroundEndpoint) => set({ pendingGroundEndpoint }),
  setGroundJointMessage: (groundJointMessage) => set({ groundJointMessage }),
  resetForDocument: () =>
    set({
      camera: defaultCamera,
      cursorWorld: { x: 0, y: 0 },
      selectedIds: [],
      previewEntities: {},
      draftEntity: null,
      marquee: null,
      connectorStartEndpoint: null,
      groundJointStart: null,
      groundJointHover: null,
      pendingGroundEndpoint: null,
      groundJointMessage: null,
    }),
}))
