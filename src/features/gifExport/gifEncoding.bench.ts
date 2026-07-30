import { bench } from 'vitest'

import { GifEncodingSession } from './gifEncoding'

const width = 640
const height = 360
const frame = new Uint8ClampedArray(width * height * 4)

for (let pixel = 0; pixel < width * height; pixel += 1) {
  const x = pixel % width
  const y = Math.floor(pixel / width)
  const offset = pixel * 4
  frame[offset] = x % 64 < 32 ? 218 : 48
  frame[offset + 1] = y % 64 < 32 ? 92 : 154
  frame[offset + 2] = 178
  frame[offset + 3] = 255
}

bench(
  '编码 640×360、15 FPS 的一秒代表性 GIF',
  () => {
    const session = new GifEncodingSession({
      width,
      height,
      transparent: false,
      paletteSample: frame,
      maxOutputBytes: 512 * 1024 * 1024,
    })
    for (let index = 0; index < 15; index += 1) session.writeFrame(frame, index % 3 === 0 ? 70 : 60)
    session.finish()
  },
  { time: 1000, warmupTime: 200 },
)
