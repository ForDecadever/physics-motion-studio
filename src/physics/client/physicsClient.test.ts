import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createEmptyScene } from '../../scene/model/createEmptyScene'
import { useSimulationStore } from '../../stores/simulationStore'
import type { MainToPhysicsMessage, PhysicsToMainMessage } from '../worker/messages'
import { physicsClient } from './physicsClient'

class FakeWorker {
  static instances: FakeWorker[] = []

  onmessage: ((event: MessageEvent<PhysicsToMainMessage>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly messages: MainToPhysicsMessage[] = []
  terminated = false

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(message: MainToPhysicsMessage): void {
    this.messages.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  emit(message: PhysicsToMainMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<PhysicsToMainMessage>)
  }
}

describe('PhysicsClient Worker 初始化恢复', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    vi.useFakeTimers()
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker)
  })

  afterEach(() => {
    physicsClient.stop()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('初始化超时后重建 Worker，并在新 Worker 就绪后停止重试', async () => {
    const scene = createEmptyScene('Worker 重试', new Date('2026-07-26T00:00:00.000Z'))

    physicsClient.initialize(scene)
    expect(FakeWorker.instances).toHaveLength(1)
    expect(FakeWorker.instances[0]?.messages[0]).toMatchObject({ type: 'initialize' })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(FakeWorker.instances[0]?.terminated).toBe(true)
    expect(FakeWorker.instances).toHaveLength(2)
    expect(FakeWorker.instances[1]?.messages[0]).toMatchObject({ type: 'initialize' })

    FakeWorker.instances[1]?.emit({ type: 'ready', fixedTimeStep: 1 / 120 })
    expect(useSimulationStore.getState().status).toBe('ready')

    await vi.advanceTimersByTimeAsync(15_000)
    expect(FakeWorker.instances).toHaveLength(2)
  })

  it('连续三次初始化超时后进入错误状态，避免无限重启', async () => {
    const scene = createEmptyScene('Worker 失败', new Date('2026-07-26T00:00:00.000Z'))

    physicsClient.initialize(scene)
    await vi.advanceTimersByTimeAsync(15_000)

    expect(FakeWorker.instances).toHaveLength(3)
    expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true)
    expect(useSimulationStore.getState()).toMatchObject({
      status: 'error',
      errorMessage: '物理线程初始化超时。',
    })
  })

  it('通过请求编号接收可转移的 GIF 历史快照', async () => {
    physicsClient.start()
    const worker = FakeWorker.instances[0]!
    const pending = physicsClient.requestGifHistory()
    const request = worker.messages.at(-1)
    expect(request).toMatchObject({ type: 'requestGifHistory' })
    if (request?.type !== 'requestGifHistory') return

    const snapshot = {
      requestId: request.requestId,
      status: {
        kind: 'ready' as const,
        bodyCount: 0,
        maxBodies: 200,
        sampleCount: 2,
        startTime: 0,
        endTime: 1 / 30,
      },
      sampleRate: 30,
      bodyIds: [],
      times: new Float32Array([0, 1 / 30]),
      values: new Float32Array(),
    }
    worker.emit({ type: 'gifHistorySnapshot', snapshot })
    await expect(pending).resolves.toBe(snapshot)
  })

  it('forwards the GIF history clear request to the physics worker', () => {
    physicsClient.start()
    physicsClient.clearGifHistory()
    expect(FakeWorker.instances[0]?.messages.at(-1)).toEqual({ type: 'clearGifHistory' })
  })
})
