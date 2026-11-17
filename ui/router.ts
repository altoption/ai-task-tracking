/** Hash router: `#/`, `#/new` (`?parent=Q-269` prefills the parent, `?project=` and `?status=` those fields), `#/issue/:id`, `#/issues`, `#/view/:slug`, `#/project/:slug` and `#/project/:slug/view/:view` (a project's own view; those four keep view state in `?…`), `#/search?q=`, `#/settings`, `#/settings/:tab`. */
import { useSyncExternalStore } from 'react'
import { isSettingsTab, type SettingsTab } from './settingsModel'

export type Route =
  | { name: 'home' }
  | { name: 'new'; parent?: string; project?: string; status?: string }
  | { name: 'issue'; id: string }
  | { name: 'issues'; query?: string }
  | { name: 'view'; slug: string; query?: string }
  | { name: 'project'; slug: string; view?: string; query?: string }
  | { name: 'search'; q: string }
  /** No tab: General. */
  | { name: 'settings'; tab?: SettingsTab }
  | { name: 'notFound'; path: string }

const dec = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }
/** List pages keep their view state (display options, filters) in the query. */
const withQuery = (r: Extract<Route, { query?: string }>, query: string): Route => (query ? { ...r, query } : r)
const q = (query?: string) => (query ? `?${query}` : '')

/** Pure: parse a location hash (with or without the leading `#`). */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/'
  const [path = '/', query = ''] = raw.split('?', 2) as [string, string?]
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return { name: 'home' }
  const [head, arg, ...rest] = parts
  if (rest.length === 0) {
    if (head === 'new' && arg === undefined) {
      const p = new URLSearchParams(query)
      const parent = p.get('parent')?.trim().toUpperCase(), project = p.get('project')?.trim(), status = p.get('status')?.trim()
      return { name: 'new', ...(parent ? { parent } : {}), ...(project ? { project } : {}), ...(status ? { status } : {}) }
    }
    if (head === 'issues' && arg === undefined) return withQuery({ name: 'issues' }, query)
    if (head === 'search' && arg === undefined) return { name: 'search', q: new URLSearchParams(query).get('q') ?? '' }
    if (head === 'settings' && arg === undefined) return { name: 'settings' }
    if (arg !== undefined) {
      if (head === 'settings' && isSettingsTab(arg)) return { name: 'settings', tab: arg }
      if (head === 'issue') return { name: 'issue', id: dec(arg).toUpperCase() }
      if (head === 'view') return withQuery({ name: 'view', slug: dec(arg) }, query)
      if (head === 'project') return withQuery({ name: 'project', slug: dec(arg) }, query)
    }
  }
  if (head === 'project' && arg !== undefined && rest.length === 2 && rest[0] === 'view') return withQuery({ name: 'project', slug: dec(arg), view: dec(rest[1]!) }, query)
  return { name: 'notFound', path }
}

/** Pure: the hash for a route. */
export function href(r: Route): string {
  switch (r.name) {
    case 'home': return '#/'
    case 'new': {
      const p = new URLSearchParams()
      if (r.parent) p.set('parent', r.parent)
      if (r.project) p.set('project', r.project)
      if (r.status) p.set('status', r.status)
      return `#/new${q(p.toString())}`
    }
    case 'issue': return `#/issue/${encodeURIComponent(r.id)}`
    case 'issues': return `#/issues${q(r.query)}`
    case 'view': return `#/view/${encodeURIComponent(r.slug)}${q(r.query)}`
    case 'project': return `#/project/${encodeURIComponent(r.slug)}${r.view ? `/view/${encodeURIComponent(r.view)}` : ''}${q(r.query)}`
    case 'search': return `#/search?q=${encodeURIComponent(r.q)}`
    case 'settings': return r.tab ? `#/settings/${r.tab}` : '#/settings'
    case 'notFound': return `#${r.path}`
  }
}

export function navigate(r: Route | string): void {
  location.hash = typeof r === 'string' ? r : href(r)
}

/** Change the hash without a history entry (view-option tweaks shouldn't fill the back button). */
export function replaceRoute(r: Route): void {
  const h = href(r)
  if (location.hash === h) return
  history.replaceState(history.state, '', h)
  dispatchEvent(new HashChangeEvent('hashchange'))
}

const subscribe = (f: () => void) => {
  addEventListener('hashchange', f)
  return () => removeEventListener('hashchange', f)
}
/** The current location hash (re-renders on change). */
export function useHash(): string {
  return useSyncExternalStore(subscribe, () => location.hash)
}

/** Pure: the `aitt://` link that opens this route in the app (issue, project, new, settings; anything else opens Home). */
export function appHref(r: Route): string {
  switch (r.name) {
    case 'issue': return `aitt://issue/${encodeURIComponent(r.id)}`
    case 'project': return `aitt://project/${encodeURIComponent(r.slug)}`
    case 'new': return 'aitt://new'
    case 'settings': return 'aitt://settings'
    default: return 'aitt://home'
  }
}

/** The app's web view appends `TrackerApp/<n>` to its user agent. */
export const inTrackerApp = (userAgent: string): boolean => /\bTrackerApp\/\d/.test(userAgent)

// ---------- history position (the Back and Forward buttons) ----------
// History can't say whether there's anywhere to go, so each entry carries its index in this tab's session
// (`history.state.aittIndex`). A new entry (a link, navigate(), the address bar, the app's window) gets the previous
// index + 1; Back, Forward, ⌘[ ⌘], the mouse buttons and swipes restore an entry's own index. replaceRoute keeps the
// state, so the index survives view-option tweaks. The furthest index lives in sessionStorage so a reload keeps
// Forward. A page load without an index (a fresh tab, a link from elsewhere) starts at 0: Back stays off rather than
// leaving the app.

export interface HistoryPosition { index: number; max: number }
export const HISTORY_MAX_KEY = 'aitt.historyMax'

let position: HistoryPosition = { index: 0, max: 0 }
let tracking = false
const positionListeners = new Set<() => void>()

function stateIndex(): number | null {
  const s = history.state as { aittIndex?: unknown } | null
  return s && typeof s === 'object' && typeof s.aittIndex === 'number' ? s.aittIndex : null
}

function storedMax(): number {
  try { return Number(sessionStorage.getItem(HISTORY_MAX_KEY)) || 0 } catch { return 0 }
}

function saveMax(max: number): void {
  try { sessionStorage.setItem(HISTORY_MAX_KEY, String(max)) } catch { /* private mode: Forward resets on reload */ }
}

function setPosition(next: HistoryPosition): void {
  if (next.index === position.index && next.max === position.max) return
  position = next
  saveMax(next.max)
  for (const f of positionListeners) f()
}

/** Reads (or assigns) the current entry's index. Runs on every hashchange/popstate; idempotent. */
function syncPosition(): void {
  const i = stateIndex()
  if (i !== null) return setPosition({ index: i, max: Math.max(i, position.max) })
  // A new entry: everything after it was dropped from history.
  const index = tracking ? position.index + 1 : 0
  const state = history.state && typeof history.state === 'object' ? history.state : {}
  history.replaceState({ ...state, aittIndex: index }, '')
  setPosition({ index, max: index })
}

/** Starts tracking this tab's position in history (once, at startup). */
export function trackHistory(): void {
  if (tracking) return
  const i = stateIndex()
  if (i !== null) {
    position = { index: i, max: Math.max(i, storedMax()) } // a reload: keep Forward
  } else {
    // A fresh page: index 0, and any max an earlier page left in this tab no longer applies.
    syncPosition()
    saveMax(position.max)
  }
  tracking = true
  addEventListener('popstate', syncPosition)
  addEventListener('hashchange', syncPosition)
}

/** Test hook: stop tracking and forget the position. */
export function untrackHistory(): void {
  removeEventListener('popstate', syncPosition)
  removeEventListener('hashchange', syncPosition)
  tracking = false
  position = { index: 0, max: 0 }
}

export const historyPosition = (): HistoryPosition => position

const subscribePosition = (f: () => void) => {
  positionListeners.add(f)
  return () => { positionListeners.delete(f) }
}
/** Whether Back and Forward have somewhere to go in this tab (re-renders on change). */
export function useHistoryPosition(): { canBack: boolean; canForward: boolean } {
  const p = useSyncExternalStore(subscribePosition, historyPosition)
  return { canBack: p.index > 0, canForward: p.index < p.max }
}
