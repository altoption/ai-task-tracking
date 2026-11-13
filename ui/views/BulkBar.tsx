import { useMemo, useState } from 'react'
import type { IssueSummary } from '../../src/model'
import { asksReason, bulkItems, commonProject, familyClose, statusItems, type BulkPatch } from '../bulk'
import { callTool, listedProjects, useTracker } from '../client'
import { PRIORITIES, PriorityIcon, StatusIcon } from '../components/icons'
import { Picker, type PickOption } from '../components/Picker'
import { labelOptions } from '../issuePage'
import { NO_PROJECT } from '../client'
import { useIssueOptions } from './IssueProperties'

/**
 * Floats over the foot of the list while rows are selected (so ticking a box never moves the rows): change all of
 * them in one save_issues call (all or nothing). The selection stays after a change, for the next one; rows a change
 * moves out of the view drop out of it by themselves.
 */
export function BulkBar({ ids, byId, onClear, kids, onAddKids }: {
  ids: string[]
  byId: ReadonlyMap<string, IssueSummary>
  onClear: () => void
  /** Sub-issues of the selected rows that aren't selected, and the way to take them. */
  kids: number
  onAddKids: () => void
}) {
  const state = useTracker()
  const { config } = state
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [closing, setClosing] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  // Open sub-issues outside the selection that the closing status takes along.
  const fam = useMemo(
    () => (closing ? familyClose(ids, config?.statuses.find((s) => s.name === closing), state.issues.values(), config?.statuses ?? []) : null),
    [closing, ids, state.issues, config],
  )

  const run = async (patch: BulkPatch, why?: string) => {
    setBusy(true); setError('')
    try {
      await callTool('save_issues', { issues: 'state' in patch ? statusItems(ids, patch.state, fam, why) : bulkItems(ids, patch, why) })
      setClosing(null); setReason('')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const statusOpts: PickOption[] = (config?.statuses ?? []).map((s) => ({ value: s.name, label: s.name, group: null, icon: <StatusIcon status={s.name} config={config} /> }))
  const priorityOpts: PickOption[] = PRIORITIES.map((p, n) => ({ value: String(n), label: p, group: null, icon: <PriorityIcon priority={n} /> }))
  const addLabelOpts = useMemo(() => labelOptions(state.labels), [state.labels])
  // Remove offers only labels some selected issue has.
  const removeLabelOpts = useMemo(() => {
    const on = new Set(ids.flatMap((id) => byId.get(id)?.labels ?? []))
    return addLabelOpts.filter((o) => on.has(o.value))
  }, [ids, byId, addLabelOpts])
  const projectOpts: PickOption[] = listedProjects(state.projects).map((p) => ({ value: p.slug, label: p.name, group: null, color: p.color }))

  // A parent: any issue but the selected ones, found as you type. A milestone: only when they share a project.
  const idSet = useMemo(() => new Set(ids), [ids])
  const project = useMemo(() => commonProject(ids, (id) => byId.get(id)?.project), [ids, byId])
  const { options: issueOptions, onQuery } = useIssueOptions(idSet, project ?? '')
  const anyParent = ids.some((id) => byId.get(id)?.parent)
  const parentOpts = useMemo(() => (q: string): PickOption[] => [...(anyParent && !q.trim() ? [{ value: '', label: 'No parent', group: null }] : []), ...issueOptions(q)], [issueOptions, anyParent])
  const milestones = project && project !== NO_PROJECT ? state.projects.find((p) => p.slug === project)?.milestones ?? [] : []
  const milestoneOpts: PickOption[] = [{ value: '', label: 'No milestone', group: null }, ...milestones.map((m) => ({ value: m.name, label: m.name, group: null, ...(m.target ? { hint: m.target } : {}) }))]

  const pickStatus = (name: string) => {
    if (asksReason(config?.statuses.find((s) => s.name === name))) { setClosing(name); setReason('') }
    else void run({ state: name })
  }
  const n = ids.length
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk edit">
      <span className="bulk-count">{n} selected</span>
      {kids > 0 && !closing && <button type="button" className="ghost-btn bulk-kids" onClick={onAddKids} title="Also select the sub-issues of the selected issues">+ {kids} sub-issue{kids === 1 ? '' : 's'}</button>}
      {closing ? (
        <form className="bulk-reason" onSubmit={(e) => { e.preventDefault(); void run({ state: closing }, reason) }}>
          <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional, added as a comment)" aria-label="Reason"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setClosing(null) } }} />
          {fam && <span className="muted small bulk-family">{fam.kind === 'complete' ? 'with' : 'also cancels'} {fam.kids.length} open sub-issue{fam.kids.length === 1 ? '' : 's'}</span>}
          <button type="submit" className="primary small-btn" disabled={busy}>Move {n + (fam?.kind === 'complete' ? fam.kids.length : 0)} to {closing}</button>
          <button type="button" className="ghost-btn" onClick={() => setClosing(null)}>Back</button>
        </form>
      ) : (
        <>
          <Picker label="Status" options={statusOpts} selected={[]} onPick={pickStatus} trigger={<span>Status</span>} />
          <Picker label="Priority" options={priorityOpts} selected={[]} onPick={(v) => void run({ priority: Number(v) })} trigger={<span>Priority</span>} />
          <Picker label="Add label" options={addLabelOpts} selected={[]} onPick={(v) => void run({ addLabels: [v] })} trigger={<span>Add label</span>} />
          {removeLabelOpts.length > 0 && <Picker label="Remove label" options={removeLabelOpts} selected={[]} onPick={(v) => void run({ removeLabels: [v] })} trigger={<span>Remove label</span>} />}
          <Picker label="Parent" options={parentOpts} onQuery={onQuery} selected={[]} onPick={(v) => void run({ parentId: v || null })} trigger={<span>Parent</span>} placeholder="Make them sub-issues of…" />
          {milestones.length > 0 && <Picker label="Milestone" options={milestoneOpts} selected={[]} onPick={(v) => void run({ milestone: v || null })} trigger={<span>Milestone</span>} />}
          <Picker label="Project" options={projectOpts} selected={[]} onPick={(v) => void run({ project: v })} trigger={<span>Move to project</span>} />
        </>
      )}
      {busy && <span className="muted small">Saving…</span>}
      <button type="button" className="ghost-btn bulk-clear" onClick={onClear}>Clear</button>
      {error && <div className="form-error bulk-error" role="alert">{error}</div>}
    </div>
  )
}
