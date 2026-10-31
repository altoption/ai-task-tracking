import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { IssueSummary } from '../../src/model'
import { listedProjects, searchIssues, useTracker, type IssueDetail } from '../client'
import { ConceptIcon, PRIORITIES, PriorityIcon, StatusIcon } from '../components/icons'
import { Picker, type PickOption } from '../components/Picker'
import { CiBadgeLine } from '../components/Ci'
import { filterOptions, labelOptions } from '../issuePage'
import { isAllowedUrl } from '../markdown'
import { href } from '../router'

export type SaveFn = (args: Record<string, unknown>, otherId?: string) => Promise<void>

const fmtDate = (iso: string) => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** A linked issue in the sidebar: status, id, title (or a note when the id doesn't exist). */
export function IssueChip({ id, onRemove }: { id: string; onRemove?: () => void }) {
  const { issues, config } = useTracker()
  const i = issues.get(id)
  return (
    <div className="rel-row">
      <a href={href({ name: 'issue', id })} className="rel-link" title={i?.title}>
        {i ? <StatusIcon status={i.status} config={config} size={12} /> : <ConceptIcon concept="warning" size={12} />}
        <span className="id">{id}</span>
        <span className="t">{i ? i.title : 'not found'}</span>
      </a>
      {onRemove && <button type="button" className="rel-x" onClick={onRemove} aria-label={`Remove ${id}`}>×</button>}
    </div>
  )
}

/** Issue options for parent/blocked-by/blocks/related: id or title matches from the live store, then full-text hits from /api/search. */
function useIssueOptions(selfId: string, project: string) {
  const { issues, config } = useTracker()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<IssueSummary[]>([])
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    let live = true
    const t = setTimeout(() => { searchIssues(q).then((r) => { if (live) setHits(r.slice(0, 30)) }, () => {}) }, 120)
    return () => { live = false; clearTimeout(t) }
  }, [q])
  const toOpt = (i: IssueSummary): PickOption => ({ value: i.id, label: `${i.id} ${i.title}`, group: null, icon: <StatusIcon status={i.status} config={config} size={12} /> })
  const options = useMemo(() => (query: string) => {
    const all = [...issues.values()].filter((i) => i.id !== selfId)
    let base: IssueSummary[]
    if (!query.trim()) base = all.filter((i) => i.project === project).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 30)
    else {
      const up = query.trim().toUpperCase()
      const local = filterOptions(all.map((i) => ({ value: i.id, label: `${i.id} ${i.title}`, group: null, i })), query)
      base = [...all.filter((i) => i.id === up), ...local.map((o) => o.i).sort((a, b) => b.updated.localeCompare(a.updated))].slice(0, 50)
    }
    const seen = new Set<string>()
    return [...base, ...hits.filter((h) => h.id !== selfId)].filter((i) => !seen.has(i.id) && !!seen.add(i.id)).map(toOpt)
  }, [issues, hits, selfId, project, config])
  return { options, onQuery: setQ }
}

function Section({ title, error, children }: { title?: string; error?: string; children: ReactNode }) {
  return (
    <section className="prop-section">
      {title && <h3>{title}</h3>}
      {children}
      {error && <div className="form-error" role="alert">{error}</div>}
    </section>
  )
}

export function IssueProperties({ issue, save }: { issue: IssueDetail; save: SaveFn }) {
  const state = useTracker()
  const { config } = state
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [linkDraft, setLinkDraft] = useState<{ url: string; title: string } | null>(null)
  const { options: issueOptions, onQuery } = useIssueOptions(issue.id, issue.project)

  const run = async (section: string, args: Record<string, unknown>, otherId?: string) => {
    setErrors((e) => ({ ...e, [section]: '' }))
    try { await save(args, otherId) } catch (err) { setErrors((e) => ({ ...e, [section]: err instanceof Error ? err.message : String(err) })) }
  }

  const statusOpts: PickOption[] = (config?.statuses ?? []).map((s) => ({ value: s.name, label: s.name, group: null, icon: <StatusIcon status={s.name} config={config} /> }))
  const priorityOpts: PickOption[] = PRIORITIES.map((p, n) => ({ value: String(n), label: p, group: null, icon: <PriorityIcon priority={n} /> }))
  const labels = useMemo(() => labelOptions(state.labels), [state.labels])
  const labelColor = (name: string) => state.labels.find((l) => l.name === name)?.color
  const projects = listedProjects(state.projects)
  const project = state.projects.find((p) => p.slug === issue.project)
  const projectOpts: PickOption[] = projects.map((p) => ({ value: p.slug, label: p.name, group: null, color: p.color }))
  const milestoneOpts: PickOption[] = [{ value: '', label: 'No milestone', group: null }, ...(project?.milestones ?? []).map((m) => ({ value: m.name, label: m.name, group: null, hint: m.target }))]
  const plus = (text: string) => <span className="prop-add"><span className="plus">+</span>{text}</span>

  return (
    <aside className="issue-props" aria-label="Properties">
      <Section title="Properties" error={errors.status || errors.priority}>
        <Picker label="Status" options={statusOpts} selected={[issue.status]} onPick={(v) => void run('status', { state: v })}
          trigger={<><StatusIcon status={issue.status} config={config} /><span>{issue.status}</span></>} />
        <Picker label="Priority" options={priorityOpts} selected={[String(issue.priority)]} onPick={(v) => void run('priority', { priority: Number(v) })}
          trigger={<><PriorityIcon priority={issue.priority} /><span className={issue.priority ? '' : 'muted'}>{issue.priority ? PRIORITIES[issue.priority] : 'Set priority'}</span></>} />
      </Section>

      <Section title="Labels" error={errors.labels}>
        {issue.labels.length > 0 && (
          <div className="label-chips">
            {issue.labels.map((l) => (
              <span key={l} className="chip"><span className="swatch round" style={{ background: labelColor(l) ?? 'var(--faint)' }} />{l}
                <button type="button" onClick={() => void run('labels', { removeLabels: [l] })} aria-label={`Remove label ${l}`}>×</button></span>
            ))}
          </div>
        )}
        <Picker label="Labels" multi options={labels} selected={issue.labels} onPick={(v, on) => void run('labels', on ? { addLabels: [v] } : { removeLabels: [v] })}
          create={(q) => ({ value: q, label: `Create label “${q}”`, group: null })} trigger={plus('Add label')} />
      </Section>

      <Section title="Project" error={errors.project}>
        <Picker label="Project" options={projectOpts} selected={[issue.project]} onPick={(v) => { if (v !== issue.project) void run('project', { project: v }) }}
          trigger={<><ConceptIcon concept="project" /><span className={project && issue.project !== '_none' ? '' : 'muted'}>{project && issue.project !== '_none' ? project.name : 'No project'}</span></>} />
        <Picker label="Milestone" className="indent" options={milestoneOpts} selected={[issue.milestone ?? '']} onPick={(v) => void run('project', { milestone: v || null })}
          trigger={<><ConceptIcon concept="milestone" /><span className={issue.milestone ? '' : 'muted'}>{issue.milestone ?? 'Set milestone'}</span></>} />
      </Section>

      <Section title="Relations" error={errors.relations}>
        <div className="rel-head">Parent</div>
        {issue.parent && <IssueChip id={issue.parent} onRemove={() => void run('relations', { parentId: null })} />}
        <Picker label="Parent" options={issueOptions} onQuery={onQuery} selected={issue.parent ? [issue.parent] : []} onPick={(v) => void run('relations', { parentId: v })}
          trigger={plus(issue.parent ? 'Change parent' : 'Set parent')} />
        <div className="rel-head">Blocked by</div>
        {issue.blockedBy.map((b) => <IssueChip key={b} id={b} onRemove={() => void run('relations', { removeBlockedBy: [b] })} />)}
        <Picker label="Blocked by" multi options={issueOptions} onQuery={onQuery} selected={issue.blockedBy} onPick={(v, on) => void run('relations', on ? { addBlockedBy: [v] } : { removeBlockedBy: [v] })} trigger={plus('Add blocker')} />
        <div className="rel-head">Blocks</div>
        {issue.blocks.map((b) => <IssueChip key={b} id={b} onRemove={() => void run('relations', { removeBlockedBy: [issue.id] }, b)} />)}
        <Picker label="Blocks" multi options={issueOptions} onQuery={onQuery} selected={issue.blocks}
          onPick={(v, on) => void run('relations', on ? { addBlockedBy: [issue.id] } : { removeBlockedBy: [issue.id] }, v)} trigger={plus('Add blocked issue')} />
        <div className="rel-head">Related</div>
        {issue.related.map((r) => <IssueChip key={r} id={r} onRemove={() => void run('relations', { removeRelatedTo: [r] })} />)}
        <Picker label="Related" multi options={issueOptions} onQuery={onQuery} selected={issue.related} onPick={(v, on) => void run('relations', on ? { addRelatedTo: [v] } : { removeRelatedTo: [v] })} trigger={plus('Add related')} />
      </Section>

      <Section title="Links" error={errors.links}>
        {issue.links.map((l) => (
          <div key={l.url}>
          <div className="rel-row">
            {isAllowedUrl(l.url) && /^https?:/i.test(l.url.trim())
              ? <a className="rel-link" href={l.url} target="_blank" rel="noopener noreferrer" title={l.url}><span className="t">{l.title || l.url}</span></a>
              : <span className="rel-link muted" title={l.url}><span className="t">{l.title || l.url}</span></span>}
            <button type="button" className="rel-x" onClick={() => void run('links', { removeLinks: [l.url] })} aria-label={`Remove link ${l.title || l.url}`}>×</button>
          </div>
          {issue.ci?.[l.url] && <CiBadgeLine status={issue.ci[l.url]!} now={Date.now()} />}
          {issue.ciProblems?.[l.url] && <div className="ci-line"><span className="ci-when">CI status: {issue.ciProblems[l.url]}</span></div>}
          </div>
        ))}
        {linkDraft ? (
          <form className="link-form" onSubmit={(e) => {
            e.preventDefault()
            if (!linkDraft.url.trim()) return
            void run('links', { links: [{ url: linkDraft.url.trim(), ...(linkDraft.title.trim() ? { title: linkDraft.title.trim() } : {}) }] }).then(() => setLinkDraft(null))
          }}>
            <input autoFocus placeholder="https://…" value={linkDraft.url} onChange={(e) => setLinkDraft({ ...linkDraft, url: e.target.value })} aria-label="Link URL"
              onKeyDown={(e) => { if (e.key === 'Escape') setLinkDraft(null) }} />
            <input placeholder="Title (optional)" value={linkDraft.title} onChange={(e) => setLinkDraft({ ...linkDraft, title: e.target.value })} aria-label="Link title"
              onKeyDown={(e) => { if (e.key === 'Escape') setLinkDraft(null) }} />
            <div className="row-buttons"><button type="button" className="ghost-btn" onClick={() => setLinkDraft(null)}>Cancel</button><button type="submit" className="primary">Add</button></div>
          </form>
        ) : <button type="button" className="prop-button" onClick={() => setLinkDraft({ url: '', title: '' })}>{plus('Add link')}</button>}
      </Section>

      <Section title="Due date" error={errors.due}>
        <div className="due-row">
          <input type="date" className="date-input" value={issue.due ?? ''} aria-label="Due date" onChange={(e) => void run('due', { dueDate: e.target.value || null })} />
          {issue.due && <button type="button" className="rel-x" onClick={() => void run('due', { dueDate: null })} aria-label="Clear due date">×</button>}
        </div>
      </Section>

      <Section title="Details">
        <dl className="details">
          <dt>Created</dt><dd>{fmtDate(issue.created)}</dd>
          <dt>Updated</dt><dd>{fmtDate(issue.updated)}</dd>
          <dt>Touched by</dt>
          <dd>{issue.touchedBy ? [issue.touchedBy.actor === 'you' ? 'you' : (issue.touchedBy.workspace ?? 'agent'), issue.touchedBy.branch].filter(Boolean).join(' · ') : '—'}</dd>
        </dl>
      </Section>
    </aside>
  )
}
