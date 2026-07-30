import { decompressFrames, parseGIF } from 'gifuct-js'
import { describe, expect, it } from 'vitest'

import { GifEncodingSession } from './gifEncoding'

function solidFrame(
  width: number,
  height: number,
  color: [number, number, number, number],
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    pixels.set(color, index * 4)
  }
  return pixels
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

describe('GifEncodingSession', () => {
  it('creates a looping multi-frame GIF with expected delays', () => {
    const width = 2
    const height = 2
    const red = solidFrame(width, height, [255, 0, 0, 255])
    const blue = solidFrame(width, height, [0, 0, 255, 255])
    const paletteSample = new Uint8ClampedArray([...red, ...blue])
    const session = new GifEncodingSession({
      width,
      height,
      transparent: false,
      paletteSample,
      maxOutputBytes: 1024 * 1024,
    })
    session.writeFrame(red, 70)
    session.writeFrame(blue, 60)
    const bytes = session.finish()

    expect(new TextDecoder().decode(bytes.slice(0, 6))).toBe('GIF89a')
    const parsed = parseGIF(copiedArrayBuffer(bytes))
    const frames = decompressFrames(parsed, true)
    expect(frames).toHaveLength(2)
    expect(frames.map((frame) => frame.delay)).toEqual([70, 60])
    expect(parsed.lsd.width).toBe(width)
    expect(parsed.lsd.height).toBe(height)
  })

  it('preserves binary transparency through a transparent palette index', () => {
    const pixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0])
    const session = new GifEncodingSession({
      width: 2,
      height: 1,
      transparent: true,
      paletteSample: pixels.slice(),
      maxOutputBytes: 1024 * 1024,
    })
    session.writeFrame(pixels, 100)
    const bytes = session.finish()
    const frames = decompressFrames(parseGIF(copiedArrayBuffer(bytes)), true)
    expect([...frames[0]!.patch.slice(4, 8)]).toEqual([0, 0, 0, 0])
  })
})
