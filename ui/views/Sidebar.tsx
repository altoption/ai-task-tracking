import { useEffect, useMemo, useRef, useState } from 'react'
import { listedProjects, setScope, setTheme, useScope, useTracker, type Scope, type TrackerState } from '../client'
import { appHref, href, inTrackerApp, navigate, useHistoryPosition, type Route } from '../router'
import { TOGGLE_SHORTCUT } from '../sidebarState'
import { ConceptIcon, Icon, type Concept } from '../components/icons'
import { makeThemePick } from './Palette'

const CLOSED = new Set(['completed', 'canceled', 'duplicate'])
/** The app's Settings window (app/Sources/TrackerCore/DeepLink.swift). */
export const SETTINGS_HREF = 'aitt://settings'
/** The user docs, served by the engine (src/server/http.ts serveDocs). */
export const DOCS_HREF = '/docs/'

export function isOpen(state: TrackerState, status: string): boolean {
  const t = state.config?.statuses.find((s) => s.name === status)?.type
  return !t || !CLOSED.has(t)
}

export function scopeLabel(scope: Scope, state: TrackerState): string {
  if (scope.kind === 'all') return 'All workspaces'
  if (scope.kind === 'workspace') return scope.name
  return state.projects.find((p) => p.slug === scope.slug)?.name ?? scope.slug
}

/** "All workspaces" → AW, "web-app" → WA, "Support" → SU. */
export function initials(name: string): string {
  const words = name.split(/[\s\-_/]+/).filter(Boolean)
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2)).toUpperCase()
}

function NavItem({ to, active, icon, label, count, color, collapsed }: { to: string; active: boolean; icon?: Concept; label: string; count?: number; color?: string; collapsed: boolean }) {
  // Collapsed, only the icon shows: the name (and open count) is the tooltip.
  const tip = collapsed ? (count ? `${label} (${count} open)` : label) : undefined
  return (
    <a className={`nav-item${active ? ' active' : ''}`} href={to} aria-current={active ? 'page' : undefined} title={tip} aria-label={collapsed ? label : undefined}>
      {color
        ? (collapsed ? <span className="tile" style={{ background: color }}>{initials(label)}</span> : <span className="swatch" style={{ background: color }} />)
        : <ConceptIcon concept={icon ?? 'issues'} />}
      <span className="label">{label}</span>
      {count !== undefined && count > 0 && <span className="count">{count}</span>}
    </a>
  )
}

function ScopeSwitcher({ collapsed }: { collapsed: boolean }) {
  const state = useTracker()
  const scope = useScope()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // Collapsed, the menu would be clipped by the narrow sidebar: it opens beside the button instead.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const toggleMenu = () => {
    const r = ref.current?.getBoundingClientRect()
    setAt(collapsed && r ? { top: r.top, left: r.right + 6 } : null)
    setOpen(!open)
  }
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false)
    }
    addEventListener('mousedown', close)
    addEventListener('keydown', close)
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', close) }
  }, [open])
  const workspaces = useMemo(() => {
    const names = new Set(Object.keys(state.config?.workspaces ?? {}))
    for (const i of state.issues.values()) if (i.touchedBy?.workspace && i.touchedBy.workspace !== 'external') names.add(i.touchedBy.workspace)
    return [...names].sort()
  }, [state.config, state.issues])
  const projects = useMemo(() => listedProjects(state.projects), [state.projects])
  const pick = (s: Scope) => { setScope(s); setOpen(false) }
  const is = (s: Scope) => JSON.stringify(s) === JSON.stringify(scope)
  return (
    <div className="scope" ref={ref}>
      <button className="scope-button" onClick={toggleMenu} aria-haspopup="menu" aria-expanded={open}
        title={collapsed ? `Workspace: ${scopeLabel(scope, state)}` : undefined}
        aria-label={collapsed ? `Workspace: ${scopeLabel(scope, state)}` : undefined}>
        <span className="avatar">{initials(scopeLabel(scope, state))}</span>
        <span className="label">{scopeLabel(scope, state)}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <div className="menu" role="menu" style={at ? { position: 'fixed', ...at } : undefined}>
          <button role="menuitemradio" aria-checked={is({ kind: 'all' })} onClick={() => pick({ kind: 'all' })}>All workspaces</button>
          {workspaces.length > 0 && <div className="menu-heading">Workspaces</div>}
          {workspaces.map((w) => (
            <button key={w} role="menuitemradio" aria-checked={is({ kind: 'workspace', name: w })} onClick={() => pick({ kind: 'workspace', name: w })}>{w}</button>
          ))}
          {projects.length > 0 && <div className="menu-heading">Projects</div>}
          {projects.map((p) => (
            <button key={p.slug} role="menuitemradio" aria-checked={is({ kind: 'project', slug: p.slug })} onClick={() => pick({ kind: 'project', slug: p.slug })}>{p.name}</button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The theme icon: a menu of every theme, opening upward from the bottom of the sidebar. */
function ThemeMenu() {
  const themes = useTracker().themes
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null)
  const [error, setError] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const open = at !== null
  const close = () => setAt(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const pick = useMemo(() => makeThemePick(setTheme, {
    alive: () => mounted.current, pending: () => {}, done: () => setAt(null), fail: setError,
  }), [])
  const button = () => box.current?.querySelector<HTMLButtonElement>('.icon-button')
  useEffect(() => {
    if (!open) return
    const items = () => [...(box.current?.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]') ?? [])]
    ;(items().find((i) => i.getAttribute('aria-checked') === 'true') ?? items()[0])?.focus()
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) close() }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); button()?.focus() }
      if (e.key === 'Tab') close()
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const all = items()
      const step = e.key === 'ArrowDown' ? 1 : -1
      all[(all.indexOf(document.activeElement as HTMLButtonElement) + step + all.length) % all.length]?.focus()
    }
    addEventListener('mousedown', onDown)
    addEventListener('keydown', onKey, true)
    return () => { removeEventListener('mousedown', onDown); removeEventListener('keydown', onKey, true) }
  }, [open])
  if (!themes) return null
  const current = themes.effective ?? themes.selected
  const toggle = () => {
    const r = button()?.getBoundingClientRect()
    setError('')
    setAt(open || !r ? null : { left: r.left, bottom: innerHeight - r.top + 6 })
  }
  return (
    <div className="theme-menu" ref={box}>
      <button className="icon-button" onClick={toggle} title="Theme" aria-label="Theme" aria-haspopup="menu" aria-expanded={open}>
        <ConceptIcon concept="theme" />
      </button>
      {at && (
        <div className="menu" role="menu" aria-label="Theme" style={{ position: 'fixed', top: 'auto', ...at }}>
          {themes.list.map((t) => (
            <button key={t.id} role="menuitemradio" aria-checked={t.id === current} onClick={() => { setError(''); pick(t.id) }}>{t.name}</button>
          ))}
          {error && <div className="menu-heading" role="alert">{error}</div>}
        </div>
      )}
    </div>
  )
}

const HIDE_OPEN_IN_APP = 'tracker.hideOpenInApp'

/** In a normal browser (not the app's web view): a dismissible link that opens the current page in the app. */
function OpenInApp({ route }: { route: Route }) {
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(HIDE_OPEN_IN_APP) === '1' } catch { return false }
  })
  if (hidden || inTrackerApp(navigator.userAgent)) return null
  const dismiss = () => {
    setHidden(true)
    try { localStorage.setItem(HIDE_OPEN_IN_APP, '1') } catch { /* private mode: hidden for this page only */ }
  }
  return (
    <div className="open-in-app">
      <a href={appHref(route)}>Open in AI Task Tracking</a>
      <button className="icon-button" onClick={dismiss} title="Hide" aria-label="Hide the Open in AI Task Tracking link">×</button>
    </div>
  )
}

/** Back, Forward (browser history, so they match ⌘[ ⌘], the mouse buttons and swipes), Home, and the collapse toggle. */
function NavControls({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { canBack, canForward } = useHistoryPosition()
  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar'
  return (
    <div className="sidebar-nav">
      <button className="icon-button" onClick={onToggle} title={`${toggleLabel} (${TOGGLE_SHORTCUT})`} aria-label={toggleLabel} aria-expanded={!collapsed}>
        <Icon name="sidebar" />
      </button>
      <span className="spacer" />
      <button className="icon-button" onClick={() => history.back()} disabled={!canBack} title="Back (⌘[)" aria-label="Back"><Icon name="back" /></button>
      <button className="icon-button" onClick={() => history.forward()} disabled={!canForward} title="Forward (⌘])" aria-label="Forward"><Icon name="forward" /></button>
      {!collapsed && (
        <button className="icon-button" onClick={() => navigate({ name: 'home' })} title="Home (G then H)" aria-label="Home"><ConceptIcon concept="home" /></button>
      )}
    </div>
  )
}

export function Sidebar({ route, onSearch, collapsed, onToggle }: { route: Route; onSearch: () => void; collapsed: boolean; onToggle: () => void }) {
  const state = useTracker()
  const projects = useMemo(() => listedProjects(state.projects), [state.projects])
  const views = useMemo(
    () => [...state.views].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name)),
    [state.views],
  )
  const openByProject = useMemo(() => {
    const m = new Map<string, number>()
    let all = 0
    for (const i of state.issues.values()) {
      if (!isOpen(state, i.status)) continue
      all++
      m.set(i.project, (m.get(i.project) ?? 0) + 1)
    }
    return { m, all }
  }, [state.issues, state.config])

  return (
    <nav className="sidebar" aria-label="Main">
      <NavControls collapsed={collapsed} onToggle={onToggle} />
      <div className="sidebar-top">
        <ScopeSwitcher collapsed={collapsed} />
        <button className="icon-button" onClick={onSearch} title="Search (⌘K)" aria-label="Search"><ConceptIcon concept="search" /></button>
        <a className="icon-button" href={href({ name: 'new' })} title="New issue (C)" aria-label="New issue"><ConceptIcon concept="newIssue" /></a>
      </div>

      <div className="nav-group">
        <NavItem to={href({ name: 'home' })} active={route.name === 'home'} icon="home" label="Home" collapsed={collapsed} />
        <NavItem to={href({ name: 'issues' })} active={route.name === 'issues'} icon="issues" label="All issues" count={openByProject.all} collapsed={collapsed} />
      </div>

      <div className="nav-section">Projects</div>
      <div className="nav-group">
        {projects.map((p) => (
          <NavItem key={p.slug} to={href({ name: 'project', slug: p.slug })} active={route.name === 'project' && route.slug === p.slug}
            label={p.name} color={p.color ?? 'var(--muted)'} count={openByProject.m.get(p.slug)} collapsed={collapsed} />
        ))}
        {state.ready && projects.length === 0 && !collapsed && <div className="nav-empty">No projects</div>}
      </div>

      <div className="nav-section">Views</div>
      <div className="nav-group">
        {views.map((v) => (
          <NavItem key={v.slug} to={href({ name: 'view', slug: v.slug })} active={route.name === 'view' && route.slug === v.slug}
            icon={v.favorite ? 'favorite' : 'views'} label={v.name} collapsed={collapsed} />
        ))}
        {state.ready && views.length === 0 && !collapsed && <div className="nav-empty">No saved views</div>}
      </div>

      <div className="sidebar-bottom">
        {state.errors.length > 0 && collapsed && (
          <span className="file-errors" title={`${state.errors.length} file${state.errors.length === 1 ? '' : 's'} can't be read (expand the sidebar for details)`}><ConceptIcon concept="warning" /></span>
        )}
        {state.errors.length > 0 && !collapsed && (
          <details className="file-errors">
            <summary><ConceptIcon concept="warning" /> {state.errors.length} file{state.errors.length === 1 ? '' : 's'} can't be read</summary>
            <ul>{state.errors.map((e) => <li key={e.path}><code>{e.path.split('/').slice(-3).join('/')}</code> {e.message}</li>)}</ul>
          </details>
        )}
        {!collapsed && <OpenInApp route={route} />}
        {/* The docs site the engine serves; same origin, so the app's window shows it too. */}
        <NavItem to={DOCS_HREF} active={false} icon="docs" label="Docs" collapsed={collapsed} />
        <div className="sidebar-tools">
          <div className={`conn ${state.connected ? 'on' : 'off'}`} title={state.connected ? 'Live' : 'Reconnecting…'}>
            <span className="conn-dot" /> <span className="label">{state.connected ? 'Live' : state.ready ? 'Reconnecting…' : 'Connecting…'}</span>
          </div>
          <span className="spacer" />
          <ThemeMenu />
          {/* Settings is the app's window: the app's web view opens it directly, a browser hands the link to the app. */}
          <a className="icon-button" href={SETTINGS_HREF} title="Settings" aria-label="Settings"><ConceptIcon concept="settings" /></a>
        </div>
      </div>
    </nav>
  )
}
