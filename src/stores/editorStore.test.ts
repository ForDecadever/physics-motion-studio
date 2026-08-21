import { afterEach, describe, expect, it } from 'vitest'

import { useEditorStore } from './editorStore'

afterEach(() => {
  const editor = useEditorStore.getState()
  if (!editor.blockSnapEnabled) editor.toggleBlockSnap()
  if (!editor.wallSnapEnabled) editor.toggleWallSnap()
  editor.setBodyToolPreset('ball')
  editor.setBlockToolShape('rectangle')
  editor.setTriangleAngleDeg(30)
})

describe('物块吸附编辑器状态', () => {
  it('默认开启并可独立切换', () => {
    const editor = useEditorStore.getState()
    expect(editor.blockSnapEnabled).toBe(true)
    expect(editor.wallSnapEnabled).toBe(true)

    editor.toggleBlockSnap()
    expect(useEditorStore.getState().blockSnapEnabled).toBe(false)
    expect(useEditorStore.getState().wallSnapEnabled).toBe(true)
  })

  it('文档重置保留当前会话中的开关状态', () => {
    const editor = useEditorStore.getState()
    editor.toggleBlockSnap()
    editor.resetForDocument()

    expect(useEditorStore.getState().blockSnapEnabled).toBe(false)
  })

  it('物块形状默认使用矩形并限制三角形角度', () => {
    const editor = useEditorStore.getState()
    expect(editor.blockToolShape).toBe('rectangle')
    expect(editor.triangleAngleDeg).toBe(30)

    editor.setBlockToolShape('triangle')
    editor.setTriangleAngleDeg(2)
    expect(useEditorStore.getState()).toMatchObject({
      blockToolShape: 'triangle',
      triangleAngleDeg: 5,
    })

    editor.setTriangleAngleDeg(90)
    expect(useEditorStore.getState().triangleAngleDeg).toBe(85)
  })
})
