import { describe, expect, it } from 'vitest'

import {
  bringWorkspacePanelToFront,
  createDefaultWorkspaceLayout,
  dockWorkspacePanel,
  floatWorkspacePanel,
  moveFloatingPanel,
  repairWorkspaceLayout,
  resizeDockEdge,
  resizeDockedPanelPair,
  resizeFloatingPanel,
  setWorkspacePanelCollapsed,
  setWorkspacePanelVisibility,
} from './workspaceLayout'

const bounds = { width: 1200, height: 700 }

describe('工作区面板布局', () => {
  it('建立工具左置、图层属性右置、图像底置的默认布局', () => {
    const layout = createDefaultWorkspaceLayout()

    expect(layout.version).toBe(1)
    expect(layout.panels.tools.placement).toMatchObject({ mode: 'docked', edge: 'left' })
    expect(layout.panels.layers.placement).toMatchObject({
      mode: 'docked',
      edge: 'right',
      order: 0,
    })
    expect(layout.panels.inspector.placement).toMatchObject({
      mode: 'docked',
      edge: 'right',
      order: 1,
    })
    expect(layout.panels.charts.placement).toMatchObject({ mode: 'docked', edge: 'bottom' })
  })

  it('迁移旧右栏宽度和图像高度', () => {
    const layout = createDefaultWorkspaceLayout({ right: 420, chart: 280 })

    expect(layout.dockSizes.right).toBe(420)
    expect(layout.dockSizes.bottom).toBe(280)
  })

  it('迁移旧尺寸时会按当前窗口修复越界布局', () => {
    const layout = repairWorkspaceLayout(
      undefined,
      { width: 1024, height: 500 },
      {
        right: 540,
        chart: 520,
      },
    )

    expect(layout.dockSizes.bottom).toBeLessThanOrEqual(340)
    expect(layout.dockSizes.left + layout.dockSizes.right).toBeLessThanOrEqual(704)
  })

  it('隐藏和恢复面板时保留原位置', () => {
    const layout = createDefaultWorkspaceLayout()
    const hidden = setWorkspacePanelVisibility(layout, 'layers', false)
    const restored = setWorkspacePanelVisibility(hidden, 'layers', true)

    expect(hidden.panels.layers.visible).toBe(false)
    expect(restored.panels.layers).toEqual(layout.panels.layers)
  })

  it('浮窗会夹紧到工作区并遵守各面板最小尺寸', () => {
    const layout = floatWorkspacePanel(
      createDefaultWorkspaceLayout(),
      'charts',
      { x: -40, y: 620, width: 100, height: 80 },
      bounds,
    )
    const placement = layout.panels.charts.placement

    expect(placement.mode).toBe('floating')
    if (placement.mode !== 'floating') return
    expect(placement.rect).toEqual({ x: 0, y: 460, width: 360, height: 240 })
  })

  it('八方向缩放夹紧最小尺寸和边界', () => {
    const floating = floatWorkspacePanel(
      createDefaultWorkspaceLayout(),
      'layers',
      { x: 100, y: 100, width: 300, height: 260 },
      bounds,
    )
    const resized = resizeFloatingPanel(floating, 'layers', 'northWest', { x: 200, y: 200 }, bounds)
    const placement = resized.panels.layers.placement

    expect(placement.mode).toBe('floating')
    if (placement.mode !== 'floating') return
    expect(placement.rect).toEqual({ x: 160, y: 180, width: 240, height: 180 })
  })

  it('停靠时按插入位置重排同边面板', () => {
    const layout = dockWorkspacePanel(createDefaultWorkspaceLayout(), 'charts', 'right', 1)

    expect(layout.panels.layers.placement).toMatchObject({ edge: 'right', order: 0 })
    expect(layout.panels.charts.placement).toMatchObject({ edge: 'right', order: 1 })
    expect(layout.panels.inspector.placement).toMatchObject({ edge: 'right', order: 2 })
  })

  it('移动浮窗时保持在工作区内，点击面板会把它置顶', () => {
    const first = floatWorkspacePanel(
      createDefaultWorkspaceLayout(),
      'layers',
      { x: 100, y: 100, width: 280, height: 220 },
      bounds,
    )
    const moved = moveFloatingPanel(first, 'layers', { x: 2000, y: -300 }, bounds)
    const front = bringWorkspacePanelToFront(moved, 'tools')
    const placement = moved.panels.layers.placement

    expect(placement.mode).toBe('floating')
    if (placement.mode !== 'floating') return
    expect(placement.rect).toEqual({ x: 920, y: 0, width: 280, height: 220 })
    expect(front.panels.tools.z).toBeGreaterThan(front.panels.layers.z)
  })

  it('限制停靠边缘尺寸并保留中央画布', () => {
    const layout = resizeDockEdge(createDefaultWorkspaceLayout(), 'right', 1000, bounds)

    expect(layout.dockSizes.right).toBe(540)
    expect(layout.dockSizes.left + layout.dockSizes.right).toBeLessThanOrEqual(880)
  })

  it('折叠图像面板时保留原停靠信息', () => {
    const layout = createDefaultWorkspaceLayout()
    const collapsed = setWorkspacePanelCollapsed(layout, 'charts', true)

    expect(collapsed.panels.charts.collapsed).toBe(true)
    expect(collapsed.panels.charts.placement).toEqual(layout.panels.charts.placement)
  })

  it('拖动同一停靠区内的分隔条时只调整相邻面板比例', () => {
    const layout = createDefaultWorkspaceLayout()
    const resized = resizeDockedPanelPair(layout, 'layers', 'inspector', 0.2)
    const layers = resized.panels.layers.placement
    const inspector = resized.panels.inspector.placement

    expect(layers).toMatchObject({ mode: 'docked', weight: 0.62 })
    expect(inspector).toMatchObject({ mode: 'docked', weight: 0.38 })
  })

  it('损坏或未知版本的布局回退默认值并限制停靠尺寸', () => {
    const repaired = repairWorkspaceLayout(
      {
        version: 99,
        dockSizes: { left: 900, right: 900, bottom: 900 },
        panels: {},
      },
      bounds,
    )

    expect(repaired).toEqual(createDefaultWorkspaceLayout())
  })
})
