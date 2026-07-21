import { create } from 'zustand'

import {
  chartColorForBody,
  getChartMetric,
  type ChartMetricId,
} from '../features/charts/chartMetrics'
import type { RuntimeSample } from '../physics/worker/messages'
import type { BodyEntity, EntityId } from '../scene/model/types'

export const MAX_CHART_CURVES = 10
export const MAX_CHART_SAMPLES = 60 * 300

export interface ChartPoint {
  time: number
  value: number
}

export interface ChartCurve {
  id: string
  entityId: EntityId
  metricId: ChartMetricId
  displayName: string
  color: string
  unit: string
  visible: boolean
}

interface ChartState {
  curves: ChartCurve[]
  series: Record<string, ChartPoint[]>
  reachedRecordLimit: boolean
  collapsed: boolean
  sampleLimit: number
  addCurve: (body: BodyEntity, metricId: ChartMetricId) => boolean
  removeCurve: (curveId: string) => void
  toggleCurve: (curveId: string) => void
  clearCurves: () => void
  clearHistory: () => void
  appendSamples: (samples: RuntimeSample[]) => void
  toggleCollapsed: () => void
  configureLimit: (sampleRate: number, durationSeconds: number) => void
}

function curveId(entityId: EntityId, metricId: ChartMetricId): string {
  return `${entityId}:${metricId}`
}

export const useChartStore = create<ChartState>((set) => ({
  curves: [],
  series: {},
  reachedRecordLimit: false,
  collapsed: false,
  sampleLimit: MAX_CHART_SAMPLES,
  addCurve: (body, metricId) => {
    let added = false
    set((state) => {
      const id = curveId(body.id, metricId)
      if (
        state.curves.some((curve) => curve.id === id) ||
        state.curves.length >= MAX_CHART_CURVES
      ) {
        return state
      }
      const metric = getChartMetric(metricId)
      added = true
      return {
        curves: [
          ...state.curves,
          {
            id,
            entityId: body.id,
            metricId,
            displayName: `${body.name} · ${metric.symbol}`,
            color: chartColorForBody(body),
            unit: metric.unit,
            visible: true,
          },
        ],
        series: { ...state.series, [id]: [] },
      }
    })
    return added
  },
  removeCurve: (curveIdToRemove) =>
    set((state) => {
      const series = Object.fromEntries(
        Object.entries(state.series).filter(([curveId]) => curveId !== curveIdToRemove),
      )
      return {
        curves: state.curves.filter((curve) => curve.id !== curveIdToRemove),
        series,
      }
    }),
  toggleCurve: (curveIdToToggle) =>
    set((state) => ({
      curves: state.curves.map((curve) =>
        curve.id === curveIdToToggle ? { ...curve, visible: !curve.visible } : curve,
      ),
    })),
  clearCurves: () => set({ curves: [], series: {}, reachedRecordLimit: false }),
  clearHistory: () =>
    set((state) => ({
      series: Object.fromEntries(state.curves.map((curve) => [curve.id, []])),
      reachedRecordLimit: false,
    })),
  appendSamples: (samples) => {
    if (samples.length === 0) return
    set((state) => {
      if (state.curves.length === 0) return state
      const newestIncomingTime = samples.at(-1)?.simulationTime ?? 0
      const hasLaterRecordedPoint = state.curves.some(
        (curve) => (state.series[curve.id]?.at(-1)?.time ?? -Infinity) > newestIncomingTime,
      )
      const nextSeries = hasLaterRecordedPoint
        ? Object.fromEntries(state.curves.map((curve) => [curve.id, []]))
        : { ...state.series }
      let reachedRecordLimit = state.reachedRecordLimit

      for (const curve of state.curves) {
        const metric = getChartMetric(curve.metricId)
        let points = nextSeries[curve.id] ?? []
        for (const sample of samples) {
          const body = sample.bodies.find((candidate) => candidate.entityId === curve.entityId)
          if (!body) continue
          const point = { time: sample.simulationTime, value: metric.read(body) }
          const previous = points.at(-1)
          points =
            previous?.time === point.time ? [...points.slice(0, -1), point] : [...points, point]
        }
        if (points.length > state.sampleLimit) {
          points = points.slice(-state.sampleLimit)
          reachedRecordLimit = true
        }
        nextSeries[curve.id] = points
      }

      return { series: nextSeries, reachedRecordLimit }
    })
  },
  toggleCollapsed: () => set((state) => ({ collapsed: !state.collapsed })),
  configureLimit: (sampleRate, durationSeconds) =>
    set({ sampleLimit: Math.max(1, Math.floor(sampleRate * durationSeconds)) }),
}))
