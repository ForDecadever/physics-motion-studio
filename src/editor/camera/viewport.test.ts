import { describe, expect, it } from 'vitest'

import {
  MAX_PIXELS_PER_METER,
  MIN_PIXELS_PER_METER,
  defaultCamera,
  getAdaptiveGridStep,
  getVisibleGridSteps,
  getVisibleSnapStep,
  panCamera,
  screenToWorld,
  snapAngle,
  snapPoint,
  worldToScreen,
  zoomCameraAtPoint,
} from './viewport'

const size = { width: 800, height: 600 }

describe('二维视口', () => {
  it('世界坐标和屏幕坐标可以往返转换', () => {
    const world = { x: 1.25, y: -0.75 }
    const screen = worldToScreen(world, defaultCamera, size)

    expect(screenToWorld(screen, defaultCamera, size)).toEqual(world)
    expect(worldToScreen({ x: 0, y: 1 }, defaultCamera, size)).toEqual({ x: 400, y: 280 })
  })

  it('缩放时保持指针下方的世界点不动', () => {
    const pointer = { x: 630, y: 170 }
    const before = screenToWorld(pointer, defaultCamera, size)
    const zoomed = zoomCameraAtPoint(defaultCamera, pointer, size, 1.8)

    expect(screenToWorld(pointer, zoomed, size).x).toBeCloseTo(before.x)
    expect(screenToWorld(pointer, zoomed, size).y).toBeCloseTo(before.y)
  })

  it('平移、网格和角度吸附符合约定', () => {
    expect(panCamera(defaultCamera, { x: 100, y: -50 }).center).toEqual({ x: -5, y: -2.5 })
    expect(snapPoint({ x: 1.26, y: -0.74 }, 0.1)).toEqual({ x: 1.3, y: -0.7000000000000001 })
    expect(snapAngle((17 * Math.PI) / 180)).toBeCloseTo(Math.PI / 12)
    expect(getAdaptiveGridStep(1, 100)).toBe(0.2)
    expect(getVisibleGridSteps(5, defaultCamera.pixelsPerMeter).majorStep).toBe(5)
    expect(getVisibleSnapStep(5, defaultCamera.pixelsPerMeter)).toBe(1)
    expect(getVisibleSnapStep(5, 200)).toBe(0.1)
  })

  it('扩大后的缩放上下限仍会被安全钳制', () => {
    expect(zoomCameraAtPoint(defaultCamera, { x: 400, y: 300 }, size, 1e9).pixelsPerMeter).toBe(
      MAX_PIXELS_PER_METER,
    )
    expect(zoomCameraAtPoint(defaultCamera, { x: 400, y: 300 }, size, 1e-9).pixelsPerMeter).toBe(
      MIN_PIXELS_PER_METER,
    )
  })
})
