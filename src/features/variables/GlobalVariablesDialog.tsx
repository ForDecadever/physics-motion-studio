import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import styles from '../../app/App.module.css'
import { createReplaceSceneCommand } from '../../editor/commands/entityCommands'
import {
  recomputePropertyExpressions,
  resolveGlobalVariables,
} from '../../scene/model/propertyExpressions'
import type { GlobalVariableDefinition, SceneDocument } from '../../scene/model/types'
import { useDocumentStore } from '../../stores/documentStore'

interface GlobalVariablesDialogProps {
  scene: SceneDocument
  onClose: () => void
  onApplied: () => void
}

function nextVariableName(definitions: readonly GlobalVariableDefinition[]): string {
  const used = new Set(definitions.map((definition) => definition.name))
  for (const name of 'abcdefghijklmnopqrstuvwxyz') if (!used.has(name)) return name
  let index = 1
  while (used.has(`variable${index}`)) index += 1
  return `variable${index}`
}

export function GlobalVariablesDialog({ scene, onClose, onApplied }: GlobalVariablesDialogProps) {
  const [drafts, setDrafts] = useState<GlobalVariableDefinition[]>(() =>
    scene.globalVariables.map((definition) => ({ ...definition })),
  )
  const [applyError, setApplyError] = useState<string | null>(null)
  const resolution = useMemo(() => {
    try {
      return { result: resolveGlobalVariables(drafts), error: null }
    } catch (error) {
      return {
        result: null,
        error: error instanceof Error ? error.message : '全局变量定义无效。',
      }
    }
  }, [drafts])
  const update = (index: number, patch: Partial<GlobalVariableDefinition>) =>
    setDrafts((current) =>
      current.map((definition, candidate) =>
        candidate === index ? { ...definition, ...patch } : definition,
      ),
    )
  const move = (index: number, offset: -1 | 1) =>
    setDrafts((current) => {
      const target = index + offset
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      const [definition] = next.splice(index, 1)
      if (definition) next.splice(target, 0, definition)
      return next
    })

  return (
    <div className={styles.modalBackdrop}>
      <section
        className={`${styles.modal} ${styles.wideModal}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="global-variables-title"
      >
        <h2 id="global-variables-title">全局变量</h2>
        <p>变量可以引用排在它前面的变量；属性中可直接输入 3a、a/10 或 sin(a)。</p>
        <div className={styles.variableTable}>
          <div className={styles.variableHeader} aria-hidden="true">
            <span>符号</span>
            <span>定义</span>
            <span>当前值</span>
            <span>操作</span>
          </div>
          {drafts.map((definition, index) => (
            <div className={styles.variableRow} key={`${index}-${definition.name}`}>
              <input
                aria-label={`变量 ${index + 1} 符号`}
                value={definition.name}
                onChange={(event) => update(index, { name: event.target.value })}
              />
              <input
                aria-label={`变量 ${definition.name || index + 1} 定义`}
                value={definition.expression}
                onChange={(event) => update(index, { expression: event.target.value })}
              />
              <output>{resolution.result?.definitions[index]?.value.toPrecision(8) ?? '—'}</output>
              <span className={styles.variableActions}>
                <button
                  type="button"
                  aria-label={`上移变量 ${definition.name}`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  aria-label={`下移变量 ${definition.name}`}
                  disabled={index === drafts.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  type="button"
                  aria-label={`删除变量 ${definition.name}`}
                  onClick={() =>
                    setDrafts((current) => current.filter((_, item) => item !== index))
                  }
                >
                  <Trash2 size={14} />
                </button>
              </span>
            </div>
          ))}
        </div>
        {drafts.length === 0 ? <p className={styles.emptyModalState}>尚未定义全局变量。</p> : null}
        {resolution.error || applyError ? (
          <p className={styles.modalError}>{resolution.error ?? applyError}</p>
        ) : null}
        <div className={styles.modalActions}>
          <button
            type="button"
            onClick={() => {
              if (!resolution.result) return
              try {
                const document = useDocumentStore.getState()
                const next = recomputePropertyExpressions(
                  document.scene,
                  resolution.result.definitions,
                )
                document.executeCommand(
                  createReplaceSceneCommand(document.scene, next, '修改全局变量'),
                )
                onApplied()
              } catch (error) {
                setApplyError(
                  error instanceof Error ? error.message : '无法应用全局变量，请检查属性公式。',
                )
              }
            }}
            disabled={!resolution.result}
          >
            应用
          </button>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            onClick={() =>
              setDrafts((current) => [
                ...current,
                { name: nextVariableName(current), expression: '1', value: 1 },
              ])
            }
          >
            <Plus size={14} /> 新增变量
          </button>
        </div>
      </section>
    </div>
  )
}
