export interface PendingEditorEdit {
  input: HTMLInputElement
  commit: () => void
  cancel: () => void
}

let pendingEdit: PendingEditorEdit | null = null

export function registerPendingEditorEdit(edit: PendingEditorEdit): void {
  pendingEdit = edit
}

export function commitPendingEditorEdit(nextTarget?: EventTarget | null): void {
  const pending = pendingEdit
  if (!pending || pending.input === nextTarget) return
  pendingEdit = null
  pending.commit()
  pending.input.blur()
}

export function commitPendingEditorEditFromBlur(input: HTMLInputElement): void {
  if (pendingEdit?.input !== input) return
  const pending = pendingEdit
  pendingEdit = null
  pending.commit()
}

export function cancelPendingEditorEdit(input: HTMLInputElement): void {
  if (pendingEdit?.input !== input) return
  const pending = pendingEdit
  pendingEdit = null
  pending.cancel()
  pending.input.blur()
}
