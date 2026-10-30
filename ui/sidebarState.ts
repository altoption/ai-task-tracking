/** The sidebar's collapsed state: a saved preference, and a narrow window that collapses it on its own. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

export const SIDEBAR_KEY = 'aitt.sidebarCollapsed'
/** Below this width the sidebar collapses on its own (the app window's minimum is 640). */
export const NARROW_QUERY = '(max-width: 760px)'
/** The app's View ▸ Toggle Sidebar menu item dispatches this on the page. */
export const TOGGLE_EVENT = 'aitt:toggle-sidebar'
export const TOGGLE_SHORTCUT = '⌘\\'

type Store = Pick<Storage, 'getItem' | 'setItem'>
const local = (): Store | null => { try { return localStorage } catch { return null } }

export function loadCollapsed(store: Store | null = local()): boolean {
  try { return store?.getItem(SIDEBAR_KEY) === '1' } catch { return false }
}

export function saveCollapsed(collapsed: boolean, store: Store | null = local()): void {
  try { store?.setItem(SIDEBAR_KEY, collapsed ? '1' : '0') } catch { /* private mode: this page only */ }
}

/** ⌘\ (Ctrl+\ off the Mac). */
export function isSidebarShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === '\\'
}

/**
 * `saved` is the preference (kept across launches). In a narrow window the sidebar is collapsed whatever the
 * preference; toggling there opens it for now (`narrowOpen`) without changing the preference.
 */
export interface SidebarState { saved: boolean; narrowOpen: boolean }
export const isCollapsed = (s: SidebarState, narrow: boolean): boolean => (narrow ? !s.narrowOpen : s.saved)
export const toggled = (s: SidebarState, narrow: boolean): SidebarState =>
  narrow ? { ...s, narrowOpen: !s.narrowOpen } : { ...s, saved: !s.saved }

function useMedia(query: string): boolean {
  const subscribe = useCallback((f: () => void) => {
    const m = matchMedia(query)
    m.addEventListener('change', f)
    return () => m.removeEventListener('change', f)
  }, [query])
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches)
}

export function useSidebar(): { collapsed: boolean; toggle: () => void } {
  const narrow = useMedia(NARROW_QUERY)
  const [state, setState] = useState<SidebarState>(() => ({ saved: loadCollapsed(), narrowOpen: false }))
  const narrowRef = useRef(narrow)
  narrowRef.current = narrow
  useEffect(() => setState((s) => (s.narrowOpen ? { ...s, narrowOpen: false } : s)), [narrow])
  useEffect(() => saveCollapsed(state.saved), [state.saved])
  const toggle = useCallback(() => setState((s) => toggled(s, narrowRef.current)), [])
  return { collapsed: isCollapsed(state, narrow), toggle }
}
