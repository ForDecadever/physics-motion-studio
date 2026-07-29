import { create } from 'zustand'

import { ChartTelemetryBuffer } from '../features/charts/chartTelemetry'
import type { RuntimeSample } from '../physics/worker/messages'

export const MAX_CHART_SAMPLES = 60 * 300
const CHART_PUBLISH_INTERVAL_MS = 1000 / 15

interface ChartState {
  revision: number
  reachedRecordLimit: boolean
  collapsed: boolean
  sampleLimit: number
  clearHistory: () => void
  appendSamples: (samples: RuntimeSample[]) => void
  toggleCollapsed: () => void
  configureLimit: (sampleRate: number, durationSeconds: number) => void
}

let telemetryBuffer = new ChartTelemetryBuffer(MAX_CHART_SAMPLES)
let lastPublishedAt = 0
let publishTimer: ReturnType<typeof setTimeout> | null = null

export function getChartTelemetryBuffer(): ChartTelemetryBuffer {
  return telemetryBuffer
}

function cancelPendingPublish(): void {
  if (publishTimer !== null) clearTimeout(publishTimer)
  publishTimer = null
}

export const useChartStore = create<ChartState>((set) => ({
  revision: 0,
  reachedRecordLimit: false,
  collapsed: false,
  sampleLimit: MAX_CHART_SAMPLES,
  clearHistory: () => {
    cancelPendingPublish()
    telemetryBuffer.clear()
    lastPublishedAt = 0
    set((state) => ({
      revision: state.revision + 1,
      reachedRecordLimit: false,
    }))
  },
  appendSamples: (samples) => {
    if (samples.length === 0) return
    telemetryBuffer.append(samples)
    const publish = () => {
      lastPublishedAt = performance.now()
      publishTimer = null
      set((state) => ({
        revision: state.revision + 1,
        reachedRecordLimit: telemetryBuffer.reachedLimit,
      }))
    }
    const remaining = CHART_PUBLISH_INTERVAL_MS - (performance.now() - lastPublishedAt)
    if (remaining <= 0) publish()
    else if (publishTimer === null) publishTimer = setTimeout(publish, remaining)
  },
  toggleCollapsed: () => set((state) => ({ collapsed: !state.collapsed })),
  configureLimit: (sampleRate, durationSeconds) => {
    cancelPendingPublish()
    const sampleLimit = Math.max(1, Math.floor(sampleRate * durationSeconds))
    telemetryBuffer = new ChartTelemetryBuffer(sampleLimit)
    lastPublishedAt = 0
    set((state) => ({
      sampleLimit,
      revision: state.revision + 1,
      reachedRecordLimit: false,
    }))
  },
}))
