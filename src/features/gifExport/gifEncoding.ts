import { GIFEncoder, applyPalette, quantize, type GifPalette } from 'gifenc'

interface GifEncodingOptions {
  width: number
  height: number
  transparent: boolean
  paletteSample: Uint8ClampedArray
  maxOutputBytes: number
}

export class GifEncodingSession {
  private readonly encoder = GIFEncoder({ initialCapacity: 4 * 1024 * 1024 })
  private readonly palette: GifPalette
  private readonly transparentIndex: number
  private firstFrame = true

  constructor(private readonly options: GifEncodingOptions) {
    const format = options.transparent ? 'rgba4444' : 'rgb565'
    this.palette = quantize(options.paletteSample, options.transparent ? 255 : 256, {
      format,
      oneBitAlpha: options.transparent ? 127 : false,
      clearAlpha: options.transparent,
      clearAlphaThreshold: 127,
    })

    let transparentIndex = 0
    if (options.transparent) {
      transparentIndex = this.palette.findIndex((color) => (color[3] ?? 255) === 0)
      if (transparentIndex < 0) {
        this.palette.push([0, 0, 0, 0])
        transparentIndex = this.palette.length - 1
      }
    }
    this.transparentIndex = transparentIndex
  }

  get byteLength(): number {
    return this.encoder.bytesView().byteLength
  }

  writeFrame(pixels: Uint8ClampedArray, delayMs: number): number {
    const { width, height, transparent } = this.options
    if (pixels.length !== width * height * 4) {
      throw new Error('渲染帧尺寸与导出设置不一致。')
    }
    const indexed = applyPalette(pixels, this.palette, transparent ? 'rgba4444' : 'rgb565')
    this.encoder.writeFrame(indexed, width, height, {
      ...(this.firstFrame ? { palette: this.palette } : {}),
      repeat: 0,
      delay: delayMs,
      transparent,
      transparentIndex: this.transparentIndex,
      dispose: transparent ? 2 : -1,
    })
    this.firstFrame = false
    this.assertSize()
    return this.byteLength
  }

  finish(): Uint8Array {
    this.encoder.finish()
    this.assertSize()
    return this.encoder.bytes()
  }

  private assertSize(): void {
    if (this.byteLength > this.options.maxOutputBytes) {
      throw new Error('GIF 已超过 512 MiB，请缩短时间或降低分辨率与帧率。')
    }
  }
}
