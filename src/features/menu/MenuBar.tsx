import {
  CircleHelp,
  Download,
  FileJson,
  FolderOpen,
  FlaskConical,
  Grid2X2,
  Info,
  Redo2,
  Save,
  Settings2,
  Undo2,
} from 'lucide-react'
import type { MouseEvent, ReactNode } from 'react'

import styles from './MenuBar.module.css'

interface MenuBarProps {
  sceneName: string
  fileName: string | null
  isDirty: boolean
  onNew: () => void
  onOpen: () => void
  onSave: () => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
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
    <details className={styles.menu}>
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
  sceneName,
  fileName,
  isDirty,
  onNew,
  onOpen,
  onSave,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: MenuBarProps) {
  return (
    <header className={styles.header} role="banner">
      <div className={styles.brand} aria-label="Motion Studio">
        <span className={styles.brandMark} aria-hidden="true">
          M
        </span>
        <span>Motion Studio</span>
      </div>

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
            保存到文件
          </MenuAction>
          <MenuAction icon={<Download size={15} />} disabled>
            导出画布 PNG
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
        </Menu>

        <Menu label="视图">
          <MenuAction icon={<Grid2X2 size={15} />} disabled>
            网格与参考线
          </MenuAction>
        </Menu>

        <Menu label="模拟">
          <MenuAction icon={<FlaskConical size={15} />} disabled>
            模拟精度
          </MenuAction>
        </Menu>

        <Menu label="设置">
          <MenuAction icon={<Settings2 size={15} />} disabled>
            首选项
          </MenuAction>
        </Menu>

        <Menu label="帮助">
          <MenuAction icon={<CircleHelp size={15} />} disabled>
            快捷键与教程
          </MenuAction>
          <MenuAction icon={<Info size={15} />} disabled>
            物理模型说明
          </MenuAction>
        </Menu>
      </nav>

      <div className={styles.sceneStatus} title={fileName ?? '尚未保存到文件'}>
        <span className={styles.statusDot} data-dirty={isDirty} />
        <span className={styles.sceneName}>{sceneName}</span>
        <span className={styles.stageBadge}>阶段 2</span>
      </div>
    </header>
  )
}
