import { beforeEach, describe, expect, it } from 'vitest'

import { useSimulationStore } from './simulationStore'

beforeEach(() => {
  useSimulationStore.getState().beginInitialization()
})

describe('simulationStore bounded runtime state', () => {
  it('deduplicates a repeated warning by its stable message', () => {
    const store = useSimulationStore.getState()
    store.addWarning('设备暂时无法跟上模拟速度。')
    store.addWarning('另一个警告。')
    store.addWarning('设备暂时无法跟上模拟速度。')

    expect(useSimulationStore.getState().warnings).toEqual([
      '另一个警告。',
      '设备暂时无法跟上模拟速度。',
    ])
  })

  it('keeps at most five distinct recent warnings', () => {
    const store = useSimulationStore.getState()
    for (let index = 0; index < 8; index += 1) store.addWarning(`警告 ${index}`)
    expect(useSimulationStore.getState().warnings).toEqual([
      '警告 3',
      '警告 4',
      '警告 5',
      '警告 6',
      '警告 7',
    ])
  })
})
