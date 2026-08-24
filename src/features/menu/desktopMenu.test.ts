import { describe, expect, it } from 'vitest'

import { createDesktopMenuModel, type DesktopMenuState, type MenuModel } from './desktopMenu'

function findMenuItem(items: MenuModel[], id: string): MenuModel | undefined {
  for (const menuItem of items) {
    if (menuItem.id === id) return menuItem
    if (menuItem.kind === 'submenu') {
      const nestedItem = findMenuItem(menuItem.items, id)
      if (nestedItem) return nestedItem
    }
  }
  return undefined
}

const baseState: DesktopMenuState = {
  canUndo: true,
  canRedo: false,
  canPaste: true,
  hasSelection: true,
  hasChartData: false,
  simulationLocked: false,
  modalLocked: false,
  globalVariablesDisabled: false,
  gridVisible: true,
  snapEnabled: false,
  panelVisibility: {
    tools: true,
    layers: true,
    inspector: false,
    charts: true,
  },
  recentFiles: [],
}

describe('桌面系统菜单模型', () => {
  it('映射文件、编辑、视图、模拟和帮助命令', () => {
    const model = createDesktopMenuModel(baseState)
    expect(model.map((menu) => ('text' in menu ? menu.text : ''))).toEqual([
      '文件',
      '编辑',
      '视图',
      '模拟',
      '帮助',
    ])
    expect(JSON.stringify(model)).toContain('file:save')
    expect(JSON.stringify(model)).toContain('simulation:step')
    expect(JSON.stringify(model)).toContain('help:about')
  })

  it('模态窗口打开时只保留退出命令', () => {
    const model = createDesktopMenuModel({ ...baseState, modalLocked: true })
    expect(findMenuItem(model, 'file-exit')).not.toHaveProperty('enabled', false)
    expect(findMenuItem(model, 'file-save')).toMatchObject({ enabled: false })
    expect(findMenuItem(model, 'simulation-step')).toMatchObject({
      command: 'simulation:step',
      enabled: false,
    })
  })

  it('同步启用、勾选状态和最近文件', () => {
    const model = createDesktopMenuModel({
      ...baseState,
      simulationLocked: true,
      recentFiles: [
        {
          id: 'recent-id',
          fileName: '斜面实验.motionstudio',
          pathLabel: 'C:\\实验\\斜面实验.motionstudio',
          lastOpenedAt: 1,
        },
      ],
    })
    const serialized = JSON.stringify(model)
    expect(serialized).toContain('斜面实验.motionstudio')
    expect(serialized).toContain('C:\\\\实验\\\\斜面实验.motionstudio')
    expect(serialized).toContain('"id":"edit-undo"')
    expect(serialized).toContain('"enabled":false')
    expect(serialized).toContain('"id":"view-grid"')
    expect(serialized).toContain('"checked":true')
  })
})
