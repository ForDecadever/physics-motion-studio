import { Pause, Play, RotateCcw, SkipForward } from 'lucide-react'

import { physicsClient } from '../../physics/client/physicsClient'
import { useSimulationStore } from '../../stores/simulationStore'
import styles from './BottomDock.module.css'

export function PlaybackBar() {
  const status = useSimulationStore((state) => state.status)
  const simulationTime = useSimulationStore((state) => state.simulationTime)
  const playbackRate = useSimulationStore((state) => state.playbackRate)
  const errorMessage = useSimulationStore((state) => state.errorMessage)
  const warning = useSimulationStore((state) => state.warnings.at(-1))
  const unavailable = status === 'initializing' || status === 'error'
  const statusText =
    status === 'initializing'
      ? '正在准备物理世界'
      : status === 'playing'
        ? '模拟运行中'
        : status === 'paused'
          ? '模拟已暂停'
          : status === 'error'
            ? '物理内核错误'
            : '编辑模式'

  return (
    <section className={styles.playbackBar} aria-label="模拟播放控制" data-status={status}>
      <div className={styles.transport}>
        <button
          type="button"
          disabled={unavailable || status === 'playing'}
          aria-label="播放"
          title="播放"
          onClick={() => physicsClient.play()}
        >
          <Play size={15} fill="currentColor" />
        </button>
        <button
          type="button"
          disabled={status !== 'playing'}
          aria-label="暂停"
          onClick={() => physicsClient.pause()}
        >
          <Pause size={15} />
        </button>
        <button
          type="button"
          disabled={unavailable || status === 'playing'}
          aria-label="单步"
          title="前进一个固定物理步"
          onClick={() => physicsClient.step()}
        >
          <SkipForward size={15} />
        </button>
        <button
          type="button"
          disabled={unavailable || simulationTime === 0}
          aria-label="重置"
          onClick={() => physicsClient.reset()}
        >
          <RotateCcw size={15} />
        </button>
      </div>

      <div className={styles.timeReadout}>
        <span className={styles.timeLabel}>模拟时间</span>
        <output>{simulationTime.toFixed(3)} s</output>
      </div>

      <div className={styles.playbackStatus}>
        <span className={styles.readyDot} />
        <span title={errorMessage ?? warning}>{statusText}</span>
      </div>

      <label className={styles.rateControl}>
        <span>倍速</span>
        <select
          value={playbackRate}
          disabled={unavailable}
          aria-label="播放倍速"
          onChange={(event) => physicsClient.setPlaybackRate(Number(event.target.value))}
        >
          <option value="0.25">0.25×</option>
          <option value="0.5">0.5×</option>
          <option value="1">1×</option>
          <option value="2">2×</option>
          <option value="4">4×</option>
        </select>
      </label>
    </section>
  )
}
