import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { IssueSummary } from '../../src/model'
import { listedProjects, searchIssues, setTheme, useTracker, type ThemesInfo } from '../client'
import { navigate } from '../router'
import { Icon, StatusIcon } from '../components/icons'

interface Item { key: string; group: string; label: string; hint?: string; icon: ReactNode; run: () => void }
export type PaletteMode = 'root' | 'views'

/** Pure: local issue matches for the palette — exact id first, then id prefix, then title words. */
export function matchIssues(issues: Iterable<IssueSummary>, q: string, limit = 8): IssueSummary[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  const words = needle.split(/\s+/)
  const scored: { i: IssueSummary; s: number }[] = []
  for (const i of issues) {
    const id = i.id.toLowerCase()
    const title = i.title.toLowerCase()
    const s = id === needle ? 0 : id.startsWith(needle) ? 1 : words.every((w) => title.includes(w)) ? 2 : -1
    if (s >= 0) scored.push({ i, s })
  }
  return scored.sort((a, b) => a.s - b.s || b.i.updated.localeCompare(a.i.updated)).slice(0, limit).map((x) => x.i)
}

/** Pure: "Theme: <name>" commands matching the query (all of them for "theme"); the current one is marked. */
export function themeCommands(themes: ThemesInfo | null, q: string): { id: string; label: string; current: boolean }[] {
  const needle = q.trim().toLowerCase()
  if (!themes || !needle) return []
  return themes.list
    .map((t) => ({ id: t.id, label: `Theme: ${t.name}`, current: t.id === (themes.effective ?? themes.selected) }))
    .filter((t) => needle.split(/\s+/).every((w) => t.label.toLowerCase().includes(w)))
}

/**
 * Pure: the palette's groups in order. A query that starts with "theme" puts the Theme commands first, so
 * "theme paper" ⏎ switches even when an issue mentions those words; otherwise issues lead and themes follow them.
 */
export function orderGroups<T>(q: string, g: { issues: T[]; themes: T[]; actions: T[]; views: T[]; projects: T[] }): T[] {
  const rest = [...g.actions, ...g.views, ...g.projects]
  return q.trim().toLowerCase().startsWith('theme') ? [...g.themes, ...g.issues, ...rest] : [...g.issues, ...g.themes, ...rest]
}

export interface ThemePickUi {
  /** False once the bar that asked is gone (closed, or closed and reopened): its reply is then dropped. */
  alive(): boolean
  pending(id: string | null): void
  done(): void
  fail(message: string): void
}

/** One theme request at a time (a second pick while one is out is ignored); a reply after the bar is gone does nothing. */
export function makeThemePick(send: (id: string) => Promise<void>, ui: ThemePickUi): (id: string) => boolean {
  let busy = false
  return (id) => {
    if (busy) return false
    busy = true
    ui.pending(id)
    const settle = (fn: () => void) => { busy = false; if (ui.alive()) { ui.pending(null); fn() } }
    send(id).then(() => settle(() => ui.done()), (e: unknown) => settle(() => ui.fail(e instanceof Error ? e.message : String(e))))
    return true
  }
}

export function Palette({ mode: initialMode, onClose }: { mode: PaletteMode; onClose: () => void }) {
  const state = useTracker()
  const [q, setQ] = useState('')
  const [mode, setMode] = useState<PaletteMode>(initialMode)
  const [active, setActive] = useState(0)
  const [remote, setRemote] = useState<IssueSummary[]>([])
  const [error, setError] = useState('')
  const [pendingTheme, setPendingTheme] = useState<string | null>(null)
  const mounted = useRef(true)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const pickTheme = useMemo(() => makeThemePick(setTheme, {
    alive: () => mounted.current, pending: setPendingTheme, done: () => close.current(), fail: setError,
  }), [])
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => { input.current?.focus() }, [mode])

  // Full-text search on the engine (titles, descriptions, comments), debounced; stale replies are dropped.
  useEffect(() => {
    if (mode !== 'root' || !q.trim()) { setRemote([]); return }
    let live = true
    const t = setTimeout(() => { searchIssues(q.trim()).then((r) => { if (live) setRemote(r.slice(0, 10)) }, () => {}) }, 120)
    return () => { live = false; clearTimeout(t) }
  }, [q, mode])

  const go = (fn: () => void) => () => { onClose(); fn() }
  const items = useMemo<Item[]>(() => {
    const needle = q.trim().toLowerCase()
    const has = (s: string) => !needle || s.toLowerCase().includes(needle)
    const views = state.views.filter((v) => has(v.name)).map<Item>((v) => ({
      key: `view:${v.slug}`, group: 'Views', label: v.name, icon: <Icon name={v.favorite ? 'star' : 'view'} />, run: go(() => navigate({ name: 'view', slug: v.slug })),
    }))
    if (mode === 'views') return views

    const out: Item[] = []
    const seen = new Set<string>()
    for (const i of [...matchIssues(state.issues.values(), q), ...remote]) {
      if (seen.has(i.id) || out.length >= 10) continue
      seen.add(i.id)
      out.push({ key: `issue:${i.id}`, group: 'Issues', label: i.title, hint: i.id, icon: <StatusIcon status={i.status} config={state.config} />, run: go(() => navigate({ name: 'issue', id: i.id })) })
    }
    const actions: Item[] = [
      { key: 'a:new', group: 'Actions', label: 'New issue', hint: 'C', icon: <Icon name="new" />, run: go(() => navigate({ name: 'new' })) },
      { key: 'a:home', group: 'Actions', label: 'Go to Home', hint: 'G H', icon: <Icon name="home" />, run: go(() => navigate({ name: 'home' })) },
      { key: 'a:issues', group: 'Actions', label: 'Go to All issues', hint: 'G I', icon: <Icon name="issues" />, run: go(() => navigate({ name: 'issues' })) },
      { key: 'a:views', group: 'Actions', label: 'Go to view…', icon: <Icon name="view" />, run: () => { setMode('views'); setQ(''); setActive(0) } },
    ].filter((a) => has(a.label))
    if (needle) actions.unshift({ key: 'a:search', group: 'Actions', label: `Search for “${q.trim()}”`, icon: <Icon name="search" />, run: go(() => navigate({ name: 'search', q: q.trim() })) })
    const projects = needle
      ? listedProjects(state.projects).filter((p) => has(p.name)).map<Item>((p) => ({
          key: `project:${p.slug}`, group: 'Projects', label: p.name, icon: <span className="swatch" style={{ background: p.color ?? 'var(--muted)' }} />,
          run: go(() => navigate({ name: 'project', slug: p.slug })),
        }))
      : []
    const themes = themeCommands(state.themes, q).map<Item>((t) => ({
      key: `theme:${t.id}`, group: 'Themes', label: t.label, hint: pendingTheme === t.id ? 'Switching…' : t.current ? 'Current' : undefined, icon: <Icon name="display" />,
      // Stays open until the engine answers, so a refusal shows here.
      run: () => { setError(''); pickTheme(t.id) },
    }))
    return orderGroups(q, { issues: out, themes, actions, views: needle ? views : [], projects })
  }, [q, mode, remote, state.issues, state.views, state.projects, state.config, state.themes, pendingTheme, pickTheme])

  const current = Math.min(active, Math.max(0, items.length - 1))
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [current])

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); setActive((current + 1) % Math.max(1, items.length)) }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); setActive((current - 1 + items.length) % Math.max(1, items.length)) }
    else if (e.key === 'Enter') { e.preventDefault(); items[current]?.run() }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'Backspace' && !q && mode !== 'root') { e.preventDefault(); setMode('root') }
  }

  let lastGroup = ''
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          {mode === 'views' && <span className="chip">Views</span>}
          <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setActive(0); setError('') }} onKeyDown={onKey}
            placeholder={mode === 'views' ? 'Go to view…' : 'Type a command or search issues…'}
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={items[current]?.key} />
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {error && <div className="form-error palette-error" role="alert">{error}</div>}
          {items.length === 0 && <div className="palette-empty">No results</div>}
          {items.map((it, k) => {
            const heading = it.group !== lastGroup ? <div className="palette-group" key={`g:${it.group}`}>{it.group}</div> : null
            lastGroup = it.group
            return [
              heading,
              <div key={it.key} id={it.key} role="option" aria-selected={k === current} className="palette-item"
                onMouseMove={() => { if (k !== current) setActive(k) }} onMouseDown={(e) => { e.preventDefault(); it.run() }}>
                {it.icon}
                {it.group === 'Issues' && <span className="id">{it.hint}</span>}
                <span className="label">{it.label}</span>
                {it.group !== 'Issues' && it.hint && <kbd>{it.hint}</kbd>}
              </div>,
            ]
          })}
        </div>
      </div>
    </div>
  )
}
