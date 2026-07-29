import { ChevronDown, GripHorizontal, X } from 'lucide-react'
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

import { commitPendingEditorEdit } from '../../editor/editing/pendingEditorEdit'
import { useWorkspaceLayoutStore } from '../../stores/workspaceLayoutStore'
import { CanvasWorkspace } from '../canvas/CanvasWorkspace'
import { ChartPanel } from '../charts/ChartPanel'
import { InspectorPanel } from '../inspector/InspectorPanel'
import { LayersPanel } from '../layers/LayersPanel'
import { Toolbar } from '../toolbar/Toolbar'
import {
  bringWorkspacePanelToFront,
  dockWorkspacePanel,
  floatWorkspacePanel,
  moveFloatingPanel,
  resizeDockEdge,
  resizeDockedPanelPair,
  resizeFloatingPanel,
  type DockEdge,
  type ResizeDirection,
  type WorkspaceLayoutV1,
  type WorkspacePanelId,
} from './workspaceLayout'
import styles from './DockableWorkspace.module.css'

const panelTitles: Record<WorkspacePanelId, string> = {
  tools: '工具',
  layers: '图层',
  inspector: '属性',
  charts: '图像',
}

const resizeNames: Record<ResizeDirection, string> = {
  north: '北边',
  northEast: '东北角',
  east: '东边',
  southEast: '东南角',
  south: '南边',
  southWest: '西南角',
  west: '西边',
  northWest: '西北角',
}

function panelContent(panelId: WorkspacePanelId, edge?: DockEdge): ReactNode {
  switch (panelId) {
    case 'tools':
      return <Toolbar orientation={edge === 'bottom' ? 'horizontal' : 'vertical'} />
    case 'layers':
      return <LayersPanel embedded />
    case 'inspector':
      return <InspectorPanel embedded />
    case 'charts':
      return <ChartPanel embedded />
  }
}

function visibleDockedPanels(layout: WorkspaceLayoutV1, edge: DockEdge): WorkspacePanelId[] {
  return (Object.keys(layout.panels) as WorkspacePanelId[])
    .filter((panelId) => {
      const panel = layout.panels[panelId]
      return panel.visible && panel.placement.mode === 'docked' && panel.placement.edge === edge
    })
    .sort((first, second) => {
      const a = layout.panels[first].placement
      const b = layout.panels[second].placement
      return (a.mode === 'docked' ? a.order : 0) - (b.mode === 'docked' ? b.order : 0)
    })
}

function beginWindowPointerTracking(
  event: ReactPointerEvent,
  onMove: (event: PointerEvent) => void,
  onEnd: (cancelled: boolean) => void,
): void {
  event.preventDefault()
  const handleMove = (moveEvent: PointerEvent) => onMove(moveEvent)
  const finish = (cancelled: boolean) => {
    window.removeEventListener('pointermove', handleMove)
    window.removeEventListener('pointerup', handleUp)
    window.removeEventListener('pointercancel', handleCancel)
    window.removeEventListener('keydown', handleKeyDown, true)
    onEnd(cancelled)
  }
  const handleUp = () => finish(false)
  const handleCancel = () => finish(true)
  const handleKeyDown = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== 'Escape') return
    keyEvent.preventDefault()
    keyEvent.stopPropagation()
    finish(true)
  }
  window.addEventListener('pointermove', handleMove)
  window.addEventListener('pointerup', handleUp, { once: true })
  window.addEventListener('pointercancel', handleCancel, { once: true })
  window.addEventListener('keydown', handleKeyDown, true)
}

interface PanelFrameProps {
  panelId: WorkspacePanelId
  edge?: DockEdge
  style?: CSSProperties
  onBeginDrag: (panelId: WorkspacePanelId, event: ReactPointerEvent) => void
  onBeginResize: (
    panelId: WorkspacePanelId,
    direction: ResizeDirection,
    event: ReactPointerEvent,
  ) => void
}

function PanelFrame({ panelId, edge, style, onBeginDrag, onBeginResize }: PanelFrameProps) {
  const panel = useWorkspaceLayoutStore((state) => state.layout.panels[panelId])
  const setPanelVisible = useWorkspaceLayoutStore((state) => state.setPanelVisible)
  const setPanelCollapsed = useWorkspaceLayoutStore((state) => state.setPanelCollapsed)
  const bringPanelToFront = useWorkspaceLayoutStore((state) => state.bringPanelToFront)
  const floating = panel.placement.mode === 'floating'
  const title = panelTitles[panelId]

  return (
    <section
      className={styles.panelFrame}
      role="region"
      aria-label={`${title}面板`}
      data-panel={panelId}
      data-mode={panel.placement.mode}
      data-edge={edge}
      data-collapsed={panel.collapsed}
      style={style}
      onPointerDown={() => {
        if (floating) bringPanelToFront(panelId)
      }}
    >
      <header className={styles.panelTitlebar}>
        <button
          type="button"
          className={styles.dragHandle}
          aria-label={`拖动${title}面板`}
          title={`拖动${title}面板`}
          onPointerDown={(event) => onBeginDrag(panelId, event)}
          onKeyDown={(event) => {
            if (!floating || !event.key.startsWith('Arrow')) return
            const delta = {
              x: event.key === 'ArrowLeft' ? -10 : event.key === 'ArrowRight' ? 10 : 0,
              y: event.key === 'ArrowUp' ? -10 : event.key === 'ArrowDown' ? 10 : 0,
            }
            event.preventDefault()
            const state = useWorkspaceLayoutStore.getState()
            state.replaceLayout(moveFloatingPanel(state.layout, panelId, delta, state.bounds))
          }}
        >
          <GripHorizontal size={14} />
        </button>
        <span className={styles.panelTitle}>{title}面板</span>
        {panelId === 'charts' ? (
          <button
            type="button"
            className={styles.titleAction}
            aria-label={panel.collapsed ? '展开图像面板' : '折叠图像面板'}
            onClick={() => setPanelCollapsed(panelId, !panel.collapsed)}
          >
            <ChevronDown size={14} />
          </button>
        ) : null}
        <button
          type="button"
          className={styles.titleAction}
          aria-label={`关闭${title}面板`}
          onClick={() => setPanelVisible(panelId, false)}
        >
          <X size={13} />
        </button>
      </header>
      {panel.collapsed ? null : (
        <div className={styles.panelContent}>{panelContent(panelId, edge)}</div>
      )}
      {floating
        ? (Object.keys(resizeNames) as ResizeDirection[]).map((direction) => (
            <div
              key={direction}
              className={styles.resizeHandle}
              data-direction={direction}
              role="separator"
              tabIndex={0}
              aria-label={`调整${title}面板${resizeNames[direction]}`}
              onPointerDown={(event) => onBeginResize(panelId, direction, event)}
              onKeyDown={(event) => {
                const delta = {
                  x: event.key === 'ArrowLeft' ? -10 : event.key === 'ArrowRight' ? 10 : 0,
                  y: event.key === 'ArrowUp' ? -10 : event.key === 'ArrowDown' ? 10 : 0,
                }
                if (delta.x === 0 && delta.y === 0) return
                event.preventDefault()
                const state = useWorkspaceLayoutStore.getState()
                state.replaceLayout(
                  resizeFloatingPanel(state.layout, panelId, direction, delta, state.bounds),
                )
              }}
            />
          ))
        : null}
    </section>
  )
}

export function DockableWorkspace() {
  const workspaceRef = useRef<HTMLElement>(null)
  const layout = useWorkspaceLayoutStore((state) => state.layout)
  const bounds = useWorkspaceLayoutStore((state) => state.bounds)
  const setBounds = useWorkspaceLayoutStore((state) => state.setBounds)
  const replaceLayout = useWorkspaceLayoutStore((state) => state.replaceLayout)
  const [dropPreview, setDropPreview] = useState<DockEdge | null>(null)

  useEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      setBounds({
        width: Math.max(1, entry.contentRect.width),
        height: Math.max(1, entry.contentRect.height),
      })
    })
    observer.observe(workspace)
    return () => observer.disconnect()
  }, [setBounds])

  const docked = useMemo(
    () => ({
      left: visibleDockedPanels(layout, 'left'),
      right: visibleDockedPanels(layout, 'right'),
      bottom: visibleDockedPanels(layout, 'bottom'),
    }),
    [layout],
  )

  const leftSize = docked.left.length > 0 ? layout.dockSizes.left : 0
  const rightSize = docked.right.length > 0 ? layout.dockSizes.right : 0
  const bottomCollapsed =
    docked.bottom.length > 0 && docked.bottom.every((id) => layout.panels[id].collapsed)
  const bottomSize = docked.bottom.length > 0 ? (bottomCollapsed ? 31 : layout.dockSizes.bottom) : 0

  const beginPanelDrag = (panelId: WorkspacePanelId, event: ReactPointerEvent) => {
    event.stopPropagation()
    commitPendingEditorEdit(event.target)
    const workspace = workspaceRef.current
    const frame = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-panel]')
    if (!workspace || !frame) return
    const workspaceRect = workspace.getBoundingClientRect()
    const panelRect = frame.getBoundingClientRect()
    const startPointer = { x: event.clientX, y: event.clientY }
    const startLayout = bringWorkspacePanelToFront(
      structuredClone(useWorkspaceLayoutStore.getState().layout),
      panelId,
    )
    replaceLayout(startLayout)
    const startBounds = useWorkspaceLayoutStore.getState().bounds
    const initialPanel = startLayout.panels[panelId]
    const floatingStart =
      initialPanel.placement.mode === 'floating'
        ? startLayout
        : floatWorkspacePanel(
            startLayout,
            panelId,
            {
              x: panelRect.left - workspaceRect.left,
              y: panelRect.top - workspaceRect.top,
              width: panelRect.width,
              height: panelRect.height,
            },
            startBounds,
          )
    let dragged = false
    let preview: DockEdge | null = null
    let previewIndex = Number.POSITIVE_INFINITY

    beginWindowPointerTracking(
      event,
      (moveEvent) => {
        const delta = {
          x: moveEvent.clientX - startPointer.x,
          y: moveEvent.clientY - startPointer.y,
        }
        if (!dragged && Math.hypot(delta.x, delta.y) <= 6) return
        dragged = true
        replaceLayout(moveFloatingPanel(floatingStart, panelId, delta, startBounds))
        const localX = moveEvent.clientX - workspaceRect.left
        const localY = moveEvent.clientY - workspaceRect.top
        preview =
          localX <= 48
            ? 'left'
            : localX >= workspaceRect.width - 48
              ? 'right'
              : localY >= workspaceRect.height - 48
                ? 'bottom'
                : null
        if (preview) {
          const candidates = [
            ...workspace.querySelectorAll<HTMLElement>(
              `.${styles.dockZone}[data-edge="${preview}"] > [data-panel]`,
            ),
          ].filter((candidate) => candidate.dataset.panel !== panelId)
          const pointerCoordinate = preview === 'bottom' ? moveEvent.clientX : moveEvent.clientY
          previewIndex = candidates.findIndex((candidate) => {
            const rect = candidate.getBoundingClientRect()
            const center =
              preview === 'bottom' ? rect.left + rect.width / 2 : rect.top + rect.height / 2
            return pointerCoordinate < center
          })
          if (previewIndex < 0) previewIndex = candidates.length
        } else {
          previewIndex = Number.POSITIVE_INFINITY
        }
        setDropPreview(preview)
      },
      (cancelled) => {
        setDropPreview(null)
        if (cancelled) {
          replaceLayout(startLayout)
          return
        }
        if (!dragged) return
        if (preview) {
          replaceLayout(
            dockWorkspacePanel(
              useWorkspaceLayoutStore.getState().layout,
              panelId,
              preview,
              previewIndex,
            ),
          )
        }
      },
    )
  }

  const beginPanelResize = (
    panelId: WorkspacePanelId,
    direction: ResizeDirection,
    event: ReactPointerEvent,
  ) => {
    event.stopPropagation()
    const startPointer = { x: event.clientX, y: event.clientY }
    const startLayout = bringWorkspacePanelToFront(
      structuredClone(useWorkspaceLayoutStore.getState().layout),
      panelId,
    )
    replaceLayout(startLayout)
    const startBounds = useWorkspaceLayoutStore.getState().bounds
    beginWindowPointerTracking(
      event,
      (moveEvent) =>
        replaceLayout(
          resizeFloatingPanel(
            startLayout,
            panelId,
            direction,
            {
              x: moveEvent.clientX - startPointer.x,
              y: moveEvent.clientY - startPointer.y,
            },
            startBounds,
          ),
        ),
      (cancelled) => {
        if (cancelled) replaceLayout(startLayout)
      },
    )
  }

  const beginDockResize = (edge: DockEdge, event: ReactPointerEvent) => {
    const workspace = workspaceRef.current
    if (!workspace) return
    const startLayout = structuredClone(useWorkspaceLayoutStore.getState().layout)
    const workspaceRect = workspace.getBoundingClientRect()
    beginWindowPointerTracking(
      event,
      (moveEvent) => {
        const size =
          edge === 'left'
            ? moveEvent.clientX - workspaceRect.left
            : edge === 'right'
              ? workspaceRect.right - moveEvent.clientX
              : workspaceRect.bottom - moveEvent.clientY
        replaceLayout(resizeDockEdge(startLayout, edge, size, bounds))
      },
      (cancelled) => {
        if (cancelled) replaceLayout(startLayout)
      },
    )
  }

  const beginPanelPairResize = (
    edge: DockEdge,
    firstId: WorkspacePanelId,
    secondId: WorkspacePanelId,
    event: ReactPointerEvent,
  ) => {
    const zone = (event.currentTarget as HTMLElement).parentElement
    if (!zone) return
    const zoneRect = zone.getBoundingClientRect()
    const startPointer = { x: event.clientX, y: event.clientY }
    const startLayout = structuredClone(useWorkspaceLayoutStore.getState().layout)
    beginWindowPointerTracking(
      event,
      (moveEvent) => {
        const distance =
          edge === 'bottom'
            ? moveEvent.clientX - startPointer.x
            : moveEvent.clientY - startPointer.y
        const totalSize = edge === 'bottom' ? zoneRect.width : zoneRect.height
        replaceLayout(resizeDockedPanelPair(startLayout, firstId, secondId, distance / totalSize))
      },
      (cancelled) => {
        if (cancelled) replaceLayout(startLayout)
      },
    )
  }

  const resizeDockWithKeyboard = (edge: DockEdge, event: React.KeyboardEvent) => {
    const delta =
      edge === 'left'
        ? event.key === 'ArrowRight'
          ? 16
          : event.key === 'ArrowLeft'
            ? -16
            : 0
        : edge === 'right'
          ? event.key === 'ArrowLeft'
            ? 16
            : event.key === 'ArrowRight'
              ? -16
              : 0
          : event.key === 'ArrowUp'
            ? 16
            : event.key === 'ArrowDown'
              ? -16
              : 0
    if (delta === 0) return
    event.preventDefault()
    const state = useWorkspaceLayoutStore.getState()
    state.replaceLayout(
      resizeDockEdge(state.layout, edge, state.layout.dockSizes[edge] + delta, state.bounds),
    )
  }

  const renderDock = (edge: DockEdge, panelIds: WorkspacePanelId[]) => {
    if (panelIds.length === 0) return null
    return (
      <div className={styles.dockZone} data-edge={edge}>
        {panelIds.map((panelId, index) => {
          const placement = layout.panels[panelId].placement
          const weight = placement.mode === 'docked' ? placement.weight : 1
          return (
            <Fragment key={panelId}>
              {index > 0 ? (
                <div
                  className={styles.panelDivider}
                  role="separator"
                  tabIndex={0}
                  aria-label={`调整${panelTitles[panelIds[index - 1]!]}与${panelTitles[panelId]}面板比例`}
                  aria-orientation={edge === 'bottom' ? 'vertical' : 'horizontal'}
                  onPointerDown={(event) =>
                    beginPanelPairResize(edge, panelIds[index - 1]!, panelId, event)
                  }
                  onKeyDown={(event) => {
                    const delta =
                      edge === 'bottom'
                        ? event.key === 'ArrowLeft'
                          ? -0.03
                          : event.key === 'ArrowRight'
                            ? 0.03
                            : 0
                        : event.key === 'ArrowUp'
                          ? -0.03
                          : event.key === 'ArrowDown'
                            ? 0.03
                            : 0
                    if (delta === 0) return
                    event.preventDefault()
                    replaceLayout(
                      resizeDockedPanelPair(
                        useWorkspaceLayoutStore.getState().layout,
                        panelIds[index - 1]!,
                        panelId,
                        delta,
                      ),
                    )
                  }}
                />
              ) : null}
              <PanelFrame
                panelId={panelId}
                edge={edge}
                style={{ flexGrow: weight, flexBasis: 0 }}
                onBeginDrag={beginPanelDrag}
                onBeginResize={beginPanelResize}
              />
            </Fragment>
          )
        })}
      </div>
    )
  }

  return (
    <main
      ref={workspaceRef}
      className={styles.workspace}
      aria-label="编辑工作区"
      style={
        {
          '--workspace-left': `${leftSize}px`,
          '--workspace-right': `${rightSize}px`,
          '--workspace-bottom': `${bottomSize}px`,
        } as CSSProperties
      }
    >
      <div className={styles.canvasSlot}>
        <CanvasWorkspace />
      </div>
      {renderDock('left', docked.left)}
      {renderDock('right', docked.right)}
      {renderDock('bottom', docked.bottom)}

      {leftSize > 0 ? (
        <div
          className={styles.dockBoundary}
          data-edge="left"
          role="separator"
          tabIndex={0}
          aria-label="调整左侧停靠区宽度"
          onPointerDown={(event) => beginDockResize('left', event)}
          onKeyDown={(event) => resizeDockWithKeyboard('left', event)}
        />
      ) : null}
      {rightSize > 0 ? (
        <div
          className={styles.dockBoundary}
          data-edge="right"
          role="separator"
          tabIndex={0}
          aria-label="调整右侧停靠区宽度"
          onPointerDown={(event) => beginDockResize('right', event)}
          onKeyDown={(event) => resizeDockWithKeyboard('right', event)}
        />
      ) : null}
      {bottomSize > 0 && !bottomCollapsed ? (
        <div
          className={styles.dockBoundary}
          data-edge="bottom"
          role="separator"
          tabIndex={0}
          aria-label="调整底部停靠区高度"
          onPointerDown={(event) => beginDockResize('bottom', event)}
          onKeyDown={(event) => resizeDockWithKeyboard('bottom', event)}
        />
      ) : null}

      {(Object.keys(layout.panels) as WorkspacePanelId[])
        .filter((panelId) => {
          const panel = layout.panels[panelId]
          return panel.visible && panel.placement.mode === 'floating'
        })
        .map((panelId) => {
          const panel = layout.panels[panelId]
          if (panel.placement.mode !== 'floating') return null
          const rect = panel.placement.rect
          return (
            <PanelFrame
              key={panelId}
              panelId={panelId}
              style={{
                left: rect.x,
                top: rect.y,
                width: rect.width,
                height: panel.collapsed ? 31 : rect.height,
                zIndex: panel.z,
              }}
              onBeginDrag={beginPanelDrag}
              onBeginResize={beginPanelResize}
            />
          )
        })}

      {dropPreview ? <div className={styles.dropPreview} data-edge={dropPreview} /> : null}
    </main>
  )
}
