/**
 * `#/project/:slug`: header (name, status), description, milestones with progress, documents, then the project's
 * issues (the shared list/board screen with the project locked in). Markdown edits carry the text they started from
 * (`baseDescription` / `baseContent`) so a newer save by an agent is refused instead of overwritten.
 *
 * A hidden project (`hiddenProjects` in config.yml) isn't in the live store; its link still opens it, read from
 * `/api/projects/:slug`, with a "This project is hidden" line and Unhide. "Hide project" in the header hides it and
 * keeps you on the page.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { IssueSummary, Project } from '../../src/model'
import { callTool, getProject, inScope, isHiddenProject, NO_PROJECT, setProjectHidden, useScope, useTracker, type ProjectDetail } from '../client'
import { ConceptIcon, Icon, ProgressRing } from '../components/icons'
import { Markdown } from '../components/Markdown'
import type { MdContext } from '../markdown'
import { milestoneProgress, targetLabel } from '../projectPage'
import { HiddenNotice } from './HiddenNotice'
import { ViewScreen } from './ViewScreen'
import type { ViewState } from '../viewModel'
import { DEFAULT_DISPLAY } from '../viewModel'

const STALE_RE = /changed since you started editing/
const STATUSES = ['Planned', 'Active', 'Paused', 'Completed', 'Canceled']
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Rendered markdown with Edit / Save / Cancel (⌘↩ saves). `save(text, base)` throws to show an error. */
function MarkdownBlock({ source, ctx, save, emptyLabel, label }: {
  source: string; ctx: MdContext; label: string; emptyLabel: string
  save: (text: string, base: string) => Promise<void>
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [base, setBase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stale, setStale] = useState(false)
  const start = (t: string) => { setDraft(t); setBase(source); setError(''); setStale(false) }
  const close = () => { setDraft(null); setError(''); setStale(false) }
  const commit = async () => {
    if (draft === null || busy) return
    setBusy(true); setError(''); setStale(false)
    try { await save(draft, base); setDraft(null) } catch (e) {
      const m = errText(e)
      setStale(STALE_RE.test(m)); setError(m)
    }
    setBusy(false)
  }
  if (draft !== null) {
    return (
      <div className="desc-edit">
        <textarea autoFocus className="desc-textarea" value={draft} aria-label={label} onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(40, Math.max(8, draft.split('\n').length + 1))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void commit() }
            else if (e.key === 'Escape') { e.preventDefault(); close() }
          }} />
        {error && (
          <div className="form-error" role="alert">
            {error}
            {stale && <button type="button" className="ghost-btn inline" onClick={close}>Discard my edit and show the latest</button>}
          </div>
        )}
        <div className="row-buttons">
          <span className="muted small">⌘↩ to save · Esc to cancel</span>
          <button type="button" className="ghost-btn" onClick={close}>Cancel</button>
          <button type="button" className="primary" disabled={busy} onClick={() => void commit()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    )
  }
  return (
    <div className="desc">
      <button type="button" className="ghost-btn desc-edit-btn" onClick={() => start(source)}>Edit</button>
      {source.trim() ? <Markdown source={source} ctx={ctx} /> : <button type="button" className="desc-empty" onClick={() => start('')}>{emptyLabel}</button>}
    </div>
  )
}

function Name({ project }: { project: Project }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')
  const cancelled = useRef(false) // Escape → blur() must not commit the draft
  const commit = async () => {
    const next = (draft ?? '').replace(/\s+/g, ' ').trim()
    setDraft(null)
    if (cancelled.current) { cancelled.current = false; setError(''); return }
    if (!next || next === project.name) return
    try { await callTool('save_project', { id: project.slug, name: next }); setError('') } catch (e) { setError(errText(e)) }
  }
  return (
    <>
      <input className="project-name" value={draft ?? project.name} aria-label="Project name"
        onFocus={() => { cancelled.current = false; setDraft(project.name) }} onChange={(e) => setDraft(e.target.value)} onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
          else if (e.key === 'Escape') { e.preventDefault(); cancelled.current = true; e.currentTarget.blur() }
        }} />
      {error && <span className="form-error" role="alert">{error}</span>}
    </>
  )
}

function Milestones({ project, progress }: { project: Project; progress: ReturnType<typeof milestoneProgress> }) {
  const { config } = useTracker()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [date, setDate] = useState('')
  const [error, setError] = useState('')
  const run = async (args: Record<string, unknown>) => {
    setError('')
    try { await callTool('save_milestone', { project: project.slug, ...args }); return true } catch (e) { setError(errText(e)); return false }
  }
  const add = async () => {
    if (!name.trim()) return
    if (await run({ name: name.trim(), ...(date ? { targetDate: date } : {}) })) { setAdding(false); setName(''); setDate('') }
  }
  return (
    <section className="proj-section" aria-label="Milestones">
      <div className="proj-section-head">
        <h2>Milestones</h2>
        {!adding && <button type="button" className="ghost-btn" onClick={() => setAdding(true)}><span className="plus">+</span>Add milestone</button>}
      </div>
      {project.milestones.length === 0 && !adding && <div className="muted small">No milestones yet.</div>}
      <ul className="milestones">
        {project.milestones.map((m) => {
          const p = progress.get(m.name) ?? { done: 0, total: 0 }
          return (
            <li key={m.name} className="milestone-row">
              <ConceptIcon concept="milestone" />
              <span className="m-name" title={m.description}>{m.name}</span>
              <label className="m-date">
                <span className="muted small">{m.target ? targetLabel(m.target) : 'No date'}</span>
                {/^\d{4}-\d{2}-\d{2}$/.test(m.target ?? '') || !m.target
                  ? <input type="date" aria-label={`Target date for ${m.name}`} value={m.target ?? ''} onChange={(e) => { if (e.target.value) void run({ name: m.name, targetDate: e.target.value }) }} />
                  : null}
              </label>
              <span className="m-count muted small">
                <ProgressRing done={p.done} total={p.total} config={config} noun="issues" />
                <span aria-hidden="true">{p.done}/{p.total}</span>
              </span>
            </li>
          )
        })}
      </ul>
      {adding && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void add() }}>
          <input autoFocus placeholder="Milestone name" aria-label="Milestone name" value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setAdding(false) }} />
          <input type="date" aria-label="Target date" value={date} onChange={(e) => setDate(e.target.value)} />
          <button type="button" className="ghost-btn" onClick={() => setAdding(false)}>Cancel</button>
          <button type="submit" className="primary" disabled={!name.trim()}>Add</button>
        </form>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
    </section>
  )
}

function Documents({ project, ctx }: { project: Project; ctx: MdContext }) {
  const [open, setOpen] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [error, setError] = useState('')
  const create = async () => {
    if (!title.trim()) return
    setError('')
    try {
      const r = await callTool<{ id: string }>('save_document', { project: project.slug, title: title.trim(), content })
      setCreating(false); setTitle(''); setContent(''); setOpen(r.id.slice(r.id.indexOf('/') + 1))
    } catch (e) { setError(errText(e)) }
  }
  return (
    <section className="proj-section" aria-label="Documents">
      <div className="proj-section-head">
        <h2>Documents</h2>
        {!creating && <button type="button" className="ghost-btn" onClick={() => setCreating(true)}><span className="plus">+</span>New document</button>}
      </div>
      {project.docs.length === 0 && !creating && <div className="muted small">No documents yet.</div>}
      <ul className="docs">
        {project.docs.map((d) => {
          const isOpen = open === d.slug
          return (
            <li key={d.slug} className={`doc ${isOpen ? 'open' : ''}`}>
              <button type="button" className="doc-title" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : d.slug)}>
                <span className={`doc-chev ${isOpen ? 'open' : ''}`}><Icon name="chevron" size={12} /></span>{d.title}
              </button>
              {isOpen && (
                <div className="doc-body">
                  <MarkdownBlock key={d.slug} source={d.content} ctx={ctx} label={`${d.title} content`} emptyLabel="Empty document — write something…"
                    save={async (text, base) => { await callTool('save_document', { project: project.slug, id: `${project.slug}/${d.slug}`, title: d.title, content: text, baseContent: base }) }} />
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {creating && (
        <form className="doc-new" onSubmit={(e) => { e.preventDefault(); void create() }}>
          <input autoFocus placeholder="Document title" aria-label="Document title" value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setCreating(false) }} />
          <textarea className="desc-textarea" rows={6} placeholder="Markdown…" aria-label="Document content" value={content} onChange={(e) => setContent(e.target.value)} />
          <div className="row-buttons">
            <button type="button" className="ghost-btn" onClick={() => setCreating(false)}>Cancel</button>
            <button type="submit" className="primary" disabled={!title.trim()}>Create</button>
          </div>
        </form>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
    </section>
  )
}

/**
 * A hidden project by its link: `/api/projects/:slug`, refetched when the snapshot changes (project edits, hiding and
 * unhiding) or anything in a hidden project changes (`hiddenRev`). Null until loaded; `missing` when it doesn't exist.
 */
function useDirectProject(slug: string, on: boolean): { detail: ProjectDetail | null; missing: boolean } {
  const state = useTracker()
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    if (!on) return
    let live = true
    getProject(slug).then((d) => { if (live) { setDetail(d); setMissing(false) } }, () => { if (live) setMissing(true) })
    return () => { live = false }
  }, [on, slug, state.hiddenRev, state.config, state.projects])
  return { detail: on && detail?.project.slug === slug ? detail : null, missing: on && missing }
}

function HideButton({ slug }: { slug: string }) {
  const [error, setError] = useState('')
  return (
    <>
      <button type="button" className="ghost-btn project-hide" title="Hide this project from the sidebar, lists, Home and the menu bar; its links still open"
        onClick={() => { setError(''); setProjectHidden(slug, true).catch((e) => setError(errText(e))) }}>Hide project</button>
      {error && <span className="form-error" role="alert">{error}</span>}
    </>
  )
}

export function ProjectPage({ slug, query, routeQuery }: { slug: string; query?: string; routeQuery: (q?: string) => import('../router').Route }) {
  const state = useTracker()
  const scope = useScope()
  const live = state.projects.find((p) => p.slug === slug)
  const hidden = isHiddenProject(state, slug)
  const direct = useDirectProject(slug, state.ready && !live && hidden && slug !== NO_PROJECT)
  const project = live ?? direct.detail?.project
  const [statusError, setStatusError] = useState('')
  const keys = useMemo(() => new Set([...state.projects.map((p) => p.key), ...Object.keys(state.config?.nextNumber ?? {})]), [state.projects, state.config])
  const ctx = useMemo<MdContext>(() => ({ project: slug, keys }), [slug, keys])

  const closedTypes = useMemo(() => new Map((state.config?.statuses ?? []).map((s) => [s.name, s.type])), [state.config])
  const closed = useMemo(() => (st: string) => { const t = closedTypes.get(st); return t === 'completed' || t === 'canceled' || t === 'duplicate' }, [closedTypes])
  // Counts respect the workspace switcher: only issues in scope count. A hidden project's come from its direct read.
  const directIssues = live ? undefined : direct.detail?.issues
  const pool = useMemo<IssueSummary[]>(() => directIssues ?? [...state.issues.values()].filter((i) => i.project === slug && inScope(i, scope, state.config)),
    [directIssues, state.issues, slug, scope, state.config])
  const progress = useMemo(() => milestoneProgress(pool, slug, project?.milestones.map((m) => m.name) ?? [], closed), [pool, slug, project, closed])
  const total = pool.length
  const done = pool.reduce((n, i) => n + (closed(i.status) ? 1 : 0), 0)

  if (!project || slug === NO_PROJECT) {
    const loading = !state.ready || (hidden && slug !== NO_PROJECT && !direct.missing)
    return (
      <section className="page">
        <header className="page-head"><h1>{slug}</h1></header>
        {hidden && slug === NO_PROJECT && <HiddenNotice slug={slug} />}
        <p className="muted placeholder">{loading ? 'Loading…' : `Project "${slug}" not found.`}</p>
      </section>
    )
  }
  const statuses = STATUSES.includes(project.status) ? STATUSES : [project.status, ...STATUSES]
  const base: ViewState = { filter: {}, display: DEFAULT_DISPLAY }
  return (
    <div className="project-page">
      <header className="project-head">
        <span className="project-icon" style={{ color: project.color ?? 'var(--muted)' }}><ConceptIcon concept="project" size={20} /></span>
        <Name key={project.name} project={project} />
        <select className="project-status" aria-label="Project status" value={project.status}
          onChange={(e) => {
            setStatusError('')
            // Controlled: the value only changes when the snapshot does, so a failed save reverts by itself.
            callTool('save_project', { id: project.slug, state: e.target.value }).catch((err) => setStatusError(errText(err)))
          }}>
          {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {statusError && <span className="form-error" role="alert">{statusError}</span>}
        <span className="muted small project-count">{total > 0 && <ProgressRing done={done} total={total} config={state.config} noun="issues" decorative />}{done}/{total} issues done{scope.kind !== 'all' && !directIssues ? ' in this workspace' : ''}</span>
        {!hidden && <HideButton slug={project.slug} />}
      </header>
      {hidden && <div className="project-hidden"><HiddenNotice slug={project.slug} /></div>}
      <div className="project-body">
        <MarkdownBlock key={project.slug} source={project.description} ctx={ctx} label="Project description" emptyLabel="Add description…"
          save={async (text, base) => { await callTool('save_project', { id: project.slug, description: text, baseDescription: base }) }} />
        <Milestones project={project} progress={progress} />
        <Documents project={project} ctx={ctx} />
        <h2 className="proj-issues-h">Issues</h2>
      </div>
      <ViewScreen key={`project:${slug}`} title={project.name} defaults={base} base={{ project: [slug] }} locked={['project']} query={query} routeFor={routeQuery}
        {...(directIssues ? { issues: directIssues, extraProjects: [project] } : {})} />
    </div>
  )
}
