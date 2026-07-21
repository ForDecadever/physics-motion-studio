import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react'

import { duplicateEntities } from '../editor/clipboard/entityClipboard'
import {
  createAddEntityCommand,
  createDeleteEntitiesCommand,
} from '../editor/commands/entityCommands'
import { CanvasWorkspace } from '../features/canvas/CanvasWorkspace'
import { downloadChartCsv } from '../features/charts/chartCsv'
import { ChartPanel } from '../features/charts/ChartPanel'
import { InspectorPanel } from '../features/inspector/InspectorPanel'
import { LayersPanel } from '../features/layers/LayersPanel'
import { MenuBar } from '../features/menu/MenuBar'
import { PlaybackBar } from '../features/playback/PlaybackBar'
import { ToolOptionsBar } from '../features/toolbar/ToolOptionsBar'
import { Toolbar } from '../features/toolbar/Toolbar'
import {
  clearSceneDraft,
  loadSceneDraft,
  saveSceneDraft,
  type SceneDraft,
} from '../persistence/draftStorage'
import {
  isFilePickerCancellation,
  openSceneWithPicker,
  saveScene,
  supportsDirectFileAccess,
} from '../persistence/fileSystemAccess'
import { readSceneFile } from '../persistence/sceneFile'
import { physicsClient } from '../physics/client/physicsClient'
import type { SceneEntity } from '../scene/model/types'
import { useChartStore } from '../stores/chartStore'
import { useDocumentStore } from '../stores/documentStore'
import { useEditorStore } from '../stores/editorStore'
import { isSimulationRuntimeLocked, useSimulationStore } from '../stores/simulationStore'
import styles from './App.module.css'

interface Notice {
  tone: 'success' | 'error'
  message: string
}

interface PanelSizes {
  right: number
  chart: number
}

function initialPanelSizes(): PanelSizes {
  try {
    const stored = JSON.parse(
      localStorage.getItem('motion-studio:panel-sizes') ?? '',
    ) as Partial<PanelSizes>
    return {
      right: Math.min(480, Math.max(240, Number(stored.right) || 296)),
      chart: Math.min(400, Math.max(100, Number(stored.chart) || 184)),
    }
  } catch {
    return { right: 296, chart: 184 }
  }
}

export function App() {
  const inputRef = useRef<HTMLInputElement>(null)
  const fileHandleRef = useRef<FileSystemFileHandle | null>(null)
  const clipboardRef = useRef<SceneEntity[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [draftPrompt, setDraftPrompt] = useState<SceneDraft | null>(null)
  const [helpTopic, setHelpTopic] = useState<'shortcuts' | 'physics' | null>(null)
  const [clipboardCount, setClipboardCount] = useState(0)
  const [panelSizes, setPanelSizes] = useState(initialPanelSizes)
  const scene = useDocumentStore((state) => state.scene)
  const fileName = useDocumentStore((state) => state.fileName)
  const isDirty = useDocumentStore((state) => state.isDirty)
  const createNewScene = useDocumentStore((state) => state.createNewScene)
  const replaceScene = useDocumentStore((state) => state.replaceScene)
  const restoreDraft = useDocumentStore((state) => state.restoreDraft)
  const markSaved = useDocumentStore((state) => state.markSaved)
  const undoStackLength = useDocumentStore((state) => state.undoStack.length)
  const redoStackLength = useDocumentStore((state) => state.redoStack.length)
  const undo = useDocumentStore((state) => state.undo)
  const redo = useDocumentStore((state) => state.redo)
  const chartCollapsed = useChartStore((state) => state.collapsed)
  const hasChartData = useChartStore((state) =>
    state.curves.some((curve) => (state.series[curve.id]?.length ?? 0) > 0),
  )
  const selectedIds = useEditorStore((state) => state.selectedIds)
  const gridVisible = useEditorStore((state) => state.gridVisible)
  const snapEnabled = useEditorStore((state) => state.snapEnabled)

  useEffect(() => {
    physicsClient.start()
    return () => physicsClient.stop()
  }, [])

  useEffect(() => {
    localStorage.setItem('motion-studio:panel-sizes', JSON.stringify(panelSizes))
  }, [panelSizes])

  useEffect(() => {
    physicsClient.initialize(scene)
  }, [scene])

  useEffect(() => {
    void loadSceneDraft()
      .then((draft) => setDraftPrompt(draft))
      .catch(() =>
        setNotice({ tone: 'error', message: '无法读取自动恢复草稿；正式场景文件不受影响。' }),
      )
  }, [])

  useEffect(() => {
    if (!isDirty) return
    const timer = window.setTimeout(() => {
      void saveSceneDraft(scene, fileName).catch(() =>
        setNotice({ tone: 'error', message: '自动草稿保存失败，请手动保存场景。' }),
      )
    }, 800)
    return () => window.clearTimeout(timer)
  }, [fileName, isDirty, scene])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!useDocumentStore.getState().isDirty) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  const showNotice = (nextNotice: Notice) => {
    setNotice(nextNotice)
    window.setTimeout(() => setNotice(null), 3200)
  }

  const confirmDiscardChanges = () =>
    !useDocumentStore.getState().isDirty ||
    window.confirm('当前场景有未保存更改。继续操作将放弃这些更改，是否继续？')

  const resetEditorForDocument = () => {
    useEditorStore.getState().resetForDocument()
    useChartStore.getState().clearCurves()
  }

  const handleNew = () => {
    if (!confirmDiscardChanges()) return
    createNewScene()
    fileHandleRef.current = null
    resetEditorForDocument()
    void clearSceneDraft()
    showNotice({ tone: 'success', message: '已创建新的空场景' })
  }

  const applyOpenedScene = (
    nextScene: typeof scene,
    nextFileName: string,
    handle: FileSystemFileHandle | null,
  ) => {
    replaceScene(nextScene, nextFileName)
    fileHandleRef.current = handle
    resetEditorForDocument()
    void clearSceneDraft()
    showNotice({ tone: 'success', message: `已打开 ${nextFileName}` })
  }

  const handleOpenRequest = async () => {
    if (!confirmDiscardChanges()) return
    if (!supportsDirectFileAccess()) {
      inputRef.current?.click()
      return
    }
    try {
      const opened = await openSceneWithPicker()
      if (opened) applyOpenedScene(opened.scene, opened.fileName, opened.handle)
    } catch (error) {
      if (isFilePickerCancellation(error)) return
      const message = error instanceof Error ? error.message : '无法读取该场景文件。'
      showNotice({ tone: 'error', message })
    }
  }

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const [file] = event.target.files ?? []
    event.target.value = ''
    if (!file) return

    try {
      const nextScene = await readSceneFile(file)
      applyOpenedScene(nextScene, file.name, null)
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法读取该场景文件。'
      showNotice({ tone: 'error', message })
    }
  }

  const handleSave = async (saveAs = false) => {
    try {
      const result = await saveScene(
        useDocumentStore.getState().scene,
        fileHandleRef.current,
        saveAs,
      )
      fileHandleRef.current = result.handle
      markSaved(result.fileName)
      await clearSceneDraft()
      showNotice({
        tone: 'success',
        message:
          result.method === 'direct'
            ? `已保存并校验 ${result.fileName}`
            : `浏览器不支持直接覆盖文件，已下载 ${result.fileName}`,
      })
    } catch (error) {
      if (isFilePickerCancellation(error)) return
      const message = error instanceof Error ? error.message : '无法保存场景。'
      showNotice({ tone: 'error', message })
    }
  }

  const handleCopy = () => {
    const document = useDocumentStore.getState().scene
    const ids = new Set(useEditorStore.getState().selectedIds)
    clipboardRef.current = structuredClone(document.entities.filter((entity) => ids.has(entity.id)))
    setClipboardCount(clipboardRef.current.length)
    if (clipboardRef.current.length > 0) {
      showNotice({ tone: 'success', message: `已复制 ${clipboardRef.current.length} 个实体` })
    }
  }

  const handlePaste = () => {
    if (isSimulationRuntimeLocked(useSimulationStore.getState())) return
    const document = useDocumentStore.getState()
    const copies = duplicateEntities(clipboardRef.current)
    if (copies.length === 0) return
    document.executeCommand(createAddEntityCommand(document.scene, copies))
    useEditorStore.getState().setSelectedIds(copies.map((entity) => entity.id))
  }

  const handleSelectAll = () => {
    useEditorStore
      .getState()
      .setSelectedIds(useDocumentStore.getState().scene.entities.map((entity) => entity.id))
  }

  const handlePlayPause = () => {
    const simulation = useSimulationStore.getState()
    if (simulation.status === 'playing') physicsClient.pause()
    else if (simulation.status !== 'initializing' && simulation.status !== 'error')
      physicsClient.play()
  }

  const handleStep = () => {
    const simulation = useSimulationStore.getState()
    if (
      simulation.status !== 'playing' &&
      simulation.status !== 'initializing' &&
      simulation.status !== 'error'
    ) {
      physicsClient.step()
    }
  }

  const handleResetSimulation = () => {
    const simulation = useSimulationStore.getState()
    if (simulation.status !== 'initializing' && simulation.status !== 'error') physicsClient.reset()
  }

  const handleExportCsv = () => {
    const chart = useChartStore.getState()
    if (!chart.curves.some((curve) => (chart.series[curve.id]?.length ?? 0) > 0)) return
    const exportedName = downloadChartCsv(scene.metadata.name, chart.curves, chart.series)
    showNotice({ tone: 'success', message: `已下载 ${exportedName}` })
  }

  const beginResize = (kind: keyof PanelSizes, event: React.PointerEvent) => {
    event.preventDefault()
    const handleMove = (moveEvent: PointerEvent) => {
      setPanelSizes((current) => ({
        ...current,
        [kind]:
          kind === 'right'
            ? Math.min(480, Math.max(240, window.innerWidth - moveEvent.clientX))
            : Math.min(400, Math.max(100, window.innerHeight - moveEvent.clientY)),
      }))
    }
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
  }

  const resizeWithKeyboard = (kind: keyof PanelSizes, event: React.KeyboardEvent) => {
    const delta =
      kind === 'right'
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
    setPanelSizes((current) => ({
      ...current,
      [kind]: Math.min(
        kind === 'right' ? 480 : 400,
        Math.max(kind === 'right' ? 240 : 100, current[kind] + delta),
      ),
    }))
  }

  const pruneSelection = () => {
    const validIds = new Set(useDocumentStore.getState().scene.entities.map((entity) => entity.id))
    const editor = useEditorStore.getState()
    editor.setSelectedIds(editor.selectedIds.filter((id) => validIds.has(id)))
    editor.clearPreview()
    editor.setDraftEntity(null)
    editor.setMarquee(null)
    editor.setConnectorStartBodyId(null)
  }

  const handleUndo = () => {
    if (isSimulationRuntimeLocked(useSimulationStore.getState())) return
    undo()
    pruneSelection()
  }

  const handleRedo = () => {
    if (isSimulationRuntimeLocked(useSimulationStore.getState())) return
    redo()
    pruneSelection()
  }

  const handleDelete = () => {
    if (isSimulationRuntimeLocked(useSimulationStore.getState())) return
    const editor = useEditorStore.getState()
    if (editor.selectedIds.length === 0) return
    const documentState = useDocumentStore.getState()
    const command = createDeleteEntitiesCommand(documentState.scene, editor.selectedIds)
    if (!command) return
    documentState.executeCommand(command)
    editor.clearSelection()
    editor.setConnectorStartBodyId(null)
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return
      }

      const key = event.key.toLowerCase()
      const commandKey = event.ctrlKey || event.metaKey
      if (commandKey && key === 's') {
        event.preventDefault()
        void handleSave(event.shiftKey)
        return
      }
      if (commandKey && key === 'o') {
        event.preventDefault()
        void handleOpenRequest()
        return
      }
      if (commandKey && key === 'n') {
        event.preventDefault()
        handleNew()
        return
      }
      if (commandKey && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) handleRedo()
        else handleUndo()
        return
      }
      if (commandKey && key === 'y') {
        event.preventDefault()
        handleRedo()
        return
      }
      if (commandKey && key === 'c') {
        event.preventDefault()
        handleCopy()
        return
      }
      if (commandKey && key === 'v') {
        event.preventDefault()
        handlePaste()
        return
      }
      if (commandKey && key === 'a') {
        event.preventDefault()
        handleSelectAll()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        handleDelete()
        return
      }
      if (event.key === 'Escape') {
        useEditorStore.getState().clearSelection()
        return
      }
      if (event.shiftKey && key === 'r') {
        event.preventDefault()
        handleResetSimulation()
        return
      }
      if (!commandKey && !event.altKey && !event.shiftKey && !event.repeat && key === 'p') {
        event.preventDefault()
        handlePlayPause()
        return
      }
      if (!commandKey && !event.altKey && !event.shiftKey && !event.repeat && event.key === '.') {
        event.preventDefault()
        handleStep()
        return
      }
      if (commandKey || event.altKey || event.shiftKey || event.repeat) return

      const shortcuts = {
        v: 'select',
        r: 'rotate',
        h: 'hand',
        z: 'zoom',
        g: 'ground',
        o: 'body',
        f: 'field',
        l: 'connector',
      } as const
      const tool = shortcuts[key as keyof typeof shortcuts]
      if (tool) useEditorStore.getState().setActiveTool(tool)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  return (
    <div
      className={styles.appShell}
      data-chart-collapsed={chartCollapsed}
      style={
        {
          '--right-dock-width': `${panelSizes.right}px`,
          '--chart-height': `${panelSizes.chart}px`,
        } as CSSProperties
      }
    >
      <MenuBar
        sceneName={scene.metadata.name}
        fileName={fileName}
        isDirty={isDirty}
        onNew={handleNew}
        onOpen={handleOpenRequest}
        onSave={() => void handleSave()}
        onSaveAs={() => void handleSave(true)}
        onExportCsv={handleExportCsv}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onCopy={handleCopy}
        onPaste={handlePaste}
        onDelete={handleDelete}
        onSelectAll={handleSelectAll}
        onToggleGrid={() => useEditorStore.getState().toggleGrid()}
        onToggleSnap={() => useEditorStore.getState().toggleSnap()}
        onPlayPause={handlePlayPause}
        onStepSimulation={handleStep}
        onResetSimulation={handleResetSimulation}
        onClearRecords={() => useChartStore.getState().clearHistory()}
        onShowShortcuts={() => setHelpTopic('shortcuts')}
        onShowPhysics={() => setHelpTopic('physics')}
        canUndo={undoStackLength > 0}
        canRedo={redoStackLength > 0}
        canPaste={clipboardCount > 0}
        hasSelection={selectedIds.length > 0}
        hasChartData={hasChartData}
        gridVisible={gridVisible}
        snapEnabled={snapEnabled}
      />
      <ToolOptionsBar />

      <div className={styles.workspace}>
        <Toolbar />
        <CanvasWorkspace />
        <div
          className={styles.rightResizer}
          role="separator"
          tabIndex={0}
          aria-label="调整右侧面板宽度"
          aria-orientation="vertical"
          aria-valuemin={240}
          aria-valuemax={480}
          aria-valuenow={panelSizes.right}
          onPointerDown={(event) => beginResize('right', event)}
          onKeyDown={(event) => resizeWithKeyboard('right', event)}
        />
        <aside className={styles.rightDock} aria-label="图层和属性">
          <LayersPanel />
          <InspectorPanel />
        </aside>
      </div>

      <PlaybackBar />
      <div
        className={styles.chartResizer}
        role="separator"
        tabIndex={chartCollapsed ? -1 : 0}
        aria-hidden={chartCollapsed}
        aria-label="调整图表区高度"
        aria-orientation="horizontal"
        aria-valuemin={100}
        aria-valuemax={400}
        aria-valuenow={panelSizes.chart}
        onPointerDown={(event) => beginResize('chart', event)}
        onKeyDown={(event) => resizeWithKeyboard('chart', event)}
      />
      <ChartPanel />

      <input
        ref={inputRef}
        className={styles.hiddenInput}
        type="file"
        accept=".json,.motion.json,application/json"
        onChange={handleFileChange}
        aria-hidden="true"
        tabIndex={-1}
      />

      {notice ? (
        <div className={styles.notice} data-tone={notice.tone} role="status" aria-live="polite">
          {notice.message}
        </div>
      ) : null}

      {draftPrompt ? (
        <div className={styles.modalBackdrop}>
          <section
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="draft-title"
          >
            <h2 id="draft-title">发现自动恢复草稿</h2>
            <p>
              草稿保存于 {new Date(draftPrompt.savedAt).toLocaleString()}
              。恢复后会标记为“未保存”，不会覆盖正式文件。
            </p>
            <div className={styles.modalActions}>
              <button
                type="button"
                onClick={() => {
                  restoreDraft(draftPrompt.scene, draftPrompt.fileName)
                  fileHandleRef.current = null
                  resetEditorForDocument()
                  setDraftPrompt(null)
                  showNotice({ tone: 'success', message: '已恢复草稿，请手动保存以保留它。' })
                }}
              >
                恢复草稿
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraftPrompt(null)
                  void clearSceneDraft()
                }}
              >
                丢弃草稿
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {helpTopic ? (
        <div className={styles.modalBackdrop}>
          <section
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
          >
            <h2 id="help-title">{helpTopic === 'shortcuts' ? '快捷键与入门' : '物理模型与近似'}</h2>
            {helpTopic === 'shortcuts' ? (
              <ul>
                <li>V / R：选择移动 / 旋转；G / O / F / L：地面、物体、场、连接。</li>
                <li>P：播放或暂停；句点：单步；Shift+R：重置。</li>
                <li>Ctrl+S / O / Z / Y / C / V：保存、打开、撤销、重做、复制、粘贴。</li>
                <li>空格临时抓手；Alt 临时关闭吸附；Delete 删除选择。</li>
              </ul>
            ) : (
              <ul>
                <li>模拟使用固定时间步长，结果存在可测量的离散误差。</li>
                <li>圆弧与贝塞尔地面通常以误差受控的折线参与碰撞。</li>
                <li>场边界按物体中心判断；质点碰撞使用有限半径近似。</li>
                <li>浮点数会产生极小误差。本工具适合教学和常规模拟，不替代科研验证。</li>
              </ul>
            )}
            <div className={styles.modalActions}>
              <button type="button" autoFocus onClick={() => setHelpTopic(null)}>
                关闭
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
