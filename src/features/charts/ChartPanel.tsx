import { LineChart as EChartsLineChart } from 'echarts/charts'
import {
  DataZoomInsideComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import {
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  LineChart,
  Plus,
  Settings2,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'

import { createReplaceChartsCommand } from '../../editor/commands/entityCommands'
import { physicsClient } from '../../physics/client/physicsClient'
import {
  MAX_CHARTS,
  MAX_CHART_SERIES,
  MAX_CHART_SERIES_PER_CHART,
  MAX_RECORDED_CHART_BODIES,
  createDefaultChart,
} from '../../scene/model/chartDefaults'
import type {
  BodyEntity,
  ChartAxisDefinition,
  ChartAxisMetricId,
  ChartDefinition,
  ChartLineStyle,
  ChartSeriesDefinition,
} from '../../scene/model/types'
import { listRuntimeBodyTargets } from '../../scene/model/runtimeBodyTargets'
import { useChartStore, getChartTelemetryBuffer } from '../../stores/chartStore'
import { useDocumentStore } from '../../stores/documentStore'
import { useEditorStore } from '../../stores/editorStore'
import { axisLabel, axisSource, chartAxisMetricDefinitions } from './chartAxis'
import { formatChartNumber, resolveConstantChartAxisRange } from './chartNumberFormat'
import { downloadAllChartsCsv, downloadSingleChartCsv } from './chartCsv'
import {
  ChartExpressionError,
  chartExpressionVariables,
  compileChartExpression,
} from './chartExpression'
import { defaultChartColor } from './chartPalette'
import { evaluateChart, type EvaluatedChart } from './chartSeries'
import styles from './ChartPanel.module.css'

echarts.use([
  EChartsLineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  DataZoomInsideComponent,
  CanvasRenderer,
])

const DISPLAY_SAMPLE_LIMIT = 2000

function commitCharts(charts: ChartDefinition[], label: string): void {
  const document = useDocumentStore.getState()
  document.executeCommand(createReplaceChartsCommand(document.scene, charts, label))
}

function updateChart(
  chartId: string,
  updater: (chart: ChartDefinition) => ChartDefinition,
  label: string,
): void {
  const charts = useDocumentStore
    .getState()
    .scene.charts.map((chart) => (chart.id === chartId ? updater(chart) : chart))
  commitCharts(charts, label)
}

function safeEvaluate(
  chart: ChartDefinition,
  maximumSamples: number,
): {
  evaluated: EvaluatedChart | null
  error: string
} {
  try {
    return {
      evaluated: evaluateChart(chart, getChartTelemetryBuffer(), maximumSamples),
      error: '',
    }
  } catch (error) {
    return {
      evaluated: null,
      error: error instanceof Error ? error.message : '无法计算该坐标系。',
    }
  }
}

function ChartCanvas({
  chart,
  evaluated,
  bodyNames,
}: {
  chart: ChartDefinition
  evaluated: EvaluatedChart
  bodyNames: ReadonlyMap<string, string>
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.EChartsType | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const instance = echarts.init(host, undefined, { renderer: 'canvas' })
    chartRef.current = instance
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(host)
    return () => {
      observer.disconnect()
      instance.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    const instance = chartRef.current
    if (!instance) return
    const evaluatedById = new Map(evaluated.series.map((series) => [series.id, series]))
    const visible = chart.series.filter((series) => series.visible)
    let xMin = Number.POSITIVE_INFINITY
    let xMax = Number.NEGATIVE_INFINITY
    let yMin = Number.POSITIVE_INFINITY
    let yMax = Number.NEGATIVE_INFINITY
    for (const series of visible) {
      for (const point of evaluatedById.get(series.id)?.points ?? []) {
        if (point.x === null || point.y === null) continue
        xMin = Math.min(xMin, point.x)
        xMax = Math.max(xMax, point.x)
        yMin = Math.min(yMin, point.y)
        yMax = Math.max(yMax, point.y)
      }
    }
    const constantXRange = resolveConstantChartAxisRange(xMin, xMax)
    const constantYRange = resolveConstantChartAxisRange(yMin, yMax)
    instance.setOption(
      {
        animation: false,
        backgroundColor: 'transparent',
        grid: { left: 76, right: 24, top: 28, bottom: 50, containLabel: false },
        legend: {
          type: 'scroll',
          bottom: 3,
          textStyle: { color: '#a4aab4', fontSize: 9 },
          pageTextStyle: { color: '#8f97a3' },
        },
        tooltip: {
          trigger: 'axis',
          axisPointer: {
            type: 'cross',
            label: {
              backgroundColor: '#313741',
              formatter: (parameters: unknown) =>
                formatChartNumber(Number((parameters as { value?: unknown }).value)),
            },
          },
          valueFormatter: (value: unknown) =>
            typeof value === 'number' ? formatChartNumber(value) : String(value),
        },
        xAxis: {
          type: 'value',
          name: axisLabel(chart.xAxis, evaluated.xUnit),
          nameTextStyle: { color: '#a4aab4' },
          axisLabel: {
            color: '#8f97a3',
            width: 72,
            overflow: 'truncate',
            hideOverlap: true,
            formatter: (value: number) => formatChartNumber(value),
          },
          axisLine: { lineStyle: { color: '#4b535f' } },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
          min: constantXRange?.min ?? 'dataMin',
          max: constantXRange?.max ?? 'dataMax',
          splitNumber: 5,
          scale: true,
        },
        yAxis: {
          type: 'value',
          name: axisLabel(chart.yAxis, evaluated.yUnit),
          nameTextStyle: { color: '#a4aab4' },
          axisLabel: {
            color: '#8f97a3',
            width: 64,
            overflow: 'truncate',
            hideOverlap: true,
            formatter: (value: number) => formatChartNumber(value),
          },
          axisLine: { show: true, lineStyle: { color: '#4b535f' } },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
          min: constantYRange?.min,
          max: constantYRange?.max,
          splitNumber: 5,
          scale: true,
        },
        dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }],
        series: visible.map((series) => ({
          id: series.id,
          name: bodyNames.get(series.entityId) ?? '已删除物体',
          type: 'line',
          showSymbol: false,
          connectNulls: false,
          progressive: 2000,
          data: (evaluatedById.get(series.id)?.points ?? []).map((point) => [point.x, point.y]),
          lineStyle: {
            color: series.color,
            width: series.lineWidth,
            type: series.lineStyle,
          },
          itemStyle: { color: series.color },
        })),
      },
      { notMerge: true, lazyUpdate: true },
    )
  }, [bodyNames, chart, evaluated])

  return (
    <div ref={hostRef} className={styles.chartCanvas} role="img" aria-label={`${chart.name}图像`} />
  )
}

function AxisEditor({ chart, axisKey }: { chart: ChartDefinition; axisKey: 'xAxis' | 'yAxis' }) {
  const axis = chart[axisKey]
  const [draft, setDraft] = useState(axisSource(axis))
  const validation = useMemo(() => {
    try {
      const compiled = compileChartExpression(draft)
      const availableAliases = new Set(chart.bindings.map((binding) => binding.alias))
      const missing = compiled.referencedAliases.find((alias) => !availableAliases.has(alias))
      if (missing) throw new ChartExpressionError(`请先为 @${missing} 绑定一个物体。`)
      return { error: '', unit: compiled.unit }
    } catch (nextError) {
      return {
        error: nextError instanceof Error ? nextError.message : '公式无效。',
        unit: '',
      }
    }
  }, [chart.bindings, draft])

  const commitAxis = (nextAxis: ChartAxisDefinition) =>
    updateChart(chart.id, (current) => ({ ...current, [axisKey]: nextAxis }), '修改图表坐标轴')

  const validateDraft = (value: string): boolean => {
    try {
      const compiled = compileChartExpression(value)
      const availableAliases = new Set(chart.bindings.map((binding) => binding.alias))
      const missing = compiled.referencedAliases.find((alias) => !availableAliases.has(alias))
      if (missing) throw new ChartExpressionError(`请先为 @${missing} 绑定一个物体。`)
      return true
    } catch {
      return false
    }
  }

  const handleDraftChange = (event: ChangeEvent<HTMLInputElement>) => {
    setDraft(event.target.value)
  }

  const commitDraft = () => {
    if (!validateDraft(draft)) return
    if (axis.type === 'expression' && axis.expression === draft.trim()) return
    commitAxis({ type: 'expression', expression: draft.trim() })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur()
    if (event.key === 'Escape') {
      setDraft(axisSource(axis))
      event.currentTarget.blur()
    }
  }

  const insertVariable = (variable: string) => {
    const next = `${draft}${draft && !draft.endsWith(' ') ? ' ' : ''}${variable}`
    setDraft(next)
  }

  return (
    <fieldset className={styles.axisEditor}>
      <legend>{axisKey === 'xAxis' ? '横轴' : '纵轴'}</legend>
      <label>
        <span>来源</span>
        <select
          aria-label={`${axisKey === 'xAxis' ? '横轴' : '纵轴'}来源`}
          value={axis.type}
          onChange={(event) => {
            if (event.target.value === 'metric') {
              commitAxis({
                type: 'metric',
                metricId: axisKey === 'xAxis' ? 'time' : 'positionY',
              })
            } else {
              const expression = axisSource(axis)
              setDraft(expression)
              commitAxis({ type: 'expression', expression })
            }
          }}
        >
          <option value="metric">预设物理量</option>
          <option value="expression">自定义公式</option>
        </select>
      </label>
      {axis.type === 'metric' ? (
        <label>
          <span>物理量</span>
          <select
            aria-label={`${axisKey === 'xAxis' ? '横轴' : '纵轴'}物理量`}
            value={axis.metricId}
            onChange={(event) =>
              commitAxis({
                type: 'metric',
                metricId: event.target.value as ChartAxisMetricId,
              })
            }
          >
            {chartAxisMetricDefinitions.map((metric) => (
              <option value={metric.id} key={metric.id}>
                {metric.name} {metric.symbol} / {metric.unit}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <label>
            <span>公式</span>
            <input
              aria-label={`${axisKey === 'xAxis' ? '横轴' : '纵轴'}公式`}
              value={draft}
              onChange={handleDraftChange}
              onBlur={commitDraft}
              onKeyDown={handleKeyDown}
              spellCheck={false}
            />
          </label>
          <div className={styles.variablePalette} aria-label="可插入变量">
            {chartExpressionVariables.map((variable) => (
              <button type="button" key={variable} onClick={() => insertVariable(variable)}>
                {variable}
              </button>
            ))}
          </div>
          <small
            className={validation.error ? styles.formulaError : styles.formulaUnit}
            role="status"
          >
            {validation.error || `推导单位：${validation.unit}`}
          </small>
        </>
      )}
    </fieldset>
  )
}

function BindingEditor({
  chart,
  bodies,
}: {
  chart: ChartDefinition
  bodies: readonly BodyEntity[]
}) {
  const referencedAliases = useMemo(() => {
    const aliases = new Set<string>()
    for (const axis of [chart.xAxis, chart.yAxis]) {
      try {
        compileChartExpression(axisSource(axis)).referencedAliases.forEach((alias) =>
          aliases.add(alias),
        )
      } catch {
        // Invalid drafts are never committed; this protects imported malformed extensions.
      }
    }
    return aliases
  }, [chart.xAxis, chart.yAxis])

  const addBinding = () => {
    const alias = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
      .split('')
      .find((candidate) => !chart.bindings.some((binding) => binding.alias === candidate))
    const body = bodies[0]
    if (!alias || !body) return
    updateChart(
      chart.id,
      (current) => ({
        ...current,
        bindings: [...current.bindings, { alias, entityId: body.id }],
      }),
      '添加图表物体引用',
    )
  }

  return (
    <section className={styles.bindingEditor} aria-label="跨物体引用">
      <div className={styles.configSectionTitle}>
        <span>跨物体引用</span>
        <button
          type="button"
          disabled={bodies.length === 0 || chart.bindings.length >= 26}
          onClick={addBinding}
        >
          <Plus size={12} />
          添加别名
        </button>
      </div>
      {chart.bindings.length === 0 ? <small>添加后可在公式中写 @A.x、@B.speed。</small> : null}
      {chart.bindings.map((binding) => {
        const bodyExists = bodies.some((body) => body.id === binding.entityId)
        const inUse = referencedAliases.has(binding.alias)
        return (
          <div className={styles.bindingRow} key={binding.alias}>
            <code>@{binding.alias}</code>
            <select
              aria-label={`@${binding.alias} 绑定物体`}
              value={binding.entityId}
              onChange={(event) =>
                updateChart(
                  chart.id,
                  (current) => ({
                    ...current,
                    bindings: current.bindings.map((candidate) =>
                      candidate.alias === binding.alias
                        ? { ...candidate, entityId: event.target.value }
                        : candidate,
                    ),
                  }),
                  '修改图表物体引用',
                )
              }
            >
              {!bodyExists ? <option value={binding.entityId}>对象已删除</option> : null}
              {bodies.map((body) => (
                <option key={body.id} value={body.id}>
                  {body.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={inUse}
              title={inUse ? '该别名仍在公式中使用，请先修改公式' : '删除别名'}
              aria-label={`删除 @${binding.alias} 引用`}
              onClick={() =>
                updateChart(
                  chart.id,
                  (current) => ({
                    ...current,
                    bindings: current.bindings.filter(
                      (candidate) => candidate.alias !== binding.alias,
                    ),
                  }),
                  '删除图表物体引用',
                )
              }
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
    </section>
  )
}

function SeriesEditor({
  chart,
  bodies,
  selectedIds,
}: {
  chart: ChartDefinition
  bodies: readonly BodyEntity[]
  selectedIds: readonly string[]
}) {
  const [adding, setAdding] = useState(false)
  const [draftIds, setDraftIds] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const allCharts = useDocumentStore((state) => state.scene.charts)

  const openAdding = () => {
    const existing = new Set(chart.series.map((series) => series.entityId))
    setDraftIds(
      selectedIds.filter(
        (entityId) => bodies.some((body) => body.id === entityId) && !existing.has(entityId),
      ),
    )
    setMessage('')
    setAdding(true)
  }

  const addSelectedBodies = () => {
    const document = useDocumentStore.getState().scene
    const additions = bodies.filter(
      (body) =>
        draftIds.includes(body.id) && !chart.series.some((series) => series.entityId === body.id),
    )
    if (additions.length === 0) {
      setMessage('请选择至少一个尚未添加的物体。')
      return
    }
    const totalSeries = document.charts.reduce(
      (total, candidate) => total + candidate.series.length,
      0,
    )
    const referencedBodies = new Set(
      document.charts.flatMap((candidate) => [
        ...candidate.series.map((series) => series.entityId),
        ...candidate.bindings.map((binding) => binding.entityId),
      ]),
    )
    additions.forEach((body) => referencedBodies.add(body.id))
    if (chart.series.length + additions.length > MAX_CHART_SERIES_PER_CHART) {
      setMessage(`每个坐标系最多包含 ${MAX_CHART_SERIES_PER_CHART} 条线。`)
      return
    }
    if (totalSeries + additions.length > MAX_CHART_SERIES) {
      setMessage(`全部坐标系最多包含 ${MAX_CHART_SERIES} 条线。`)
      return
    }
    if (referencedBodies.size > MAX_RECORDED_CHART_BODIES) {
      setMessage(`图表最多记录 ${MAX_RECORDED_CHART_BODIES} 个物体。`)
      return
    }
    const addedSeries: ChartSeriesDefinition[] = []
    let paletteCharts = document.charts
    for (const body of additions) {
      const definition: ChartSeriesDefinition = {
        id: crypto.randomUUID(),
        entityId: body.id,
        visible: true,
        color: defaultChartColor(paletteCharts, body.id),
        lineStyle: 'solid',
        lineWidth: 2,
      }
      addedSeries.push(definition)
      paletteCharts = paletteCharts.map((candidate) =>
        candidate.id === chart.id
          ? { ...candidate, series: [...candidate.series, definition] }
          : candidate,
      )
    }
    updateChart(
      chart.id,
      (current) => ({
        ...current,
        series: [...current.series, ...addedSeries],
      }),
      '添加图表曲线',
    )
    setAdding(false)
    setMessage('')
  }

  return (
    <section className={styles.seriesEditor} aria-label="坐标系曲线">
      <div className={styles.configSectionTitle}>
        <span>物体曲线</span>
        <button
          type="button"
          disabled={
            chart.series.length >= MAX_CHART_SERIES_PER_CHART ||
            allCharts.reduce((total, candidate) => total + candidate.series.length, 0) >=
              MAX_CHART_SERIES
          }
          onClick={openAdding}
        >
          <Plus size={12} />
          添加物体
        </button>
      </div>
      {adding ? (
        <div className={styles.bodyPicker} role="group" aria-label={`向${chart.name}添加物体`}>
          {bodies.map((body) => {
            const alreadyAdded = chart.series.some((series) => series.entityId === body.id)
            return (
              <label key={body.id} data-disabled={alreadyAdded}>
                <input
                  type="checkbox"
                  disabled={alreadyAdded}
                  checked={alreadyAdded || draftIds.includes(body.id)}
                  onChange={(event) =>
                    setDraftIds((current) =>
                      event.target.checked
                        ? [...current, body.id]
                        : current.filter((entityId) => entityId !== body.id),
                    )
                  }
                />
                <span>{body.name}</span>
              </label>
            )
          })}
          <div className={styles.pickerActions}>
            <button type="button" onClick={addSelectedBodies}>
              确认添加
            </button>
            <button type="button" onClick={() => setAdding(false)}>
              取消
            </button>
          </div>
        </div>
      ) : null}
      {chart.series.map((series) => {
        const body = bodies.find((candidate) => candidate.id === series.entityId)
        const name = body?.name ?? '已删除物体'
        return (
          <div className={styles.seriesRow} key={series.id} data-hidden={!series.visible}>
            <input
              type="color"
              value={series.color}
              aria-label={`${name}线条颜色`}
              title="线条颜色"
              onChange={(event) =>
                updateChart(
                  chart.id,
                  (current) => ({
                    ...current,
                    series: current.series.map((candidate) =>
                      candidate.id === series.id
                        ? { ...candidate, color: event.target.value }
                        : candidate,
                    ),
                  }),
                  '修改图表线条颜色',
                )
              }
            />
            <span title={name}>{name}</span>
            <select
              value={series.lineStyle}
              aria-label={`${name}线型`}
              onChange={(event) =>
                updateChart(
                  chart.id,
                  (current) => ({
                    ...current,
                    series: current.series.map((candidate) =>
                      candidate.id === series.id
                        ? {
                            ...candidate,
                            lineStyle: event.target.value as ChartLineStyle,
                          }
                        : candidate,
                    ),
                  }),
                  '修改图表线型',
                )
              }
            >
              <option value="solid">实线</option>
              <option value="dashed">虚线</option>
              <option value="dotted">点线</option>
            </select>
            <input
              type="number"
              min={1}
              max={6}
              step={0.5}
              value={series.lineWidth}
              aria-label={`${name}线宽`}
              onChange={(event) => {
                const value = Number(event.target.value)
                if (!Number.isFinite(value) || value < 1 || value > 6) return
                updateChart(
                  chart.id,
                  (current) => ({
                    ...current,
                    series: current.series.map((candidate) =>
                      candidate.id === series.id ? { ...candidate, lineWidth: value } : candidate,
                    ),
                  }),
                  '修改图表线宽',
                )
              }}
            />
            <button
              type="button"
              aria-label={`${series.visible ? '隐藏' : '显示'}${name}曲线`}
              title={series.visible ? '隐藏曲线' : '显示曲线'}
              onClick={() =>
                updateChart(
                  chart.id,
                  (current) => ({
                    ...current,
                    series: current.series.map((candidate) =>
                      candidate.id === series.id
                        ? { ...candidate, visible: !candidate.visible }
                        : candidate,
                    ),
                  }),
                  '切换图表曲线显示',
                )
              }
            >
              {series.visible ? <Eye size={12} /> : <EyeOff size={12} />}
            </button>
            <button
              type="button"
              aria-label={`移除${name}曲线`}
              title="移除曲线"
              onClick={() =>
                updateChart(
                  chart.id,
                  (current) => ({
                    ...current,
                    series: current.series.filter((candidate) => candidate.id !== series.id),
                  }),
                  '移除图表曲线',
                )
              }
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
      {message ? (
        <small className={styles.formulaError} role="status">
          {message}
        </small>
      ) : null}
    </section>
  )
}

function ChartCard({
  chart,
  bodies,
  selectedIds,
  sceneName,
}: {
  chart: ChartDefinition
  bodies: readonly BodyEntity[]
  selectedIds: readonly string[]
  sceneName: string
}) {
  const [configOpen, setConfigOpen] = useState(false)
  const revision = useChartStore((state) => state.revision)
  const bodyNames = useMemo(() => new Map(bodies.map((body) => [body.id, body.name])), [bodies])
  const evaluation = useMemo(() => {
    void revision
    return safeEvaluate(chart, DISPLAY_SAMPLE_LIMIT)
  }, [chart, revision])

  const commitName = (value: string) => {
    const name = value.trim()
    if (!name || name === chart.name) {
      return
    }
    updateChart(chart.id, (current) => ({ ...current, name }), '重命名坐标系')
  }

  const exportChart = () => {
    const full = safeEvaluate(chart, Number.POSITIVE_INFINITY)
    if (!full.evaluated) return
    downloadSingleChartCsv(sceneName, chart, full.evaluated, bodyNames)
  }

  return (
    <article className={styles.chartCard} aria-label={chart.name}>
      <header className={styles.cardHeader}>
        <div className={styles.cardIdentity}>
          <input
            key={chart.name}
            aria-label="坐标系名称"
            defaultValue={chart.name}
            maxLength={80}
            onBlur={(event) => {
              if (!event.currentTarget.value.trim()) event.currentTarget.value = chart.name
              commitName(event.currentTarget.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                event.currentTarget.value = chart.name
                event.currentTarget.blur()
              }
            }}
          />
          <small>
            X: {axisSource(chart.xAxis)} · Y: {axisSource(chart.yAxis)}
          </small>
        </div>
        <div className={styles.cardActions}>
          <button
            type="button"
            title="配置坐标系"
            aria-label={`配置${chart.name}`}
            data-active={configOpen}
            onClick={() => setConfigOpen((open) => !open)}
          >
            <Settings2 size={13} />
          </button>
          <button
            type="button"
            disabled={getChartTelemetryBuffer().length === 0}
            title="导出这个坐标系"
            aria-label={`导出${chart.name} CSV`}
            onClick={exportChart}
          >
            <Download size={13} />
          </button>
          <button
            type="button"
            title="删除坐标系"
            aria-label={`删除${chart.name}`}
            onClick={() => {
              const document = useDocumentStore.getState().scene
              commitCharts(
                document.charts.filter((candidate) => candidate.id !== chart.id),
                '删除坐标系',
              )
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </header>
      {configOpen ? (
        <div className={styles.cardConfig}>
          <div className={styles.axisGrid}>
            <AxisEditor
              key={`x-${chart.xAxis.type}-${axisSource(chart.xAxis)}`}
              chart={chart}
              axisKey="xAxis"
            />
            <AxisEditor
              key={`y-${chart.yAxis.type}-${axisSource(chart.yAxis)}`}
              chart={chart}
              axisKey="yAxis"
            />
          </div>
          <BindingEditor chart={chart} bodies={bodies} />
          <SeriesEditor chart={chart} bodies={bodies} selectedIds={selectedIds} />
        </div>
      ) : null}
      <div className={styles.plotArea}>
        {evaluation.error ? (
          <div className={styles.chartError} role="alert">
            {evaluation.error}
          </div>
        ) : chart.series.length === 0 ? (
          <div className={styles.chartEmpty}>
            <LineChart size={18} />
            <span>打开设置并添加一个或多个物体</span>
          </div>
        ) : evaluation.evaluated ? (
          <ChartCanvas chart={chart} evaluated={evaluation.evaluated} bodyNames={bodyNames} />
        ) : null}
      </div>
    </article>
  )
}

export function ChartPanel({ embedded = false }: { embedded?: boolean }) {
  const scene = useDocumentStore((state) => state.scene)
  const selectedIds = useEditorStore((state) => state.selectedIds)
  const storedCollapsed = useChartStore((state) => state.collapsed)
  const collapsed = embedded ? false : storedCollapsed
  const revision = useChartStore((state) => state.revision)
  const reachedRecordLimit = useChartStore((state) => state.reachedRecordLimit)
  const clearHistory = useChartStore((state) => state.clearHistory)
  const toggleCollapsed = useChartStore((state) => state.toggleCollapsed)
  const bodies = useMemo(() => listRuntimeBodyTargets(scene), [scene])
  const totalSeries = scene.charts.reduce((total, chart) => total + chart.series.length, 0)
  const hasData = revision >= 0 && getChartTelemetryBuffer().length > 0
  const recordedBodyIds = useMemo(
    () => [
      ...new Set(
        scene.charts.flatMap((chart) => [
          ...chart.series.map((series) => series.entityId),
          ...chart.bindings.map((binding) => binding.entityId),
        ]),
      ),
    ],
    [scene.charts],
  )

  useEffect(() => {
    physicsClient.setRecordedBodyIds(recordedBodyIds)
  }, [recordedBodyIds])

  const addChart = () => {
    const document = useDocumentStore.getState().scene
    if (document.charts.length >= MAX_CHARTS) return
    commitCharts(
      [
        ...document.charts,
        createDefaultChart(crypto.randomUUID(), `坐标系 ${document.charts.length + 1}`),
      ],
      '新建坐标系',
    )
  }

  const exportAll = () => {
    const evaluated = new Map<string, EvaluatedChart>()
    for (const chart of scene.charts) {
      const result = safeEvaluate(chart, Number.POSITIVE_INFINITY)
      if (result.evaluated) evaluated.set(chart.id, result.evaluated)
    }
    downloadAllChartsCsv(scene.metadata.name, scene.charts, evaluated, bodies)
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
          <h2 id="chart-heading">多坐标系图像区</h2>
          <span className={styles.chartBadge}>{scene.charts.length} 个坐标系</span>
          <span className={styles.chartBadge}>{totalSeries} 条线</span>
        </div>
        <div className={styles.chartActions}>
          <button type="button" disabled={scene.charts.length >= MAX_CHARTS} onClick={addChart}>
            <Plus size={14} />
            新建坐标系
          </button>
          <button type="button" disabled={!hasData || totalSeries === 0} onClick={exportAll}>
            <Download size={14} />
            导出全部
          </button>
          <button type="button" disabled={!hasData} onClick={clearHistory}>
            <Trash2 size={14} />
            清空记录
          </button>
          {embedded ? null : (
            <button
              type="button"
              aria-label={collapsed ? '展开图像区' : '折叠图像区'}
              title={collapsed ? '展开图像区' : '折叠图像区'}
              onClick={toggleCollapsed}
            >
              <ChevronDown size={15} className={styles.collapseIcon} />
            </button>
          )}
        </div>
      </header>
      {collapsed ? null : (
        <div className={styles.chartBody}>
          {scene.charts.length === 0 ? (
            <div className={styles.panelEmpty}>
              <LineChart size={20} />
              <span>当前没有坐标系</span>
              <button type="button" onClick={addChart}>
                <Plus size={14} />
                新建坐标系
              </button>
            </div>
          ) : (
            <div className={styles.chartGrid}>
              {scene.charts.map((chart) => (
                <ChartCard
                  key={chart.id}
                  chart={chart}
                  bodies={bodies}
                  selectedIds={selectedIds}
                  sceneName={scene.metadata.name}
                />
              ))}
            </div>
          )}
          {reachedRecordLimit ? (
            <p className={styles.limitMessage} role="status">
              已保留最近 {scene.settings.recordingDurationSeconds} 秒，较早数据已移除。
            </p>
          ) : null}
        </div>
      )}
    </section>
  )
}
