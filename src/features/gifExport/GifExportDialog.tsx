import {
  Download,
  FolderOpen,
  Maximize2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react'

import type { Camera2D } from '../../editor/camera/viewport'
import { isFilePickerCancellation } from '../../persistence/fileSystemAccess'
import { chooseGifFile, saveGif, supportsGifFilePicker } from '../../persistence/gifFile'
import type { GifHistorySnapshot } from '../../physics/worker/messages'
import type { BodyEntity, EntityId, SceneDocument } from '../../scene/model/types'
import { GifEncoderClient } from './gifEncoderClient'
import {
  createDefaultGifExportSettings,
  fitGifCamera,
  gifFrameDelaysMs,
  gifFrameTimes,
  gifGuideColor,
  gifSourceFrameStep,
  GIF_MAX_OUTPUT_BYTES,
  GIF_SPEED_MULTIPLIERS,
  type GifExportSettings,
  type GifSpeedMultiplier,
  normalizeGifTrim,
  validateGifExportLoad,
} from './gifExportModel'
import { GifPreview, type GifPreviewHandle } from './GifPreview'
import { GifTimeline } from './GifTimeline'
import styles from './GifExportDialog.module.css'

interface GifExportDialogProps {
  scene: SceneDocument
  snapshot: GifHistorySnapshot
  initialGridVisible: boolean
  onClose: () => void
  onExported: (fileName: string, method: 'direct' | 'download') => void
}

interface ExportProgress {
  stage: 'palette' | 'encoding' | 'saving'
  ratio: number
  currentFrame: number
  totalFrames: number
  elapsedSeconds: number
  remainingSeconds: number | null
  byteLength: number
}

const RESOLUTIONS = [
  [640, 360],
  [960, 540],
  [1280, 720],
  [1920, 1080],
  [1080, 1080],
] as const
const FPS_PRESETS = [5, 10, 15, 20, 25, 30] as const
const PALETTE_PIXEL_LIMIT = 250_000

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '00:00.000'
  const minutes = Math.floor(Math.max(0, seconds) / 60)
  const remainder = Math.max(0, seconds) - minutes * 60
  return `${minutes.toString().padStart(2, '0')}:${remainder.toFixed(3).padStart(6, '0')}`
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '正在估算…'
  if (seconds < 60) return `约 ${Math.max(1, Math.round(seconds))} 秒`
  const minutes = Math.floor(seconds / 60)
  return `约 ${minutes} 分 ${Math.round(seconds - minutes * 60)} 秒`
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function setMembership(ids: EntityId[], entityId: EntityId, checked: boolean): EntityId[] {
  return checked
    ? ids.includes(entityId)
      ? ids
      : [...ids, entityId]
    : ids.filter((id) => id !== entityId)
}

function createPaletteSample(
  frames: Uint8ClampedArray[],
  width: number,
  height: number,
  pixelLimit = PALETTE_PIXEL_LIMIT,
): Uint8ClampedArray {
  if (frames.length === 0) throw new Error('没有可用于生成调色板的画面。')
  const pixelsPerFrame = width * height
  const perFrameLimit = Math.max(1, Math.floor(pixelLimit / frames.length))
  const stride = Math.max(1, Math.ceil(pixelsPerFrame / perFrameLimit))
  const sampledPixels = Math.min(pixelLimit, frames.length * Math.ceil(pixelsPerFrame / stride))
  const result = new Uint8ClampedArray(sampledPixels * 4)
  let target = 0

  for (const frame of frames) {
    for (
      let sourcePixel = 0;
      sourcePixel < pixelsPerFrame && target < sampledPixels;
      sourcePixel += stride
    ) {
      const source = sourcePixel * 4
      const targetOffset = target * 4
      result[targetOffset] = frame[source]!
      result[targetOffset + 1] = frame[source + 1]!
      result[targetOffset + 2] = frame[source + 2]!
      result[targetOffset + 3] = frame[source + 3]!
      target += 1
    }
  }
  return target === sampledPixels ? result : result.slice(0, target * 4)
}

function joinPaletteSamples(samples: Uint8ClampedArray[]): Uint8ClampedArray {
  const result = new Uint8ClampedArray(samples.reduce((total, sample) => total + sample.length, 0))
  let offset = 0
  for (const sample of samples) {
    result.set(sample, offset)
    offset += sample.length
  }
  return result
}

export function GifExportDialog({
  scene,
  snapshot,
  initialGridVisible,
  onClose,
  onExported,
}: GifExportDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previewRef = useRef<GifPreviewHandle>(null)
  const encoderRef = useRef<GifEncoderClient | null>(null)
  const exportJobRef = useRef(0)
  const initialSettings = useMemo(
    () => createDefaultGifExportSettings(snapshot, initialGridVisible),
    [initialGridVisible, snapshot],
  )
  const [settings, setSettings] = useState(initialSettings)
  const [previewTime, setPreviewTime] = useState(initialSettings.startTime)
  const [camera, setCamera] = useState<Camera2D>(() =>
    fitGifCamera(
      scene,
      snapshot,
      { width: initialSettings.width, height: initialSettings.height },
      initialSettings.startTime,
      initialSettings.endTime,
      false,
    ),
  )
  const [previewPlaying, setPreviewPlaying] = useState(false)
  const [fileHandle, setFileHandle] = useState<FileSystemFileHandle | null>(null)
  const [aspectLocked, setAspectLocked] = useState(true)
  const [customFps, setCustomFps] = useState(false)
  const [fpsDraft, setFpsDraft] = useState(String(initialSettings.fps))
  const [previewReady, setPreviewReady] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const status = snapshot.status
  const load = validateGifExportLoad(settings)
  const fpsDraftValue = Number(fpsDraft)
  const customFpsValid =
    !customFps || (Number.isInteger(fpsDraftValue) && fpsDraftValue >= 1 && fpsDraftValue <= 30)
  const trackedIds = new Set(snapshot.bodyIds)
  const visibleLayerIds = new Set(
    scene.layers.filter((layer) => layer.visible).map((layer) => layer.id),
  )
  const bodies = scene.entities.filter(
    (entity): entity is BodyEntity =>
      entity.kind === 'body' && entity.visible && visibleLayerIds.has(entity.layerId),
  )
  const historyReady = status.kind === 'ready' && status.sampleCount >= 2
  const canExport =
    historyReady && previewReady && customFpsValid && load.valid && progress === null
  const pickerSupported = supportsGifFilePicker()
  const handlePreviewReadyChange = useCallback((ready: boolean) => setPreviewReady(ready), [])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  useEffect(() => {
    if (!previewPlaying || progress) return
    let animationFrame = 0
    let previous = performance.now()
    const tick = (now: number) => {
      const elapsed = (now - previous) / 1000
      previous = now
      setPreviewTime((current) => {
        const next = current + elapsed * settings.speedMultiplier
        return next >= settings.endTime ? settings.startTime : next
      })
      animationFrame = requestAnimationFrame(tick)
    }
    animationFrame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animationFrame)
  }, [previewPlaying, progress, settings.endTime, settings.speedMultiplier, settings.startTime])

  const patchSettings = (patch: Partial<GifExportSettings>) => {
    setSettings((current) => ({ ...current, ...patch }))
  }

  const refit = (nextSettings = settings) => {
    setCamera(
      fitGifCamera(
        scene,
        snapshot,
        { width: nextSettings.width, height: nextSettings.height },
        nextSettings.startTime,
        nextSettings.endTime,
        nextSettings.guides.velocityIds.length > 0 || nextSettings.guides.forceIds.length > 0,
      ),
    )
  }

  const setResolution = (width: number, height: number) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
    const next = { ...settings, width, height }
    setSettings(next)
    refit(next)
  }

  const setDimension = (dimension: 'width' | 'height', value: number) => {
    if (!Number.isFinite(value) || value <= 0) return
    let width = dimension === 'width' ? value : settings.width
    let height = dimension === 'height' ? value : settings.height
    if (aspectLocked) {
      const ratio = settings.width / settings.height
      if (dimension === 'width') height = Math.round(value / ratio)
      else width = Math.round(value * ratio)
    }
    setResolution(width, height)
  }

  const updateTimingSettings = (
    patch: Partial<Pick<GifExportSettings, 'fps' | 'speedMultiplier'>>,
  ) => {
    let next = { ...settings, ...patch }
    if (status.kind === 'ready') {
      next = {
        ...next,
        ...normalizeGifTrim(next, status.startTime, status.endTime),
      }
    }
    setSettings(next)
    setPreviewTime((current) => Math.min(next.endTime, Math.max(next.startTime, current)))
  }

  const updateTrim = (edge: 'start' | 'end', value: number) => {
    const minimumGap = gifSourceFrameStep(settings)
    const historyStartTime = status.kind === 'ready' ? status.startTime : settings.startTime
    const historyEndTime = status.kind === 'ready' ? status.endTime : settings.endTime
    if (historyEndTime - historyStartTime + Number.EPSILON < minimumGap) {
      patchSettings({ startTime: historyStartTime, endTime: historyEndTime })
      setPreviewTime((current) => Math.min(historyEndTime, Math.max(historyStartTime, current)))
      return
    }
    const startTime =
      edge === 'start'
        ? Math.max(historyStartTime, Math.min(value, settings.endTime - minimumGap))
        : settings.startTime
    const endTime =
      edge === 'end'
        ? Math.min(historyEndTime, Math.max(value, settings.startTime + minimumGap))
        : settings.endTime
    patchSettings({ startTime, endTime })
    setPreviewTime((current) => Math.min(endTime, Math.max(startTime, current)))
  }

  const updateGuide = (
    key: keyof GifExportSettings['guides'],
    entityId: EntityId,
    checked: boolean,
  ) => {
    setSettings((current) => ({
      ...current,
      guides: {
        ...current.guides,
        [key]: setMembership(current.guides[key], entityId, checked),
      },
    }))
  }

  const setAllGuides = (key: keyof GifExportSettings['guides'], checked: boolean) => {
    setSettings((current) => ({
      ...current,
      guides: {
        ...current.guides,
        [key]: checked
          ? bodies.filter((body) => trackedIds.has(body.id)).map((body) => body.id)
          : [],
      },
    }))
  }

  const handleChooseLocation = async () => {
    try {
      const handle = await chooseGifFile(settings.fileName)
      if (handle) {
        setFileHandle(handle)
        patchSettings({ fileName: handle.name })
      }
    } catch (error) {
      if (!isFilePickerCancellation(error)) {
        setErrorMessage(error instanceof Error ? error.message : '无法选择 GIF 保存位置。')
      }
    }
  }

  const cancelExport = () => {
    if (!progress) {
      onClose()
      return
    }
    if (!window.confirm('GIF 仍在导出，确定要取消吗？')) return
    exportJobRef.current += 1
    encoderRef.current?.cancel()
    encoderRef.current = null
    onClose()
  }

  const handleExport = async () => {
    if (!canExport || !previewRef.current) return
    setPreviewPlaying(false)
    setErrorMessage(null)
    const jobId = exportJobRef.current + 1
    exportJobRef.current = jobId
    const frameTimes = gifFrameTimes(settings)
    const frameDelays = gifFrameDelaysMs(frameTimes.length, settings.fps)
    const startedAt = performance.now()
    const sampleIndices = Array.from(
      new Set(
        Array.from({ length: Math.min(12, frameTimes.length) }, (_, index) =>
          Math.round(
            (index * (frameTimes.length - 1)) / Math.max(1, Math.min(12, frameTimes.length) - 1),
          ),
        ),
      ),
    )

    try {
      setProgress({
        stage: 'palette',
        ratio: 0,
        currentFrame: 0,
        totalFrames: frameTimes.length,
        elapsedSeconds: 0,
        remainingSeconds: null,
        byteLength: 0,
      })
      const paletteSamples: Uint8ClampedArray[] = []
      const palettePixelsPerFrame = Math.max(
        1,
        Math.floor(PALETTE_PIXEL_LIMIT / sampleIndices.length),
      )
      for (const [sampleNumber, frameIndex] of sampleIndices.entries()) {
        if (exportJobRef.current !== jobId) return
        const pixels = previewRef.current.capture(frameTimes[frameIndex]!)
        paletteSamples.push(
          createPaletteSample([pixels], settings.width, settings.height, palettePixelsPerFrame),
        )
        setProgress((current) =>
          current
            ? { ...current, ratio: ((sampleNumber + 1) / sampleIndices.length) * 0.1 }
            : current,
        )
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
      const paletteSample = joinPaletteSamples(paletteSamples)
      paletteSamples.length = 0

      const encoder = new GifEncoderClient()
      encoderRef.current = encoder
      await encoder.initialize(
        settings.width,
        settings.height,
        settings.transparent,
        paletteSample,
        GIF_MAX_OUTPUT_BYTES,
      )

      let byteLength = 0
      let previousFrameCompletedAt = performance.now()
      const recentFrameDurations: number[] = []
      for (const [frameIndex, time] of frameTimes.entries()) {
        if (exportJobRef.current !== jobId) return
        const pixels = previewRef.current.capture(time)
        byteLength = await encoder.encodeFrame(frameIndex, pixels, frameDelays[frameIndex]!)
        const completed = frameIndex + 1
        const now = performance.now()
        recentFrameDurations.push((now - previousFrameCompletedAt) / 1000)
        previousFrameCompletedAt = now
        if (recentFrameDurations.length > 30) recentFrameDurations.shift()
        const elapsedSeconds = (now - startedAt) / 1000
        const averageFrameDuration =
          recentFrameDurations.reduce((sum, duration) => sum + duration, 0) /
          recentFrameDurations.length
        const remainingSeconds = averageFrameDuration * Math.max(0, frameTimes.length - completed)
        setProgress({
          stage: 'encoding',
          ratio: 0.1 + (completed / frameTimes.length) * 0.85,
          currentFrame: completed,
          totalFrames: frameTimes.length,
          elapsedSeconds,
          remainingSeconds,
          byteLength,
        })
      }

      const bytes = await encoder.finish()
      encoder.destroy()
      encoderRef.current = null
      setProgress((current) =>
        current
          ? {
              ...current,
              stage: 'saving',
              ratio: 0.97,
              byteLength: bytes.byteLength,
              remainingSeconds: null,
            }
          : current,
      )
      const saved = await saveGif(bytes, settings.fileName, fileHandle)
      if (exportJobRef.current !== jobId) return
      setProgress((current) => (current ? { ...current, ratio: 1 } : current))
      onExported(saved.fileName, saved.method)
    } catch (error) {
      if (exportJobRef.current !== jobId) return
      encoderRef.current?.destroy()
      encoderRef.current = null
      setProgress(null)
      setErrorMessage(error instanceof Error ? error.message : 'GIF 导出失败。')
    }
  }

  const handleDialogCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault()
    cancelExport()
  }

  const statusMessage =
    status.kind === 'blocked'
      ? `当前有 ${status.bodyCount} 个动态物体，GIF 最多记录 ${status.maxBodies} 个。请减少物体并重置模拟。`
      : status.sampleCount < 2
        ? '还没有足够的运动记录。请关闭窗口，播放或单步运行模拟后再试。'
        : null

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="gif-export-title"
      onCancel={handleDialogCancel}
      onKeyDownCapture={(event) => event.stopPropagation()}
    >
      <header className={styles.header}>
        <div>
          <h2 id="gif-export-title">导出运动 GIF</h2>
          <p>使用本次模拟已记录的画面生成循环动图</p>
        </div>
        <button
          className={styles.iconButton}
          type="button"
          aria-label="关闭 GIF 导出"
          onClick={cancelExport}
        >
          <X size={18} />
        </button>
      </header>

      <div className={styles.content}>
        <section className={styles.previewSection} aria-label="GIF 预览和时间范围">
          <div className={styles.previewToolbar}>
            <span>
              {settings.width} × {settings.height}
            </span>
            <button type="button" onClick={() => refit()} disabled={Boolean(progress)}>
              <Maximize2 size={14} />
              重新适配
            </button>
          </div>
          <GifPreview
            ref={previewRef}
            scene={scene}
            snapshot={snapshot}
            settings={settings}
            camera={camera}
            previewTime={previewTime}
            onCameraChange={setCamera}
            onReadyChange={handlePreviewReadyChange}
          />
          <div className={styles.transport}>
            <button
              type="button"
              aria-label="上一帧"
              disabled={Boolean(progress)}
              onClick={() =>
                setPreviewTime(
                  Math.max(settings.startTime, previewTime - gifSourceFrameStep(settings)),
                )
              }
            >
              <SkipBack size={16} />
            </button>
            <button
              type="button"
              aria-label={previewPlaying ? '暂停预览' : '播放预览'}
              disabled={Boolean(progress) || !historyReady}
              onClick={() => setPreviewPlaying((playing) => !playing)}
            >
              {previewPlaying ? <Pause size={17} /> : <Play size={17} />}
            </button>
            <button
              type="button"
              aria-label="下一帧"
              disabled={Boolean(progress)}
              onClick={() =>
                setPreviewTime(
                  Math.min(settings.endTime, previewTime + gifSourceFrameStep(settings)),
                )
              }
            >
              <SkipForward size={16} />
            </button>
            <strong>{formatTime(previewTime)}</strong>
          </div>

          {status.kind === 'ready' ? (
            <GifTimeline
              historyStartTime={status.startTime}
              historyEndTime={status.endTime}
              startTime={settings.startTime}
              endTime={settings.endTime}
              previewTime={previewTime}
              sampleRate={snapshot.sampleRate}
              fps={settings.fps}
              speedMultiplier={settings.speedMultiplier}
              disabled={Boolean(progress)}
              formatTime={formatTime}
              onStartTimeChange={(time) => updateTrim('start', time)}
              onEndTimeChange={(time) => updateTrim('end', time)}
              onPreviewTimeChange={setPreviewTime}
            />
          ) : null}
        </section>

        <aside className={styles.settings} aria-label="GIF 导出设置">
          <fieldset disabled={Boolean(progress)}>
            <legend>文件</legend>
            <label>
              文件名
              <input
                type="text"
                value={settings.fileName}
                maxLength={120}
                onChange={(event) => {
                  setFileHandle(null)
                  patchSettings({ fileName: event.currentTarget.value })
                }}
              />
            </label>
            <button type="button" onClick={() => void handleChooseLocation()}>
              <FolderOpen size={15} />
              {pickerSupported ? '选择位置…' : '使用浏览器下载目录'}
            </button>
            <small>
              {fileHandle
                ? `已选择：${fileHandle.name}`
                : pickerSupported
                  ? '尚未选择时，导出会使用浏览器下载。'
                  : '当前浏览器不支持直接选择路径，将保存到默认下载目录。'}
            </small>
          </fieldset>

          <fieldset disabled={Boolean(progress)}>
            <legend>画质</legend>
            <label>
              常用分辨率
              <select
                value={
                  RESOLUTIONS.find(
                    ([width, height]) => width === settings.width && height === settings.height,
                  )
                    ? `${settings.width}x${settings.height}`
                    : 'custom'
                }
                onChange={(event) => {
                  if (event.currentTarget.value === 'custom') return
                  const [width, height] = event.currentTarget.value.split('x').map(Number)
                  setResolution(width!, height!)
                }}
              >
                {RESOLUTIONS.map(([width, height]) => (
                  <option key={`${width}x${height}`} value={`${width}x${height}`}>
                    {width} × {height}
                  </option>
                ))}
                <option value="custom">自定义</option>
              </select>
            </label>
            <div className={styles.inlineFields}>
              <label>
                宽度
                <input
                  type="number"
                  min={64}
                  max={1920}
                  value={settings.width}
                  onChange={(event) => setDimension('width', event.currentTarget.valueAsNumber)}
                />
              </label>
              <label>
                高度
                <input
                  type="number"
                  min={64}
                  max={1920}
                  value={settings.height}
                  onChange={(event) => setDimension('height', event.currentTarget.valueAsNumber)}
                />
              </label>
            </div>
            <label className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={aspectLocked}
                onChange={(event) => setAspectLocked(event.currentTarget.checked)}
              />
              锁定宽高比例
            </label>
            <label>
              每秒帧数
              <select
                aria-label="GIF 每秒帧数"
                value={customFps ? 'custom' : String(settings.fps)}
                onChange={(event) => {
                  if (event.currentTarget.value === 'custom') {
                    setCustomFps(true)
                    setFpsDraft(String(settings.fps))
                    return
                  }
                  const fps = Number(event.currentTarget.value)
                  setCustomFps(false)
                  setFpsDraft(String(fps))
                  updateTimingSettings({ fps })
                }}
              >
                {FPS_PRESETS.map((fps) => (
                  <option key={fps} value={fps}>
                    {fps} FPS
                  </option>
                ))}
                <option value="custom">自定义…</option>
              </select>
            </label>
            {customFps ? (
              <label>
                自定义 FPS
                <input
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  value={fpsDraft}
                  aria-invalid={!customFpsValid}
                  onChange={(event) => {
                    const draft = event.currentTarget.value
                    setFpsDraft(draft)
                    const value = Number(draft)
                    if (Number.isInteger(value) && value >= 1 && value <= 30) {
                      updateTimingSettings({ fps: value })
                    }
                  }}
                  onBlur={() => {
                    if (!customFpsValid) setFpsDraft(String(settings.fps))
                  }}
                />
              </label>
            ) : null}
            <label>
              成片倍速
              <select
                aria-label="GIF 成片倍速"
                value={settings.speedMultiplier}
                onChange={(event) =>
                  updateTimingSettings({
                    speedMultiplier: Number(event.currentTarget.value) as GifSpeedMultiplier,
                  })
                }
              >
                {GIF_SPEED_MULTIPLIERS.map((speed) => (
                  <option key={speed} value={speed}>
                    {speed}×
                  </option>
                ))}
              </select>
            </label>
            {customFps && !customFpsValid ? (
              <small className={styles.fieldError}>自定义帧率必须是 1～30 的整数。</small>
            ) : null}
          </fieldset>

          <fieldset disabled={Boolean(progress)}>
            <legend>背景</legend>
            <label className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={settings.gridVisible}
                onChange={(event) => patchSettings({ gridVisible: event.currentTarget.checked })}
              />
              显示网格
            </label>
            <label className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={settings.transparent}
                onChange={(event) => patchSettings({ transparent: event.currentTarget.checked })}
              />
              透明背景
            </label>
            <label className={styles.colorLabel}>
              <input
                type="color"
                aria-label="背景颜色"
                value={settings.backgroundColor}
                disabled={settings.transparent}
                onChange={(event) => patchSettings({ backgroundColor: event.currentTarget.value })}
              />
              <span>背景颜色</span>
            </label>
            {settings.transparent ? (
              <small>GIF 透明度只有“完全透明”和“完全不透明”两种状态。</small>
            ) : null}
          </fieldset>

          <fieldset
            className={styles.guideFieldset}
            data-testid="gif-guide-fieldset"
            disabled={Boolean(progress)}
          >
            <legend>运动标注</legend>
            <div className={styles.guideBulk}>
              {(
                [
                  ['trajectoryIds', '轨迹'],
                  ['velocityIds', '速度'],
                  ['forceIds', '合力'],
                ] as const
              ).map(([key, label]) => (
                <span key={key}>
                  {label}
                  <button type="button" onClick={() => setAllGuides(key, true)}>
                    全选
                  </button>
                  <button type="button" onClick={() => setAllGuides(key, false)}>
                    清除
                  </button>
                </span>
              ))}
            </div>
            <div className={styles.guideTable} data-testid="gif-guide-table">
              <div className={styles.guideHeader}>
                <span>物体</span>
                <span>轨迹</span>
                <span>速度</span>
                <span>合力</span>
              </div>
              {bodies.map((body) => {
                const available = trackedIds.has(body.id)
                return (
                  <div className={styles.guideRow} key={body.id}>
                    <span title={body.name}>
                      <i style={{ background: gifGuideColor(body.id, snapshot.bodyIds) }} />
                      {body.name}
                    </span>
                    {(['trajectoryIds', 'velocityIds', 'forceIds'] as const).map((key) => (
                      <label className={styles.guideToggle} key={key}>
                        <input
                          type="checkbox"
                          aria-label={`${body.name} ${key === 'trajectoryIds' ? '轨迹' : key === 'velocityIds' ? '速度' : '合力'}`}
                          disabled={!available}
                          checked={settings.guides[key].includes(body.id)}
                          onChange={(event) =>
                            updateGuide(key, body.id, event.currentTarget.checked)
                          }
                        />
                      </label>
                    ))}
                  </div>
                )
              })}
            </div>
            <small>轨迹从导出入点开始累计；速度和合力箭头使用固定比例。</small>
          </fieldset>

          <section className={styles.summary} aria-label="导出负载">
            <span>模拟区间</span>
            <strong>{load.sourceDurationSeconds.toFixed(2)} 秒</strong>
            <span>GIF 时长</span>
            <strong>{load.outputDurationSeconds.toFixed(2)} 秒</strong>
            <span>帧数</span>
            <strong>{load.frameCount.toLocaleString()}</strong>
            <span>像素帧</span>
            <strong>{load.pixelFrames.toLocaleString()}</strong>
          </section>

          {statusMessage ? <div className={styles.warning}>{statusMessage}</div> : null}
          {load.message ? <div className={styles.warning}>{load.message}</div> : null}
          {errorMessage ? <div className={styles.error}>{errorMessage}</div> : null}

          {progress ? (
            <section className={styles.progress} aria-live="polite">
              <div>
                <strong>
                  {progress.stage === 'palette'
                    ? '正在准备颜色'
                    : progress.stage === 'encoding'
                      ? '正在渲染并编码'
                      : '正在写入文件'}
                </strong>
                <span>{Math.round(progress.ratio * 100)}%</span>
              </div>
              <progress max={1} value={progress.ratio} />
              <p>
                {progress.currentFrame} / {progress.totalFrames} 帧 ·{' '}
                {formatDuration(progress.remainingSeconds)} · {formatBytes(progress.byteLength)}
              </p>
            </section>
          ) : null}
        </aside>
      </div>

      <footer className={styles.footer}>
        <button type="button" onClick={cancelExport}>
          {progress ? '取消导出' : '取消'}
        </button>
        <button
          className={styles.primaryButton}
          type="button"
          disabled={!canExport}
          onClick={() => void handleExport()}
        >
          <Download size={16} />
          导出 GIF
        </button>
      </footer>
    </dialog>
  )
}

export function GifExportPreparingDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className={styles.preparingDialog}
      aria-label="正在读取 GIF 历史记录"
      onCancel={(event) => event.preventDefault()}
    >
      <strong>正在冻结模拟记录…</strong>
      <p>很快就好，导出设置和预览正在准备。</p>
      <progress />
    </dialog>
  )
}
