import { useEffect, useState } from 'react'
import type { IssueSummary } from '../../src/model'
import { inScope, searchIssues, useScope, useTracker } from '../client'
import { href } from '../router'
import { PriorityIcon, ProgressPill, StatusIcon } from '../components/icons'

/** One issue row (search results). */
export function IssueRow({ issue }: { issue: IssueSummary }) {
  const { config } = useTracker()
  return (
    <a className="issue-row" href={href({ name: 'issue', id: issue.id })}>
      <PriorityIcon priority={issue.priority} />
      <span className="id">{issue.id}</span>
      <StatusIcon status={issue.status} config={config} />
      <span className="title">{issue.title}</span>
      <ProgressPill done={issue.progress.done} total={issue.progress.total} config={config} />
      {issue.labels.slice(0, 3).map((l) => <span key={l} className="pill">{l}</span>)}
    </a>
  )
}

/** `#/search?q=`: full-text results from the engine, kept live from the store. */
export function SearchResults({ q }: { q: string }) {
  const state = useTracker()
  const scope = useScope()
  const [ids, setIds] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setIds(null); setError('')
    if (!q.trim()) { setIds([]); return }
    searchIssues(q).then((r) => { if (live) setIds(r.map((i) => i.id)) }, (e: unknown) => { if (live) setError(String(e)) })
    return () => { live = false }
  }, [q])
  const rows = (ids ?? []).map((id) => state.issues.get(id)).filter((i): i is IssueSummary => !!i && inScope(i, scope, state.config))
  return (
    <section className="page">
      <header className="page-head"><h1>Search</h1><span className="muted">{q ? `“${q}” · ${ids === null ? 'searching…' : `${rows.length} results`}` : 'Type ⌘K or / to search'}</span></header>
      {error && <div className="form-error">{error}</div>}
      <div className="rows">{rows.map((i) => <IssueRow key={i.id} issue={i} />)}</div>
    </section>
  )
}
