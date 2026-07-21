import {
  Box,
  ChevronDown,
  Eye,
  EyeOff,
  Layers3,
  Link2,
  Lock,
  LockOpen,
  Magnet,
  Plus,
  Spline,
  Trash2,
} from 'lucide-react'

import { useDocumentStore } from '../../stores/documentStore'
import { useEditorStore } from '../../stores/editorStore'
import { createReplaceLayersCommand } from '../../editor/commands/entityCommands'
import { isSimulationRuntimeLocked, useSimulationStore } from '../../stores/simulationStore'
import styles from '../panels/Panels.module.css'

const entityIcons = {
  ground: Spline,
  body: Box,
  field: Magnet,
  connector: Link2,
}

export function LayersPanel() {
  const layers = useDocumentStore((state) => state.scene.layers)
  const entities = useDocumentStore((state) => state.scene.entities)
  const selectedIds = useEditorStore((state) => state.selectedIds)
  const activeLayerId = useEditorStore((state) => state.activeLayerId)
  const setSelectedIds = useEditorStore((state) => state.setSelectedIds)
  const setActiveLayerId = useEditorStore((state) => state.setActiveLayerId)
  const runtimeLocked = useSimulationStore((state) =>
    isSimulationRuntimeLocked({ status: state.status, simulationTime: state.simulationTime }),
  )

  const replaceLayers = (nextLayers: typeof layers, label: string) => {
    if (runtimeLocked) return
    const document = useDocumentStore.getState()
    document.executeCommand(createReplaceLayersCommand(document.scene, nextLayers, label))
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
    <section className={styles.panel} aria-labelledby="layers-heading">
      <header className={styles.panelHeader}>
        <div>
          <span className={styles.eyebrow}>SCENE</span>
          <h2 id="layers-heading">图层</h2>
        </div>
        <span className={styles.countBadge}>{entities.length}</span>
      </header>

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
                <button
                  type="button"
                  className={styles.layerNameButton}
                  onClick={() => setActiveLayerId(layer.id)}
                >
                  <span className={styles.layerName}>{layer.name}</span>
                </button>
                <span className={styles.layerCount}>{layerEntities.length}</span>
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
                    <button
                      className={styles.entityRow}
                      type="button"
                      data-selected={selectedIds.includes(entity.id)}
                      onClick={(event) =>
                        event.shiftKey
                          ? useEditorStore.getState().toggleSelectedId(entity.id)
                          : setSelectedIds([entity.id])
                      }
                      key={entity.id}
                    >
                      <EntityIcon size={13} />
                      <span>{entity.name}</span>
                      {entity.locked ? <Lock size={11} /> : null}
                    </button>
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
