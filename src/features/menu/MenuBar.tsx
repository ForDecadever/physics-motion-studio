import {
  Check,
  ChevronRight,
  CircleHelp,
  Clipboard,
  Copy,
  Download,
  FileJson,
  FolderOpen,
  FlaskConical,
  Grid2X2,
  Info,
  Play,
  Redo2,
  RotateCcw,
  Save,
  Settings2,
  SkipForward,
  Trash2,
  Undo2,
} from 'lucide-react'
import type { MouseEvent, ReactNode } from 'react'

import type { WorkspacePanelId } from '../workspace/workspaceLayout'
import styles from './MenuBar.module.css'

interface MenuBarProps {
  navigationVisible?: boolean
  onNew: () => void
  onOpen: () => void
  onSave: () => void
  onSaveAs: () => void
  onExportCsv: () => void
  onExportGif: () => void
  onUndo: () => void
  onRedo: () => void
  onCopy: () => void
  onPaste: () => void
  onDelete: () => void
  onSelectAll: () => void
  onToggleGrid: () => void
  onToggleSnap: () => void
  onPlayPause: () => void
  onStepSimulation: () => void
  onResetSimulation: () => void
  onClearRecords: () => void
  onShowShortcuts: () => void
  onShowPhysics: () => void
  canUndo: boolean
  canRedo: boolean
  canPaste: boolean
  hasSelection: boolean
  hasChartData: boolean
  gridVisible: boolean
  snapEnabled: boolean
  panelVisibility: Record<WorkspacePanelId, boolean>
  onTogglePanel: (panelId: WorkspacePanelId) => void
  onResetWorkspaceLayout: () => void
}

function MenuCheckboxAction({
  checked,
  children,
  onClick,
}: {
  checked: boolean
  children: ReactNode
  onClick: () => void
}) {
  return (
    <button
      className={styles.menuAction}
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={(event) => {
        event.currentTarget.closest('details')?.removeAttribute('open')
        onClick()
      }}
    >
      <span className={styles.menuActionIcon}>{checked ? <Check size={14} /> : null}</span>
      <span>{children}</span>
    </button>
  )
}

function MenuSubmenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.submenu}>
      <button className={styles.menuAction} type="button" role="menuitem" aria-haspopup="menu">
        <span className={styles.menuActionIcon} />
        <span>{label}</span>
        <ChevronRight size={13} />
      </button>
      <div className={styles.submenuPopover} role="menu" aria-label={label}>
        {children}
      </div>
    </div>
  )
}

interface MenuActionProps {
  children: ReactNode
  icon?: ReactNode
  shortcut?: string
  disabled?: boolean
  onClick?: () => void
}

function MenuAction({ children, icon, shortcut, disabled, onClick }: MenuActionProps) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.closest('details')?.removeAttribute('open')
    onClick?.()
  }

  return (
    <button
      className={styles.menuAction}
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={handleClick}
    >
      <span className={styles.menuActionIcon}>{icon}</span>
      <span>{children}</span>
      {shortcut ? <kbd>{shortcut}</kbd> : null}
    </button>
  )
}

function Menu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details
      className={styles.menu}
      onMouseLeave={(event) => event.currentTarget.removeAttribute('open')}
    >
      <summary>{label}</summary>
      <div className={styles.menuPopover} role="menu">
        {children}
      </div>
    </details>
  )
}

function MenuDivider() {
  return <div className={styles.menuDivider} role="separator" />
}

export function MenuBar({
  navigationVisible = true,
  onNew,
  onOpen,
  onSave,
  onSaveAs,
  onExportCsv,
  onExportGif,
  onUndo,
  onRedo,
  onCopy,
  onPaste,
  onDelete,
  onSelectAll,
  onToggleGrid,
  onToggleSnap,
  onPlayPause,
  onStepSimulation,
  onResetSimulation,
  onClearRecords,
  onShowShortcuts,
  onShowPhysics,
  canUndo,
  canRedo,
  canPaste,
  hasSelection,
  hasChartData,
  gridVisible,
  snapEnabled,
  panelVisibility,
  onTogglePanel,
  onResetWorkspaceLayout,
}: MenuBarProps) {
  return (
    <header className={styles.header} role="banner">
      {navigationVisible ? (
        <nav className={styles.menuBar} aria-label="应用菜单">
        <Menu label="文件">
          <MenuAction icon={<FileJson size={15} />} shortcut="Ctrl+N" onClick={onNew}>
            新建场景
          </MenuAction>
          <MenuAction icon={<FolderOpen size={15} />} shortcut="Ctrl+O" onClick={onOpen}>
            打开…
          </MenuAction>
          <MenuDivider />
          <MenuAction icon={<Save size={15} />} shortcut="Ctrl+S" onClick={onSave}>
            保存
          </MenuAction>
          <MenuAction icon={<Save size={15} />} shortcut="Ctrl+Shift+S" onClick={onSaveAs}>
            另存为…
          </MenuAction>
          <MenuAction icon={<Download size={15} />} disabled={!hasChartData} onClick={onExportCsv}>
            导出记录 CSV
          </MenuAction>
          <MenuAction icon={<Download size={15} />} onClick={onExportGif}>
            导出动图 GIF
          </MenuAction>
        </Menu>

        <Menu label="编辑">
          <MenuAction
            icon={<Undo2 size={15} />}
            shortcut="Ctrl+Z"
            disabled={!canUndo}
            onClick={onUndo}
          >
            撤销
          </MenuAction>
          <MenuAction
            icon={<Redo2 size={15} />}
            shortcut="Ctrl+Y"
            disabled={!canRedo}
            onClick={onRedo}
          >
            重做
          </MenuAction>
          <MenuDivider />
          <MenuAction
            icon={<Copy size={15} />}
            shortcut="Ctrl+C"
            disabled={!hasSelection}
            onClick={onCopy}
          >
            复制
          </MenuAction>
          <MenuAction
            icon={<Clipboard size={15} />}
            shortcut="Ctrl+V"
            disabled={!canPaste}
            onClick={onPaste}
          >
            粘贴
          </MenuAction>
          <MenuAction
            icon={<Trash2 size={15} />}
            shortcut="Delete"
            disabled={!hasSelection}
            onClick={onDelete}
          >
            删除
          </MenuAction>
          <MenuAction shortcut="Ctrl+A" onClick={onSelectAll}>
            全选
          </MenuAction>
        </Menu>

        <Menu label="视图">
          <MenuAction icon={<Grid2X2 size={15} />} onClick={onToggleGrid}>
            {gridVisible ? '隐藏网格' : '显示网格'}
          </MenuAction>
          <MenuAction onClick={onToggleSnap}>
            {snapEnabled ? '关闭网格吸附' : '开启网格吸附'}
          </MenuAction>
          <MenuDivider />
          <MenuSubmenu label="窗口">
            <MenuCheckboxAction
              checked={panelVisibility.tools}
              onClick={() => onTogglePanel('tools')}
            >
              工具
            </MenuCheckboxAction>
            <MenuCheckboxAction
              checked={panelVisibility.layers}
              onClick={() => onTogglePanel('layers')}
            >
              图层
            </MenuCheckboxAction>
            <MenuCheckboxAction
              checked={panelVisibility.inspector}
              onClick={() => onTogglePanel('inspector')}
            >
              属性
            </MenuCheckboxAction>
            <MenuCheckboxAction
              checked={panelVisibility.charts}
              onClick={() => onTogglePanel('charts')}
            >
              图像
            </MenuCheckboxAction>
            <MenuDivider />
            <MenuAction onClick={onResetWorkspaceLayout}>恢复默认布局</MenuAction>
          </MenuSubmenu>
        </Menu>

        <Menu label="模拟">
          <MenuAction icon={<Play size={15} />} shortcut="P" onClick={onPlayPause}>
            播放 / 暂停
          </MenuAction>
          <MenuAction icon={<SkipForward size={15} />} shortcut="." onClick={onStepSimulation}>
            单步
          </MenuAction>
          <MenuAction icon={<RotateCcw size={15} />} shortcut="Shift+R" onClick={onResetSimulation}>
            重置模拟
          </MenuAction>
          <MenuAction icon={<Trash2 size={15} />} onClick={onClearRecords}>
            清空记录
          </MenuAction>
          <MenuAction icon={<FlaskConical size={15} />} disabled>
            模拟精度（场景属性）
          </MenuAction>
        </Menu>

        <Menu label="设置">
          <MenuAction icon={<Settings2 size={15} />} disabled>
            首选项
          </MenuAction>
        </Menu>

        <Menu label="帮助">
          <MenuAction icon={<CircleHelp size={15} />} onClick={onShowShortcuts}>
            快捷键与教程
          </MenuAction>
          <MenuAction icon={<Info size={15} />} onClick={onShowPhysics}>
            物理模型说明
          </MenuAction>
        </Menu>
      </nav>
      ) : null}
    </header>
  )
}
