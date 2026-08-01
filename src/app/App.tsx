import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'

import { collectClipboardEntities, duplicateEntities } from '../editor/clipboard/entityClipboard'
import { commitPendingEditorEdit } from '../editor/editing/pendingEditorEdit'
import {
  createAddEntityCommand,
  createDeleteEntitiesCommand,
} from '../editor/commands/entityCommands'
import { downloadAllChartsCsv } from '../features/charts/chartCsv'
import { evaluateChart, type EvaluatedChart } from '../features/charts/chartSeries'
import { MenuBar } from '../features/menu/MenuBar'
import { closeDesktopMenu, installDesktopMenu, type AppCommand } from '../features/menu/desktopMenu'
import { GifExportDialog, GifExportPreparingDialog } from '../features/gifExport/GifExportDialog'
import { PlaybackBar } from '../features/playback/PlaybackBar'
import { ToolOptionsBar } from '../features/toolbar/ToolOptionsBar'
import { DockableWorkspace } from '../features/workspace/DockableWorkspace'
import {
  clearSceneDraft,
  loadSceneDraft,
  saveSceneDraft,
  type SceneDraft,
} from '../persistence/draftStorage'
import {
  isSceneFileCancellation,
  sceneFileService,
  type OpenedScene,
  type RecentSceneEntry,
  type SceneFileToken,
} from '../persistence/sceneFileService'
import { readSceneFile } from '../persistence/sceneFile'
import { isDesktopRuntime } from '../platform/runtime'
import { physicsClient } from '../physics/client/physicsClient'
import type { BodyEntity, SceneDocument, SceneEntity } from '../scene/model/types'
import type { GifHistorySnapshot } from '../physics/worker/messages'
import { getChartTelemetryBuffer, useChartStore } from '../stores/chartStore'
import { useDocumentStore } from '../stores/documentStore'
import { useEditorStore } from '../stores/editorStore'
import { isSimulationRuntimeLocked, useSimulationStore } from '../stores/simulationStore'
import { useWorkspaceLayoutStore } from '../stores/workspaceLayoutStore'
import styles from './App.module.css'

interface Notice {
  tone: 'success' | 'error'
  message: string
}

type GifExportModalState =
  { state: 'preparing' } | { state: 'ready'; scene: SceneDocument; snapshot: GifHistorySnapshot }

const desktopRuntime = isDesktopRuntime()

function resetEditorForDocument() {
  useEditorStore.getState().resetForDocument()
  useChartStore.getState().clearHistory()
}

export function App() {
  const inputRef = useRef<HTMLInputElement>(null)
  const fileTokenRef = useRef<SceneFileToken | null>(null)
  const clipboardRef = useRef<SceneEntity[]>([])
  const desktopHandlersRef = useRef<{
    execute: (command: AppCommand) => void
    openRecent: (id: string) => void
    clearRecent: () => void
  } | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [draftPrompt, setDraftPrompt] = useState<SceneDraft | null>(null)
  const [helpTopic, setHelpTopic] = useState<'shortcuts' | 'physics' | 'about' | null>(null)
  const [gifExportModal, setGifExportModal] = useState<GifExportModalState | null>(null)
  const [clipboardCount, setClipboardCount] = useState(0)
  const [recentFiles, setRecentFiles] = useState<RecentSceneEntry[]>([])
  const [pendingOpenRevision, setPendingOpenRevision] = useState(desktopRuntime ? 1 : 0)
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
  const chartRevision = useChartStore((state) => state.revision)
  const hasChartData = chartRevision >= 0 && getChartTelemetryBuffer().length > 0
  const selectedIds = useEditorStore((state) => state.selectedIds)
  const gridVisible = useEditorStore((state) => state.gridVisible)
  const snapEnabled = useEditorStore((state) => state.snapEnabled)
  const workspacePanels = useWorkspaceLayoutStore((state) => state.layout.panels)
  const simulationLocked = useSimulationStore((state) => isSimulationRuntimeLocked(state))

  useEffect(() => {
    physicsClient.start()
    return () => physicsClient.stop()
  }, [])

  const physicsEntities = scene.entities
  const physicsLayers = scene.layers
  const physicsSettings = scene.settings

  useEffect(() => {
    physicsClient.initialize(useDocumentStore.getState().scene)
  }, [physicsEntities, physicsLayers, physicsSettings])

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

  const showNotice = useCallback((nextNotice: Notice) => {
    setNotice(nextNotice)
    window.setTimeout(() => setNotice(null), 3200)
  }, [])

  const confirmDiscardChanges = useCallback(
    () =>
      !useDocumentStore.getState().isDirty ||
      window.confirm('当前场景有未保存更改。继续操作将放弃这些更改，是否继续？'),
    [],
  )

  const refreshRecentFiles = useCallback(async () => {
    if (!desktopRuntime) return
    try {
      setRecentFiles(await sceneFileService.listRecent())
    } catch (error) {
      showNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : '无法读取最近文件。',
      })
    }
  }, [showNotice])

  const handleNew = () => {
    if (!confirmDiscardChanges()) return
    createNewScene()
    fileTokenRef.current = null
    resetEditorForDocument()
    void clearSceneDraft()
    showNotice({ tone: 'success', message: '已创建新的空场景' })
  }

  const applyOpenedScene = useCallback(
    (opened: Omit<OpenedScene, 'token'> & { token: SceneFileToken | null }) => {
      replaceScene(opened.scene, opened.fileName)
      fileTokenRef.current = opened.token
      resetEditorForDocument()
      void clearSceneDraft()
      if (opened.token) {
        void sceneFileService
          .confirmOpened(opened.token)
          .then(refreshRecentFiles)
          .catch(() => undefined)
      }
      showNotice({ tone: 'success', message: `已打开 ${opened.fileName}` })
    },
    [refreshRecentFiles, replaceScene, showNotice],
  )

  const handleOpenRequest = async () => {
    if (!confirmDiscardChanges()) return
    if (!sceneFileService.supportsNativeOpen()) {
      inputRef.current?.click()
      return
    }
    try {
      const opened = await sceneFileService.open()
      if (opened) applyOpenedScene(opened)
    } catch (error) {
      if (isSceneFileCancellation(error)) return
      const message = error instanceof Error ? error.message : '无法读取该场景文件。'
      showNotice({ tone: 'error', message })
    }
  }

  const handleOpenRecent = async (id: string) => {
    if (!confirmDiscardChanges()) return
    try {
      applyOpenedScene(await sceneFileService.openRecent(id))
    } catch (error) {
      await refreshRecentFiles()
      showNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : '无法打开最近文件。',
      })
    }
  }

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const [file] = event.target.files ?? []
    event.target.value = ''
    if (!file) return

    try {
      const nextScene = await readSceneFile(file)
      applyOpenedScene({ scene: nextScene, fileName: file.name, token: null })
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法读取该场景文件。'
      showNotice({ tone: 'error', message })
    }
  }

  const handleSave = async (saveAs = false) => {
    try {
      const result = await sceneFileService.save(
        useDocumentStore.getState().scene,
        fileTokenRef.current,
        saveAs,
      )
      fileTokenRef.current = result.token
      markSaved(result.fileName)
      await clearSceneDraft()
      await refreshRecentFiles()
      showNotice({
        tone: 'success',
        message:
          result.method === 'direct'
            ? `已保存并校验 ${result.fileName}`
            : `浏览器不支持直接覆盖文件，已下载 ${result.fileName}`,
      })
    } catch (error) {
      if (isSceneFileCancellation(error)) return
      const message = error instanceof Error ? error.message : '无法保存场景。'
      showNotice({ tone: 'error', message })
    }
  }

  const handleCopy = () => {
    const document = useDocumentStore.getState().scene
    clipboardRef.current = structuredClone(
      collectClipboardEntities(document.entities, useEditorStore.getState().selectedIds),
    )
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
    if (getChartTelemetryBuffer().length === 0) return
    const bodies = scene.entities.filter((entity): entity is BodyEntity => entity.kind === 'body')
    const evaluated = new Map<string, EvaluatedChart>()
    for (const chart of scene.charts) {
      try {
        evaluated.set(
          chart.id,
          evaluateChart(chart, getChartTelemetryBuffer(), Number.POSITIVE_INFINITY),
        )
      } catch {
        // Invalid chart extensions are skipped; validated in-app charts always compile.
      }
    }
    const exportedName = downloadAllChartsCsv(scene.metadata.name, scene.charts, evaluated, bodies)
    showNotice({ tone: 'success', message: `已下载 ${exportedName}` })
  }

  const handleOpenGifExport = async () => {
    if (gifExportModal) return
    commitPendingEditorEdit()
    physicsClient.pause()
    const frozenScene = structuredClone(useDocumentStore.getState().scene)
    setGifExportModal({ state: 'preparing' })
    try {
      const snapshot = await physicsClient.requestGifHistory()
      setGifExportModal({ state: 'ready', scene: frozenScene, snapshot })
    } catch (error) {
      setGifExportModal(null)
      showNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : '无法读取 GIF 历史记录。',
      })
    }
  }

  const pruneSelection = () => {
    const validIds = new Set(useDocumentStore.getState().scene.entities.map((entity) => entity.id))
    const editor = useEditorStore.getState()
    editor.setSelectedIds(editor.selectedIds.filter((id) => validIds.has(id)))
    editor.clearPreview()
    editor.setDraftEntity(null)
    editor.setMarquee(null)
    editor.setConnectorStartBodyId(null)
    editor.setGroundJointStart(null)
    editor.setGroundJointMessage(null)
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
    editor.setGroundJointStart(null)
    editor.setGroundJointMessage(null)
  }

  const handleClearRecords = () => {
    useChartStore.getState().clearHistory()
    physicsClient.clearGifHistory()
  }

  const executeAppCommand = (command: AppCommand) => {
    if (command.startsWith('view:toggle-panel:')) {
      const panelId = command.slice('view:toggle-panel:'.length) as keyof typeof workspacePanels
      useWorkspaceLayoutStore.getState().togglePanelVisible(panelId)
      return
    }

    switch (command) {
      case 'file:new':
        handleNew()
        break
      case 'file:open':
        void handleOpenRequest()
        break
      case 'file:save':
        void handleSave()
        break
      case 'file:save-as':
        void handleSave(true)
        break
      case 'file:export-csv':
        handleExportCsv()
        break
      case 'file:export-gif':
        void handleOpenGifExport()
        break
      case 'file:exit':
        void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
          getCurrentWindow().close(),
        )
        break
      case 'edit:undo':
        handleUndo()
        break
      case 'edit:redo':
        handleRedo()
        break
      case 'edit:copy':
        handleCopy()
        break
      case 'edit:paste':
        handlePaste()
        break
      case 'edit:delete':
        handleDelete()
        break
      case 'edit:select-all':
        handleSelectAll()
        break
      case 'view:toggle-grid':
        useEditorStore.getState().toggleGrid()
        break
      case 'view:toggle-snap':
        useEditorStore.getState().toggleSnap()
        break
      case 'view:reset-layout':
        useWorkspaceLayoutStore.getState().resetLayout()
        break
      case 'simulation:play-pause':
        handlePlayPause()
        break
      case 'simulation:step':
        handleStep()
        break
      case 'simulation:reset':
        handleResetSimulation()
        break
      case 'simulation:clear-records':
        handleClearRecords()
        break
      case 'help:shortcuts':
        setHelpTopic('shortcuts')
        break
      case 'help:physics':
        setHelpTopic('physics')
        break
      case 'help:about':
        setHelpTopic('about')
        break
    }
  }

  useEffect(() => {
    desktopHandlersRef.current = {
      execute: executeAppCommand,
      openRecent: (id) => void handleOpenRecent(id),
      clearRecent: () => {
        void sceneFileService.clearRecent().then(refreshRecentFiles)
      },
    }
  })

  useEffect(() => {
    if (!desktopRuntime) return
    let disposed = false
    let unsubscribe: (() => void) | undefined

    const initialRefresh = window.setTimeout(() => void refreshRecentFiles(), 0)
    void sceneFileService
      .subscribeOpenRequests(() => setPendingOpenRevision((revision) => revision + 1))
      .then((nextUnsubscribe) => {
        if (disposed) nextUnsubscribe()
        else unsubscribe = nextUnsubscribe
      })
      .catch((error) =>
        showNotice({
          tone: 'error',
          message: error instanceof Error ? error.message : '无法监听关联文件。',
        }),
      )

    return () => {
      disposed = true
      window.clearTimeout(initialRefresh)
      unsubscribe?.()
    }
  }, [refreshRecentFiles, showNotice])

  useEffect(() => {
    if (!desktopRuntime || gifExportModal || draftPrompt || helpTopic) return
    let cancelled = false

    void sceneFileService
      .takePendingOpen()
      .then((opened) => {
        if (!opened || cancelled) return
        if (confirmDiscardChanges()) applyOpenedScene(opened)
        setPendingOpenRevision((revision) => revision + 1)
      })
      .catch((error) => {
        if (cancelled) return
        showNotice({
          tone: 'error',
          message: error instanceof Error ? error.message : '无法打开关联场景文件。',
        })
      })

    return () => {
      cancelled = true
    }
  }, [
    applyOpenedScene,
    confirmDiscardChanges,
    draftPrompt,
    gifExportModal,
    helpTopic,
    pendingOpenRevision,
    showNotice,
  ])

  useEffect(() => {
    if (!desktopRuntime) return
    let unlisten: (() => void) | undefined
    let disposed = false

    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const appWindow = getCurrentWindow()
      await appWindow.setTitle(`${isDirty ? '*' : ''}${scene.metadata.name} — Motion Studio`)
      unlisten = await appWindow.onCloseRequested(async (event) => {
        event.preventDefault()
        if (
          gifExportModal &&
          !window.confirm('GIF 导出窗口仍在工作。确认放弃导出并退出 Motion Studio？')
        ) {
          return
        }
        if (!confirmDiscardChanges()) return
        await appWindow.destroy()
      })
      if (disposed) unlisten()
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [confirmDiscardChanges, gifExportModal, isDirty, scene.metadata.name])

  useEffect(() => {
    if (!desktopRuntime) return
    void installDesktopMenu(
      {
        canUndo: undoStackLength > 0,
        canRedo: redoStackLength > 0,
        canPaste: clipboardCount > 0,
        hasSelection: selectedIds.length > 0,
        hasChartData,
        simulationLocked,
        modalLocked: Boolean(gifExportModal || draftPrompt || helpTopic),
        gridVisible,
        snapEnabled,
        panelVisibility: {
          tools: workspacePanels.tools.visible,
          layers: workspacePanels.layers.visible,
          inspector: workspacePanels.inspector.visible,
          charts: workspacePanels.charts.visible,
        },
        recentFiles,
      },
      {
        execute: (command) => desktopHandlersRef.current?.execute(command),
        openRecent: (id) => desktopHandlersRef.current?.openRecent(id),
        clearRecent: () => desktopHandlersRef.current?.clearRecent(),
      },
    ).catch((error) =>
      showNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : '无法更新桌面系统菜单。',
      }),
    )
  }, [
    clipboardCount,
    gridVisible,
    hasChartData,
    draftPrompt,
    gifExportModal,
    helpTopic,
    recentFiles,
    redoStackLength,
    selectedIds,
    simulationLocked,
    showNotice,
    snapEnabled,
    undoStackLength,
    workspacePanels,
  ])

  useEffect(
    () => () => {
      if (desktopRuntime) void closeDesktopMenu()
    },
    [],
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (gifExportModal || draftPrompt || helpTopic) return
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
        const editor = useEditorStore.getState()
        editor.clearSelection()
        editor.setGroundJointStart(null)
        editor.setGroundJointMessage(null)
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
        s: 'scale',
        h: 'hand',
        z: 'zoom',
        g: 'ground',
        j: 'groundJoint',
        o: 'body',
        f: 'field',
        l: 'connector',
      } as const
      const tool = shortcuts[key as keyof typeof shortcuts]
      if (tool === 'scale' && isSimulationRuntimeLocked(useSimulationStore.getState())) return
      if (tool) useEditorStore.getState().setActiveTool(tool)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  return (
    <div
      className={desktopRuntime ? `${styles.appShell} ${styles.appShellDesktop}` : styles.appShell}
      onPointerDownCapture={(event) => commitPendingEditorEdit(event.target)}
    >
      {!desktopRuntime ? (
        <MenuBar
          navigationVisible
          sceneName={scene.metadata.name}
          fileName={fileName}
          isDirty={isDirty}
          onNew={handleNew}
          onOpen={handleOpenRequest}
          onSave={() => void handleSave()}
          onSaveAs={() => void handleSave(true)}
          onExportCsv={handleExportCsv}
          onExportGif={() => void handleOpenGifExport()}
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
          onClearRecords={handleClearRecords}
          onShowShortcuts={() => setHelpTopic('shortcuts')}
          onShowPhysics={() => setHelpTopic('physics')}
          canUndo={undoStackLength > 0}
          canRedo={redoStackLength > 0}
          canPaste={clipboardCount > 0}
          hasSelection={selectedIds.length > 0}
          hasChartData={hasChartData}
          gridVisible={gridVisible}
          snapEnabled={snapEnabled}
          panelVisibility={{
            tools: workspacePanels.tools.visible,
            layers: workspacePanels.layers.visible,
            inspector: workspacePanels.inspector.visible,
            charts: workspacePanels.charts.visible,
          }}
          onTogglePanel={(panelId) =>
            useWorkspaceLayoutStore.getState().togglePanelVisible(panelId)
          }
          onResetWorkspaceLayout={() => useWorkspaceLayoutStore.getState().resetLayout()}
        />
      ) : null}
      <ToolOptionsBar />

      <DockableWorkspace />
      <PlaybackBar />

      {gifExportModal?.state === 'preparing' ? <GifExportPreparingDialog /> : null}
      {gifExportModal?.state === 'ready' ? (
        <GifExportDialog
          scene={gifExportModal.scene}
          snapshot={gifExportModal.snapshot}
          initialGridVisible={gridVisible}
          onClose={() => setGifExportModal(null)}
          onExported={(exportedFileName, method) => {
            setGifExportModal(null)
            showNotice({
              tone: 'success',
              message:
                method === 'direct' ? `已导出 ${exportedFileName}` : `已下载 ${exportedFileName}`,
            })
          }}
        />
      ) : null}

      <input
        ref={inputRef}
        className={styles.hiddenInput}
        type="file"
        accept=".motionstudio,.motion.json,.json,application/vnd.motion-studio.scene+json,application/json"
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
                  fileTokenRef.current = null
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
            <h2 id="help-title">
              {helpTopic === 'shortcuts'
                ? '快捷键与入门'
                : helpTopic === 'physics'
                  ? '物理模型与近似'
                  : '关于 Motion Studio'}
            </h2>
            {helpTopic === 'shortcuts' ? (
              <ul>
                <li>V / R / S：选择移动 / 旋转 / 对象缩放；Z：画布缩放。</li>
                <li>G / O / F / L：地面、物体、场、连接。</li>
                <li>P：播放或暂停；句点：单步；Shift+R：重置。</li>
                <li>Ctrl+S / O / Z / Y / C / V：保存、打开、撤销、重做、复制、粘贴。</li>
                <li>J 地面连接点；空格临时抓手；Alt 临时关闭吸附；Delete 删除选择。</li>
              </ul>
            ) : helpTopic === 'physics' ? (
              <ul>
                <li>模拟使用固定时间步长，结果存在可测量的离散误差。</li>
                <li>圆弧与贝塞尔地面通常以误差受控的折线参与碰撞。</li>
                <li>场边界按物体中心判断；小球关闭碰撞时不会创建碰撞体。</li>
                <li>浮点数会产生极小误差。本工具适合教学和常规模拟，不替代科研验证。</li>
              </ul>
            ) : (
              <div>
                <p>Motion Studio 1.0.0</p>
                <p>二维物理运动建模、仿真与可视化工具。</p>
                <p>采用 Apache-2.0 许可证开源。</p>
              </div>
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
