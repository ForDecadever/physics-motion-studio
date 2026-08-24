import {
  ArrowUpDown,
  Box,
  BoxSelect,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  GitMerge,
  Link2,
  Lock,
  LockOpen,
  Magnet,
  Plus,
  Sparkles,
  Spline,
  MoveUpRight,
  Pencil,
  Trash2,
  Unlink,
} from 'lucide-react'
import { useState } from 'react'

import {
  createAddBooleanOperandCommand,
  createDissolveBooleanLayerCommand,
  createMoveTreeItemToRootCommand,
  createRemoveBooleanOperandCommand,
  createReplaceBooleanNodeCommand,
  createSwapBooleanOperandsCommand,
} from '../../editor/commands/booleanLayerCommands'
import {
  createDeleteEntitiesCommand,
  createReplaceEntitiesCommand,
} from '../../editor/commands/entityCommands'
import { commitPendingEditorEdit } from '../../editor/editing/pendingEditorEdit'
import { resolveBooleanScene } from '../../scene/model/booleanGeometry'
import { sceneTreeItemTargetId } from '../../scene/model/booleanLayerGraph'
import type { BooleanNode, SceneEntity, SceneTreeItem } from '../../scene/model/types'
import { useDocumentStore } from '../../stores/documentStore'
import { useEditorStore } from '../../stores/editorStore'
import { isSimulationRuntimeLocked, useSimulationStore } from '../../stores/simulationStore'
import styles from '../panels/Panels.module.css'

const entityIcons = {
  ground: Spline,
  groundJoint: GitMerge,
  body: Box,
  field: Magnet,
  connector: Link2,
  particleSource: Sparkles,
  force: MoveUpRight,
  measurement: Pencil,
}

export function LayersPanel({ embedded = false }: { embedded?: boolean }) {
  const scene = useDocumentStore((state) => state.scene)
  const selectedIds = useEditorStore((state) => state.selectedIds)
  const setSelectedIds = useEditorStore((state) => state.setSelectedIds)
  const toggleSelectedId = useEditorStore((state) => state.toggleSelectedId)
  const runtimeLocked = useSimulationStore(isSimulationRuntimeLocked)
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(() => new Set())
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draggedTargetId, setDraggedTargetId] = useState<string | null>(null)
  const booleanScene = resolveBooleanScene(scene)

  const execute = (command: ReturnType<typeof createDeleteEntitiesCommand>) => {
    if (runtimeLocked || !command) return
    commitPendingEditorEdit()
    useDocumentStore.getState().executeCommand(command)
  }
  const replaceEntity = (entity: SceneEntity, label: string) => {
    if (runtimeLocked) return
    const document = useDocumentStore.getState()
    document.executeCommand(createReplaceEntitiesCommand(document.scene, [entity], label))
  }
  const replaceNode = (node: BooleanNode, label: string) => {
    if (runtimeLocked) return
    const document = useDocumentStore.getState()
    document.executeCommand(createReplaceBooleanNodeCommand(document.scene, node, label))
  }

  const renderItem = (
    item: SceneTreeItem,
    depth: number,
    parent: BooleanNode | null,
    operandIndex: number,
  ): React.ReactNode => {
    const targetId = sceneTreeItemTargetId(item)
    if (item.kind === 'entity') {
      const entity = scene.entities.find((candidate) => candidate.id === item.entityId)
      if (!entity) {
        return (
          <div className={styles.booleanDiagnostic} style={{ paddingLeft: 12 + depth * 18 }}>
            缺失实体 {item.entityId}
          </div>
        )
      }
      const Icon = entityIcons[entity.kind]
      return (
        <div
          className={styles.entityRow}
          key={targetId}
          data-selected={selectedIds.includes(targetId)}
          data-visible={entity.visible}
          style={{ paddingLeft: 8 + depth * 18 }}
          draggable={!runtimeLocked}
          onDragStart={() => setDraggedTargetId(targetId)}
          onDragEnd={() => setDraggedTargetId(null)}
          onDragOver={(event) => {
            if (!parent && draggedTargetId) event.preventDefault()
          }}
          onDrop={(event) => {
            if (parent || !draggedTargetId) return
            const bounds = event.currentTarget.getBoundingClientRect()
            const placement = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
            execute(createMoveTreeItemToRootCommand(scene, draggedTargetId, targetId, placement))
            setDraggedTargetId(null)
          }}
        >
          <button
            type="button"
            className={styles.entitySelect}
            onDoubleClick={() => setRenamingId(targetId)}
            onClick={(event) =>
              event.shiftKey ? toggleSelectedId(targetId) : setSelectedIds([targetId])
            }
          >
            <Icon size={14} />
            {renamingId === targetId ? (
              <input
                className={styles.inlineNameInput}
                defaultValue={entity.name}
                autoFocus
                aria-label={`重命名 ${entity.name}`}
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim()
                  if (name && name !== entity.name) replaceEntity({ ...entity, name }, '重命名实体')
                  setRenamingId(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                  if (event.key === 'Escape') setRenamingId(null)
                }}
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              <span>{entity.name}</span>
            )}
          </button>
          <div className={styles.entityActions}>
            {parent ? (
              <button
                type="button"
                className={styles.entityAction}
                aria-label="移出布尔组合"
                title="移出布尔组合"
                disabled={runtimeLocked}
                onClick={() =>
                  execute(createRemoveBooleanOperandCommand(scene, parent.id, operandIndex))
                }
              >
                <Unlink size={13} />
              </button>
            ) : null}
            <button
              type="button"
              className={styles.entityAction}
              aria-label={`${entity.visible ? '隐藏' : '显示'}对象 ${entity.name}`}
              disabled={runtimeLocked}
              onClick={() =>
                replaceEntity(
                  { ...entity, visible: !entity.visible },
                  entity.visible ? '隐藏实体' : '显示实体',
                )
              }
            >
              {entity.visible ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
            <button
              type="button"
              className={styles.entityAction}
              aria-label={`${entity.locked ? '解锁' : '锁定'}对象 ${entity.name}`}
              disabled={runtimeLocked}
              onClick={() =>
                replaceEntity(
                  { ...entity, locked: !entity.locked },
                  entity.locked ? '解锁实体' : '锁定实体',
                )
              }
            >
              {entity.locked ? <Lock size={13} /> : <LockOpen size={13} />}
            </button>
            <button
              type="button"
              className={`${styles.entityAction} ${styles.entityDelete}`}
              aria-label={`删除对象 ${entity.name}`}
              disabled={runtimeLocked}
              onClick={() => execute(createDeleteEntitiesCommand(scene, [targetId]))}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      )
    }

    const expanded = !collapsedNodeIds.has(item.id)
    const resolved = booleanScene.byResultId.get(item.resultId)
    const selectedOperandId = selectedIds.find((selectedId) => selectedId !== item.resultId)
    return (
      <div className={styles.layerGroup} key={item.id}>
        <div
          className={styles.layerRow}
          data-active={selectedIds.includes(item.resultId)}
          style={{ paddingLeft: 4 + depth * 18 }}
          draggable={!runtimeLocked}
          onDragStart={() => setDraggedTargetId(item.resultId)}
          onDragEnd={() => setDraggedTargetId(null)}
          onDragOver={(event) => {
            if (draggedTargetId && (!parent || item.operands.length < 2)) event.preventDefault()
          }}
          onDrop={(event) => {
            if (!draggedTargetId) return
            const bounds = event.currentTarget.getBoundingClientRect()
            const relativeY = (event.clientY - bounds.top) / bounds.height
            const rootReorder = !parent && (relativeY < 0.25 || relativeY > 0.75)
            if (rootReorder) {
              execute(
                createMoveTreeItemToRootCommand(
                  scene,
                  draggedTargetId,
                  item.resultId,
                  relativeY < 0.5 ? 'before' : 'after',
                ),
              )
            } else {
              execute(createAddBooleanOperandCommand(scene, item.id, draggedTargetId))
            }
            setDraggedTargetId(null)
          }}
        >
          <button
            type="button"
            className={styles.layerToggle}
            aria-label={expanded ? '收起布尔组合' : '展开布尔组合'}
            aria-expanded={expanded}
            onClick={() =>
              setCollapsedNodeIds((current) => {
                const next = new Set(current)
                if (expanded) next.add(item.id)
                else next.delete(item.id)
                return next
              })
            }
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <button
            type="button"
            className={styles.layerNameButton}
            aria-label={item.name}
            onDoubleClick={() => setRenamingId(item.resultId)}
            onClick={(event) =>
              event.shiftKey ? toggleSelectedId(item.resultId) : setSelectedIds([item.resultId])
            }
          >
            {item.operation === 'union' ? (
              <GitMerge size={14} />
            ) : item.operation === 'intersection' ? (
              <BoxSelect size={14} />
            ) : (
              <Box size={14} />
            )}
            {renamingId === item.resultId ? (
              <input
                className={styles.inlineNameInput}
                defaultValue={item.name}
                autoFocus
                aria-label={`重命名 ${item.name}`}
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim()
                  if (name && name !== item.name) replaceNode({ ...item, name }, '重命名布尔组合')
                  setRenamingId(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                  if (event.key === 'Escape') setRenamingId(null)
                }}
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              <span>{item.name}</span>
            )}
            <span className={styles.layerCount}>{item.operands.length}/2</span>
          </button>
          <div className={styles.entityActions}>
            {item.operands.length === 2 ? (
              <button
                type="button"
                className={styles.entityAction}
                aria-label="交换输入"
                disabled={runtimeLocked}
                onClick={() => execute(createSwapBooleanOperandsCommand(scene, item.id))}
              >
                <ArrowUpDown size={13} />
              </button>
            ) : null}
            {item.operands.length < 2 ? (
              <button
                type="button"
                className={styles.entityAction}
                aria-label="添加当前所选对象"
                title="添加当前所选对象"
                disabled={runtimeLocked || !selectedOperandId}
                onClick={() =>
                  selectedOperandId &&
                  execute(createAddBooleanOperandCommand(scene, item.id, selectedOperandId))
                }
              >
                <Plus size={13} />
              </button>
            ) : null}
            <button
              type="button"
              className={styles.entityAction}
              aria-label={`${item.visible ? '隐藏' : '显示'}布尔组合 ${item.name}`}
              disabled={runtimeLocked}
              onClick={() =>
                replaceNode(
                  { ...item, visible: !item.visible },
                  item.visible ? '隐藏布尔组合' : '显示布尔组合',
                )
              }
            >
              {item.visible ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
            <button
              type="button"
              className={styles.entityAction}
              aria-label={`${item.locked ? '解锁' : '锁定'}布尔组合 ${item.name}`}
              disabled={runtimeLocked}
              onClick={() =>
                replaceNode(
                  { ...item, locked: !item.locked },
                  item.locked ? '解锁布尔组合' : '锁定布尔组合',
                )
              }
            >
              {item.locked ? <Lock size={13} /> : <LockOpen size={13} />}
            </button>
            <button
              type="button"
              className={styles.entityAction}
              aria-label={`解散布尔组合 ${item.name}`}
              disabled={runtimeLocked}
              onClick={() => execute(createDissolveBooleanLayerCommand(scene, item.id))}
            >
              <Unlink size={13} />
            </button>
            <button
              type="button"
              className={`${styles.entityAction} ${styles.entityDelete}`}
              aria-label={`删除布尔组合 ${item.name}`}
              disabled={runtimeLocked}
              onClick={() => execute(createDeleteEntitiesCommand(scene, [item.resultId]))}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
        {!resolved?.valid ? (
          <div className={styles.booleanDiagnostic} style={{ paddingLeft: 28 + depth * 18 }}>
            {resolved?.diagnostics[0] ?? '需要两个兼容输入'}
          </div>
        ) : null}
        {expanded ? (
          <div className={styles.entityList}>
            {item.operands.map((operand, index) => renderItem(operand, depth + 1, item, index))}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <section
      className={styles.panel}
      data-embedded={embedded}
      aria-label={embedded ? '场景树' : undefined}
    >
      {!embedded ? (
        <header className={styles.panelHeader}>
          <h2>场景树</h2>
        </header>
      ) : null}
      <div className={styles.layerList}>
        {scene.rootItems.length > 0 ? (
          scene.rootItems.map((item, index) => renderItem(item, 0, null, index))
        ) : (
          <div className={styles.emptyState}>场景为空。可从左侧工具栏创建对象或布尔组合。</div>
        )}
      </div>
    </section>
  )
}
