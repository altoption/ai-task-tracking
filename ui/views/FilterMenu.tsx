/**
 * Filter popover (limited to: Status, Priority, Labels, Project, Milestone, Parent, Relations, Dates,
 * Content, Links, Workspace) and the chip bar that shows / removes active filters.
 * `locked` keys are fixed by the page (e.g. a project page's project) and not offered.
 */
import { useMemo, useState, type ReactNode } from 'react'
import type { Filter, IssueSummary } from '../../src/model'
import { ConceptIcon, Icon, PriorityIcon, PRIORITIES, StatusIcon, type Concept } from '../components/icons'
import { Popover } from '../components/Popover'
import { listedProjects, type TrackerState } from '../client'
import { byIssueNumber } from '../issuePage'

type Key = keyof Filter
interface Opt { value: string; label: string; icon?: ReactNode; hint?: string }
/** A filter category. Its id is its concept, so its icon is `CONCEPT_ICON[id]` (ui/components/icons.tsx). */
export interface Category { id: Concept; label: string; keys: Key[] }

export const CATEGORIES: Category[] = [
  { id: 'status', label: 'Status', keys: ['status'] },
  { id: 'priority', label: 'Priority', keys: ['priority'] },
  { id: 'labels', label: 'Labels', keys: ['labels'] },
  { id: 'relations', label: 'Relations', keys: ['blocked', 'blocking', 'hasRelated'] },
  { id: 'dates', label: 'Dates', keys: ['createdAfter', 'updatedAfter', 'closedWithinDays'] },
  { id: 'project', label: 'Project', keys: ['project'] },
  { id: 'milestone', label: 'Milestone', keys: ['milestone'] },
  { id: 'parent', label: 'Parent issue', keys: ['parent'] },
  { id: 'content', label: 'Content', keys: ['query'] },
  { id: 'links', label: 'Links', keys: ['hasLinks'] },
  { id: 'workspace', label: 'Workspace', keys: ['workspace'] },
]

/** Workspaces known to config or seen on issues. */
function workspaceNames(state: TrackerState): string[] {
  const s = new Set(Object.keys(state.config?.workspaces ?? {}))
  for (const i of state.issues.values()) for (const w of i.workspaces) s.add(w)
  return [...s].sort()
}

function listOptions(cat: string, state: TrackerState): Opt[] {
  switch (cat) {
    case 'status': return (state.config?.statuses ?? []).map((s) => ({ value: s.name, label: s.name, icon: <StatusIcon status={s.name} config={state.config} /> }))
    case 'priority': return [1, 2, 3, 4, 0].map((p) => ({ value: String(p), label: PRIORITIES[p]!, icon: <PriorityIcon priority={p} /> }))
    case 'labels': return [...state.labels].sort((a, b) => a.name.localeCompare(b.name)).map((l) => ({ value: l.name, label: l.name, icon: <span className="swatch round" style={{ background: l.color }} /> }))
    case 'project': return listedProjects(state.projects).map((p) => ({ value: p.slug, label: p.name, icon: <span className="swatch round" style={{ background: p.color ?? 'var(--accent)' }} /> }))
    case 'milestone': {
      const out: Opt[] = []
      const seen = new Set<string>()
      for (const p of listedProjects(state.projects)) for (const m of p.milestones) if (!seen.has(m.name)) { seen.add(m.name); out.push({ value: m.name, label: m.name, hint: p.name }) }
      return out
    }
    case 'workspace': return workspaceNames(state).map((w) => ({ value: w, label: w }))
    default: return []
  }
}

const LIST_KEY: Record<string, 'status' | 'labels' | 'project' | 'milestone' | 'workspace'> = { status: 'status', labels: 'labels', project: 'project', milestone: 'milestone', workspace: 'workspace' }

export function FilterMenu({ filter, locked = [], state, onChange }: { filter: Filter; locked?: Key[]; state: TrackerState; onChange: (f: Filter) => void }) {
  const [cat, setCat] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const cats = CATEGORIES.filter((c) => !c.keys.every((k) => locked.includes(k)))
  const active = activeChips(filter, locked, state).length > 0
  return (
    <Popover label="Filter" button={<ConceptIcon concept="filter" />} active={active} className="filter-menu">
      {() => (
        <div className="fm" onKeyDown={(e) => { if (e.key === 'Backspace' && !q && cat) { setCat(null) } }}>
          <div className="fm-head">
            {cat && <button className="icon-button" aria-label="Back" onClick={() => { setCat(null); setQ('') }}>‹</button>}
            <input autoFocus className="picker-input" placeholder={cat ? `${CATEGORIES.find((c) => c.id === cat)?.label}…` : 'Add filter…'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter search" />
          </div>
          <div className="picker-list">
            {!cat && cats.filter((c) => c.label.toLowerCase().includes(q.toLowerCase())).map((c) => (
              <div key={c.id} role="button" tabIndex={0} className="picker-item" onClick={() => { setCat(c.id); setQ('') }} onKeyDown={(e) => { if (e.key === 'Enter') { setCat(c.id); setQ('') } }}>
                <ConceptIcon concept={c.id} /><span className="label">{c.label}</span><span className="hint">›</span>
              </div>
            ))}
            {cat && <CategoryPanel cat={cat} q={q} filter={filter} state={state} onChange={onChange} />}
          </div>
        </div>
      )}
    </Popover>
  )
}

function CategoryPanel({ cat, q, filter, state, onChange }: { cat: string; q: string; filter: Filter; state: TrackerState; onChange: (f: Filter) => void }) {
  const set = (patch: Partial<Filter>) => {
    const next: Filter = { ...filter, ...patch }
    for (const k of Object.keys(patch) as Key[]) if (patch[k] === undefined) delete next[k]
    onChange(next)
  }
  const ql = q.toLowerCase()
  if (LIST_KEY[cat] || cat === 'priority') {
    const opts = listOptions(cat, state).filter((o) => o.label.toLowerCase().includes(ql))
    const sel = cat === 'priority' ? (filter.priority ?? []).map(String) : (filter[LIST_KEY[cat]!] ?? [])
    const toggle = (v: string) => {
      const on = sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v]
      if (cat === 'priority') set({ priority: on.length ? on.map(Number) : undefined })
      else set({ [LIST_KEY[cat]!]: on.length ? on : undefined })
    }
    if (!opts.length) return <div className="picker-empty">No options</div>
    return <>{opts.map((o) => <Check key={o.value} opt={o} on={sel.includes(o.value)} onClick={() => toggle(o.value)} />)}</>
  }
  if (cat === 'parent') return <ParentPanel q={ql} filter={filter} state={state} set={set} />
  if (cat === 'relations') {
    const rel: [Key, string, boolean][] = [['blocked', 'Blocked', true], ['blocked', 'Not blocked', false], ['blocking', 'Blocking other issues', true], ['hasRelated', 'Has related issues', true]]
    return <>{rel.map(([k, label, val]) => <Check key={label} opt={{ value: label, label }} on={filter[k] === val} onClick={() => set({ [k]: filter[k] === val ? undefined : val })} />)}</>
  }
  if (cat === 'links') {
    return <>{([['Has links', true], ['No links', false]] as const).map(([label, val]) => <Check key={label} opt={{ value: label, label }} on={filter.hasLinks === val} onClick={() => set({ hasLinks: filter.hasLinks === val ? undefined : val })} />)}</>
  }
  if (cat === 'dates') {
    return (
      <div className="fm-form">
        {([['createdAfter', 'Created after'], ['updatedAfter', 'Updated after']] as const).map(([k, label]) => (
          <label key={k} className="dm-row"><span className="dm-label">{label}</span>
            <input type="date" className="date-input" value={filter[k]?.slice(0, 10) ?? ''} onChange={(e) => set({ [k]: e.target.value || undefined })} />
          </label>
        ))}
        <label className="dm-row"><span className="dm-label">Closed in the last (days)</span>
          <input type="number" min={1} step={1} className="date-input" value={filter.closedWithinDays ?? ''}
            onChange={(e) => { const n = Number(e.target.value); set({ closedWithinDays: Number.isInteger(n) && n > 0 ? n : undefined }) }} />
        </label>
      </div>
    )
  }
  if (cat === 'content') {
    return (
      <div className="fm-form">
        <input className="date-input" placeholder="Title or ID contains…" defaultValue={filter.query ?? ''} aria-label="Content"
          onKeyDown={(e) => { if (e.key === 'Enter') set({ query: e.currentTarget.value.trim() || undefined }) }}
          onBlur={(e) => set({ query: e.currentTarget.value.trim() || undefined })} />
        <div className="muted small">Every word must appear in the title or ID. Enter to apply.</div>
      </div>
    )
  }
  return null
}

function ParentPanel({ q, filter, state, set }: { q: string; filter: Filter; state: TrackerState; set: (p: Partial<Filter>) => void }) {
  const parents = useMemo(() => [...state.issues.values()].filter((i) => i.childCount > 0).sort(byIssueNumber), [state.issues])
  const shown = parents.filter((i) => `${i.id} ${i.title}`.toLowerCase().includes(q)).slice(0, 50)
  return (
    <>
      <Check opt={{ value: '', label: 'No parent (top-level issues)' }} on={filter.parent === null} onClick={() => set({ parent: filter.parent === null ? undefined : null })} />
      {shown.map((i: IssueSummary) => (
        <Check key={i.id} opt={{ value: i.id, label: i.title, hint: i.id, icon: <StatusIcon status={i.status} config={state.config} /> }} on={filter.parent === i.id}
          onClick={() => set({ parent: filter.parent === i.id ? undefined : i.id })} />
      ))}
    </>
  )
}

function Check({ opt, on, onClick }: { opt: Opt; on: boolean; onClick: () => void }) {
  return (
    <div role="menuitemcheckbox" aria-checked={on} tabIndex={0} className="picker-item" onClick={onClick} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}>
      <span className={`fm-box${on ? ' on' : ''}`}>{on ? '✓' : ''}</span>
      {opt.icon}<span className="label">{opt.label}</span>{opt.hint && <span className="hint">{opt.hint}</span>}
    </div>
  )
}

// ---------- chips ----------

interface Chip { keys: Key[]; text: string }

const names = (xs: string[], max = 2) => (xs.length > max ? `${xs.slice(0, max).join(', ')} +${xs.length - max}` : xs.join(', '))

/** Pure-ish: the active filters as readable chips (locked keys left out). */
export function activeChips(f: Filter, locked: Key[], state: Pick<TrackerState, 'projects' | 'issues'>): Chip[] {
  const out: Chip[] = []
  const add = (k: Key, text: string) => { if (!locked.includes(k)) out.push({ keys: [k], text }) }
  const anyOf = (label: string, xs: string[]) => `${label} ${xs.length > 1 ? 'is any of' : 'is'} ${names(xs)}`
  if (f.status?.length) add('status', anyOf('Status', f.status))
  if (f.priority?.length) add('priority', anyOf('Priority', f.priority.map((p) => PRIORITIES[p] ?? String(p))))
  if (f.labels?.length) add('labels', anyOf('Label', f.labels))
  if (f.project?.length) add('project', anyOf('Project', f.project.map((s) => state.projects.find((p) => p.slug === s)?.name ?? s)))
  if (f.milestone?.length) add('milestone', anyOf('Milestone', f.milestone))
  if (f.parent !== undefined) add('parent', f.parent === null ? 'No parent' : `Parent is ${f.parent}`)
  if (f.blocked !== undefined) add('blocked', f.blocked ? 'Blocked' : 'Not blocked')
  if (f.blocking !== undefined) add('blocking', f.blocking ? 'Blocking' : 'Not blocking')
  if (f.hasRelated !== undefined) add('hasRelated', f.hasRelated ? 'Has related' : 'No related')
  if (f.createdAfter) add('createdAfter', `Created after ${f.createdAfter.slice(0, 10)}`)
  if (f.updatedAfter) add('updatedAfter', `Updated after ${f.updatedAfter.slice(0, 10)}`)
  if (f.closedWithinDays) add('closedWithinDays', `Closed in the last ${f.closedWithinDays === 1 ? 'day' : `${f.closedWithinDays} days`}`)
  if (f.query) add('query', `Content contains “${f.query}”`)
  if (f.hasLinks !== undefined) add('hasLinks', f.hasLinks ? 'Has links' : 'No links')
  if (f.workspace?.length) add('workspace', anyOf('Workspace', f.workspace))
  if (f.includeDone) add('includeDone', 'Including completed')
  return out
}

export function FilterBar({ filter, locked = [], state, onChange }: { filter: Filter; locked?: Key[]; state: TrackerState; onChange: (f: Filter) => void }) {
  const chips = activeChips(filter, locked, state)
  if (!chips.length) return null
  const remove = (keys: Key[]) => { const next = { ...filter }; for (const k of keys) delete next[k]; onChange(next) }
  return (
    <div className="filter-bar">
      {chips.map((c) => (
        <span key={c.keys.join()} className="chip filter-chip">{c.text}<button aria-label={`Remove filter ${c.text}`} onClick={() => remove(c.keys)}><Icon name="x" size={11} /></button></span>
      ))}
      <button className="ghost-btn" onClick={() => remove(chips.flatMap((c) => c.keys))}>Clear</button>
    </div>
  )
}
