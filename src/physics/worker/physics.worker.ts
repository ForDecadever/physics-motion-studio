import type { SimulationWorld } from '../core/SimulationWorld'
import type {
  MainToPhysicsMessage,
  PhysicsToMainMessage,
  RuntimeSample,
  SimulationStatus,
} from './messages'
import type { SceneDocument } from '../../scene/model/types'
import { GIF_RECORDING_SAMPLE_RATE, GifTelemetryBuffer } from '../recording/gifTelemetry'

const MAX_CATCH_UP_STEPS = 16
const FRAME_INTERVAL_MS = 1000 / 60
const LOOP_INTERVAL_MS = 4
const ALLOWED_RATES = new Set([0.25, 0.5, 1, 2, 4])

let sceneSnapshot: SceneDocument | null = null
let simulation: SimulationWorld | null = null
let SimulationWorldConstructor:
  (typeof import('../core/SimulationWorld'))['SimulationWorld'] | null = null
let pendingMessages: MainToPhysicsMessage[] = []
let status: Exclude<SimulationStatus, 'initializing' | 'error'> = 'ready'
let playbackRate = 1
let accumulatorSeconds = 0
let lastRealTimeMs = performance.now()
let lastFrameTimeMs = 0
let lastCatchUpWarningMs = -Infinity
let nextRecordTime = 0
let recordedBodyIds = new Set<string>()
let pendingSamples: RuntimeSample[] = []
let recordIntervalSeconds = 1 / 60
let gifTelemetry = new GifTelemetryBuffer([])
let nextGifRecordTime = 0

function post(message: PhysicsToMainMessage, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer)
}

function postState(): void {
  post({
    type: 'state',
    status,
    simulationTime: simulation?.simulationTime ?? 0,
    playbackRate,
  })
}

function postFrame(): void {
  if (!simulation) return
  post({
    type: 'frame',
    simulationTime: simulation.simulationTime,
    bodies: simulation.getBodyStates(),
    samples: pendingSamples,
  })
  pendingSamples = []
}

function recordCurrentState(force = false): void {
  if (!simulation || recordedBodyIds.size === 0) return
  if (!force && simulation.simulationTime + Number.EPSILON < nextRecordTime) return
  const bodies = simulation.getBodyStates().filter((body) => recordedBodyIds.has(body.entityId))
  if (bodies.length > 0) {
    pendingSamples.push({ simulationTime: simulation.simulationTime, bodies })
  }
  nextRecordTime = simulation.simulationTime + recordIntervalSeconds
}

function recordGifCurrentState(force = false): void {
  if (!simulation || gifTelemetry.status.kind === 'blocked') return
  if (!force && simulation.simulationTime + Number.EPSILON < nextGifRecordTime) return
  if (gifTelemetry.append(simulation.simulationTime, simulation.getBodyStates())) {
    const length = gifTelemetry.length
    if (length === 1 || length % GIF_RECORDING_SAMPLE_RATE === 0) {
      post({ type: 'gifHistoryStatus', status: gifTelemetry.getStatus() })
    }
  }
  nextGifRecordTime = simulation.simulationTime + 1 / GIF_RECORDING_SAMPLE_RATE
}

function buildSimulation(scene: SceneDocument): void {
  if (!SimulationWorldConstructor) {
    throw new Error('物理引擎尚未完成初始化。')
  }
  simulation?.dispose()
  simulation = new SimulationWorldConstructor(scene)
  recordIntervalSeconds = 1 / scene.settings.recordingSampleRate
  gifTelemetry = new GifTelemetryBuffer(
    scene.entities
      .filter((entity) => entity.kind === 'body' && entity.simulationEnabled)
      .map((entity) => entity.id),
  )
  accumulatorSeconds = 0
  pendingSamples = []
  nextRecordTime = 0
  nextGifRecordTime = 0
  status = 'ready'
  lastRealTimeMs = performance.now()
  post({ type: 'ready', fixedTimeStep: simulation.fixedTimeStep })
  post({ type: 'gifHistoryStatus', status: gifTelemetry.getStatus() })
  if (gifTelemetry.status.kind === 'blocked') {
    post({
      type: 'warning',
      message: `GIF 记录最多支持 ${gifTelemetry.status.maxBodies} 个动态物体；当前有 ${gifTelemetry.status.bodyCount} 个，请减少物体并重置模拟。`,
    })
  }
  for (const warning of simulation.warnings) post({ type: 'warning', ...warning })
  recordCurrentState(true)
  recordGifCurrentState(true)
  postFrame()
  postState()
}

function handleMessage(message: MainToPhysicsMessage): void {
  if (message.type === 'initialize') {
    sceneSnapshot = message.scene
    buildSimulation(message.scene)
    return
  }
  if (!simulation) return

  if (message.type === 'play') {
    status = 'playing'
    lastRealTimeMs = performance.now()
    postState()
  } else if (message.type === 'pause') {
    status = 'paused'
    accumulatorSeconds = 0
    postFrame()
    postState()
  } else if (message.type === 'step') {
    if (status !== 'playing') {
      simulation.step()
      recordCurrentState()
      recordGifCurrentState()
      status = 'paused'
      postFrame()
      postState()
    }
  } else if (message.type === 'reset') {
    if (sceneSnapshot) buildSimulation(sceneSnapshot)
  } else if (message.type === 'setPlaybackRate') {
    if (ALLOWED_RATES.has(message.rate)) playbackRate = message.rate
    postState()
  } else if (message.type === 'setRecordedBodyIds') {
    recordedBodyIds = new Set(message.entityIds)
    pendingSamples = []
    recordCurrentState(true)
    postFrame()
  } else if (message.type === 'clearGifHistory') {
    gifTelemetry.clear()
    nextGifRecordTime = simulation.simulationTime
    recordGifCurrentState(true)
    post({ type: 'gifHistoryStatus', status: gifTelemetry.getStatus() })
  } else if (message.type === 'requestGifHistory') {
    const snapshot = gifTelemetry.snapshot(message.requestId)
    post({ type: 'gifHistorySnapshot', snapshot }, [snapshot.times.buffer, snapshot.values.buffer])
  }
}

function tick(nowMs: number): void {
  if (simulation && status === 'playing') {
    const elapsedSeconds = Math.min(0.25, Math.max(0, (nowMs - lastRealTimeMs) / 1000))
    accumulatorSeconds += elapsedSeconds * playbackRate
    let stepCount = 0

    while (accumulatorSeconds >= simulation.fixedTimeStep && stepCount < MAX_CATCH_UP_STEPS) {
      simulation.step()
      recordCurrentState()
      recordGifCurrentState()
      accumulatorSeconds -= simulation.fixedTimeStep
      stepCount += 1
    }

    if (accumulatorSeconds >= simulation.fixedTimeStep) {
      accumulatorSeconds %= simulation.fixedTimeStep
      if (nowMs - lastCatchUpWarningMs > 1000) {
        post({ type: 'warning', message: '设备暂时无法跟上模拟速度，已丢弃过期的追赶步。' })
        lastCatchUpWarningMs = nowMs
      }
    }

    if (stepCount > 0 && nowMs - lastFrameTimeMs >= FRAME_INTERVAL_MS) {
      postFrame()
      lastFrameTimeMs = nowMs
    }
  }
  lastRealTimeMs = nowMs
  setTimeout(() => tick(performance.now()), LOOP_INTERVAL_MS)
}

function dispatchMessage(message: MainToPhysicsMessage): void {
  if (!SimulationWorldConstructor) {
    if (message.type === 'initialize') pendingMessages = [message]
    else pendingMessages.push(message)
    return
  }

  try {
    handleMessage(message)
  } catch (error) {
    const message = error instanceof Error ? error.message : '物理线程发生未知错误。'
    post({ type: 'fatalError', message })
  }
}

self.onmessage = (event: MessageEvent<MainToPhysicsMessage>) => {
  dispatchMessage(event.data)
}

void import('../core/SimulationWorld')
  .then((module) => {
    SimulationWorldConstructor = module.SimulationWorld
    const messages = pendingMessages
    pendingMessages = []
    for (const message of messages) dispatchMessage(message)
  })
  .catch((error: unknown) => {
    pendingMessages = []
    const message = error instanceof Error ? error.message : '物理引擎无法完成初始化。'
    post({ type: 'fatalError', message })
  })

tick(performance.now())
