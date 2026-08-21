import { describe, expect, it } from 'vitest'

import type { GifHistorySnapshot } from '../../physics/worker/messages'
import {
  createDefaultGifExportSettings,
  fitGifPreviewDisplaySize,
  gifFrameDelaysMs,
  gifFrameTimes,
  gifSourceFrameStep,
  GifHistoryReader,
  normalizeGifTrim,
  validateGifExportLoad,
} from './gifExportModel'

function snapshot(): GifHistorySnapshot {
  return {
    requestId: 1,
    status: {
      kind: 'ready',
      bodyCount: 1,
      maxBodies: 200,
      sampleCount: 2,
      startTime: 0,
      endTime: 1,
    },
    sampleRate: 30,
    bodyIds: ['body'],
    times: new Float32Array([0, 1]),
    values: new Float32Array([
      0,
      0,
      (Math.PI * 170) / 180,
      0,
      0,
      0,
      0,
      10,
      20,
      (-Math.PI * 170) / 180,
      2,
      4,
      6,
      8,
    ]),
    connectorIds: ['spring'],
    connectorPointOffsets: new Uint32Array([0, 2]),
    connectorValues: new Float32Array([0, 0, 1, 0, 2, 4, 5, 4]),
    particleIonCount: 0,
    particleIonTs: new Float32Array(),
    particleValues: new Float32Array(),
  }
}

describe('GIF export model', () => {
  it('uses the confirmed defaults and full retained range', () => {
    const settings = createDefaultGifExportSettings(
      snapshot(),
      true,
      new Date(2026, 6, 29, 3, 4, 5),
    )
    expect(settings).toMatchObject({
      fileName: 'motion-studio-20260729-030405.gif',
      width: 640,
      height: 360,
      fps: 15,
      speedMultiplier: 1,
      gridVisible: true,
      startTime: 0,
      endTime: 1,
    })
  })

  it('interpolates vectors and takes the shortest angle path', () => {
    const frame = new GifHistoryReader(snapshot()).frameAt(0.5)
    expect(frame.bodies.body?.position).toEqual({ x: 5, y: 10 })
    expect(frame.bodies.body?.linearVelocity).toEqual({ x: 1, y: 2 })
    expect(frame.bodies.body?.netForce).toEqual({ x: 3, y: 4 })
    expect(Math.abs(frame.bodies.body?.angleRad ?? 0)).toBeCloseTo(Math.PI)
    expect(frame.connectors.spring?.points).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 2 },
    ])
  })

  it('keeps an exact valid endpoint but never interpolates across a missing-body gap', () => {
    const discontinuous = snapshot()
    discontinuous.values.fill(Number.NaN, 7, 14)
    const reader = new GifHistoryReader(discontinuous)

    expect(reader.frameAt(0).bodies.body?.position).toEqual({ x: 0, y: 0 })
    expect(reader.frameAt(0.5).bodies.body).toBeUndefined()
  })

  it('rejects unsafe pixel-frame combinations without changing settings', () => {
    const settings = createDefaultGifExportSettings(snapshot(), true)
    const invalid = validateGifExportLoad({
      ...settings,
      width: 1920,
      height: 1080,
      fps: 30,
      endTime: 300,
    })
    expect(invalid.valid).toBe(false)
    expect(invalid.pixelFrames).toBeGreaterThan(500_000_000)
  })

  it('requires the trim handles to remain at least one output frame apart', () => {
    const settings = createDefaultGifExportSettings(snapshot(), true)
    expect(
      validateGifExportLoad({
        ...settings,
        fps: 5,
        speedMultiplier: 2,
        startTime: 0,
        endTime: 0.1,
      }),
    ).toMatchObject({
      valid: false,
      message: '当前历史区间不足一个输出帧，请降低倍速或提高帧率。',
    })
  })

  it('changes output duration, frame count and source sampling stride with speed', () => {
    const settings = {
      ...createDefaultGifExportSettings(snapshot(), true),
      fps: 10,
      speedMultiplier: 2 as const,
    }
    expect(validateGifExportLoad(settings)).toMatchObject({
      sourceDurationSeconds: 1,
      outputDurationSeconds: 0.5,
      frameCount: 5,
    })
    expect(gifSourceFrameStep(settings)).toBe(0.2)
    expect(gifFrameTimes(settings)).toEqual([0, 0.2, 0.4, expect.closeTo(0.6), 0.8])
  })

  it('expands the end first and moves the start only near the history boundary', () => {
    const settings = {
      ...createDefaultGifExportSettings(snapshot(), true),
      fps: 5,
      speedMultiplier: 2 as const,
      startTime: 0.2,
      endTime: 0.3,
    }
    expect(normalizeGifTrim(settings, 0, 1)).toEqual({
      startTime: 0.2,
      endTime: expect.closeTo(0.6),
    })
    expect(
      normalizeGifTrim(
        {
          ...settings,
          startTime: 0.85,
          endTime: 0.95,
        },
        0,
        1,
      ),
    ).toEqual({
      startTime: expect.closeTo(0.55),
      endTime: 0.95,
    })
  })

  it('slow motion increases load and remains subject to the pixel-frame budget', () => {
    const settings = {
      ...createDefaultGifExportSettings(snapshot(), true),
      width: 1920,
      height: 1080,
      fps: 30,
      speedMultiplier: 0.25 as const,
      endTime: 3,
    }
    const load = validateGifExportLoad(settings)
    expect(load.outputDurationSeconds).toBe(12)
    expect(load.frameCount).toBe(360)
    expect(load.pixelFrames).toBeGreaterThan(500_000_000)
    expect(load.valid).toBe(false)
  })

  it('centers the export frame within a preview margin without changing its aspect ratio', () => {
    expect(fitGifPreviewDisplaySize(1000, 600, 640, 360)).toEqual({
      width: 952,
      height: 535,
    })
    expect(fitGifPreviewDisplaySize(500, 700, 1080, 1920)).toEqual({
      width: 366,
      height: 652,
    })
  })

  it('distributes centisecond delays without long-term speed drift', () => {
    const delays = gifFrameDelaysMs(30, 30)
    expect(new Set(delays)).toEqual(new Set([30, 40]))
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(1000)
  })
})
