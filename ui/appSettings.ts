/**
 * The app's own settings (UserDefaults, Launch at login), reached through a message handler only the app's web view has
 * (SettingsBridgeHandler in the app). A browser has no handler, and the Settings page says "Only in the app".
 *
 * - `get`, `set` and `backupNow` answer with a promise; `get` and `set` answer with the current state.
 * - The app also dispatches `aitt:app-settings` when a setting changes elsewhere (the fallback window, the menu).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

export const BRIDGE_NAME = 'aittSettings'
export const CHANGE_EVENT = 'aitt:app-settings'

export interface AppBridge { postMessage(message: unknown): Promise<unknown> }
export interface PresetOption { id: string; label: string }
export interface AppSettingsState {
  /** Every setting by key: a switch's boolean, or the chosen shortcut's id. */
  values: Record<string, boolean | string>
  presets: Record<string, PresetOption[]>
  /** Why a setting isn't what was asked for (Launch at login, refused by macOS), by key. */
  problems?: Record<string, string>
}

/** The bridge, when this page runs in the app's web view. */
export function appBridge(win: unknown): AppBridge | null {
  const handlers = (win as { webkit?: { messageHandlers?: Record<string, AppBridge | undefined> } } | undefined)?.webkit?.messageHandlers
  const b = handlers?.[BRIDGE_NAME]
  return b && typeof b.postMessage === 'function' ? b : null
}

/** Pure: a reply or event from the app as a state, or null when it isn't one. */
export function parseAppSettings(x: unknown): AppSettingsState | null {
  const o = x as Partial<AppSettingsState> | null
  if (!o || typeof o !== 'object' || !o.values || typeof o.values !== 'object' || !o.presets || typeof o.presets !== 'object') return null
  return { values: o.values, presets: o.presets, problems: o.problems && typeof o.problems === 'object' ? o.problems : {} }
}

/** Tell the app the engine's theme changed, so its window's colors follow now rather than at its next poll. */
export function notifyAppOfTheme(bridge: AppBridge | null): void {
  bridge?.postMessage({ op: 'themeChanged' }).catch(() => { /* the next poll catches up */ })
}

export interface AppSettingsApi {
  state: AppSettingsState | null
  error: string
  set(key: string, value: boolean | string): void
  /** Resolves with the line to show ("Backed up just now"). */
  backupNow(): Promise<string>
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The app's settings, kept current; null in a browser. */
export function useAppSettings(): AppSettingsApi | null {
  const bridge = useMemo(() => appBridge(globalThis), [])
  const [state, setState] = useState<AppSettingsState | null>(null)
  const [error, setError] = useState('')
  const take = useCallback((x: unknown) => { const s = parseAppSettings(x); if (s) setState(s) }, [])
  useEffect(() => {
    if (!bridge) return
    const get = () => { bridge.postMessage({ op: 'get' }).then(take, (e: unknown) => setError(message(e))) }
    const onChange = (e: Event) => take((e as CustomEvent).detail)
    get()
    addEventListener(CHANGE_EVENT, onChange)
    addEventListener('focus', get) // Launch at login can change in System Settings
    return () => { removeEventListener(CHANGE_EVENT, onChange); removeEventListener('focus', get) }
  }, [bridge, take])
  return useMemo(() => bridge && {
    state, error,
    set(key, value) {
      setError('')
      bridge.postMessage({ op: 'set', key, value }).then(take, (e: unknown) => setError(message(e)))
    },
    async backupNow() {
      const r = await bridge.postMessage({ op: 'backupNow' }) as { text?: unknown } | null
      return typeof r?.text === 'string' ? r.text : 'Backup finished'
    },
  }, [bridge, state, error, take])
}
