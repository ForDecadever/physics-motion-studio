import {
  Box,
  ChevronDown,
  Eye,
  EyeOff,
  GitMerge,
  Layers3,
  Link2,
  Lock,
  LockOpen,
  Magnet,
  Pencil,
  Plus,
  Spline,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  cancelPendingEditorEdit,
  commitPendingEditorEdit,
  commitPendingEditorEditFromBlur,
  registerPendingEditorEdit,
} from '../../editor/editing/pendingEditorEdit'
import { useDocumentStore } from '../../stores/documentStore'
import { useEditorStore } from '../../stores/editorStore'
import {
  createDeleteEntitiesCommand,
  createReplaceEntitiesCommand,
  createReplaceLayersCommand,
} from '../../editor/commands/entityCommands'
import type { SceneEntity } from '../../scene/model/types'
import { isSimulationRuntimeLocked, useSimulationStore } from '../../stores/simulationStore'
import styles from '../panels/Panels.module.css'

const entityIcons = {
  ground: Spline,
  groundJoint: GitMerge,
  body: Box,
  field: Magnet,
  connector: Link2,
}

interface InlineRenameProps {
  value: string
  ariaLabel: string
  onCommit: (name: string) => void
  onDone: () => void
}

function InlineRename({ value, ariaLabel, onCommit, onDone }: InlineRenameProps) {
  const [draft, setDraft] = useState(value)
  const latest = useRef({ draft, value, onCommit, onDone })
  useEffect(() => {
    latest.current = { draft, value, onCommit, onDone }
  }, [draft, onCommit, onDone, value])

  const cancel = () => latest.current.onDone()
  const commit = () => {
    const current = latest.current
    const name = current.draft.trim()
    if (name && name !== current.value) current.onCommit(name)
    current.onDone()
  }

  return (
    <input
      className={styles.inlineNameInput}
      type="text"
      aria-label={ariaLabel}
      value={draft}
      maxLength={80}
      autoFocus
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => registerPendingEditorEdit({ input: event.currentTarget, commit, cancel })}
      onBlur={(event) => commitPendingEditorEditFromBlur(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commitPendingEditorEdit()
        if (event.key === 'Escape') cancelPendingEditorEdit(event.currentTarget)
      }}
      onPointerDown={(event) => event.stopPropagation()}
    />
  )
}

export function LayersPanel({ embedded = false }: { embedded?: boolean }) {
  const layers = useDocumentStore((state) => state.scene.layers)
  const entities = useDocumentStore((state) => state.scene.entities)
  const selectedIds = useEditorStore((state) => state.selectedIds)
  const activeLayerId = useEditorStore((state) => state.activeLayerId)
  const setSelectedIds = useEditorStore((state) => state.setSelectedIds)
  const setActiveLayerId = useEditorStore((state) => state.setActiveLayerId)
  const runtimeLocked = useSimulationStore((state) =>
    isSimulationRuntimeLocked({ status: state.status, simulationTime: state.simulationTime }),
  )
  const [renaming, setRenaming] = useState<{ type: 'layer' | 'entity'; id: string } | null>(null)

  const replaceLayers = (nextLayers: typeof layers, label: string) => {
    if (runtimeLocked) return
    const document = useDocumentStore.getState()
    document.executeCommand(createReplaceLayersCommand(document.scene, nextLayers, label))
  }

  const replaceEntity = (nextEntity: SceneEntity, label: string) => {
    if (runtimeLocked) return
    const document = useDocumentStore.getState()
    document.executeCommand(createReplaceEntitiesCommand(document.scene, [nextEntity], label))
  }

  const deleteEntity = (entityId: string) => {
    if (runtimeLocked) return
    const document = useDocumentStore.getState()
    const command = createDeleteEntitiesCommand(document.scene, [entityId])
    if (!command) return
    document.executeCommand(command)

    const validEntities = useDocumentStore.getState().scene.entities
    const validIds = new Set(validEntities.map((entity) => entity.id))
    const editor = useEditorStore.getState()
    editor.setSelectedIds(editor.selectedIds.filter((id) => validIds.has(id)))
    if (editor.connectorStartBodyId && !validIds.has(editor.connectorStartBodyId)) {
      editor.setConnectorStartBodyId(null)
    }
    const validGroundIds = new Set(
      validEntities.filter((entity) => entity.kind === 'ground').map((entity) => entity.id),
    )
    const groundJointStartInvalid =
      editor.groundJointStart && !validGroundIds.has(editor.groundJointStart.groundId)
    const groundJointHoverInvalid =
      editor.groundJointHover && !validGroundIds.has(editor.groundJointHover.groundId)
    if (groundJointStartInvalid) {
      editor.setGroundJointStart(null)
    }
    if (groundJointHoverInvalid) {
      editor.setGroundJointHover(null)
    }
    if (groundJointStartInvalid || groundJointHoverInvalid) {
      editor.setGroundJointMessage(null)
    }
  }

  const addLayer = () => {
    const layerId = crypto.randomUUID()
    replaceLayers(
      [
        ...layers,
        {
          id: layerId,
          name: `图层 ${layers.length + 1}`,
          visible: true,
          locked: false,
        },
      ],
      '新建图层',
    )
    setActiveLayerId(layerId)
  }

  const lastLayer = layers.at(-1)
  const canDeleteLastLayer =
    !runtimeLocked &&
    layers.length > 1 &&
    Boolean(lastLayer && !entities.some((entity) => entity.layerId === lastLayer.id))

  return (
    <section
      className={styles.panel}
      data-embedded={embedded}
      aria-label={embedded ? '图层内容' : undefined}
      aria-labelledby={embedded ? undefined : 'layers-heading'}
    >
      {embedded ? null : (
        <header className={styles.panelHeader}>
          <div>
            <span className={styles.eyebrow}>SCENE</span>
            <h2 id="layers-heading">图层</h2>
          </div>
          <span className={styles.countBadge}>{entities.length}</span>
        </header>
      )}

      <div className={styles.layerList}>
        {layers.map((layer) => {
          const layerEntities = entities.filter((entity) => entity.layerId === layer.id)
          return (
            <div className={styles.layerGroup} key={layer.id}>
              <div className={styles.layerRow} data-active={activeLayerId === layer.id}>
                <ChevronDown size={14} />
                <span className={styles.layerIcon}>
                  <Layers3 size={15} />
                </span>
                {renaming?.type === 'layer' && renaming.id === layer.id ? (
                  <InlineRename
                    value={layer.name}
                    ariaLabel={`重命名图层 ${layer.name}`}
                    onDone={() => setRenaming(null)}
                    onCommit={(name) =>
                      replaceLayers(
                        layers.map((candidate) =>
                          candidate.id === layer.id ? { ...candidate, name } : candidate,
                        ),
                        '重命名图层',
                      )
                    }
                  />
                ) : (
                  <button
                    type="button"
                    className={styles.layerNameButton}
                    onClick={() => setActiveLayerId(layer.id)}
                    onDoubleClick={() => {
                      if (!runtimeLocked) setRenaming({ type: 'layer', id: layer.id })
                    }}
                  >
                    <span className={styles.layerName}>{layer.name}</span>
                  </button>
                )}
                <span className={styles.layerCount}>{layerEntities.length}</span>
                <button
                  type="button"
                  className={styles.layerToggle}
                  disabled={runtimeLocked}
                  aria-label={`重命名图层 ${layer.name}`}
                  onClick={() => setRenaming({ type: 'layer', id: layer.id })}
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  className={styles.layerToggle}
                  disabled={runtimeLocked}
                  aria-label={`${layer.visible ? '隐藏' : '显示'}图层 ${layer.name}`}
                  aria-pressed={layer.visible}
                  onClick={() =>
                    replaceLayers(
                      layers.map((candidate) =>
                        candidate.id === layer.id
                          ? { ...candidate, visible: !candidate.visible }
                          : candidate,
                      ),
                      '切换图层显示',
                    )
                  }
                >
                  {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
                <button
                  type="button"
                  className={styles.layerToggle}
                  disabled={runtimeLocked}
                  aria-label={`${layer.locked ? '解锁' : '锁定'}图层 ${layer.name}`}
                  aria-pressed={layer.locked}
                  onClick={() =>
                    replaceLayers(
                      layers.map((candidate) =>
                        candidate.id === layer.id
                          ? { ...candidate, locked: !candidate.locked }
                          : candidate,
                      ),
                      '切换图层锁定',
                    )
                  }
                >
                  {layer.locked ? <Lock size={13} /> : <LockOpen size={13} />}
                </button>
              </div>
              <div className={styles.entityList}>
                {layerEntities.map((entity) => {
                  const EntityIcon = entityIcons[entity.kind]
                  return (
                    <div
                      className={styles.entityRow}
                      data-selected={selectedIds.includes(entity.id)}
                      data-visible={entity.visible}
                      key={entity.id}
                    >
                      {renaming?.type === 'entity' && renaming.id === entity.id ? (
                        <div className={styles.entitySelect} data-editing="true">
                          <EntityIcon size={13} />
                          <InlineRename
                            value={entity.name}
                            ariaLabel={`重命名 ${entity.name}`}
                            onDone={() => setRenaming(null)}
                            onCommit={(name) => replaceEntity({ ...entity, name }, '重命名对象')}
                          />
                          {entity.locked ? <Lock size={11} /> : null}
                        </div>
                      ) : (
                        <button
                          className={styles.entitySelect}
                          type="button"
                          onClick={(event) =>
                            event.shiftKey
                              ? useEditorStore.getState().toggleSelectedId(entity.id)
                              : setSelectedIds([entity.id])
                          }
                          onDoubleClick={() => {
                            if (!runtimeLocked) setRenaming({ type: 'entity', id: entity.id })
                          }}
                        >
                          <EntityIcon size={13} />
                          <span>{entity.name}</span>
                          {entity.locked ? <Lock size={11} /> : null}
                        </button>
                      )}
                      <div className={styles.entityActions}>
                        <button
                          type="button"
                          className={styles.entityAction}
                          disabled={runtimeLocked}
                          aria-label={`重命名对象 ${entity.name}`}
                          onClick={() => setRenaming({ type: 'entity', id: entity.id })}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          className={styles.entityAction}
                          disabled={runtimeLocked}
                          aria-label={`${entity.visible ? '隐藏' : '显示'}对象 ${entity.name}`}
                          aria-pressed={entity.visible}
                          onClick={() =>
                            replaceEntity(
                              { ...entity, visible: !entity.visible },
                              entity.visible ? '隐藏对象' : '显示对象',
                            )
                          }
                        >
                          {entity.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                        </button>
                        <button
                          type="button"
                          className={`${styles.entityAction} ${styles.entityDelete}`}
                          disabled={runtimeLocked}
                          aria-label={`删除对象 ${entity.name}`}
                          onClick={() => deleteEntity(entity.id)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  )
                })}
                {layerEntities.length === 0 ? (
                  <span className={styles.emptyLayer}>使用左侧工具在画布中创建实体</span>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      <footer className={styles.panelFooter}>
        <button type="button" disabled={runtimeLocked} onClick={addLayer}>
          <Plus size={15} />
          新建图层
        </button>
        <button
          type="button"
          disabled={!canDeleteLastLayer}
          aria-label="删除最后一个空图层"
          title="只能删除最后一个空图层"
          onClick={() => {
            if (lastLayer) replaceLayers(layers.slice(0, -1), '删除空图层')
          }}
        >
          <Trash2 size={15} />
        </button>
      </footer>
    </section>
  )
}
