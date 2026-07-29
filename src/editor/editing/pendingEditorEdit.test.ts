import { describe, expect, it, vi } from 'vitest'

import {
  cancelPendingEditorEdit,
  commitPendingEditorEdit,
  commitPendingEditorEditFromBlur,
  registerPendingEditorEdit,
} from './pendingEditorEdit'

function fakeInput() {
  return { blur: vi.fn() } as unknown as HTMLInputElement
}

describe('通用编辑草稿协调器', () => {
  it('切换到其他目标前提交当前草稿并让输入框失焦', () => {
    const input = fakeInput()
    const commit = vi.fn()
    registerPendingEditorEdit({ input, commit, cancel: vi.fn() })

    commitPendingEditorEdit({} as EventTarget)

    expect(commit).toHaveBeenCalledOnce()
    expect(input.blur).toHaveBeenCalledOnce()
  })

  it('同一个输入框上的点击不会提前提交', () => {
    const input = fakeInput()
    const commit = vi.fn()
    registerPendingEditorEdit({ input, commit, cancel: vi.fn() })

    commitPendingEditorEdit(input)

    expect(commit).not.toHaveBeenCalled()
  })

  it('失焦提交与 Escape 取消都只执行一次', () => {
    const first = fakeInput()
    const firstCommit = vi.fn()
    registerPendingEditorEdit({ input: first, commit: firstCommit, cancel: vi.fn() })
    commitPendingEditorEditFromBlur(first)
    commitPendingEditorEditFromBlur(first)
    expect(firstCommit).toHaveBeenCalledOnce()

    const second = fakeInput()
    const cancel = vi.fn()
    registerPendingEditorEdit({ input: second, commit: vi.fn(), cancel })
    cancelPendingEditorEdit(second)
    cancelPendingEditorEdit(second)
    expect(cancel).toHaveBeenCalledOnce()
    expect(second.blur).toHaveBeenCalledOnce()
  })
})
