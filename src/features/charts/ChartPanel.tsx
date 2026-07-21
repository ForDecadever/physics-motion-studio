import { LineChart as EChartsLineChart } from 'echarts/charts'
import { DataZoomInsideComponent, GridComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { ChevronDown, Download, Eye, EyeOff, LineChart, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { physicsClient } from '../../physics/client/physicsClient'
import type { BodyEntity } from '../../scene/model/types'
import { useDocumentStore } from '../../stores/documentStore'
import { useEditorStore } from '../../stores/editorStore'
import { MAX_CHART_CURVES, useChartStore } from '../../stores/chartStore'
import { chartMetricDefinitions, type ChartMetricId } from './chartMetrics'
import { downloadChartCsv } from './chartCsv'
import styles from './ChartPanel.module.css'

echarts.use([
  EChartsLineChart,
  GridComponent,
  TooltipComponent,
  DataZoomInsideComponent,
  CanvasRenderer,
])

function ChartCanvas() {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.EChartsType | null>(null)
  const curves = useChartStore((state) => state.curves)
  const series = useChartStore((state) => state.series)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const chart = echarts.init(host, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(host)
    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const visibleCurves = curves.filter((curve) => curve.visible)
    const units = [...new Set(visibleCurves.map((curve) => curve.unit))]
    chart.setOption(
      {
        animation: false,
        backgroundColor: 'transparent',
        grid: { left: 48, right: 18, top: 20, bottom: 32, containLabel: true },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross', label: { backgroundColor: '#313741' } },
          valueFormatter: (value: unknown) =>
            typeof value === 'number' ? value.toPrecision(6) : String(value),
        },
        xAxis: {
          type: 'value',
          name: 't / s',
          nameTextStyle: { color: '#a4aab4' },
          axisLabel: { color: '#8f97a3' },
          axisLine: { lineStyle: { color: '#4b535f' } },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
          min: 'dataMin',
          max: 'dataMax',
        },
        yAxis: {
          type: 'value',
          name: units.length > 0 ? units.join(' · ') : '物理量',
          nameTextStyle: { color: '#a4aab4' },
          axisLabel: { color: '#8f97a3' },
          axisLine: { show: true, lineStyle: { color: '#4b535f' } },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
          scale: true,
        },
        dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }],
        series: visibleCurves.map((curve, index) => ({
          id: curve.id,
          name: `${curve.displayName} (${curve.unit})`,
          type: 'line',
          showSymbol: false,
          sampling: 'lttb',
          progressive: 2000,
          data: (series[curve.id] ?? []).map((point) => [point.time, point.value]),
          lineStyle: {
            color: curve.color,
            width: 1.7,
            type: index % 3 === 1 ? 'dashed' : index % 3 === 2 ? 'dotted' : 'solid',
          },
          itemStyle: { color: curve.color },
        })),
      },
      { notMerge: true, lazyUpdate: true },
    )
  }, [curves, series])

  return (
    <div ref={hostRef} className={styles.chartCanvas} role="img" aria-label="物理量时间曲线图" />
  )
}

export function ChartPanel() {
  const [adding, setAdding] = useState(false)
  const [metricId, setMetricId] = useState<ChartMetricId>('positionY')
  const [bodyId, setBodyId] = useState('')
  const [message, setMessage] = useState('')
  const scene = useDocumentStore((state) => state.scene)
  const selectedIds = useEditorStore((state) => state.selectedIds)
  const curves = useChartStore((state) => state.curves)
  const series = useChartStore((state) => state.series)
  const reachedRecordLimit = useChartStore((state) => state.reachedRecordLimit)
  const collapsed = useChartStore((state) => state.collapsed)
  const addCurve = useChartStore((state) => state.addCurve)
  const removeCurve = useChartStore((state) => state.removeCurve)
  const toggleCurve = useChartStore((state) => state.toggleCurve)
  const clearHistory = useChartStore((state) => state.clearHistory)
  const toggleCollapsed = useChartStore((state) => state.toggleCollapsed)
  const selectedBodies = scene.entities.filter(
    (entity): entity is BodyEntity => entity.kind === 'body' && selectedIds.includes(entity.id),
  )
  const effectiveBodyId = selectedBodies.some((body) => body.id === bodyId)
    ? bodyId
    : (selectedBodies[0]?.id ?? '')
  const recordedBodyIds = useMemo(
    () => [...new Set(curves.map((curve) => curve.entityId))],
    [curves],
  )

  useEffect(() => {
    physicsClient.setRecordedBodyIds(recordedBodyIds)
  }, [recordedBodyIds])

  const handleAdd = () => {
    const body = selectedBodies.find((candidate) => candidate.id === effectiveBodyId)
    if (!body) return
    if (!addCurve(body, metricId)) {
      setMessage(
        curves.length >= MAX_CHART_CURVES ? '最多同时记录 10 条曲线。' : '这条曲线已经存在。',
      )
      return
    }
    setMessage('')
    setAdding(false)
  }

  const handleExport = () => {
    if (curves.length === 0 || !curves.some((curve) => (series[curve.id]?.length ?? 0) > 0)) {
      setMessage('请先运行模拟并记录至少一个数据点。')
      return
    }
    downloadChartCsv(scene.metadata.name, curves, series)
    setMessage('CSV 已下载；表头包含每条曲线的指标与单位。')
  }

  return (
    <section
      className={styles.chartPanel}
      aria-labelledby="chart-heading"
      data-collapsed={collapsed}
    >
      <header className={styles.chartHeader}>
        <div className={styles.chartTitle}>
          <LineChart size={15} />
          <h2 id="chart-heading">物理量—时间</h2>
          <span className={styles.chartBadge}>{curves.length} 条曲线</span>
        </div>
        <div className={styles.chartActions}>
          <button
            type="button"
            disabled={selectedBodies.length === 0 || curves.length >= MAX_CHART_CURVES}
            title={selectedBodies.length === 0 ? '先在画布或图层中选择物体' : '添加物理量曲线'}
            onClick={() => setAdding((value) => !value)}
          >
            <Plus size={14} />
            添加曲线
          </button>
          <button type="button" disabled={curves.length === 0} onClick={handleExport}>
            <Download size={14} />
            导出 CSV
          </button>
          <button
            type="button"
            disabled={!Object.values(series).some((points) => points.length > 0)}
            title="保留曲线配置，只清除本次运行数据"
            onClick={clearHistory}
          >
            <Trash2 size={14} />
            清空记录
          </button>
          <button
            type="button"
            aria-label={collapsed ? '展开图表' : '折叠图表'}
            title={collapsed ? '展开图表' : '折叠图表'}
            onClick={toggleCollapsed}
          >
            <ChevronDown size={15} className={styles.collapseIcon} />
          </button>
        </div>
      </header>

      {collapsed ? null : (
        <div className={styles.chartBody}>
          <aside className={styles.legend} aria-label="曲线图例">
            {adding ? (
              <div className={styles.addForm} role="group" aria-label="添加曲线">
                <label>
                  <span>物体</span>
                  <select
                    value={effectiveBodyId}
                    onChange={(event) => setBodyId(event.target.value)}
                  >
                    {selectedBodies.map((body) => (
                      <option key={body.id} value={body.id}>
                        {body.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>物理量</span>
                  <select
                    value={metricId}
                    onChange={(event) => setMetricId(event.target.value as ChartMetricId)}
                  >
                    {chartMetricDefinitions.map((metric) => (
                      <option key={metric.id} value={metric.id}>
                        {metric.name} {metric.symbol} / {metric.unit}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" onClick={handleAdd}>
                  确认添加
                </button>
              </div>
            ) : null}

            {curves.map((curve) => (
              <div className={styles.legendItem} key={curve.id} data-hidden={!curve.visible}>
                <span className={styles.swatch} style={{ backgroundColor: curve.color }} />
                <span className={styles.legendName} title={`${curve.displayName} / ${curve.unit}`}>
                  {curve.displayName}
                  <small>{curve.unit}</small>
                </span>
                <button
                  type="button"
                  aria-label={`${curve.visible ? '隐藏' : '显示'} ${curve.displayName}`}
                  title={curve.visible ? '隐藏曲线' : '显示曲线'}
                  onClick={() => toggleCurve(curve.id)}
                >
                  {curve.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
                <button
                  type="button"
                  aria-label={`移除 ${curve.displayName}`}
                  title="移除曲线"
                  onClick={() => removeCurve(curve.id)}
                >
                  <X size={13} />
                </button>
              </div>
            ))}

            {reachedRecordLimit ? (
              <p className={styles.limitMessage} role="status">
                已保留最近 {scene.settings.recordingDurationSeconds} 秒，较早数据已移除。
              </p>
            ) : null}
            {message ? (
              <p className={styles.message} role="status">
                {message}
              </p>
            ) : null}
          </aside>

          <div className={styles.plotArea}>
            {curves.length === 0 ? (
              <div className={styles.chartEmpty}>
                <LineChart size={18} />
                <span>选择一个或多个物体，再添加要观察的物理量</span>
              </div>
            ) : (
              <ChartCanvas />
            )}
          </div>
        </div>
      )}
    </section>
  )
}
