import type { Vec2 } from '../../scene/model/types'

export interface Camera2D {
  center: Vec2
  pixelsPerMeter: number
}

export interface ViewportSize {
  width: number
  height: number
}

export const MIN_PIXELS_PER_METER = 0.1
export const MAX_PIXELS_PER_METER = 20_000

export const defaultCamera: Camera2D = {
  center: { x: 0, y: 0 },
  pixelsPerMeter: 20,
}

export function worldToScreen(point: Vec2, camera: Camera2D, size: ViewportSize): Vec2 {
  return {
    x: size.width / 2 + (point.x - camera.center.x) * camera.pixelsPerMeter,
    y: size.height / 2 - (point.y - camera.center.y) * camera.pixelsPerMeter,
  }
}

export function screenToWorld(point: Vec2, camera: Camera2D, size: ViewportSize): Vec2 {
  return {
    x: camera.center.x + (point.x - size.width / 2) / camera.pixelsPerMeter,
    y: camera.center.y - (point.y - size.height / 2) / camera.pixelsPerMeter,
  }
}

export function panCamera(camera: Camera2D, screenDelta: Vec2): Camera2D {
  return {
    ...camera,
    center: {
      x: camera.center.x - screenDelta.x / camera.pixelsPerMeter,
      y: camera.center.y + screenDelta.y / camera.pixelsPerMeter,
    },
  }
}

export function zoomCameraAtPoint(
  camera: Camera2D,
  screenPoint: Vec2,
  size: ViewportSize,
  zoomFactor: number,
): Camera2D {
  const worldPoint = screenToWorld(screenPoint, camera, size)
  const pixelsPerMeter = Math.min(
    MAX_PIXELS_PER_METER,
    Math.max(MIN_PIXELS_PER_METER, camera.pixelsPerMeter * zoomFactor),
  )

  return {
    pixelsPerMeter,
    center: {
      x: worldPoint.x - (screenPoint.x - size.width / 2) / pixelsPerMeter,
      y: worldPoint.y + (screenPoint.y - size.height / 2) / pixelsPerMeter,
    },
  }
}

export function getAdaptiveGridStep(
  baseStep: number,
  pixelsPerMeter: number,
  minimumPixels = 18,
): number {
  const targetWorldStep = minimumPixels / pixelsPerMeter
  const exponent = Math.floor(Math.log10(targetWorldStep / baseStep))
  const magnitude = baseStep * 10 ** exponent

  for (const multiplier of [1, 2, 5, 10]) {
    const candidate = magnitude * multiplier
    if (candidate >= targetWorldStep) return candidate
  }

  return magnitude * 10
}

export function getVisibleGridSteps(baseMajorStep: number, pixelsPerMeter: number) {
  const minorStep = getAdaptiveGridStep(baseMajorStep / 10, pixelsPerMeter, 14)
  return { minorStep, majorStep: minorStep * 5 }
}

export function getVisibleSnapStep(baseMajorStep: number, pixelsPerMeter: number): number {
  return getVisibleGridSteps(baseMajorStep, pixelsPerMeter).minorStep
}

export function snapValue(value: number, step: number): number {
  return Math.round(value / step) * step
}

export function snapPoint(point: Vec2, step: number): Vec2 {
  return {
    x: snapValue(point.x, step),
    y: snapValue(point.y, step),
  }
}

export function snapAngle(angleRad: number, stepRad = Math.PI / 12): number {
  return snapValue(angleRad, stepRad)
}
