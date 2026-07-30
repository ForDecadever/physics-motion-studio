import type { GifEncoderRequest, GifEncoderResponse } from './gifEncoderMessages'

interface PendingFrame {
  resolve: (byteLength: number) => void
  reject: (error: Error) => void
}

export class GifEncoderClient {
  private readonly worker = new Worker(new URL('./gifEncoder.worker.ts', import.meta.url), {
    type: 'module',
    name: 'motion-studio-gif-encoder',
  })
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private finishResolve: ((bytes: Uint8Array) => void) | null = null
  private finishReject: ((error: Error) => void) | null = null
  private readonly pendingFrames = new Map<number, PendingFrame>()
  private closed = false

  constructor() {
    this.worker.onmessage = (event: MessageEvent<GifEncoderResponse>) => {
      const message = event.data
      if (message.type === 'ready') {
        this.readyResolve?.()
        this.readyResolve = null
        this.readyReject = null
      } else if (message.type === 'frameEncoded') {
        const pending = this.pendingFrames.get(message.frameIndex)
        this.pendingFrames.delete(message.frameIndex)
        pending?.resolve(message.byteLength)
      } else if (message.type === 'complete') {
        this.finishResolve?.(message.bytes)
        this.finishResolve = null
        this.finishReject = null
      } else {
        this.rejectAll(new Error(message.message))
      }
    }
    this.worker.onerror = (event) => {
      this.rejectAll(new Error(event.message || 'GIF 编码线程无法运行。'))
    }
  }

  initialize(
    width: number,
    height: number,
    transparent: boolean,
    paletteSample: Uint8ClampedArray,
    maxOutputBytes: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      this.post({ type: 'initialize', width, height, transparent, paletteSample, maxOutputBytes }, [
        paletteSample.buffer,
      ])
    })
  }

  encodeFrame(frameIndex: number, pixels: Uint8ClampedArray, delayMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.pendingFrames.set(frameIndex, { resolve, reject })
      this.post({ type: 'frame', frameIndex, pixels, delayMs }, [pixels.buffer])
    })
  }

  finish(): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.finishResolve = resolve
      this.finishReject = reject
      this.post({ type: 'finish' })
    })
  }

  cancel(): void {
    if (this.closed) return
    this.closed = true
    this.worker.terminate()
    this.rejectAll(new Error('GIF 导出已取消。'))
  }

  destroy(): void {
    if (this.closed) return
    this.closed = true
    this.worker.terminate()
  }

  private post(message: GifEncoderRequest, transfer: Transferable[] = []): void {
    if (this.closed) throw new Error('GIF 编码器已关闭。')
    this.worker.postMessage(message, transfer)
  }

  private rejectAll(error: Error): void {
    this.readyReject?.(error)
    this.finishReject?.(error)
    for (const pending of this.pendingFrames.values()) pending.reject(error)
    this.readyResolve = null
    this.readyReject = null
    this.finishResolve = null
    this.finishReject = null
    this.pendingFrames.clear()
  }
}
