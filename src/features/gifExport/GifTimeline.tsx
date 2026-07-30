import type { CSSProperties } from 'react'

import type { GifSpeedMultiplier } from './gifExportModel'
import { gifSourceFrameStep } from './gifExportModel'
import styles from './GifExportDialog.module.css'

interface GifTimelineProps {
  historyStartTime: number
  historyEndTime: number
  startTime: number
  endTime: number
  previewTime: number
  sampleRate: number
  fps: number
  speedMultiplier: GifSpeedMultiplier
  disabled: boolean
  formatTime: (seconds: number) => string
  onStartTimeChange: (time: number) => void
  onEndTimeChange: (time: number) => void
  onPreviewTimeChange: (time: number) => void
}

function timelinePercent(time: number, startTime: number, endTime: number): number {
  const duration = endTime - startTime
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.min(100, Math.max(0, ((time - startTime) / duration) * 100))
}

export function GifTimeline({
  historyStartTime,
  historyEndTime,
  startTime,
  endTime,
  previewTime,
  sampleRate,
  fps,
  speedMultiplier,
  disabled,
  formatTime,
  onStartTimeChange,
  onEndTimeChange,
  onPreviewTimeChange,
}: GifTimelineProps) {
  const previewStep = gifSourceFrameStep({ fps, speedMultiplier })
  const startPercent = timelinePercent(startTime, historyStartTime, historyEndTime)
  const endPercent = timelinePercent(endTime, historyStartTime, historyEndTime)
  const playheadPercent = timelinePercent(previewTime, historyStartTime, historyEndTime)
  const style = {
    '--trim-start': `${startPercent}%`,
    '--trim-end': `${endPercent}%`,
    '--playhead': `${playheadPercent}%`,
  } as CSSProperties

  return (
    <div className={styles.timeline} role="group" aria-label="GIF 时间轴">
      <div className={styles.trimLabels}>
        <span>入点 {formatTime(startTime)}</span>
        <span>出点 {formatTime(endTime)}</span>
      </div>
      <div
        className={styles.timelineControl}
        style={style}
        data-testid="gif-timeline-control"
        data-trim-start={startPercent.toFixed(3)}
        data-trim-end={endPercent.toFixed(3)}
        data-playhead={playheadPercent.toFixed(3)}
      >
        <div className={styles.timelineTrack} aria-hidden="true">
          <span className={styles.timelineSelection} data-testid="gif-timeline-selection" />
        </div>
        <input
          className={`${styles.timelineRange} ${styles.trimStartRange}`}
          aria-label="GIF 导出开始时间"
          type="range"
          min={historyStartTime}
          max={historyEndTime}
          step={1 / sampleRate}
          value={startTime}
          disabled={disabled}
          onChange={(event) => onStartTimeChange(event.currentTarget.valueAsNumber)}
        />
        <input
          className={`${styles.timelineRange} ${styles.trimEndRange}`}
          aria-label="GIF 导出结束时间"
          type="range"
          min={historyStartTime}
          max={historyEndTime}
          step={1 / sampleRate}
          value={endTime}
          disabled={disabled}
          onChange={(event) => onEndTimeChange(event.currentTarget.valueAsNumber)}
        />
        <input
          className={`${styles.timelineRange} ${styles.timelinePlayhead}`}
          aria-label="GIF 预览时间"
          aria-valuetext={formatTime(previewTime)}
          type="range"
          min={historyStartTime}
          max={historyEndTime}
          step="any"
          value={previewTime}
          disabled={disabled}
          onChange={(event) =>
            onPreviewTimeChange(
              Math.min(endTime, Math.max(startTime, event.currentTarget.valueAsNumber)),
            )
          }
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
              event.preventDefault()
              onPreviewTimeChange(Math.max(startTime, previewTime - previewStep))
            } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
              event.preventDefault()
              onPreviewTimeChange(Math.min(endTime, previewTime + previewStep))
            } else if (event.key === 'Home') {
              event.preventDefault()
              onPreviewTimeChange(startTime)
            } else if (event.key === 'End') {
              event.preventDefault()
              onPreviewTimeChange(endTime)
            }
          }}
        />
      </div>
    </div>
  )
}
