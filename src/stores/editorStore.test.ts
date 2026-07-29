import { afterEach, describe, expect, it } from 'vitest'

import { useEditorStore } from './editorStore'

afterEach(() => {
  const editor = useEditorStore.getState()
  if (!editor.blockSnapEnabled) editor.toggleBlockSnap()
})

describe('物块吸附编辑器状态', () => {
  it('默认开启并可独立切换', () => {
    const editor = useEditorStore.getState()
    expect(editor.blockSnapEnabled).toBe(true)
    expect(editor.wallSnapEnabled).toBe(false)

    editor.toggleBlockSnap()
    expect(useEditorStore.getState().blockSnapEnabled).toBe(false)
    expect(useEditorStore.getState().wallSnapEnabled).toBe(false)
  })

  it('文档重置保留当前会话中的开关状态', () => {
    const editor = useEditorStore.getState()
    editor.toggleBlockSnap()
    editor.resetForDocument()

    expect(useEditorStore.getState().blockSnapEnabled).toBe(false)
  })
})
