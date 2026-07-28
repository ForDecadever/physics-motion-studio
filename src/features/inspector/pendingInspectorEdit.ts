interface PendingInspectorEdit {
  input: HTMLInputElement
  commit: () => void
  cancel: () => void
}

let pendingEdit: PendingInspectorEdit | null = null

export function registerPendingInspectorEdit(edit: PendingInspectorEdit): void {
  pendingEdit = edit
}

export function commitPendingInspectorEdit(nextTarget?: EventTarget | null): void {
  const pending = pendingEdit
  if (!pending || pending.input === nextTarget) return
  pendingEdit = null
  pending.commit()
  pending.input.blur()
}

export function commitPendingInspectorEditFromBlur(input: HTMLInputElement): void {
  if (pendingEdit?.input !== input) return
  const pending = pendingEdit
  pendingEdit = null
  pending.commit()
}

export function cancelPendingInspectorEdit(input: HTMLInputElement): void {
  if (pendingEdit?.input !== input) return
  const pending = pendingEdit
  pendingEdit = null
  pending.cancel()
  pending.input.blur()
}
