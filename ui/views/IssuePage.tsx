import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FeedEvent } from '../../src/engine/eventlog'
import { callTool, getIssue, getIssueFeed, NO_PROJECT, useTracker, type IssueDetail } from '../client'
import { ConceptIcon, Icon, ProgressPill, StatusIcon } from '../components/icons'
import { Markdown } from '../components/Markdown'
import { buildTree, treeProgress, type TreeNode } from '../issuePage'
import { taskAt, type MdContext } from '../markdown'
import { href, navigate } from '../router'
import { IssueActivity } from './IssueActivity'
import { IssueAttempts } from './IssueAttempts'
import { IssueProperties } from './IssueProperties'

/**
 * `/api/issues/:id` + its feed, re-fetched (debounced) when the live store shows a change to the issue,
 * one of its children, or a new feed event for it. `apply` merges a save_issue result immediately.
 */
function useIssueDetail(id: string) {
  const state = useTracker()
  const [detail, setDetail] = useState<IssueDetail | null>(null)
  const [feed, setFeed] = useState<FeedEvent[]>([])
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState('')
  const seq = useRef(0)

  const reload = useCallback(() => {
    const mine = ++seq.current
    Promise.all([getIssue(id), getIssueFeed(id)]).then(
      ([d, f]) => { if (mine === seq.current) { setDetail(d); setFeed(f); setMissing(false); setError('') } },
      (e: unknown) => {
        if (mine !== seq.current) return
        const msg = e instanceof Error ? e.message : String(e)
        if (/not found/i.test(msg)) setMissing(true)
        else setError(msg)
      },
    )
  }, [id])

  const summary = state.issues.get(id)
  const sig = useMemo(() => {
    let kids = ''
    for (const i of state.issues.values()) if (i.parent === id) kids += `${i.id}@${i.updated},`
    const f = state.feed.find((e) => e.id === id)
    const ci = summary?.ci ? `${summary.ci.pr}:${summary.ci.state}:${summary.ci.checks}` : ''
    return `${summary?.updated ?? '-'}|${kids}|${f?.at ?? ''}|${ci}`
  }, [state.issues, state.feed, id, summary])

  const first = useRef(true)
  useEffect(() => {
    if (!state.ready) return
    const t = setTimeout(reload, first.current ? 0 : 150)
    first.current = false
    return () => clearTimeout(t)
  }, [sig, state.ready, reload])

  const apply = useCallback((d: Partial<IssueDetail>) => setDetail((cur) => (cur ? { ...cur, ...d } : cur)), [])
  return { detail, feed, missing, error, reload, apply }
}

function SubIssueRow({ node, depth, open, setOpen, closed }: { node: TreeNode; depth: number; open: Set<string>; setOpen: (id: string) => void; closed: (s: string) => boolean }) {
  const { config } = useTracker()
  const i = node.issue
  const prog = treeProgress(node.children, closed)
  const expanded = open.has(i.id)
  return (
    <>
      <div className="tree-row" style={{ paddingLeft: 8 + depth * 18 }}>
        {node.children.length > 0
          ? <button type="button" className={`tree-toggle ${expanded ? 'open' : ''}`} onClick={() => setOpen(i.id)} aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${i.id}`}><Icon name="chevron" size={12} /></button>
          : <span className="tree-toggle" />}
        <a href={href({ name: 'issue', id: i.id })} className="tree-link">
          <StatusIcon status={i.status} config={config} />
          <span className="id">{i.id}</span>
          <span className="t">{i.title}</span>
          <ProgressPill done={prog.done} total={prog.total} config={config} />
        </a>
      </div>
      {expanded && node.children.map((c) => <SubIssueRow key={c.issue.id} node={c} depth={depth + 1} open={open} setOpen={setOpen} closed={closed} />)}
    </>
  )
}

/** Sub-issues to any depth (first level shown, deeper levels collapsible), with done/total and "Add sub-issue". */
function SubIssues({ id }: { id: string }) {
  const { issues, config } = useTracker()
  const tree = useMemo(() => buildTree(issues, id), [issues, id])
  const closed = useMemo(() => {
    const types = new Map((config?.statuses ?? []).map((s) => [s.name, s.type]))
    return (s: string) => { const t = types.get(s); return t === 'completed' || t === 'canceled' || t === 'duplicate' }
  }, [config])
  const progress = useMemo(() => treeProgress(tree, closed), [tree, closed])
  const [open, setOpenSet] = useState<Set<string>>(new Set())
  const toggle = (x: string) => setOpenSet((s) => { const n = new Set(s); if (n.has(x)) n.delete(x); else n.add(x); return n })
  return (
    <section className="sub-issues" aria-label="Sub-issues">
      <div className="sub-head">
        <h2>Sub-issues</h2>
        <ProgressPill done={progress.done} total={progress.total} config={config} />
        <button type="button" className="ghost-btn" onClick={() => navigate({ name: 'new', parent: id })}><span className="plus">+</span> Add sub-issue</button>
      </div>
      {tree.map((n) => <SubIssueRow key={n.issue.id} node={n} depth={0} open={open} setOpen={toggle} closed={closed} />)}
    </section>
  )
}

function Title({ title, save }: { title: string; save: (t: string) => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }
  }, [draft])
  const commit = async () => {
    if (draft === null) return
    const t = draft.replace(/\s+/g, ' ').trim()
    if (!t || t === title) { setDraft(null); return }
    try { await save(t); setDraft(null); setError('') } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  return (
    <>
      <textarea ref={ref} className="issue-title" rows={1} value={draft ?? title} aria-label="Title" onFocus={() => setDraft(draft ?? title)}
        onChange={(e) => setDraft(e.target.value)} onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
          else if (e.key === 'Escape') { e.preventDefault(); setDraft(null); setError(''); e.currentTarget.blur() }
        }} />
      {error && <div className="form-error" role="alert">{error}</div>}
    </>
  )
}

const STALE_RE = /changed since you (started editing|loaded it)/

/**
 * Rendered description; "Edit" opens a markdown textarea (⌘↩ saves). The save carries the text the edit started
 * from (`baseDescription`), so a newer save by someone else is never overwritten: a notice offers "Reload" and the
 * draft stays visible to copy. Task checkboxes go through `toggle_task` (one at a time; the engine checks the line).
 */
function Description({ issueId, source, ctx, save, apply, reload }: {
  issueId: string; source: string; ctx: MdContext
  save: (args: Record<string, unknown>) => Promise<void>
  apply: (d: Partial<IssueDetail>) => void; reload: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [base, setBase] = useState('')
  const [stale, setStale] = useState(false)
  const [leftover, setLeftover] = useState<string | null>(null) // draft kept after a stale save + reload
  const [busy, setBusy] = useState(false)
  const [toggling, setToggling] = useState(false)
  const inFlight = useRef(false) // a ref, so two clicks in one tick can't both start
  const [error, setError] = useState('')

  const startEdit = (text: string) => { setDraft(text); setBase(source); setStale(false); setError(''); setLeftover(null) }
  const commit = async (text: string) => {
    setBusy(true); setError(''); setStale(false)
    try { await save({ description: text, baseDescription: base }); setDraft(null) } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (STALE_RE.test(msg)) setStale(true)
      setError(msg)
    }
    setBusy(false)
  }
  const reloadKeepingDraft = () => { setLeftover(draft); setDraft(null); setStale(false); setError(''); reload() }
  const toggle = async (n: number) => {
    if (inFlight.current) return
    const line = taskAt(source, n)?.text
    if (line === undefined) return
    inFlight.current = true
    setToggling(true); setError('')
    try { apply(await callTool<Partial<IssueDetail>>('toggle_task', { id: issueId, index: n, line })) } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      reload()
    }
    inFlight.current = false
    setToggling(false)
  }

  if (draft !== null) {
    return (
      <div className="desc-edit">
        <textarea autoFocus className="desc-textarea" value={draft} aria-label="Description" onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(40, Math.max(8, draft.split('\n').length + 1))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void commit(draft) }
            else if (e.key === 'Escape') { e.preventDefault(); setDraft(null); setError('') }
          }} />
        {error && (
          <div className="form-error" role="alert">
            {error}
            {stale && <button type="button" className="ghost-btn inline" onClick={reloadKeepingDraft}>Reload</button>}
          </div>
        )}
        <div className="row-buttons">
          <span className="muted small">⌘↩ to save · Esc to cancel</span>
          <button type="button" className="ghost-btn" onClick={() => { setDraft(null); setError('') }}>Cancel</button>
          <button type="button" className="primary" disabled={busy} onClick={() => void commit(draft)}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    )
  }
  return (
    <div className={`desc ${toggling ? 'busy' : ''}`}>
      {leftover !== null && (
        <div className="leftover">
          <div className="leftover-head">
            <span className="muted small">Your unsaved edit (the description below is the newer version)</span>
            <button type="button" className="ghost-btn" onClick={() => startEdit(leftover)}>Edit with my text</button>
            <button type="button" className="ghost-btn" onClick={() => setLeftover(null)}>Discard</button>
          </div>
          <textarea readOnly className="desc-textarea" value={leftover} aria-label="Unsaved edit" rows={Math.min(12, leftover.split('\n').length + 1)} />
        </div>
      )}
      <button type="button" className="ghost-btn desc-edit-btn" onClick={() => startEdit(source)}>Edit</button>
      {source.trim()
        ? <Markdown source={source} ctx={ctx} onToggleTask={(n) => void toggle(n)} />
        : <button type="button" className="desc-empty" onClick={() => startEdit('')}>Add description…</button>}
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  )
}

/** `…` menu: copy id/link, delete with an in-app confirm (no browser dialogs). */
function IssueMenu({ id, url, childCount }: { id: string; url: string; childCount: number }) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) { setOpen(false); setConfirm(false) } }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setConfirm(false) } }
    addEventListener('mousedown', onDown); addEventListener('keydown', onKey)
    return () => { removeEventListener('mousedown', onDown); removeEventListener('keydown', onKey) }
  }, [open])
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => {}); setOpen(false) }
  const del = async () => {
    setBusy(true); setError('')
    try { await callTool('delete_issue', { id }); navigate({ name: 'home' }) } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false) }
  }
  return (
    <div className="issue-menu" ref={box}>
      <button type="button" className="icon-button" aria-label="Issue actions" aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open); setConfirm(false) }}>···</button>
      {open && (
        <div className="menu menu-right" role="menu">
          {!confirm ? (
            <>
              <button role="menuitem" onClick={() => copy(id)}>Copy ID</button>
              <button role="menuitem" onClick={() => copy(url)}>Copy link</button>
              <button role="menuitem" className="danger" onClick={() => setConfirm(true)}>Delete issue…</button>
            </>
          ) : (
            <div className="confirm" role="alertdialog" aria-label={`Delete ${id}`}>
              <p>Delete <strong>{id}</strong>? Its file is removed (git history keeps it).{childCount > 0 ? ` ${childCount} sub-issue${childCount === 1 ? '' : 's'} will point at a parent that no longer exists.` : ''}</p>
              {error && <div className="form-error" role="alert">{error}</div>}
              <div className="row-buttons">
                <button type="button" className="ghost-btn" onClick={() => setConfirm(false)}>Cancel</button>
                <button type="button" className="danger-btn" disabled={busy} onClick={() => void del()}>{busy ? 'Deleting…' : 'Delete'}</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function IssuePage({ id }: { id: string }) {
  const state = useTracker()
  const { detail, feed, missing, error, reload, apply } = useIssueDetail(id)
  const keys = useMemo(() => new Set([...state.projects.map((p) => p.key), ...Object.keys(state.config?.nextNumber ?? {})]), [state.projects, state.config])
  const ctx = useMemo<MdContext>(() => ({ project: detail?.project ?? '', keys }), [detail?.project, keys])

  const save = useCallback(async (args: Record<string, unknown>, otherId?: string) => {
    const out = await callTool<Partial<IssueDetail>>('save_issue', { id: otherId ?? id, ...args })
    if (!otherId) apply(out)
    reload()
  }, [id, apply, reload])

  if (missing) {
    return (
      <section className="page">
        <header className="page-head"><h1>{id}</h1></header>
        <p className="muted placeholder">Issue {id} not found — it may have been deleted. <a href={href({ name: 'home' })}>Go home</a></p>
      </section>
    )
  }
  if (!detail) {
    return (
      <section className="page">
        <header className="page-head"><h1>{id}</h1></header>
        <p className="muted placeholder">{error || 'Loading…'}</p>
      </section>
    )
  }

  const project = state.projects.find((p) => p.slug === detail.project)
  const summary = state.issues.get(id)
  return (
    <section className="issue-page">
      <header className="page-head issue-head">
        <nav className="crumbs" aria-label="Breadcrumb">
          {project && detail.project !== NO_PROJECT && <><a href={href({ name: 'project', slug: project.slug })}><ConceptIcon concept="project" /> {project.name}</a><span className="sep">›</span></>}
          {[...detail.ancestors].reverse().map((a) => (
            <span key={a.id} className="crumb"><a href={href({ name: 'issue', id: a.id })} title={a.title}><span className="id">{a.id}</span> <span className="t">{a.title}</span></a><span className="sep">›</span></span>
          ))}
          <span className="crumb current"><span className="id">{detail.id}</span> <span className="t">{detail.title}</span></span>
        </nav>
        <IssueMenu id={detail.id} url={detail.url} childCount={summary?.childCount ?? detail.children.length} />
      </header>
      {error && <div className="form-error banner" role="alert">{error}</div>}
      <div className="issue-body">
        <article className="issue-main">
          <Title title={detail.title} save={(title) => save({ title })} />
          <Description key={detail.id} issueId={detail.id} source={detail.description} ctx={ctx} save={save} apply={apply} reload={reload} />
          <SubIssues id={detail.id} />
          <IssueAttempts attempts={detail.attempts} now={Date.now()} />
          <IssueActivity issueId={detail.id} activity={detail.activity} feed={feed} ctx={ctx} onSaved={reload} />
        </article>
        <IssueProperties issue={detail} save={save} />
      </div>
    </section>
  )
}
