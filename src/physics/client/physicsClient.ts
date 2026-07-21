import type { SceneDocument } from '../../scene/model/types'
import { useSimulationStore } from '../../stores/simulationStore'
import type { MainToPhysicsMessage, PhysicsToMainMessage } from '../worker/messages'

class PhysicsClient {
  private worker: Worker | null = null

  start(): void {
    if (this.worker) return
    this.worker = new Worker(new URL('../worker/physics.worker.ts', import.meta.url), {
      type: 'module',
      name: 'motion-studio-physics',
    })
    this.worker.onmessage = (event: MessageEvent<PhysicsToMainMessage>) => {
      const message = event.data
      const store = useSimulationStore.getState()
      if (message.type === 'ready') {
        store.setReady(message.fixedTimeStep)
      } else if (message.type === 'state') {
        store.setRuntimeState(message.status, message.simulationTime, message.playbackRate)
      } else if (message.type === 'frame') {
        store.setFrame(message.simulationTime, message.bodies)
      } else if (message.type === 'warning') {
        store.addWarning(message.message)
      } else {
        store.setError(message.message)
      }
    }
    this.worker.onerror = (event) => {
      useSimulationStore.getState().setError(event.message || '物理线程无法启动。')
    }
  }

  stop(): void {
    this.worker?.terminate()
    this.worker = null
  }

  initialize(scene: SceneDocument): void {
    useSimulationStore.getState().beginInitialization()
    this.send({ type: 'initialize', scene })
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
    this.send({ type: 'reset' })
  }

  setPlaybackRate(rate: number): void {
    this.send({ type: 'setPlaybackRate', rate })
  }

  private send(message: MainToPhysicsMessage): void {
    this.worker?.postMessage(message)
  }
}

export const physicsClient = new PhysicsClient()
