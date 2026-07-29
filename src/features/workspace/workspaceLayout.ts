export const WORKSPACE_LAYOUT_STORAGE_KEY = 'motion-studio:workspace-layout:v1'
export const WORKSPACE_LAYOUT_VERSION = 1 as const

export type WorkspacePanelId = 'tools' | 'layers' | 'inspector' | 'charts'
export type DockEdge = 'left' | 'right' | 'bottom'
export type ResizeDirection =
  'north' | 'northEast' | 'east' | 'southEast' | 'south' | 'southWest' | 'west' | 'northWest'

export interface WorkspaceBounds {
  width: number
  height: number
}

export interface FloatingRect {
  x: number
  y: number
  width: number
  height: number
}

export type PanelPlacement =
  | { mode: 'docked'; edge: DockEdge; order: number; weight: number }
  | { mode: 'floating'; rect: FloatingRect }

export interface WorkspacePanelLayout {
  visible: boolean
  collapsed: boolean
  z: number
  placement: PanelPlacement
}

export interface WorkspaceLayoutV1 {
  version: typeof WORKSPACE_LAYOUT_VERSION
  dockSizes: Record<DockEdge, number>
  panels: Record<WorkspacePanelId, WorkspacePanelLayout>
}

export interface LegacyPanelSizes {
  right?: number
  chart?: number
}

export const WORKSPACE_PANEL_IDS: readonly WorkspacePanelId[] = [
  'tools',
  'layers',
  'inspector',
  'charts',
]

const panelMinimums: Record<WorkspacePanelId, { width: number; height: number }> = {
  tools: { width: 64, height: 220 },
  layers: { width: 240, height: 180 },
  inspector: { width: 240, height: 180 },
  charts: { width: 360, height: 240 },
}

function dockMinimum(panelId: WorkspacePanelId, edge: DockEdge): number {
  return edge === 'bottom' ? panelMinimums[panelId].height : panelMinimums[panelId].width
}

function docked(edge: DockEdge, order: number, weight = 1): PanelPlacement {
  return { mode: 'docked', edge, order, weight }
}

export function createDefaultWorkspaceLayout(legacy: LegacyPanelSizes = {}): WorkspaceLayoutV1 {
  return {
    version: WORKSPACE_LAYOUT_VERSION,
    dockSizes: {
      left: 64,
      right: clampFinite(legacy.right, 240, 540, 296),
      bottom: clampFinite(legacy.chart, 140, 520, 184),
    },
    panels: {
      tools: { visible: true, collapsed: false, z: 1, placement: docked('left', 0) },
      layers: { visible: true, collapsed: false, z: 2, placement: docked('right', 0, 0.42) },
      inspector: {
        visible: true,
        collapsed: false,
        z: 3,
        placement: docked('right', 1, 0.58),
      },
      charts: { visible: true, collapsed: false, z: 4, placement: docked('bottom', 0) },
    },
  }
}

export function setWorkspacePanelVisibility(
  layout: WorkspaceLayoutV1,
  panelId: WorkspacePanelId,
  visible: boolean,
): WorkspaceLayoutV1 {
  return {
    ...layout,
    panels: {
      ...layout.panels,
      [panelId]: { ...layout.panels[panelId], visible },
    },
  }
}

export function setWorkspacePanelCollapsed(
  layout: WorkspaceLayoutV1,
  panelId: WorkspacePanelId,
  collapsed: boolean,
): WorkspaceLayoutV1 {
  return {
    ...layout,
    panels: {
      ...layout.panels,
      [panelId]: { ...layout.panels[panelId], collapsed },
    },
  }
}

export function bringWorkspacePanelToFront(
  layout: WorkspaceLayoutV1,
  panelId: WorkspacePanelId,
): WorkspaceLayoutV1 {
  const maximumZ = Math.max(...WORKSPACE_PANEL_IDS.map((candidate) => layout.panels[candidate].z))
  return {
    ...layout,
    panels: {
      ...layout.panels,
      [panelId]: { ...layout.panels[panelId], z: maximumZ + 1 },
    },
  }
}

export function dockWorkspacePanel(
  layout: WorkspaceLayoutV1,
  panelId: WorkspacePanelId,
  edge: DockEdge,
  insertAt = Number.POSITIVE_INFINITY,
): WorkspaceLayoutV1 {
  const existing = WORKSPACE_PANEL_IDS.filter((candidate) => candidate !== panelId)
    .filter((candidate) => {
      const placement = layout.panels[candidate].placement
      return placement.mode === 'docked' && placement.edge === edge
    })
    .sort((first, second) => {
      const firstPlacement = layout.panels[first].placement
      const secondPlacement = layout.panels[second].placement
      return (
        (firstPlacement.mode === 'docked' ? firstPlacement.order : 0) -
        (secondPlacement.mode === 'docked' ? secondPlacement.order : 0)
      )
    })
  const targetIndex = Math.max(0, Math.min(existing.length, Math.floor(insertAt)))
  existing.splice(targetIndex, 0, panelId)
  const nextPanels = { ...layout.panels }
  existing.forEach((candidate, order) => {
    nextPanels[candidate] = {
      ...nextPanels[candidate],
      visible: true,
      placement: docked(edge, order, 1 / existing.length),
    }
  })
  return {
    ...layout,
    dockSizes: {
      ...layout.dockSizes,
      [edge]: Math.max(layout.dockSizes[edge], ...existing.map((id) => dockMinimum(id, edge))),
    },
    panels: nextPanels,
  }
}

export function floatWorkspacePanel(
  layout: WorkspaceLayoutV1,
  panelId: WorkspacePanelId,
  rect: FloatingRect,
  bounds: WorkspaceBounds,
): WorkspaceLayoutV1 {
  const z = Math.max(...WORKSPACE_PANEL_IDS.map((candidate) => layout.panels[candidate].z)) + 1
  return {
    ...layout,
    panels: {
      ...layout.panels,
      [panelId]: {
        ...layout.panels[panelId],
        visible: true,
        z,
        placement: { mode: 'floating', rect: clampFloatingRect(panelId, rect, bounds) },
      },
    },
  }
}

export function moveFloatingPanel(
  layout: WorkspaceLayoutV1,
  panelId: WorkspacePanelId,
  delta: { x: number; y: number },
  bounds: WorkspaceBounds,
): WorkspaceLayoutV1 {
  const panel = layout.panels[panelId]
  if (panel.placement.mode !== 'floating') return layout
  const start = panel.placement.rect
  const rect = clampFloatingRect(
    panelId,
    {
      ...start,
      x: start.x + delta.x,
      y: start.y + delta.y,
    },
    bounds,
  )
  return {
    ...layout,
    panels: {
      ...layout.panels,
      [panelId]: { ...panel, placement: { mode: 'floating', rect } },
    },
  }
}

export function resizeDockEdge(
  layout: WorkspaceLayoutV1,
  edge: DockEdge,
  size: number,
  bounds: WorkspaceBounds,
): WorkspaceLayoutV1 {
  return repairWorkspaceLayout(
    {
      ...layout,
      dockSizes: {
        ...layout.dockSizes,
        [edge]: size,
      },
    },
    bounds,
  )
}

export function resizeDockedPanelPair(
  layout: WorkspaceLayoutV1,
  firstId: WorkspacePanelId,
  secondId: WorkspacePanelId,
  deltaRatio: number,
): WorkspaceLayoutV1 {
  const first = layout.panels[firstId]
  const second = layout.panels[secondId]
  if (first.placement.mode !== 'docked' || second.placement.mode !== 'docked') return layout
  if (first.placement.edge !== second.placement.edge) return layout
  const total = first.placement.weight + second.placement.weight
  if (!Number.isFinite(total) || total <= 0) return layout
  const minimum = total * 0.15
  const firstWeight = clampFinite(
    first.placement.weight + deltaRatio,
    minimum,
    total - minimum,
    total / 2,
  )
  const secondWeight = total - firstWeight
  return {
    ...layout,
    panels: {
      ...layout.panels,
      [firstId]: {
        ...first,
        placement: { ...first.placement, weight: firstWeight },
      },
      [secondId]: {
        ...second,
        placement: { ...second.placement, weight: secondWeight },
      },
    },
  }
}

export function resizeFloatingPanel(
  layout: WorkspaceLayoutV1,
  panelId: WorkspacePanelId,
  direction: ResizeDirection,
  delta: { x: number; y: number },
  bounds: WorkspaceBounds,
): WorkspaceLayoutV1 {
  const panel = layout.panels[panelId]
  if (panel.placement.mode !== 'floating') return layout
  const start = panel.placement.rect
  const minimum = panelMinimums[panelId]
  const changesWest = direction === 'west' || direction === 'northWest' || direction === 'southWest'
  const changesEast = direction === 'east' || direction === 'northEast' || direction === 'southEast'
  const changesNorth =
    direction === 'north' || direction === 'northWest' || direction === 'northEast'
  const changesSouth =
    direction === 'south' || direction === 'southWest' || direction === 'southEast'
  let left = start.x + (changesWest ? delta.x : 0)
  let right = start.x + start.width + (changesEast ? delta.x : 0)
  let top = start.y + (changesNorth ? delta.y : 0)
  let bottom = start.y + start.height + (changesSouth ? delta.y : 0)

  if (right - left < minimum.width) {
    if (changesWest) left = right - minimum.width
    else right = left + minimum.width
  }
  if (bottom - top < minimum.height) {
    if (changesNorth) top = bottom - minimum.height
    else bottom = top + minimum.height
  }
  const rect = clampFloatingRect(
    panelId,
    { x: left, y: top, width: right - left, height: bottom - top },
    bounds,
  )
  return {
    ...layout,
    panels: {
      ...layout.panels,
      [panelId]: { ...panel, placement: { mode: 'floating', rect } },
    },
  }
}

export function repairWorkspaceLayout(
  value: unknown,
  bounds: WorkspaceBounds,
  legacy: LegacyPanelSizes = {},
): WorkspaceLayoutV1 {
  if (!isWorkspaceLayout(value)) {
    return repairWorkspaceLayout(createDefaultWorkspaceLayout(legacy), bounds)
  }
  const layout = structuredClone(value)
  const maximumSide = Math.max(64, bounds.width * 0.45)
  layout.dockSizes.left = clampFinite(layout.dockSizes.left, 64, maximumSide, 64)
  layout.dockSizes.right = clampFinite(layout.dockSizes.right, 240, maximumSide, 296)
  const maximumCombined = Math.max(304, bounds.width - 320)
  const combined = layout.dockSizes.left + layout.dockSizes.right
  if (combined > maximumCombined) {
    const ratio = maximumCombined / combined
    layout.dockSizes.left *= ratio
    layout.dockSizes.right *= ratio
  }
  layout.dockSizes.bottom = clampFinite(
    layout.dockSizes.bottom,
    35,
    Math.max(35, bounds.height - 160),
    184,
  )
  for (const panelId of WORKSPACE_PANEL_IDS) {
    const panel = layout.panels[panelId]
    if (panel.placement.mode === 'floating') {
      panel.placement.rect = clampFloatingRect(panelId, panel.placement.rect, bounds)
    }
  }
  return layout
}

export function clampFloatingRect(
  panelId: WorkspacePanelId,
  rect: FloatingRect,
  bounds: WorkspaceBounds,
): FloatingRect {
  const minimum = panelMinimums[panelId]
  const width = Math.min(
    Math.max(minimum.width, finiteOr(rect.width, minimum.width)),
    Math.max(1, bounds.width),
  )
  const height = Math.min(
    Math.max(minimum.height, finiteOr(rect.height, minimum.height)),
    Math.max(1, bounds.height),
  )
  return {
    x: clampFinite(rect.x, 0, Math.max(0, bounds.width - width), 0),
    y: clampFinite(rect.y, 0, Math.max(0, bounds.height - height), 0),
    width,
    height,
  }
}

function isWorkspaceLayout(value: unknown): value is WorkspaceLayoutV1 {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WorkspaceLayoutV1>
  if (candidate.version !== WORKSPACE_LAYOUT_VERSION || !candidate.dockSizes || !candidate.panels) {
    return false
  }
  return WORKSPACE_PANEL_IDS.every((panelId) => {
    const panel = candidate.panels?.[panelId]
    if (!panel || typeof panel.visible !== 'boolean' || typeof panel.collapsed !== 'boolean') {
      return false
    }
    if (!Number.isFinite(panel.z)) return false
    const placement = panel.placement
    if (!placement || (placement.mode !== 'docked' && placement.mode !== 'floating')) return false
    if (placement.mode === 'docked') {
      return (
        ['left', 'right', 'bottom'].includes(placement.edge) &&
        Number.isFinite(placement.order) &&
        Number.isFinite(placement.weight)
      )
    }
    return Object.values(placement.rect).every(Number.isFinite)
  })
}

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback
}

function clampFinite(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Math.min(maximum, Math.max(minimum, finiteOr(value, fallback)))
}
