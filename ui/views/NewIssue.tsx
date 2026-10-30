import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { callTool, listedProjects, useScope, useTracker } from '../client'
import { navigate } from '../router'
import { PRIORITIES } from '../components/icons'

/** Pure: the save_issue args for the new-issue form (empty optional fields omitted). */
export function newIssueArgs(f: { title: string; project: string; labels: string[]; status: string; priority: number; parent: string; description: string }) {
  const args: Record<string, unknown> = { title: f.title.trim(), project: f.project, labels: f.labels, priority: f.priority }
  if (f.status) args.state = f.status
  if (f.parent.trim()) args.parentId = f.parent.trim().toUpperCase()
  if (f.description.trim()) args.description = f.description
  return args
}

/** `parent` (from `#/new?parent=Q-269`, the issue page's "Add sub-issue") prefills the parent and its project; creating then returns to the parent. */
export function NewIssueDialog({ onClose, parent: parentId }: { onClose: () => void; parent?: string }) {
  const state = useTracker()
  const scope = useScope()
  const parentProject = parentId ? state.issues.get(parentId)?.project : undefined
  const defaultProject = parentProject ? parentProject
    : scope.kind === 'project' ? scope.slug
    : scope.kind === 'workspace' ? (state.config?.workspaces[scope.name] ?? '') : ''
  const [title, setTitle] = useState('')
  const [project, setProject] = useState(defaultProject)
  const [labels, setLabels] = useState<string[]>([])
  const [labelDraft, setLabelDraft] = useState('')
  const [status, setStatus] = useState('Todo')
  const [priority, setPriority] = useState(0)
  const [parent, setParent] = useState(parentId ?? '')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { titleRef.current?.focus() }, [])
  // The snapshot may land after the dialog opens.
  const projects = useMemo(() => listedProjects(state.projects), [state.projects])
  useEffect(() => { if (!project && projects[0]) setProject(defaultProject || projects[0].slug) }, [projects, defaultProject])
  useEffect(() => { if (state.config && !state.config.statuses.some((s) => s.name === status)) setStatus(state.config.statuses[0]?.name ?? '') }, [state.config])

  const parents = useMemo(() => [...state.issues.values()].filter((i) => !project || i.project === project).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 300), [state.issues, project])

  const addLabel = (raw: string) => {
    const name = raw.trim().replace(/,$/, '').trim()
    if (name && !labels.some((l) => l.toLowerCase() === name.toLowerCase())) setLabels([...labels, name])
    setLabelDraft('')
  }

  async function submit() {
    if (busy) return
    const pending = labelDraft.trim() ? [...labels, labelDraft.trim()] : labels
    if (!title.trim()) { setError('Add a title.'); titleRef.current?.focus(); return }
    setBusy(true); setError('')
    try {
      const out = await callTool<{ id: string }>('save_issue', newIssueArgs({ title, project, labels: pending, status, priority, parent, description }))
      navigate({ name: 'issue', id: parentId && parent.trim().toUpperCase() === parentId ? parentId : out.id })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit() }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="dialog new-issue" role="dialog" aria-modal="true" aria-label="New issue" onKeyDown={onKey} onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <div className="dialog-head">
          <select className="ghost" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
            {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
          </select>
          <span className="muted">› New issue</span>
          <button type="button" className="icon-button close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <input ref={titleRef} className="title-input" placeholder="Issue title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); descRef.current?.focus() } }} />
        <textarea ref={descRef} className="desc-input" placeholder="Add description… (markdown)" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Description" rows={6} />
        <div className="props">
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            {(state.config?.statuses ?? []).map((s) => <option key={s.name}>{s.name}</option>)}
          </select>
          <select value={priority} onChange={(e) => setPriority(Number(e.target.value))} aria-label="Priority">
            {PRIORITIES.map((p, n) => <option key={p} value={n}>{p}</option>)}
          </select>
          <div className="labels-input">
            {labels.map((l) => <span key={l} className="chip">{l}<button type="button" onClick={() => setLabels(labels.filter((x) => x !== l))} aria-label={`Remove ${l}`}>×</button></span>)}
            <input list="label-options" placeholder={labels.length ? '' : 'Labels'} value={labelDraft} aria-label="Labels"
              onChange={(e) => { if (e.target.value.endsWith(',')) addLabel(e.target.value); else setLabelDraft(e.target.value) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); addLabel(labelDraft) }
                else if (e.key === 'Backspace' && !labelDraft && labels.length) setLabels(labels.slice(0, -1))
              }} />
            <datalist id="label-options">{state.labels.map((l) => <option key={l.name} value={l.name} />)}</datalist>
          </div>
          <input className="parent-input" list="parent-options" onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) e.preventDefault() }} placeholder="Parent (e.g. Q-269)" value={parent} onChange={(e) => setParent(e.target.value)} aria-label="Parent" />
          <datalist id="parent-options">{parents.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}</datalist>
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="dialog-foot">
          <span className="muted">⌘↩ to create · Esc to cancel</span>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create issue'}</button>
        </div>
      </form>
    </div>
  )
}
