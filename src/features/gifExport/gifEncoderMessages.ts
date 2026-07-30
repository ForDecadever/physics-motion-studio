export type GifEncoderRequest =
  | {
      type: 'initialize'
      width: number
      height: number
      transparent: boolean
      paletteSample: Uint8ClampedArray
      maxOutputBytes: number
    }
  | {
      type: 'frame'
      frameIndex: number
      pixels: Uint8ClampedArray
      delayMs: number
    }
  | { type: 'finish' }

export type GifEncoderResponse =
  | { type: 'ready' }
  | { type: 'frameEncoded'; frameIndex: number; byteLength: number }
  | { type: 'complete'; bytes: Uint8Array }
  | { type: 'error'; message: string }
