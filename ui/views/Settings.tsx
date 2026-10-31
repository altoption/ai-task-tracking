/**
 * Settings as a page (`#/settings`, `#/settings/<tab>`): tabs, grouped rows, a plain status on General. What each row
 * does depends on where its value is stored: see ui/settingsModel.ts.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ThemeOut } from '../../src/engine/themes'
import { useAppSettings, type AppSettingsApi } from '../appSettings'
import { getHealth, listedProjects, NO_PROJECT, setProjectHidden, setTheme, useTracker, type TrackerState } from '../client'
import { replaceRoute } from '../router'
import {
  agentStatus, APP_GROUPS, backupStatus, CHECKING, engineStatus, nextSettingsTab, SETTINGS_TABS, type AppRow, type HealthInfo, type SettingsTab, type StatusLine,
} from '../settingsModel'
import { makeThemePick } from './Palette'
import { DOCS_HREF, isOpen } from './Sidebar'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const tabId = (t: SettingsTab) => `settings-tab-${t}`
const HEALTH_POLL_MS = 5000

export interface ProjectRow { slug: string; name: string; color?: string; hidden: boolean; desc: string }

/** Pure: every project by name, visible or hidden, then No project (the Projects tab's rows, with what can be said of each). */
export function settingsProjects(state: TrackerState): ProjectRow[] {
  const hidden = new Set(state.config?.hiddenProjects ?? [])
  const open = new Map<string, number>()
  for (const i of state.issues.values()) if (isOpen(state, i.status)) open.set(i.project, (open.get(i.project) ?? 0) + 1)
  const rows: ProjectRow[] = listedProjects(state.projects).map((p) => {
    const n = open.get(p.slug) ?? 0
    return { slug: p.slug, name: p.name, color: p.color ?? 'var(--muted)', hidden: hidden.has(p.slug), desc: n ? `${n} open` : 'No open issues' }
  })
  // The engine leaves a hidden project's issues out of the snapshot, so there's no count to show for it.
  for (const p of state.hidden.projects) {
    if (p.slug !== NO_PROJECT && !rows.some((r) => r.slug === p.slug)) rows.push({ slug: p.slug, name: p.name, hidden: true, desc: 'Hidden' })
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return [...rows, { slug: NO_PROJECT, name: 'No project', hidden: hidden.has(NO_PROJECT), desc: 'Issues that have no project.' }]
}

/** Pure: what the Projects tab's count says. */
export const hiddenCount = (rows: readonly ProjectRow[]): number => rows.filter((r) => r.hidden).length

function Switch({ label, on, disabled, onFlip }: { label: string; on: boolean; disabled?: boolean; onFlip: () => void }) {
  return (
    <button type="button" className={`switch${on ? ' on' : ''}`} role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onFlip}><span /></button>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-group" aria-label={title}>
      <div className="settings-group-head">{title}</div>
      {children}
    </section>
  )
}

function Row({ name, desc, swatch, problem, children }: { name: string; desc?: ReactNode; swatch?: string; problem?: string; children?: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-name">{swatch && <span className="swatch" style={{ background: swatch }} />}{name}</div>
        {desc && <div className="settings-row-desc">{desc}</div>}
        {problem && <div className="settings-row-problem" role="alert">{problem}</div>}
      </div>
      {children}
    </div>
  )
}

function BackupNow({ app, action }: { app: AppSettingsApi; action: string }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const run = () => {
    setBusy(true); setResult('')
    app.backupNow().then(setResult, (e: unknown) => setResult(errText(e))).finally(() => setBusy(false))
  }
  return (
    <>
      {result && <span className="settings-only" role="status">{result}</span>}
      <button type="button" className="settings-btn" disabled={busy} onClick={run}>{busy ? 'Backing up…' : action}</button>
    </>
  )
}

/** One app-only row: its control in the app, "Only in the app" in a browser. */
function AppSettingRow({ row, app }: { row: AppRow; app: AppSettingsApi | null }) {
  if (row.kind === 'note') return <Row name={row.label} desc={row.desc} />
  if (!app) return <Row name={row.label} desc={row.desc}><span className="settings-only">Only in the app</span></Row>
  if (row.kind === 'backupNow') return <Row name={row.label} desc={row.desc}><BackupNow app={app} action={row.action} /></Row>
  const value = app.state?.values[row.key]
  if (row.kind === 'select') {
    const options = app.state?.presets[row.key] ?? []
    return (
      <Row name={row.label} desc={row.desc}>
        <select className="settings-select" aria-label={row.label} value={typeof value === 'string' ? value : ''} onChange={(e) => app.set(row.key, e.target.value)}>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </Row>
    )
  }
  const allowed = !row.needs || app.state?.values[row.needs] === true
  return (
    <Row name={row.label} desc={row.desc} problem={app.state?.problems?.[row.key]}>
      <Switch label={row.label} on={value === true} disabled={!app.state || !allowed} onFlip={() => app.set(row.key, value !== true)} />
    </Row>
  )
}

function StatusItem({ name, line }: { name: string; line: StatusLine }) {
  return (
    <div>
      <b>{name}</b>
      <span className="settings-status-line"><i className={`settings-dot ${line.tone}`} />{line.text}</span>
    </div>
  )
}

/** The General tab's strip. Polls /api/health while it shows; the feed and the connection are already live. */
function StatusStrip({ state }: { state: TrackerState }) {
  const [health, setHealth] = useState<HealthInfo | null | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let live = true
    const poll = () => {
      getHealth().then((h) => { if (live) { setHealth(h); setNow(Date.now()) } }, () => { if (live) setHealth(null) })
    }
    poll()
    const t = setInterval(poll, HEALTH_POLL_MS)
    return () => { live = false; clearInterval(t) }
  }, [])
  return (
    <div className="settings-status">
      {/* Until the first snapshot the live connection hasn't had its chance yet. */}
      <StatusItem name="Engine" line={engineStatus(health, state.connected || !state.ready)} />
      <StatusItem name="Backup" line={backupStatus(health, now)} />
      <StatusItem name="Agents" line={state.ready ? agentStatus(state.feed, now) : CHECKING} />
    </div>
  )
}

/** The little picture on a theme card; Match macOS shows Dark and Light side by side. */
export function themePreview(t: ThemeOut, list: readonly ThemeOut[]): { background: string; accent: string; text: string } | null {
  if (t.base !== 'system') return { background: t.colors.panel ?? '', accent: t.colors.accent ?? '', text: t.colors.text ?? '' }
  const colors = (id: string) => { const x = list.find((y) => y.id === id); return x && x.base !== 'system' ? x.colors : undefined }
  const dark = colors('dark'), light = colors('light')
  if (!dark || !light) return null
  return { background: `linear-gradient(90deg, ${dark.panel} 50%, ${light.panel} 50%)`, accent: dark.accent ?? '', text: dark.muted ?? '' }
}

function Appearance({ state }: { state: TrackerState }) {
  const themes = state.themes
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const pick = useMemo(() => makeThemePick(setTheme, {
    alive: () => mounted.current, pending: setPending, done: () => {}, fail: setError,
  }), [])
  if (!themes) return <p className="muted">Loading…</p>
  const current = themes.effective ?? themes.selected
  const custom = themes.list.filter((t) => !t.builtin).length
  const customText = custom === 1 ? '1 custom theme from the themes folder is in this list. ' : custom ? `${custom} custom themes from the themes folder are in this list. ` : ''
  return (
    <Group title="Theme">
      <div className="settings-themes">
        {themes.list.map((t) => {
          const p = themePreview(t, themes.list)
          return (
            <button key={t.id} type="button" className={`settings-theme${t.id === current ? ' on' : ''}`} aria-pressed={t.id === current} aria-busy={pending === t.id}
              onClick={() => { setError(''); pick(t.id) }}>
              <span className="settings-theme-preview" style={p ? { background: p.background } : undefined}>
                <i style={p ? { background: p.accent } : undefined} /><u style={p ? { background: p.text } : undefined} />
              </span>
              <span className="settings-theme-label">{t.name}{t.id === current && <em>Current</em>}</span>
            </button>
          )
        })}
      </div>
      {error && <div className="form-error settings-error" role="alert">{error}</div>}
      <Row name="Theme files" desc={`${customText}Make your own with a YAML file in the data folder.`}>
        <a className="settings-btn" href={`${DOCS_HREF}guides/themes/`}>Themes guide</a>
      </Row>
    </Group>
  )
}

function Projects({ rows }: { rows: ProjectRow[] }) {
  // What was just asked for, until the engine's snapshot agrees (or the request fails): the switch moves at once.
  const [wanted, setWanted] = useState<Record<string, boolean>>({})
  const [error, setError] = useState('')
  useEffect(() => {
    setWanted((w) => {
      const left = Object.entries(w).filter(([slug, on]) => rows.find((r) => r.slug === slug)?.hidden !== on)
      return left.length === Object.keys(w).length ? w : Object.fromEntries(left)
    })
  }, [rows])
  const flip = (slug: string, hidden: boolean) => {
    setError('')
    setWanted((w) => ({ ...w, [slug]: hidden }))
    setProjectHidden(slug, hidden).catch((e: unknown) => {
      setError(errText(e))
      setWanted(({ [slug]: _dropped, ...rest }) => rest)
    })
  }
  return (
    <>
      <Group title="Hidden projects">
        {rows.map((r) => {
          const hidden = wanted[r.slug] ?? r.hidden
          return (
            <Row key={r.slug} name={r.name} desc={r.desc} swatch={r.color}>
              <Switch label={`Hide ${r.name}`} on={hidden} onFlip={() => flip(r.slug, !hidden)} />
            </Row>
          )
        })}
        {error && <div className="form-error settings-error" role="alert">{error}</div>}
      </Group>
      <Group title="About hiding">
        <Row name="Direct links still open a hidden project" desc="Hidden projects leave the sidebar, lists, Home, search, the board and the menu bar. Agents still see every project." />
      </Group>
    </>
  )
}

export function SettingsView({ tab, state, app, onTab }: { tab: SettingsTab; state: TrackerState; app: AppSettingsApi | null; onTab: (t: SettingsTab) => void }) {
  const rows = useMemo(() => settingsProjects(state), [state.projects, state.hidden, state.config, state.issues])
  const count = hiddenCount(rows)
  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return // ⌘← and friends stay the browser's
    const to = nextSettingsTab(tab, e.key)
    if (!to) return
    e.preventDefault()
    onTab(to)
    document.getElementById(tabId(to))?.focus()
  }
  return (
    <section className="page settings">
      <h1>Settings</h1>
      <div className="settings-tabs" role="tablist" aria-label="Settings sections" onKeyDown={onKey}>
        {SETTINGS_TABS.map((t) => (
          <button key={t.id} type="button" id={tabId(t.id)} role="tab" className={`settings-tab${t.id === tab ? ' on' : ''}`} aria-selected={t.id === tab}
            aria-controls="settings-panel" tabIndex={t.id === tab ? 0 : -1} onClick={() => onTab(t.id)}>
            {t.name}
            {t.id === 'projects' && count > 0 && <span className="settings-tab-count" aria-label={`${count} hidden`}>{count}</span>}
          </button>
        ))}
      </div>
      <div id="settings-panel" role="tabpanel" aria-labelledby={tabId(tab)} tabIndex={0}>
        {tab === 'general' && <StatusStrip state={state} />}
        {tab === 'appearance' && <Appearance state={state} />}
        {tab === 'projects' && <Projects rows={rows} />}
        {APP_GROUPS[tab].map((g) => (
          <Group key={g.title} title={g.title}>
            {g.rows.map((r) => <AppSettingRow key={r.label} row={r} app={app} />)}
          </Group>
        ))}
        {app?.error && <div className="form-error settings-error" role="alert">{app.error}</div>}
      </div>
    </section>
  )
}

export function SettingsPage({ tab }: { tab?: SettingsTab }) {
  const state = useTracker()
  const app = useAppSettings()
  return <SettingsView tab={tab ?? 'general'} state={state} app={app} onTab={(t) => replaceRoute({ name: 'settings', tab: t })} />
}
