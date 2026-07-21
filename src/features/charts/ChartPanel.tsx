import { ChevronDown, LineChart, Plus } from 'lucide-react'

import styles from '../playback/BottomDock.module.css'

export function ChartPanel() {
  return (
    <section className={styles.chartPanel} aria-labelledby="chart-heading">
      <header className={styles.chartHeader}>
        <div className={styles.chartTitle}>
          <LineChart size={15} />
          <h2 id="chart-heading">物理量—时间</h2>
          <span className={styles.chartBadge}>0 条曲线</span>
        </div>
        <div className={styles.chartActions}>
          <button type="button" disabled title="选择物体后可添加曲线">
            <Plus size={14} />
            添加曲线
          </button>
          <button type="button" aria-label="折叠图表">
            <ChevronDown size={15} />
          </button>
        </div>
      </header>

      <div className={styles.chartBody}>
        <div className={styles.yAxisLabel}>物理量</div>
        <div className={styles.chartGrid}>
          <div className={styles.chartEmpty}>
            <LineChart size={18} />
            <span>选择物体并添加要观察的物理量</span>
          </div>
        </div>
        <div className={styles.xAxisLabel}>t / s</div>
      </div>
    </section>
  )
}
