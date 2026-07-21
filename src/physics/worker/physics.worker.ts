import { SimulationWorld } from '../core/SimulationWorld'
import type {
  MainToPhysicsMessage,
  PhysicsToMainMessage,
  RuntimeSample,
  SimulationStatus,
} from './messages'
import type { SceneDocument } from '../../scene/model/types'

const MAX_CATCH_UP_STEPS = 16
const FRAME_INTERVAL_MS = 1000 / 60
const LOOP_INTERVAL_MS = 4
const ALLOWED_RATES = new Set([0.25, 0.5, 1, 2, 4])

let sceneSnapshot: SceneDocument | null = null
let simulation: SimulationWorld | null = null
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

function post(message: PhysicsToMainMessage): void {
  self.postMessage(message)
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

function buildSimulation(scene: SceneDocument): void {
  simulation?.dispose()
  simulation = new SimulationWorld(scene)
  recordIntervalSeconds = 1 / scene.settings.recordingSampleRate
  accumulatorSeconds = 0
  pendingSamples = []
  nextRecordTime = 0
  status = 'ready'
  lastRealTimeMs = performance.now()
  post({ type: 'ready', fixedTimeStep: simulation.fixedTimeStep })
  for (const warning of simulation.warnings) post({ type: 'warning', ...warning })
  recordCurrentState(true)
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

self.onmessage = (event: MessageEvent<MainToPhysicsMessage>) => {
  try {
    handleMessage(event.data)
  } catch (error) {
    const message = error instanceof Error ? error.message : '物理线程发生未知错误。'
    post({ type: 'fatalError', message })
  }
}

tick(performance.now())
