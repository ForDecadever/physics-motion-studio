import {
  Box,
  ChevronDown,
  Eye,
  Layers3,
  Link2,
  Lock,
  Magnet,
  Plus,
  Spline,
  Trash2,
} from 'lucide-react'

import { useDocumentStore } from '../../stores/documentStore'
import { useEditorStore } from '../../stores/editorStore'
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
  const setSelectedIds = useEditorStore((state) => state.setSelectedIds)

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
              <button className={styles.layerRow} type="button" data-active>
                <ChevronDown size={14} />
                <span className={styles.layerIcon}>
                  <Layers3 size={15} />
                </span>
                <span className={styles.layerName}>{layer.name}</span>
                <span className={styles.layerCount}>{layerEntities.length}</span>
                <Eye size={14} aria-label={layer.visible ? '可见' : '隐藏'} />
                {layer.locked ? <Lock size={13} aria-label="已锁定" /> : null}
              </button>
              <div className={styles.entityList}>
                {layerEntities.map((entity) => {
                  const EntityIcon = entityIcons[entity.kind]
                  return (
                    <button
                      className={styles.entityRow}
                      type="button"
                      data-selected={selectedIds.includes(entity.id)}
                      onClick={() => setSelectedIds([entity.id])}
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
        <button type="button" disabled title="图层编辑将在编辑器阶段接入">
          <Plus size={15} />
          新建图层
        </button>
        <button type="button" disabled aria-label="删除图层" title="当前不可删除">
          <Trash2 size={15} />
        </button>
      </footer>
    </section>
  )
}
