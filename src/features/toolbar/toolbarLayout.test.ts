import { describe, expect, it } from 'vitest'

import { balancedToolbarGrid } from './toolbarLayout'

describe('工具栏均衡分列', () => {
  it.each([
    [10, 41, 1, 10],
    [10, 84, 2, 5],
    [10, 126, 3, 4],
    [14, 84, 2, 7],
  ])('%d 个工具在 %d px 下使用 %d 列、至多 %d 行', (items, width, columns, rows) => {
    expect(balancedToolbarGrid(items, width)).toEqual({ columns, rows })
  })

  it('空工具栏仍返回安全的一列零行布局', () => {
    expect(balancedToolbarGrid(0, 200)).toEqual({ columns: 1, rows: 0 })
  })
})
