import { useEffect, useRef, useState, type ChangeEvent } from 'react'

import { createDeleteEntitiesCommand } from '../editor/commands/entityCommands'
import { CanvasWorkspace } from '../features/canvas/CanvasWorkspace'
import { ChartPanel } from '../features/charts/ChartPanel'
import { InspectorPanel } from '../features/inspector/InspectorPanel'
import { LayersPanel } from '../features/layers/LayersPanel'
import { MenuBar } from '../features/menu/MenuBar'
import { PlaybackBar } from '../features/playback/PlaybackBar'
import { ToolOptionsBar } from '../features/toolbar/ToolOptionsBar'
import { Toolbar } from '../features/toolbar/Toolbar'
import { downloadScene, readSceneFile } from '../persistence/sceneFile'
import { physicsClient } from '../physics/client/physicsClient'
import { useDocumentStore } from '../stores/documentStore'
import { useEditorStore } from '../stores/editorStore'
import { isSimulationRuntimeLocked, useSimulationStore } from '../stores/simulationStore'
import styles from './App.module.css'

interface Notice {
  tone: 'success' | 'error'
  message: string
}

export function App() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const scene = useDocumentStore((state) => state.scene)
  const fileName = useDocumentStore((state) => state.fileName)
  const isDirty = useDocumentStore((state) => state.isDirty)
  const createNewScene = useDocumentStore((state) => state.createNewScene)
  const replaceScene = useDocumentStore((state) => state.replaceScene)
  const markSaved = useDocumentStore((state) => state.markSaved)
  const undoStackLength = useDocumentStore((state) => state.undoStack.length)
  const redoStackLength = useDocumentStore((state) => state.redoStack.length)
  const undo = useDocumentStore((state) => state.undo)
  const redo = useDocumentStore((state) => state.redo)

  useEffect(() => {
    physicsClient.start()
    return () => physicsClient.stop()
  }, [])

  useEffect(() => {
    physicsClient.initialize(scene)
  }, [scene])

  const showNotice = (nextNotice: Notice) => {
    setNotice(nextNotice)
    window.setTimeout(() => setNotice(null), 3200)
  }

  const handleNew = () => {
    createNewScene()
    useEditorStore.getState().resetForDocument()
    showNotice({ tone: 'success', message: '已创建新的空场景' })
  }

  const handleOpenRequest = () => inputRef.current?.click()

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const [file] = event.target.files ?? []
    event.target.value = ''
    if (!file) return

    try {
      const nextScene = await readSceneFile(file)
      replaceScene(nextScene, file.name)
      useEditorStore.getState().resetForDocument()
      showNotice({ tone: 'success', message: `已打开 ${file.name}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法读取该场景文件。'
      showNotice({ tone: 'error', message })
    }
  }

  const handleSave = () => {
    try {
      const savedFileName = downloadScene(scene)
      markSaved(savedFileName)
      showNotice({ tone: 'success', message: `已下载 ${savedFileName}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法保存场景。'
      showNotice({ tone: 'error', message })
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
        handleSave()
        return
      }
      if (commandKey && key === 'o') {
        event.preventDefault()
        handleOpenRequest()
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
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        handleDelete()
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
    <div className={styles.appShell}>
      <MenuBar
        sceneName={scene.metadata.name}
        fileName={fileName}
        isDirty={isDirty}
        onNew={handleNew}
        onOpen={handleOpenRequest}
        onSave={handleSave}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={undoStackLength > 0}
        canRedo={redoStackLength > 0}
      />
      <ToolOptionsBar />

      <div className={styles.workspace}>
        <Toolbar />
        <CanvasWorkspace />
        <aside className={styles.rightDock} aria-label="图层和属性">
          <LayersPanel />
          <InspectorPanel />
        </aside>
      </div>

      <PlaybackBar />
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
        <div className={styles.notice} data-tone={notice.tone} role="status">
          {notice.message}
        </div>
      ) : null}
    </div>
  )
}
