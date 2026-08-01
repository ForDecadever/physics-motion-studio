export type RuntimePlatform = 'web' | 'desktop'

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: unknown
}

export function detectRuntimePlatform(
  target: Window | undefined = typeof window === 'undefined' ? undefined : window,
): RuntimePlatform {
  return target && '__TAURI_INTERNALS__' in (target as TauriWindow) ? 'desktop' : 'web'
}

export function isDesktopRuntime(): boolean {
  return detectRuntimePlatform() === 'desktop'
}
