import {
  MAX_PIXELS_PER_METER,
  MIN_PIXELS_PER_METER,
  type Camera2D,
  type ViewportSize,
} from '../../editor/camera/viewport'
import { getEntityBounds } from '../../editor/geometry/entityGeometry'
import type {
  GifHistorySnapshot,
  RuntimeBodyState,
  RuntimeConnectorState,
} from '../../physics/worker/messages'
import type { BodyEntity, EntityId, SceneDocument, Vec2 } from '../../scene/model/types'
import { resolveBooleanScene } from '../../scene/model/booleanGeometry'
import { sampleAdaptiveClosedBezierPath } from '../../scene/model/bodyPath'
import { listRuntimeBodyTargets } from '../../scene/model/runtimeBodyTargets'
import { CHART_COLOR_PALETTE } from '../charts/chartPalette'

export const GIF_MAX_PIXEL_FRAMES = 500_000_000
export const GIF_MAX_OUTPUT_BYTES = 512 * 1024 * 1024
export const GIF_MIN_DIMENSION = 64
export const GIF_MAX_DIMENSION = 1920
export const GIF_MIN_FPS = 1
export const GIF_MAX_FPS = 30
export const GIF_SPEED_MULTIPLIERS = [0.25, 0.5, 1, 2, 4] as const

export type GifSpeedMultiplier = (typeof GIF_SPEED_MULTIPLIERS)[number]

export interface GifGuideSelection {
  trajectoryIds: EntityId[]
  velocityIds: EntityId[]
  forceIds: EntityId[]
}

export interface GifExportSettings {
  fileName: string
  width: number
  height: number
  fps: number
  speedMultiplier: GifSpeedMultiplier
  transparent: boolean
  backgroundColor: string
  gridVisible: boolean
  startTime: number
  endTime: number
  guides: GifGuideSelection
}

export interface GifExportLoad {
  sourceDurationSeconds: number
  outputDurationSeconds: number
  frameCount: number
  pixelFrames: number
  valid: boolean
  message: string | null
}

export interface GifInterpolatedFrame {
  simulationTime: number
  bodies: Record<EntityId, RuntimeBodyState>
  connectors: Record<EntityId, RuntimeConnectorState>
}

const BODY_CHANNELS = 7
const X = 0
const Y = 1
const ANGLE = 2
const VELOCITY_X = 3
const VELOCITY_Y = 4
const FORCE_X = 5
const FORCE_Y = 6

function timestampFileName(now = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, '0')
  return `motion-studio-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}.gif`
}

export function createDefaultGifExportSettings(
  snapshot: GifHistorySnapshot,
  gridVisible: boolean,
  now = new Date(),
): GifExportSettings {
  const status = snapshot.status
  const startTime = status.kind === 'ready' ? status.startTime : 0
  const endTime = status.kind === 'ready' ? status.endTime : 0
  return {
    fileName: timestampFileName(now),
    width: 640,
    height: 360,
    fps: 15,
    speedMultiplier: 1,
    transparent: false,
    backgroundColor: '#292d33',
    gridVisible,
    startTime,
    endTime,
    guides: { trajectoryIds: [], velocityIds: [], forceIds: [] },
  }
}

export function gifSourceFrameStep(settings: Pick<GifExportSettings, 'fps' | 'speedMultiplier'>) {
  return settings.speedMultiplier / settings.fps
}

export function normalizeGifTrim(
  settings: GifExportSettings,
  historyStartTime: number,
  historyEndTime: number,
): Pick<GifExportSettings, 'startTime' | 'endTime'> {
  const startTime = Math.min(
    historyEndTime,
    Math.max(historyStartTime, Math.min(settings.startTime, settings.endTime)),
  )
  const endTime = Math.max(
    historyStartTime,
    Math.min(historyEndTime, Math.max(settings.startTime, settings.endTime)),
  )
  const minimumGap = gifSourceFrameStep(settings)
  if (
    !Number.isFinite(minimumGap) ||
    minimumGap <= 0 ||
    historyEndTime - historyStartTime + Number.EPSILON < minimumGap ||
    endTime - startTime + Number.EPSILON >= minimumGap
  ) {
    return { startTime, endTime }
  }

  const expandedEndTime = startTime + minimumGap
  if (expandedEndTime <= historyEndTime + Number.EPSILON) {
    return { startTime, endTime: Math.min(historyEndTime, expandedEndTime) }
  }
  return {
    startTime: Math.max(historyStartTime, endTime - minimumGap),
    endTime,
  }
}

export function validateGifExportLoad(settings: GifExportSettings): GifExportLoad {
  const sourceDurationSeconds = settings.endTime - settings.startTime
  const outputDurationSeconds = sourceDurationSeconds / settings.speedMultiplier
  const frameCount =
    Number.isFinite(outputDurationSeconds) &&
    Number.isFinite(settings.fps) &&
    outputDurationSeconds > 0
      ? Math.ceil(outputDurationSeconds * settings.fps)
      : 0
  const pixelFrames = settings.width * settings.height * frameCount

  let message: string | null = null
  if (
    !Number.isInteger(settings.width) ||
    !Number.isInteger(settings.height) ||
    settings.width < GIF_MIN_DIMENSION ||
    settings.width > GIF_MAX_DIMENSION ||
    settings.height < GIF_MIN_DIMENSION ||
    settings.height > GIF_MAX_DIMENSION
  ) {
    message = `宽度和高度必须是 ${GIF_MIN_DIMENSION}～${GIF_MAX_DIMENSION} px 的整数。`
  } else if (
    !Number.isInteger(settings.fps) ||
    settings.fps < GIF_MIN_FPS ||
    settings.fps > GIF_MAX_FPS
  ) {
    message = `帧率必须是 ${GIF_MIN_FPS}～${GIF_MAX_FPS} FPS 的整数。`
  } else if (!GIF_SPEED_MULTIPLIERS.includes(settings.speedMultiplier)) {
    message = '请选择有效的 GIF 播放倍速。'
  } else if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
    message = '导出结束时间必须晚于开始时间。'
  } else if (sourceDurationSeconds + Number.EPSILON < gifSourceFrameStep(settings)) {
    message = '当前历史区间不足一个输出帧，请降低倍速或提高帧率。'
  } else if (pixelFrames > GIF_MAX_PIXEL_FRAMES) {
    message = '当前分辨率、帧率和时长的组合过大，请降低其中一项。'
  }

  return {
    sourceDurationSeconds,
    outputDurationSeconds,
    frameCount,
    pixelFrames,
    valid: message === null,
    message,
  }
}

export function gifFrameTimes(settings: GifExportSettings): number[] {
  const { frameCount } = validateGifExportLoad(settings)
  const sourceFrameStep = gifSourceFrameStep(settings)
  return Array.from(
    { length: frameCount },
    (_, index) => settings.startTime + index * sourceFrameStep,
  )
}

export function gifFrameDelaysMs(frameCount: number, fps: number): number[] {
  return Array.from({ length: frameCount }, (_, index) => {
    const startCentiseconds = Math.round((index * 100) / fps)
    const endCentiseconds = Math.round(((index + 1) * 100) / fps)
    return Math.max(1, endCentiseconds - startCentiseconds) * 10
  })
}

function shortestAngleInterpolation(start: number, end: number, ratio: number): number {
  const difference = Math.atan2(Math.sin(end - start), Math.cos(end - start))
  return start + difference * ratio
}

function lowerSampleIndex(times: Float32Array, time: number): number {
  if (times.length < 2 || time <= times[0]!) return 0
  if (time >= times[times.length - 1]!) return times.length - 1
  let low = 0
  let high = times.length - 1
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (times[middle]! <= time) low = middle
    else high = middle
  }
  return low
}

export class GifHistoryReader {
  private readonly bodyIndex: Map<EntityId, number>

  constructor(readonly snapshot: GifHistorySnapshot) {
    this.bodyIndex = new Map(snapshot.bodyIds.map((entityId, index) => [entityId, index]))
  }

  frameAt(time: number): GifInterpolatedFrame {
    const { times } = this.snapshot
    if (times.length === 0) return { simulationTime: time, bodies: {}, connectors: {} }
    const firstIndex = lowerSampleIndex(times, time)
    const secondIndex = Math.min(firstIndex + 1, times.length - 1)
    const firstTime = times[firstIndex]!
    const secondTime = times[secondIndex]!
    const ratio =
      secondTime > firstTime
        ? Math.min(1, Math.max(0, (time - firstTime) / (secondTime - firstTime)))
        : 0
    const bodies: Record<EntityId, RuntimeBodyState> = {}
    const connectors: Record<EntityId, RuntimeConnectorState> = {}

    for (const [bodyIndex, entityId] of this.snapshot.bodyIds.entries()) {
      const first = this.valueOffset(firstIndex, bodyIndex)
      const second = this.valueOffset(secondIndex, bodyIndex)
      const firstExists = Number.isFinite(this.snapshot.values[first + X])
      const secondExists = Number.isFinite(this.snapshot.values[second + X])
      if (ratio <= 0 && !firstExists) continue
      if (ratio >= 1 && !secondExists) continue
      if (ratio > 0 && ratio < 1 && (!firstExists || !secondExists)) continue
      const effectiveFirst = ratio >= 1 ? second : first
      const effectiveSecond = ratio <= 0 ? first : second
      const interpolate = (channel: number) =>
        this.snapshot.values[effectiveFirst + channel]! +
        (this.snapshot.values[effectiveSecond + channel]! -
          this.snapshot.values[effectiveFirst + channel]!) *
          ratio
      const position = { x: interpolate(X), y: interpolate(Y) }
      const linearVelocity = { x: interpolate(VELOCITY_X), y: interpolate(VELOCITY_Y) }
      const netForce = { x: interpolate(FORCE_X), y: interpolate(FORCE_Y) }
      bodies[entityId] = {
        entityId,
        position,
        angleRad: shortestAngleInterpolation(
          this.snapshot.values[effectiveFirst + ANGLE]!,
          this.snapshot.values[effectiveSecond + ANGLE]!,
          ratio,
        ),
        linearVelocity,
        angularVelocityRad: 0,
        netForce,
        acceleration: { x: 0, y: 0 },
        translationalKineticEnergyJ: 0,
        rotationalKineticEnergyJ: 0,
        kineticEnergyJ: 0,
      }
    }

    const connectorPointCount =
      this.snapshot.connectorPointOffsets[this.snapshot.connectorPointOffsets.length - 1] ?? 0
    const connectorFrameStride = connectorPointCount * 2
    for (const [connectorIndex, entityId] of this.snapshot.connectorIds.entries()) {
      const pointStart = this.snapshot.connectorPointOffsets[connectorIndex]!
      const pointEnd = this.snapshot.connectorPointOffsets[connectorIndex + 1]!
      const points: Vec2[] = []
      let valid = true
      for (let pointIndex = pointStart; pointIndex < pointEnd; pointIndex += 1) {
        const firstOffset = firstIndex * connectorFrameStride + pointIndex * 2
        const secondOffset = secondIndex * connectorFrameStride + pointIndex * 2
        const firstExists = Number.isFinite(this.snapshot.connectorValues[firstOffset])
        const secondExists = Number.isFinite(this.snapshot.connectorValues[secondOffset])
        if (
          (ratio <= 0 && !firstExists) ||
          (ratio >= 1 && !secondExists) ||
          (ratio > 0 && ratio < 1 && (!firstExists || !secondExists))
        ) {
          valid = false
          break
        }
        const effectiveFirst = ratio >= 1 ? secondOffset : firstOffset
        const effectiveSecond = ratio <= 0 ? firstOffset : secondOffset
        points.push({
          x:
            this.snapshot.connectorValues[effectiveFirst]! +
            (this.snapshot.connectorValues[effectiveSecond]! -
              this.snapshot.connectorValues[effectiveFirst]!) *
              ratio,
          y:
            this.snapshot.connectorValues[effectiveFirst + 1]! +
            (this.snapshot.connectorValues[effectiveSecond + 1]! -
              this.snapshot.connectorValues[effectiveFirst + 1]!) *
              ratio,
        })
      }
      if (valid && points.length > 0) connectors[entityId] = { entityId, points }
    }

    return { simulationTime: time, bodies, connectors }
  }

  trajectory(
    entityId: EntityId,
    startTime: number,
    endTime: number,
    pixelsPerMeter: number,
  ): Vec2[] {
    const bodyIndex = this.bodyIndex.get(entityId)
    if (bodyIndex === undefined || endTime < startTime) return []
    const points: Vec2[] = []
    const minimumDistance = 0.75 / Math.max(pixelsPerMeter, MIN_PIXELS_PER_METER)
    const minimumDistanceSquared = minimumDistance * minimumDistance
    const firstIndex = lowerSampleIndex(this.snapshot.times, startTime)

    for (let sampleIndex = firstIndex; sampleIndex < this.snapshot.times.length; sampleIndex += 1) {
      const time = this.snapshot.times[sampleIndex]!
      if (time < startTime) continue
      if (time > endTime) break
      const offset = this.valueOffset(sampleIndex, bodyIndex)
      const point = {
        x: this.snapshot.values[offset + X]!,
        y: this.snapshot.values[offset + Y]!,
      }
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
      const previous = points.at(-1)
      if (
        !previous ||
        (point.x - previous.x) ** 2 + (point.y - previous.y) ** 2 >= minimumDistanceSquared
      ) {
        points.push(point)
      }
    }

    const current = this.frameAt(endTime).bodies[entityId]?.position
    const last = points.at(-1)
    if (current && (!last || current.x !== last.x || current.y !== last.y)) points.push(current)
    return points
  }

  particleTrajectories(
    startTime: number,
    endTime: number,
    pixelsPerMeter: number,
  ): Array<{ t: number; points: Vec2[] }> {
    const ionCount = this.snapshot.particleIonCount
    const result: Array<{ t: number; points: Vec2[] }> = []
    if (ionCount === 0 || endTime < startTime || this.snapshot.particleValues.length === 0) {
      return result
    }
    const stride = ionCount * 2
    const minimumDistance = 0.75 / Math.max(pixelsPerMeter, MIN_PIXELS_PER_METER)
    const minimumDistanceSquared = minimumDistance * minimumDistance
    const firstIndex = lowerSampleIndex(this.snapshot.times, startTime)

    for (let ionIndex = 0; ionIndex < ionCount; ionIndex += 1) {
      const points: Vec2[] = []
      for (
        let sampleIndex = firstIndex;
        sampleIndex < this.snapshot.times.length;
        sampleIndex += 1
      ) {
        const time = this.snapshot.times[sampleIndex]!
        if (time < startTime) continue
        if (time > endTime) break
        const offset = sampleIndex * stride + ionIndex * 2
        const point = {
          x: this.snapshot.particleValues[offset]!,
          y: this.snapshot.particleValues[offset + 1]!,
        }
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
        const previous = points.at(-1)
        if (
          !previous ||
          (point.x - previous.x) ** 2 + (point.y - previous.y) ** 2 >= minimumDistanceSquared
        ) {
          points.push(point)
        }
      }
      if (points.length > 0) {
        result.push({ t: this.snapshot.particleIonTs[ionIndex] ?? 0, points })
      }
    }
    return result
  }

  private valueOffset(sampleIndex: number, bodyIndex: number): number {
    return (sampleIndex * this.snapshot.bodyIds.length + bodyIndex) * BODY_CHANNELS
  }
}

export function gifGuideColor(entityId: EntityId, bodyIds: readonly EntityId[]): string {
  const index = Math.max(0, bodyIds.indexOf(entityId))
  return CHART_COLOR_PALETTE[index % CHART_COLOR_PALETTE.length]!
}

export function fitGifPreviewDisplaySize(
  viewportWidth: number,
  viewportHeight: number,
  outputWidth: number,
  outputHeight: number,
  marginPx = 24,
): ViewportSize {
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    !Number.isFinite(outputWidth) ||
    !Number.isFinite(outputHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    outputWidth <= 0 ||
    outputHeight <= 0
  ) {
    return { width: 1, height: 1 }
  }
  const availableWidth = Math.max(1, viewportWidth - marginPx * 2)
  const availableHeight = Math.max(1, viewportHeight - marginPx * 2)
  const scale = Math.min(availableWidth / outputWidth, availableHeight / outputHeight)
  return {
    width: Math.max(1, Math.floor(outputWidth * scale)),
    height: Math.max(1, Math.floor(outputHeight * scale)),
  }
}

function bodyMargin(body: BodyEntity): number {
  if (body.shape.type === 'circle') return body.shape.radius
  if (body.shape.type === 'box') return Math.hypot(body.shape.width, body.shape.height) / 2
  return Math.max(
    0,
    ...sampleAdaptiveClosedBezierPath(body.shape.nodes).map((point) =>
      Math.hypot(point.x, point.y),
    ),
  )
}

export function fitGifCamera(
  scene: SceneDocument,
  snapshot: GifHistorySnapshot,
  size: ViewportSize,
  startTime: number,
  endTime: number,
  includeVectorMargin: boolean,
): Camera2D {
  const visibleEntities = scene.entities.filter((entity) => entity.visible)
  const booleanScene = resolveBooleanScene(scene)
  const booleanSourceIds = new Set(booleanScene.roots.flatMap((result) => result.sourceEntityIds))
  const bodyById = new Map(
    listRuntimeBodyTargets(scene)
      .filter((body) => body.visible)
      .map((body) => [body.id, body]),
  )
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  const include = (x: number, y: number, margin = 0) => {
    minX = Math.min(minX, x - margin)
    minY = Math.min(minY, y - margin)
    maxX = Math.max(maxX, x + margin)
    maxY = Math.max(maxY, y + margin)
  }

  for (const entity of visibleEntities) {
    if (booleanSourceIds.has(entity.id)) continue
    if (entity.kind === 'body' && snapshot.bodyIds.includes(entity.id)) continue
    const bounds = getEntityBounds(entity)
    if (!bounds) continue
    include(bounds.minX, bounds.minY)
    include(bounds.maxX, bounds.maxY)
  }

  for (const result of booleanScene.roots) {
    const rootItem = scene.rootItems.find(
      (item) => item.kind === 'boolean' && item.resultId === result.resultId,
    )
    if (rootItem?.kind === 'boolean' && !rootItem.visible) continue
    if (!result.valid) {
      for (const sourceId of result.sourceEntityIds) {
        const source = visibleEntities.find((entity) => entity.id === sourceId)
        const bounds = source ? getEntityBounds(source) : null
        if (bounds) {
          include(bounds.minX, bounds.minY)
          include(bounds.maxX, bounds.maxY)
        }
      }
      continue
    }
    if (result.kind === 'body' && snapshot.bodyIds.includes(result.resultId)) continue
    include(result.bounds.min.x, result.bounds.min.y)
    include(result.bounds.max.x, result.bounds.max.y)
  }

  for (let sampleIndex = 0; sampleIndex < snapshot.times.length; sampleIndex += 1) {
    const time = snapshot.times[sampleIndex]!
    if (time < startTime || time > endTime) continue
    for (const [bodyIndex, entityId] of snapshot.bodyIds.entries()) {
      const body = bodyById.get(entityId)
      if (!body) continue
      const offset = (sampleIndex * snapshot.bodyIds.length + bodyIndex) * BODY_CHANNELS
      const x = snapshot.values[offset + X]!
      const y = snapshot.values[offset + Y]!
      if (Number.isFinite(x) && Number.isFinite(y)) include(x, y, bodyMargin(body))
    }
  }

  const particleStride = snapshot.particleIonCount * 2
  if (particleStride > 0 && snapshot.particleValues.length > 0) {
    for (let sampleIndex = 0; sampleIndex < snapshot.times.length; sampleIndex += 1) {
      const time = snapshot.times[sampleIndex]!
      if (time < startTime || time > endTime) continue
      const offset = sampleIndex * particleStride
      for (let ionIndex = 0; ionIndex < snapshot.particleIonCount; ionIndex += 1) {
        const x = snapshot.particleValues[offset + ionIndex * 2]!
        const y = snapshot.particleValues[offset + ionIndex * 2 + 1]!
        if (Number.isFinite(x) && Number.isFinite(y)) include(x, y)
      }
    }
  }

  if (!Number.isFinite(minX)) {
    minX = -5
    minY = -5
    maxX = 5
    maxY = 5
  }
  if (includeVectorMargin) {
    minX -= 3
    minY -= 3
    maxX += 3
    maxY += 3
  }

  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)
  const pixelsPerMeter = Math.min(
    MAX_PIXELS_PER_METER,
    Math.max(
      MIN_PIXELS_PER_METER,
      Math.min(size.width / (spanX * 1.16), size.height / (spanY * 1.16)),
    ),
  )
  return {
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    pixelsPerMeter,
  }
}
