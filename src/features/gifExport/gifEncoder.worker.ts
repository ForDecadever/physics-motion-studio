/// <reference lib="webworker" />

import { GifEncodingSession } from './gifEncoding'
import type { GifEncoderRequest, GifEncoderResponse } from './gifEncoderMessages'

let encoder: GifEncodingSession | null = null

function post(message: GifEncoderResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer)
}

function fail(error: unknown): void {
  post({
    type: 'error',
    message: error instanceof Error ? error.message : 'GIF 编码发生未知错误。',
  })
}

function initialize(message: Extract<GifEncoderRequest, { type: 'initialize' }>): void {
  encoder = new GifEncodingSession(message)
  post({ type: 'ready' })
}

function encodeFrame(message: Extract<GifEncoderRequest, { type: 'frame' }>): void {
  if (!encoder) throw new Error('GIF 编码器尚未初始化。')
  const byteLength = encoder.writeFrame(message.pixels, message.delayMs)
  post({ type: 'frameEncoded', frameIndex: message.frameIndex, byteLength })
}

self.onmessage = (event: MessageEvent<GifEncoderRequest>) => {
  try {
    if (event.data.type === 'initialize') initialize(event.data)
    else if (event.data.type === 'frame') encodeFrame(event.data)
    else {
      if (!encoder) throw new Error('GIF 编码器尚未初始化。')
      const bytes = encoder.finish()
      post({ type: 'complete', bytes }, [bytes.buffer])
      encoder = null
    }
  } catch (error) {
    encoder = null
    fail(error)
  }
}
