import { useMemo } from 'react'

import { useDocumentStore } from '../../stores/documentStore'
import { useEditorStore } from '../../stores/editorStore'
import { useSimulationStore } from '../../stores/simulationStore'
import styles from '../canvas/CanvasWorkspace.module.css'
import { analyzeBodyForces } from './forceAnalysis'
import { forceColorCss } from './forcePresentation'

function formatForce(value: number): string {
  return Number(value.toPrecision(5)).toString()
}

export function ForceProbePanel() {
  const scene = useDocumentStore((state) => state.scene)
  const probe = useEditorStore((state) => state.forceProbe)
  const runtimeBodies = useSimulationStore((state) => state.runtimeBodies)
  const runtimeConnectors = useSimulationStore((state) => state.runtimeConnectors)
  const time = useSimulationStore((state) => state.simulationTime)
  const analysis = useMemo(
    () =>
      probe ? analyzeBodyForces(scene, probe.bodyId, runtimeBodies, time, runtimeConnectors) : null,
    [probe, runtimeBodies, runtimeConnectors, scene, time],
  )
  if (!probe) return null

  return (
    <aside className={styles.forceProbePanel} aria-label="测力计受力分析">
      <strong>受力分析 · t={formatForce(time)} s</strong>
      {analysis ? (
        analysis.map((entry) => {
          const magnitude = Math.hypot(entry.force.x, entry.force.y)
          return (
            <div key={entry.key} data-total={entry.key === 'net'}>
              <span className={styles.forceProbeLabel}>
                <i style={{ backgroundColor: forceColorCss(entry) }} aria-hidden="true" />
                {entry.label}
              </span>
              <output>
                {formatForce(magnitude)} N · ({formatForce(entry.force.x)},{' '}
                {formatForce(entry.force.y)})
              </output>
              {entry.derived ? (
                <small>
                  {entry.category === 'constraint'
                    ? '由最终合力减去已知外力和已归属来源得到'
                    : '由最终合力和当前连接/接触方向分解得到'}
                </small>
              ) : null}
            </div>
          )
        })
      ) : (
        <p>目标物体已经不存在。</p>
      )}
    </aside>
  )
}
