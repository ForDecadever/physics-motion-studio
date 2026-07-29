import { create } from 'zustand'

import {
  WORKSPACE_LAYOUT_STORAGE_KEY,
  bringWorkspacePanelToFront,
  createDefaultWorkspaceLayout,
  repairWorkspaceLayout,
  setWorkspacePanelCollapsed,
  setWorkspacePanelVisibility,
  type WorkspaceBounds,
  type WorkspaceLayoutV1,
  type WorkspacePanelId,
} from '../features/workspace/workspaceLayout'

const LEGACY_PANEL_SIZES_KEY = 'motion-studio:panel-sizes'
const fallbackBounds: WorkspaceBounds = { width: 1280, height: 720 }

interface WorkspaceLayoutState {
  layout: WorkspaceLayoutV1
  bounds: WorkspaceBounds
  setBounds: (bounds: WorkspaceBounds) => void
  replaceLayout: (layout: WorkspaceLayoutV1) => void
  setPanelVisible: (panelId: WorkspacePanelId, visible: boolean) => void
  togglePanelVisible: (panelId: WorkspacePanelId) => void
  setPanelCollapsed: (panelId: WorkspacePanelId, collapsed: boolean) => void
  bringPanelToFront: (panelId: WorkspacePanelId) => void
  resetLayout: () => void
}

function readLegacyPanelSizes(): { right?: number; chart?: number } {
  if (typeof window === 'undefined') return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LEGACY_PANEL_SIZES_KEY) ?? '')
    if (!parsed || typeof parsed !== 'object') return {}
    const legacy: { right?: number; chart?: number } = {}
    if (Number.isFinite(parsed.right)) legacy.right = Number(parsed.right)
    if (Number.isFinite(parsed.chart)) legacy.chart = Number(parsed.chart)
    return legacy
  } catch {
    return {}
  }
}

function initialBounds(): WorkspaceBounds {
  if (typeof window === 'undefined') return fallbackBounds
  return {
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight - 119),
  }
}

function readInitialLayout(bounds: WorkspaceBounds): WorkspaceLayoutV1 {
  const legacy = readLegacyPanelSizes()
  if (typeof window === 'undefined') return repairWorkspaceLayout(undefined, bounds, legacy)
  try {
    const stored = window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)
    return repairWorkspaceLayout(stored ? JSON.parse(stored) : undefined, bounds, legacy)
  } catch {
    return repairWorkspaceLayout(undefined, bounds, legacy)
  }
}

function persistLayout(layout: WorkspaceLayoutV1): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // Layout preferences are optional; a blocked storage area must not affect editing.
  }
}

const startupBounds = initialBounds()

export const useWorkspaceLayoutStore = create<WorkspaceLayoutState>((set, get) => ({
  bounds: startupBounds,
  layout: readInitialLayout(startupBounds),
  setBounds: (bounds) =>
    set((state) => {
      if (state.bounds.width === bounds.width && state.bounds.height === bounds.height) return state
      const repaired = repairWorkspaceLayout(state.layout, bounds)
      persistLayout(repaired)
      return { bounds, layout: repaired }
    }),
  replaceLayout: (layout) =>
    set((state) => {
      const repaired = repairWorkspaceLayout(layout, state.bounds)
      persistLayout(repaired)
      return { layout: repaired }
    }),
  setPanelVisible: (panelId, visible) =>
    set((state) => {
      const layout = setWorkspacePanelVisibility(state.layout, panelId, visible)
      persistLayout(layout)
      return { layout }
    }),
  togglePanelVisible: (panelId) =>
    get().setPanelVisible(panelId, !get().layout.panels[panelId].visible),
  setPanelCollapsed: (panelId, collapsed) =>
    set((state) => {
      const layout = setWorkspacePanelCollapsed(state.layout, panelId, collapsed)
      persistLayout(layout)
      return { layout }
    }),
  bringPanelToFront: (panelId) =>
    set((state) => {
      const layout = bringWorkspacePanelToFront(state.layout, panelId)
      persistLayout(layout)
      return { layout }
    }),
  resetLayout: () =>
    set((state) => {
      const layout = repairWorkspaceLayout(createDefaultWorkspaceLayout(), state.bounds)
      persistLayout(layout)
      return { layout }
    }),
}))
