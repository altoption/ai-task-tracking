/**
 * A list/board page: `#/issues` (ad-hoc), `#/view/:slug` (saved view) and — Task 14 — `#/project/:slug`
 * (pass `base={{ project: [slug] }}` and `locked={['project']}`).
 *
 * The state (filter + display) lives in the route's query: no query = the saved view (or `defaults`); any edit
 * writes the query (no history entry), so it survives reloads. A saved view then offers "Reset" / "Save changes";
 * an ad-hoc page offers "Save view" (writes views/<slug>.yml through the owner-only `save_view` tool).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Filter, IssueSummary, Project } from '../../src/model'
import { callTool, inScope, isHiddenProject, projectName, setProjectHidden, setScope, useScope, useTracker, type ViewDef } from '../client'
import { ConceptIcon } from '../components/icons'
import { Popover } from '../components/Popover'
import { navigate, replaceRoute, type Route } from '../router'
import { applyView, DEFAULT_DISPLAY, dropPatch, sameView, timeInStatus, viewFromQuery, viewToQuery, type ViewState } from '../viewModel'
import { BoardView } from './BoardView'
import { DisplayMenu } from './DisplayMenu'
import { FilterBar, FilterMenu } from './FilterMenu'
import type { CellCtx } from './IssueCells'
import { ListView } from './ListView'

export function savedState(v: ViewDef): ViewState {
  return { filter: v.filter ?? {}, display: { ...DEFAULT_DISPLAY, ...v.display } }
}

export function ViewScreen({ title, icon, saved, defaults, base, locked, query, routeFor, issues, extraProjects }: {
  title: string
  icon?: ReactNode
  saved?: ViewDef
  /** State when there is no saved view. */
  defaults?: ViewState
  /** Fixed criteria (always applied, not shown as chips when `locked`). */
  base?: Filter
  locked?: (keyof Filter)[]
  query?: string
  routeFor: (query?: string) => Route
  /**
   * The issues to show instead of the live store's (a hidden project's page, read by its link), with the projects
   * they need names for. The workspace switcher doesn't apply to them.
   */
  issues?: IssueSummary[]
  extraProjects?: Project[]
}) {
  const state = useTracker()
  const scope = useScope()
  const baseState = useMemo(() => (saved ? savedState(saved) : defaults ?? { filter: {}, display: DEFAULT_DISPLAY }), [saved, defaults])
  const current = useMemo(() => viewFromQuery(query ?? '', baseState), [query, baseState])
  const changed = !!query && !sameView(current, baseState)
  const update = (next: ViewState) => replaceRoute(routeFor(viewToQuery(next, baseState) || undefined))

  const pool = useMemo(() => {
    if (issues) return issues
    const out: IssueSummary[] = []
    for (const i of state.issues.values()) if (inScope(i, scope, state.config)) out.push(i)
    return out
  }, [issues, state.issues, scope, state.config])
  const byId = useMemo(() => {
    if (!issues) return state.issues
    const m = new Map(state.issues)
    for (const i of issues) m.set(i.id, i)
    return m
  }, [issues, state.issues])
  const projects = useMemo(() => (extraProjects?.length ? [...state.projects, ...extraProjects] : state.projects), [state.projects, extraProjects])
  const ctx = useMemo(() => ({ statuses: state.config?.statuses ?? [], labels: state.labels, projects, byId }), [state.config, state.labels, projects, byId])
  const effective = useMemo(() => ({ filter: { ...current.filter, ...base }, display: current.display }), [current, base])
  const result = useMemo(() => applyView(pool, effective, ctx), [pool, effective, ctx])
  // When the switcher hides everything, say so (otherwise an empty view looks broken).
  const outOfScope = useMemo(() => (result.total || scope.kind === 'all' || issues ? 0 : applyView([...state.issues.values()], effective, ctx).total), [result.total, scope, issues, state.issues, effective, ctx])
  // A filter naming a hidden project (a saved view, an old link): say so, rather than look empty or incomplete.
  const hiddenInFilter = useMemo(() => (issues ? [] : (effective.filter.project ?? []).filter((p) => isHiddenProject(state, p))), [issues, effective, state])
  const cells: CellCtx = useMemo(() => ({
    labels: new Map(state.labels.map((l) => [l.name, l])),
    projects: new Map(projects.map((p) => [p.slug, p])),
    since: timeInStatus(state.feed),
    now: Date.now(),
  }), [state.labels, projects, state.feed])

  const [toast, setToast] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const fail = (e: unknown) => {
    setToast(e instanceof Error ? e.message : String(e))
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 6000)
  }
  useEffect(() => () => clearTimeout(toastTimer.current), [])

  // After "Save changes", drop the query once the saved view (refetched via the snapshot) matches it.
  const [justSaved, setJustSaved] = useState(false)
  useEffect(() => {
    if (justSaved && query && sameView(current, baseState)) { setJustSaved(false); replaceRoute(routeFor(undefined)) }
  }, [justSaved, query, current, baseState])

  const saveChanges = async () => {
    if (!saved) return
    try {
      await callTool('save_view', { slug: saved.slug, name: saved.name, filter: current.filter, display: current.display })
      setJustSaved(true)
    } catch (e) { fail(e) }
  }
  const saveAs = async (name: string) => {
    const v = await callTool<{ slug: string }>('save_view', { name, filter: { ...current.filter, ...base }, display: current.display })
    navigate({ name: 'view', slug: v.slug })
  }
  const toggleFavorite = () => {
    if (!saved) return
    callTool('save_view', { slug: saved.slug, name: saved.name, filter: saved.filter ?? {}, display: savedState(saved).display, favorite: !saved.favorite }).catch(fail)
  }
  const onDrop = (issue: IssueSummary, group: string, row: string, fromRow: string) => {
    const patch = dropPatch(issue, current.display, group, row, fromRow)
    if (patch) callTool('save_issue', patch).catch(fail)
  }

  return (
    <section className="view-screen">
      <header className="page-head view-head">
        <div className="crumbs">
          {icon ?? <ConceptIcon concept={saved ? 'views' : 'issues'} />}
          <h1>{title}</h1>
          {saved && (
            <button className={`icon-button star${saved.favorite ? ' on' : ''}`} aria-pressed={!!saved.favorite} aria-label={saved.favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={toggleFavorite}>
              <ConceptIcon concept="favorite" />
            </button>
          )}
          <span className="muted count-label">{result.total} {result.total === 1 ? 'issue' : 'issues'}</span>
        </div>
        <div className="view-tools">
          {changed && saved && <button className="ghost-btn" onClick={() => replaceRoute(routeFor(undefined))}>Reset</button>}
          {changed && saved && <button className="primary small-btn" onClick={() => void saveChanges()}>Save changes</button>}
          {!saved && <SaveAs onSave={saveAs} />}
          <FilterMenu filter={current.filter} locked={locked} state={state} onChange={(filter) => update({ ...current, filter })} />
          <DisplayMenu display={current.display} labels={state.labels} changed={!sameView({ filter: {}, display: current.display }, { filter: {}, display: baseState.display })}
            onChange={(display) => update({ ...current, display })} onReset={() => update({ ...current, display: baseState.display })} />
        </div>
      </header>
      <FilterBar filter={current.filter} locked={locked} state={state} onChange={(filter) => update({ ...current, filter })} />
      {state.ready && hiddenInFilter.length > 0 && <HiddenFilterNote slugs={hiddenInFilter} names={hiddenInFilter.map((p) => projectName(state, p))} />}
      {!state.ready ? <div className="view-empty muted">Loading…</div>
        : outOfScope > 0 ? <div className="view-empty muted">No issues here in the current workspace — {outOfScope} {outOfScope === 1 ? 'issue matches' : 'issues match'} in all workspaces. <button className="ghost-btn inline" onClick={() => setScope({ kind: 'all' })}>Show all workspaces</button></div>
        : current.display.layout === 'board'
          ? <BoardView groups={result.groups} hidden={result.hidden} display={current.display} ctx={ctx} config={state.config} cells={cells} onDrop={onDrop} />
          : <ListView groups={result.groups} display={current.display} byId={byId} config={state.config} cells={cells} />}
      {toast && <div className="toast" role="alert">{toast}<button className="icon-button" aria-label="Dismiss" onClick={() => setToast('')}>×</button></div>}
    </section>
  )
}

/** "Filtered to a hidden project": their issues aren't listed here; Unhide brings them back live. */
function HiddenFilterNote({ slugs, names }: { slugs: string[]; names: string[] }) {
  const [error, setError] = useState('')
  const many = slugs.length > 1
  return (
    <div className="hidden-note view-hidden-note" role="note">
      <span>Filtered to {many ? 'hidden projects' : 'a hidden project'} ({names.join(', ')}): {many ? 'their' : 'its'} issues aren't listed.</span>
      <button type="button" className="ghost-btn inline" onClick={() => {
        setError('')
        Promise.all(slugs.map((s) => setProjectHidden(s, false))).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      }}>Unhide</button>
      {error && <span className="form-error" role="alert">{error}</span>}
    </div>
  )
}

function SaveAs({ onSave }: { onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Popover label="Save view" button={<span className="save-label">Save view</span>} className="save-view">
      {(close) => (
        <form className="fm-form" onSubmit={async (e) => {
          e.preventDefault()
          if (!name.trim()) return
          setBusy(true); setError('')
          try { await onSave(name.trim()); close() } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
        }}>
          <input autoFocus className="date-input" placeholder="View name" value={name} onChange={(e) => setName(e.target.value)} aria-label="View name" />
          {error && <div className="form-error">{error}</div>}
          <div className="row-buttons"><button className="primary" disabled={busy || !name.trim()}>Save</button></div>
        </form>
      )}
    </Popover>
  )
}
