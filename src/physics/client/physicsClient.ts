import type { SceneDocument } from '../../scene/model/types'
import { useChartStore } from '../../stores/chartStore'
import { useSimulationStore } from '../../stores/simulationStore'
import type {
  GifHistorySnapshot,
  MainToPhysicsMessage,
  PhysicsToMainMessage,
} from '../worker/messages'

const INITIALIZATION_TIMEOUT_MS = 5_000
const MAX_INITIALIZATION_RETRIES = 2

class PhysicsClient {
  private worker: Worker | null = null
  private pendingScene: SceneDocument | null = null
  private initializationRetries = 0
  private initializationTimer: ReturnType<typeof setTimeout> | null = null
  private nextGifHistoryRequestId = 1
  private readonly pendingGifHistoryRequests = new Map<
    number,
    {
      resolve: (snapshot: GifHistorySnapshot) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  start(): void {
    if (this.worker) return
    this.createWorker()
  }

  private createWorker(): void {
    const worker = new Worker(new URL('../worker/physics.worker.ts', import.meta.url), {
      type: 'module',
      name: 'motion-studio-physics',
    })
    this.worker = worker
    worker.onmessage = (event: MessageEvent<PhysicsToMainMessage>) => {
      if (this.worker !== worker) return
      const message = event.data
      const store = useSimulationStore.getState()
      if (message.type === 'ready') {
        this.clearInitializationTimer()
        this.pendingScene = null
        this.initializationRetries = 0
        store.setReady(message.fixedTimeStep)
      } else if (message.type === 'state') {
        store.setRuntimeState(message.status, message.simulationTime, message.playbackRate)
      } else if (message.type === 'frame') {
        store.setFrame(message.simulationTime, message.bodies)
        useChartStore.getState().appendSamples(message.samples)
      } else if (message.type === 'gifHistoryStatus') {
        store.setGifHistoryStatus(message.status)
      } else if (message.type === 'gifHistorySnapshot') {
        const pending = this.pendingGifHistoryRequests.get(message.snapshot.requestId)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingGifHistoryRequests.delete(message.snapshot.requestId)
          pending.resolve(message.snapshot)
        }
      } else if (message.type === 'warning') {
        store.addWarning(message.message)
      } else {
        this.clearInitializationTimer()
        this.pendingScene = null
        store.setError(message.message)
      }
    }
    worker.onerror = (event) => {
      if (this.worker !== worker) return
      this.retryInitialization(event.message || '物理线程无法启动。')
    }
  }

  stop(): void {
    this.clearInitializationTimer()
    this.worker?.terminate()
    this.worker = null
    this.rejectGifHistoryRequests('物理线程已停止，无法读取 GIF 历史记录。')
    this.pendingScene = null
    this.initializationRetries = 0
  }

  initialize(scene: SceneDocument): void {
    this.start()
    this.pendingScene = scene
    this.initializationRetries = 0
    useSimulationStore.getState().beginInitialization()
    const chartStore = useChartStore.getState()
    chartStore.configureLimit(
      scene.settings.recordingSampleRate,
      scene.settings.recordingDurationSeconds,
    )
    chartStore.clearHistory()
    this.send({ type: 'initialize', scene })
    this.armInitializationTimeout()
  }

  play(): void {
    this.send({ type: 'play' })
  }

  pause(): void {
    this.send({ type: 'pause' })
  }

  step(): void {
    this.send({ type: 'step' })
  }

  reset(): void {
    useChartStore.getState().clearHistory()
    this.send({ type: 'reset' })
  }

  setPlaybackRate(rate: number): void {
    this.send({ type: 'setPlaybackRate', rate })
  }

  setRecordedBodyIds(entityIds: string[]): void {
    this.send({ type: 'setRecordedBodyIds', entityIds })
  }

  clearGifHistory(): void {
    this.send({ type: 'clearGifHistory' })
  }

  requestGifHistory(): Promise<GifHistorySnapshot> {
    if (!this.worker) return Promise.reject(new Error('物理线程尚未启动。'))
    const requestId = this.nextGifHistoryRequestId
    this.nextGifHistoryRequestId += 1

    return new Promise<GifHistorySnapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingGifHistoryRequests.delete(requestId)
        reject(new Error('读取 GIF 历史记录超时，请稍后重试。'))
      }, 10_000)
      this.pendingGifHistoryRequests.set(requestId, { resolve, reject, timer })
      this.send({ type: 'requestGifHistory', requestId })
    })
  }

  private send(message: MainToPhysicsMessage): void {
    this.worker?.postMessage(message)
  }

  private clearInitializationTimer(): void {
    if (this.initializationTimer === null) return
    clearTimeout(this.initializationTimer)
    this.initializationTimer = null
  }

  private armInitializationTimeout(): void {
    this.clearInitializationTimer()
    this.initializationTimer = setTimeout(() => {
      this.retryInitialization('物理线程初始化超时。')
    }, INITIALIZATION_TIMEOUT_MS)
  }

  private retryInitialization(reason: string): void {
    const scene = this.pendingScene
    this.clearInitializationTimer()
    this.worker?.terminate()
    this.worker = null
    this.rejectGifHistoryRequests('物理线程正在重新初始化，请稍后重试。')
    if (!scene || this.initializationRetries >= MAX_INITIALIZATION_RETRIES) {
      this.pendingScene = null
      useSimulationStore.getState().setError(reason)
      return
    }

    this.initializationRetries += 1
    this.createWorker()
    this.send({ type: 'initialize', scene })
    this.armInitializationTimeout()
  }

  private rejectGifHistoryRequests(message: string): void {
    for (const pending of this.pendingGifHistoryRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
    }
    this.pendingGifHistoryRequests.clear()
  }
}

export const physicsClient = new PhysicsClient()
