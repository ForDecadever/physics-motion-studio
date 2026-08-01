import {
  CheckMenuItem,
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
  type IconMenuItem,
} from '@tauri-apps/api/menu'

import type { RecentSceneEntry } from '../../persistence/sceneFileService'
import type { WorkspacePanelId } from '../workspace/workspaceLayout'

export type AppCommand =
  | 'file:new'
  | 'file:open'
  | 'file:save'
  | 'file:save-as'
  | 'file:export-csv'
  | 'file:export-gif'
  | 'file:exit'
  | 'edit:undo'
  | 'edit:redo'
  | 'edit:copy'
  | 'edit:paste'
  | 'edit:delete'
  | 'edit:select-all'
  | 'view:toggle-grid'
  | 'view:toggle-snap'
  | `view:toggle-panel:${WorkspacePanelId}`
  | 'view:reset-layout'
  | 'simulation:play-pause'
  | 'simulation:step'
  | 'simulation:reset'
  | 'simulation:clear-records'
  | 'help:shortcuts'
  | 'help:physics'
  | 'help:about'

export type MenuModel =
  | {
      kind: 'item'
      id: string
      text: string
      command: AppCommand
      enabled?: boolean
    }
  | {
      kind: 'check'
      id: string
      text: string
      command: AppCommand
      checked: boolean
      enabled?: boolean
    }
  | { kind: 'separator'; id: string }
  | { kind: 'submenu'; id: string; text: string; items: MenuModel[]; enabled?: boolean }
  | { kind: 'recent'; id: string; text: string; recentId: string; enabled?: boolean }

export interface DesktopMenuState {
  canUndo: boolean
  canRedo: boolean
  canPaste: boolean
  hasSelection: boolean
  hasChartData: boolean
  simulationLocked: boolean
  modalLocked: boolean
  gridVisible: boolean
  snapEnabled: boolean
  panelVisibility: Record<WorkspacePanelId, boolean>
  recentFiles: RecentSceneEntry[]
}

export interface DesktopMenuHandlers {
  execute: (command: AppCommand) => void
  openRecent: (id: string) => void
  clearRecent: () => void
}

function item(
  id: string,
  text: string,
  command: AppCommand,
  options: { enabled?: boolean } = {},
): MenuModel {
  return { kind: 'item', id, text, command, ...options }
}

function applyModalLock(model: MenuModel): MenuModel {
  if (model.id === 'file-exit' || model.kind === 'separator') return model
  if (model.kind === 'submenu') {
    if (model.id === 'file') {
      return {
        ...model,
        items: model.items.map(applyModalLock),
      }
    }
    return {
      ...model,
      enabled: false,
      items: model.items.map(applyModalLock),
    }
  }
  return { ...model, enabled: false }
}

export function createDesktopMenuModel(state: DesktopMenuState): MenuModel[] {
  const recentItems: MenuModel[] =
    state.recentFiles.length > 0
      ? [
          ...state.recentFiles.map((entry): MenuModel => ({
            kind: 'recent',
            id: `recent-${entry.id}`,
            text: `${entry.fileName} — ${entry.pathLabel}`,
            recentId: entry.id,
          })),
          { kind: 'separator', id: 'recent-separator' },
          item('file-clear-recent', '清除最近文件', 'file:open'),
        ]
      : [
          {
            kind: 'submenu',
            id: 'recent-empty',
            text: '暂无最近文件',
            enabled: false,
            items: [],
          },
        ]

  const models: MenuModel[] = [
    {
      kind: 'submenu',
      id: 'file',
      text: '文件',
      items: [
        item('file-new', '新建场景', 'file:new'),
        item('file-open', '打开…', 'file:open'),
        {
          kind: 'submenu',
          id: 'file-open-recent',
          text: '最近文件',
          items: recentItems,
        },
        { kind: 'separator', id: 'file-separator-save' },
        item('file-save', '保存', 'file:save'),
        item('file-save-as', '另存为…', 'file:save-as'),
        item('file-export-csv', '导出记录 CSV', 'file:export-csv', {
          enabled: state.hasChartData,
        }),
        item('file-export-gif', '导出动图 GIF', 'file:export-gif'),
        { kind: 'separator', id: 'file-separator-exit' },
        item('file-exit', '退出', 'file:exit'),
      ],
    },
    {
      kind: 'submenu',
      id: 'edit',
      text: '编辑',
      items: [
        item('edit-undo', '撤销', 'edit:undo', {
          enabled: state.canUndo && !state.simulationLocked,
        }),
        item('edit-redo', '重做', 'edit:redo', {
          enabled: state.canRedo && !state.simulationLocked,
        }),
        { kind: 'separator', id: 'edit-separator-clipboard' },
        item('edit-copy', '复制', 'edit:copy', {
          enabled: state.hasSelection,
        }),
        item('edit-paste', '粘贴', 'edit:paste', {
          enabled: state.canPaste && !state.simulationLocked,
        }),
        item('edit-delete', '删除', 'edit:delete', {
          enabled: state.hasSelection && !state.simulationLocked,
        }),
        item('edit-select-all', '全选', 'edit:select-all'),
      ],
    },
    {
      kind: 'submenu',
      id: 'view',
      text: '视图',
      items: [
        {
          kind: 'check',
          id: 'view-grid',
          text: '显示网格',
          command: 'view:toggle-grid',
          checked: state.gridVisible,
        },
        {
          kind: 'check',
          id: 'view-snap',
          text: '网格吸附',
          command: 'view:toggle-snap',
          checked: state.snapEnabled,
        },
        { kind: 'separator', id: 'view-separator-panels' },
        {
          kind: 'submenu',
          id: 'view-windows',
          text: '窗口',
          items: [
            ...(
              [
                ['tools', '工具'],
                ['layers', '图层'],
                ['inspector', '属性'],
                ['charts', '图像'],
              ] as const
            ).map(([panelId, text]): MenuModel => ({
              kind: 'check',
              id: `view-panel-${panelId}`,
              text,
              command: `view:toggle-panel:${panelId}`,
              checked: state.panelVisibility[panelId],
            })),
            { kind: 'separator', id: 'view-separator-reset' },
            item('view-reset-layout', '恢复默认布局', 'view:reset-layout'),
          ],
        },
      ],
    },
    {
      kind: 'submenu',
      id: 'simulation',
      text: '模拟',
      items: [
        item('simulation-play-pause', '播放 / 暂停', 'simulation:play-pause'),
        item('simulation-step', '单步', 'simulation:step'),
        item('simulation-reset', '重置模拟', 'simulation:reset'),
        item('simulation-clear-records', '清空记录', 'simulation:clear-records'),
      ],
    },
    {
      kind: 'submenu',
      id: 'help',
      text: '帮助',
      items: [
        item('help-shortcuts', '快捷键与教程', 'help:shortcuts'),
        item('help-physics', '物理模型说明', 'help:physics'),
        { kind: 'separator', id: 'help-separator-about' },
        item('help-about', '关于 Motion Studio', 'help:about'),
      ],
    },
  ]
  return state.modalLocked ? models.map(applyModalLock) : models
}

type NativeMenuItem = Submenu | MenuItem | PredefinedMenuItem | CheckMenuItem | IconMenuItem

interface RegisteredMenuItem {
  kind: MenuModel['kind']
  item: NativeMenuItem
}

interface InstalledDesktopMenu {
  windowMenu: Menu
  registry: Map<string, RegisteredMenuItem>
  recentSubmenu: Submenu | null
  recentChildren: NativeMenuItem[]
}

let installed: InstalledDesktopMenu | null = null
let installQueue: Promise<void> = Promise.resolve()
let lastRecentKey: string | null = null

function recentFilesKey(entries: RecentSceneEntry[]): string {
  return entries.map((entry) => `${entry.id}:${entry.fileName}`).join('|')
}

async function createNativeMenuItem(
  model: MenuModel,
  handlers: DesktopMenuHandlers,
  registry: Map<string, RegisteredMenuItem>,
): Promise<NativeMenuItem> {
  switch (model.kind) {
    case 'separator':
      return PredefinedMenuItem.new({ item: 'Separator' })
    case 'check': {
      const item = await CheckMenuItem.new({
        id: model.id,
        text: model.text,
        checked: model.checked,
        enabled: model.enabled ?? true,
        action: () => handlers.execute(model.command),
      })
      registry.set(model.id, { kind: 'check', item })
      return item
    }
    case 'recent': {
      const item = await MenuItem.new({
        id: model.id,
        text: model.text,
        enabled: model.enabled ?? true,
        action: () => handlers.openRecent(model.recentId),
      })
      registry.set(model.id, { kind: 'recent', item })
      return item
    }
    case 'submenu': {
      const items = await Promise.all(
        model.items.map((child) => createNativeMenuItem(child, handlers, registry)),
      )
      const item = await Submenu.new({
        id: model.id,
        text: model.text,
        enabled: model.enabled ?? true,
        items,
      })
      registry.set(model.id, { kind: 'submenu', item })
      return item
    }
    case 'item': {
      const item = await MenuItem.new({
        id: model.id,
        text: model.text,
        enabled: model.enabled ?? true,
        action:
          model.id === 'file-clear-recent'
            ? () => handlers.clearRecent()
            : () => handlers.execute(model.command),
      })
      registry.set(model.id, { kind: 'item', item })
      return item
    }
  }
}

async function applyMenuState(
  models: MenuModel[],
  registry: Map<string, RegisteredMenuItem>,
): Promise<void> {
  for (const model of models) {
    const registered = registry.get(model.id)
    if (!registered || registered.kind !== model.kind) continue
    const { item } = registered

    if (model.kind === 'check' && item instanceof CheckMenuItem) {
      await item.setChecked(model.checked)
      await item.setEnabled(model.enabled ?? true)
    } else if (model.kind === 'submenu' && item instanceof Submenu) {
      await item.setEnabled(model.enabled ?? true)
      await applyMenuState(model.items, registry)
    } else if (model.kind === 'item' && item instanceof MenuItem) {
      await item.setEnabled(model.enabled ?? true)
    } else if (model.kind === 'recent' && item instanceof MenuItem) {
      await item.setEnabled(model.enabled ?? true)
    }
  }
}

function findFileOpenRecentModel(
  models: MenuModel[],
): Extract<MenuModel, { kind: 'submenu' }> | null {
  const file = models.find(
    (model): model is Extract<MenuModel, { kind: 'submenu' }> =>
      model.kind === 'submenu' && model.id === 'file',
  )
  if (!file) return null
  return (
    file.items.find(
      (model): model is Extract<MenuModel, { kind: 'submenu' }> =>
        model.kind === 'submenu' && model.id === 'file-open-recent',
    ) ?? null
  )
}

async function rebuildRecentFiles(
  current: InstalledDesktopMenu,
  state: DesktopMenuState,
  handlers: DesktopMenuHandlers,
): Promise<void> {
  const recentSubmenu = current.recentSubmenu
  const recentModel = findFileOpenRecentModel(createDesktopMenuModel(state))
  if (!recentSubmenu || !recentModel) return

  for (const child of current.recentChildren) {
    await recentSubmenu.remove(child)
  }
  current.recentChildren = []

  const built = await Promise.all(
    recentModel.items.map((child) => createNativeMenuItem(child, handlers, current.registry)),
  )
  current.recentChildren = built
  await recentSubmenu.append(built)
}

async function applyDesktopMenuState(
  state: DesktopMenuState,
  handlers: DesktopMenuHandlers,
): Promise<void> {
  const current = installed
  if (!current) return

  await applyMenuState(createDesktopMenuModel(state), current.registry)

  const recentKey = recentFilesKey(state.recentFiles)
  if (recentKey !== lastRecentKey) {
    lastRecentKey = recentKey
    await rebuildRecentFiles(current, state, handlers)
  }
}

export function installDesktopMenu(
  state: DesktopMenuState,
  handlers: DesktopMenuHandlers,
): Promise<void> {
  const install = async () => {
    if (!installed) {
      const registry = new Map<string, RegisteredMenuItem>()
      const models = createDesktopMenuModel(state)
      const items = await Promise.all(
        models.map((model) => createNativeMenuItem(model, handlers, registry)),
      )
      const windowMenu = await Menu.new({ id: 'motion-studio-menu', items })
      await windowMenu.setAsWindowMenu()

      const recentEntry = registry.get('file-open-recent')
      const recentSubmenu =
        recentEntry?.kind === 'submenu' && recentEntry.item instanceof Submenu
          ? recentEntry.item
          : null
      installed = {
        windowMenu,
        registry,
        recentSubmenu,
        recentChildren: recentSubmenu ? await recentSubmenu.items() : [],
      }
      lastRecentKey = recentFilesKey(state.recentFiles)
    }

    await applyDesktopMenuState(state, handlers)
  }
  installQueue = installQueue.then(install, install)
  return installQueue
}

export function closeDesktopMenu(): Promise<void> {
  const close = async () => {
    const current = installed
    installed = null
    lastRecentKey = null
    await current?.windowMenu.close()
  }
  installQueue = installQueue.then(close, close)
  return installQueue
}
