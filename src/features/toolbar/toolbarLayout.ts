const TOOLBAR_COLUMN_WIDTH_PX = 42

export interface ToolbarGrid {
  columns: number
  rows: number
}

export function balancedToolbarGrid(itemCount: number, availableWidth: number): ToolbarGrid {
  const safeItemCount = Math.max(0, Math.floor(itemCount))
  const columns = Math.max(
    1,
    Math.min(safeItemCount || 1, Math.floor(availableWidth / TOOLBAR_COLUMN_WIDTH_PX)),
  )
  return {
    columns,
    rows: safeItemCount === 0 ? 0 : Math.ceil(safeItemCount / columns),
  }
}
