/**
 * The Changes panel (src/engine/changes.ts), top to bottom by level: on an issue with sub-issues, whose changes
 * (the issue's own, or one sub-issue's); then the branch (tabs when the issue recorded several); its commits; an
 * outline of the changed files by folder; and each file's diff with line numbers under a header that stays in view.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityEntry, Config, IssueSummary } from '../../src/model'
import { getChanges, type Changes } from '../client'
import { branchKey, changeTotals, fileOutline, patchLines, rollupTotals, statBlocks, type FileKind, type Totals } from '../changes'
import { Icon, StatusIcon } from '../components/icons'

export { changeTotals }

/** Ask again this often while a GitHub PR diff is being fetched in the background, at most PENDING_TRIES times. */
const PENDING_MS = 2000
const PENDING_TRIES = 15
/** Files open by default when there are at most this many. */
const OPEN_FILES = 8
/** Sub-issues whose changes an epic reads when its page opens. */
const ROLLUP_MAX = 24

/** Fetch the issue's changes; again when the issue changes (an agent wrote) or another branch is picked. */
export function useChanges(id: string, updated: string, enabled: boolean, branch?: string) {
  const [data, setData] = useState<Changes | null>(null)
  const [error, setError] = useState('')
  // Another issue or branch: drop what's shown. An update to the same one swaps in place (open files stay open).
  useEffect(() => { setData(null); setError('') }, [id, branch])
  useEffect(() => {
    if (!enabled) return
    let alive = true
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      getChanges(id, branch).then((c) => {
        if (!alive) return
        setData(c); setError('')
        if (c.state === 'pending' && ++tries < PENDING_TRIES) timer = setTimeout(load, PENDING_MS)
      }, (e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    }
    load()
    return () => { alive = false; clearTimeout(timer) }
  }, [id, updated, enabled, branch])
  return { data, error }
}

/**
 * The changes of each sub-issue (the first ROLLUP_MAX), for an epic's badge and its panel's list. Read again when a
 * sub-issue changes (`sig`: their ids and `updated` stamps). A sub-issue that can't be read is left out.
 */
export function useRollup(ids: readonly string[], sig: string): ReadonlyMap<string, Changes> {
  const [map, setMap] = useState<ReadonlyMap<string, Changes>>(() => new Map())
  useEffect(() => {
    let alive = true
    const list = ids.slice(0, ROLLUP_MAX)
    if (!list.length) { setMap(new Map()); return }
    void Promise.all(list.map((id) => getChanges(id).then((c) => [id, c] as const, () => null))).then((rows) => {
      if (alive) setMap(new Map(rows.filter((r): r is readonly [string, Changes] => r !== null)))
    })
    return () => { alive = false }
  }, [sig]) // eslint-disable-line react-hooks/exhaustive-deps -- `sig` stands for `ids`
  return map
}

/** Whether the issue has anything the panel could show: an agent branch, or a GitHub PR link. */
export function hasChanges(d: { activity: ActivityEntry[]; attempts?: { branch?: string }[]; links: { url: string }[] }): boolean {
  return d.activity.some((e) => e.actor === 'agent' && e.branch) || !!d.attempts?.some((a) => a.branch)
    || d.links.some((l) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(l.url))
}

/** The header badge of an issue with sub-issues: its own changes and theirs, each branch counted once. */
export function rollupBadge(own: Changes | null, kids: ReadonlyMap<string, Changes>): Totals & { branches: number } {
  return rollupTotals([...(own ? [own] : []), ...kids.values()])
}

const MESSAGES: Partial<Record<Changes['state'], string>> = {
  'no-branch': 'No agent branch recorded on this issue yet.',
  'repo-unknown': "This branch's repo hasn't been seen on this Mac yet. It shows after the agent's next write from it.",
  'branch-gone': 'The branch no longer exists in the repo (merged or deleted).',
  'no-base': 'No base branch found (origin’s default, main or master).',
  same: 'The branch has no commits beyond its base.',
  pending: 'Fetching the PR’s diff with gh…',
}
/** The same states in a few words, for a sub-issue's row. */
const SHORT: Partial<Record<Changes['state'], string>> = {
  'no-branch': 'no branch yet', 'repo-unknown': 'repo not on this Mac', 'branch-gone': 'branch merged or deleted',
  'no-base': 'no base branch', same: 'no commits yet', pending: 'fetching…', error: 'couldn’t read', 'unknown-branch': 'no branch yet',
}

/** Images agents attached in comments written on `branch` (markdown `![alt](../files/name)`). */
function screenshotsOf(activity: ActivityEntry[], project: string, branch?: string) {
  const out: { src: string; alt: string }[] = []
  for (const e of activity) {
    if (e.actor !== 'agent' || (branch && e.branch && e.branch !== branch)) continue
    for (const m of e.body.matchAll(/!\[([^\]]*)\]\(\.\.\/files\/([^)\s]+)\)/g)) {
      out.push({ src: `/files/${encodeURIComponent(project)}/${m[2]}`, alt: m[1] || m[2]! })
    }
  }
  return out
}

const KIND: Record<FileKind, { letter: string; label: string }> = {
  added: { letter: 'A', label: 'Added' }, deleted: { letter: 'D', label: 'Deleted' }, renamed: { letter: 'R', label: 'Renamed' }, modified: { letter: 'M', label: 'Modified' },
}
/** The scopes grouped by the branch (or PR) their changes come from, in first-seen order; unread ones stay apart. */
export function branchRows(scopes: readonly ChangeScope[]): { key: string; changes: Changes | null; scopes: ChangeScope[] }[] {
  const rows = new Map<string, { key: string; changes: Changes | null; scopes: ChangeScope[] }>()
  for (const s of scopes) {
    const key = (s.changes && branchKey(s.changes)) ?? `issue:${s.issue.id}`
    const r = rows.get(key)
    if (r) r.scopes.push(s)
    else rows.set(key, { key, changes: s.changes, scopes: [s] })
  }
  return [...rows.values()]
}

const MARK = { add: '+', del: '−', ctx: '', hunk: '', note: '' } as const

function Stat({ added, removed }: { added: number; removed: number }) {
  return <span className="diff-stat"><span className="dl-add">+{added}</span> <span className="dl-del">−{removed}</span></span>
}

function DiffBody({ patch }: { patch: string }) {
  const lines = useMemo(() => patchLines(patch), [patch])
  const width = String(lines.reduce((m, l) => Math.max(m, l.old ?? 0, l.new ?? 0), 0)).length
  const row = { gridTemplateColumns: `calc(${width}ch + 14px) calc(${width}ch + 10px) 16px max-content` }
  return (
    <div className="diff-body">
      {lines.map((l, k) => (l.kind === 'hunk'
        // A hunk at the top of the file has nothing skipped above it: no divider.
        ? k === 0 && !l.text && ((lines[1]?.old ?? lines[1]?.new ?? 2) <= 1) ? null : <div key={k} className="dl dl-hunk" style={row}><span className="d-num" /><span className="d-num" /><span className="d-mark">⋯</span><code>{l.text}</code></div>
        : <div key={k} className={`dl dl-${l.kind}`} style={row}><span className="d-num">{l.old ?? ''}</span><span className="d-num">{l.new ?? ''}</span><span className="d-mark">{MARK[l.kind]}</span><code>{l.kind === 'note' ? l.text : l.text || ' '}</code></div>))}
    </div>
  )
}

export interface ChangeScope { issue: Pick<IssueSummary, 'id' | 'title' | 'status'>; own: boolean; changes: Changes | null }

/**
 * On an issue with sub-issues: whose changes to show. A diff belongs to a branch, not to a step, so there is one row
 * per branch, naming the issue and sub-issues that worked on it; sub-issues with a branch that can't be read
 * (deleted, repo not here) get a row each saying why.
 */
function Scopes({ scopes, current, onPick, config }: { scopes: ChangeScope[]; current: string; onPick: (id: string) => void; config: Config | null }) {
  const rows = useMemo(() => branchRows(scopes), [scopes])
  return (
    <ul className="changes-scopes" aria-label="Branches on this issue and its sub-issues">
      {rows.map((r) => {
        const c = r.changes
        const t = c?.files?.length ? changeTotals(c) : null
        const on = r.scopes.some((x) => x.issue.id === current)
        return (
          <li key={r.key}>
            <button type="button" className={`scope-row${on ? ' on' : ''}`} aria-pressed={on} onClick={() => onPick(r.scopes[0]!.issue.id)}
              title={r.scopes.map((x) => (x.own ? 'This issue' : `${x.issue.id} ${x.issue.title}`)).join('\n')}>
              {c?.branch ? <code>{c.branch}</code> : <code className="muted">no branch</code>}
              <span className="scope-who">{r.scopes.map((x) => <span key={x.issue.id}><StatusIcon status={x.issue.status} config={config} size={12} />{x.own ? 'this issue' : x.issue.id}</span>)}</span>
              {t ? <span className="scope-stat">{t.files} file{t.files === 1 ? '' : 's'} <Stat added={t.added} removed={t.removed} /></span>
                : <span className="scope-stat">{c ? SHORT[c.state] ?? 'no changes' : '…'}</span>}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function ChangesPanel({ data, error, activity, project, onBranch, onClose, scopes, scope, onScope, config }: {
  data: Changes | null; error: string; activity: ActivityEntry[]; project: string
  onBranch: (b: string) => void; onClose: () => void
  /** An issue with sub-issues: the rows to choose from, the chosen issue id, and the choice. */
  scopes?: ChangeScope[]; scope?: string; onScope?: (id: string) => void; config?: Config | null
}) {
  const [zoom, setZoom] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (zoom) { setZoom(null); return }
      // Esc in the comment box or a picker belongs to that field.
      const t = e.target as HTMLElement | null
      if (!t?.closest('input, textarea, select, [role="dialog"], [role="listbox"]')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom, onClose])

  const files = data?.files ?? []
  const outline = useMemo(() => fileOutline(files), [files])
  const most = files.reduce((m, f) => Math.max(m, f.added + f.removed), 0)
  const shots = data ? screenshotsOf(activity, project, data.branch) : []
  const t = data ? changeTotals(data) : null
  // With sub-issues, the list above is the branch level: no second set of tabs under it.
  const tabs = !!data && data.branches.length > 1 && !scopes?.length
  const fileEls = () => [...(scroller.current?.querySelectorAll<HTMLDetailsElement>('details.diff-file') ?? [])]
  const jump = (index: number) => {
    const el = fileEls()[index]
    if (!el) return
    el.open = true
    el.scrollIntoView({ block: 'start' })
  }
  const [allOpen, setAllOpen] = useState(true)
  useEffect(() => setAllOpen(files.length <= OPEN_FILES), [files])
  const toggleAll = () => { const next = !allOpen; for (const el of fileEls()) el.open = next; setAllOpen(next) }
  return (
    <aside className="changes-panel" aria-label="Changes">
      <header className="changes-head">
        <h2>Changes</h2>
        {data && <span className="changes-source">{data.source === 'github' ? <a href={data.url} target="_blank" rel="noreferrer">GitHub PR #{data.pr}{data.prState ? ` · ${data.prState.toLowerCase()}` : ''}</a> : data.repo ? <span title={data.repo}>Local · {data.repo.split('/').pop()}</span> : null}</span>}
        <button type="button" className="ghost-btn changes-close" aria-label="Close changes" onClick={onClose}>×</button>
      </header>
      <div className="changes-scroll" ref={scroller}>
        {scopes && scopes.length > 0 && onScope && <Scopes scopes={scopes} current={scope ?? ''} onPick={onScope} config={config ?? null} />}
        {error && <div className="form-error" role="alert">{error}</div>}
        {!data && !error && <p className="muted small">Loading…</p>}
        {data && (
          <>
            {tabs && (
              <div className="branch-tabs" role="tablist" aria-label="Branches on this issue">
                {data.branches.map((b) => (
                  <button key={b} type="button" role="tab" aria-selected={b === data.branch} className={b === data.branch ? 'on' : ''} onClick={() => { if (b !== data.branch) onBranch(b) }}><code>{b}</code></button>
                ))}
              </div>
            )}
            {data.branch && (
              <p className="changes-summary">
                {!tabs && <code>{data.branch}</code>}
                {data.base && <span className="muted">{tabs ? '' : ' '}into <code>{data.base}</code></span>}
                {data.commits && <span className="muted"> · {data.commits.length} commit{data.commits.length === 1 ? '' : 's'}</span>}
                {t && t.files > 0 && <span className="muted"> · {t.files} file{t.files === 1 ? '' : 's'} <Stat added={t.added} removed={t.removed} /></span>}
              </p>
            )}
            {data.state === 'error' && <div className="form-error" role="alert">{data.error ?? 'Could not read the changes.'}</div>}
            {MESSAGES[data.state] && <p className="muted small">{MESSAGES[data.state]}</p>}
            {data.source === 'github' && data.local === 'repo-unknown' && <p className="muted small">The repo isn't on this Mac, so this is the linked PR's diff.</p>}
            {shots.length > 0 && (
              <div className="changes-shots">
                {shots.map((s) => <button key={s.src} type="button" className="shot" onClick={() => setZoom(s.src)} title={s.alt}><img src={s.src} alt={s.alt} /><span>{s.alt}</span></button>)}
              </div>
            )}
            {!!data.commits?.length && (
              <details className="changes-commits" open={data.commits.length <= 3}>
                <summary>{data.commits.length === 1 ? 'Commit' : `${data.commits.length} commits`}</summary>
                <ul>{data.commits.map((c) => <li key={c.sha}><code>{c.sha.slice(0, 7)}</code><span className="t">{c.subject}</span><span className="muted">{c.author}</span></li>)}</ul>
              </details>
            )}
            {files.length > 1 && (
              <nav className="changes-outline" aria-label="Changed files">
                <div className="outline-head">
                  <span>{files.length} files</span>
                  <button type="button" className="ghost-btn" onClick={toggleAll}>{allOpen ? 'Collapse all' : 'Expand all'}</button>
                </div>
                {outline.map((d) => (
                  <div key={d.dir} className="outline-dir">
                    {d.dir && <div className="outline-dirname">{d.dir}/</div>}
                    {d.files.map(({ file: f, name, index, kind }) => {
                      const b = statBlocks(f.added, f.removed, most)
                      return (
                        <button key={f.path} type="button" className={`outline-file${d.dir ? ' in' : ''}`} onClick={() => jump(index)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                          <span className={`fk fk-${kind}`} title={KIND[kind].label}>{KIND[kind].letter}</span>
                          <span className="t">{name}</span>
                          {f.binary ? <span className="muted">binary</span> : <><Stat added={f.added} removed={f.removed} /><span className="blocks" aria-hidden="true">{Array.from({ length: 5 }, (_, k) => <i key={k} className={k < b.add ? 'a' : k < b.add + b.del ? 'd' : ''} />)}</span></>}
                        </button>
                      )
                    })}
                  </div>
                ))}
              </nav>
            )}
            {outline.flatMap((d) => d.files).sort((a, b) => a.index - b.index).map(({ file: f, kind }) => (
              <details key={`${f.oldPath ?? ''}>${f.path}`} className="diff-file" open={files.length <= OPEN_FILES}>
                <summary>
                  <span className="diff-chev"><Icon name="chevron" size={12} /></span>
                  <span className={`fk fk-${kind}`} title={KIND[kind].label}>{KIND[kind].letter}</span>
                  <span className="diff-path">{f.oldPath ? <span className="muted">{f.oldPath} → </span> : null}{f.path.includes('/') && <span className="muted">{f.path.slice(0, f.path.lastIndexOf('/') + 1)}</span>}{f.path.slice(f.path.lastIndexOf('/') + 1)}</span>
                  {f.binary ? <span className="muted">binary</span> : <Stat added={f.added} removed={f.removed} />}
                </summary>
                {f.patch ? <DiffBody patch={f.patch} /> : !f.binary && <p className="muted small diff-none">Not shown (the diff was cut off at 2 MB).</p>}
              </details>
            ))}
            {data.truncated && <p className="muted small">The diff is large and was cut off at 2 MB.</p>}
          </>
        )}
      </div>
      {zoom && <button type="button" className="shot-zoom" onClick={() => setZoom(null)} aria-label="Close image"><img src={zoom} alt="" /></button>}
    </aside>
  )
}
