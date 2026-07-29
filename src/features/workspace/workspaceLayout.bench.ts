import { bench, describe } from 'vitest'

import {
  floatWorkspacePanel,
  moveFloatingPanel,
  repairWorkspaceLayout,
  resizeFloatingPanel,
} from './workspaceLayout'

describe('工作区布局交互性能', () => {
  bench('浮窗移动、八方向缩放与边界修复', () => {
    const bounds = { width: 1440, height: 781 }
    const floating = floatWorkspacePanel(
      repairWorkspaceLayout(undefined, bounds),
      'layers',
      { x: 420, y: 180, width: 320, height: 300 },
      bounds,
    )
    const moved = moveFloatingPanel(floating, 'layers', { x: 12, y: -8 }, bounds)
    const resized = resizeFloatingPanel(moved, 'layers', 'southEast', { x: 16, y: 10 }, bounds)
    repairWorkspaceLayout(resized, bounds)
  })
})
