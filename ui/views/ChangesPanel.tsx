import { useEffect, useState } from 'react'
import type { ActivityEntry } from '../../src/model'
import { getChanges, type Changes } from '../client'

/** Ask again this often while a GitHub PR diff is being fetched in the background, at most PENDING_TRIES times. */
const PENDING_MS = 2000
const PENDING_TRIES = 15
/** Files open by default when there are at most this many. */
const OPEN_FILES = 8

/** Fetch the issue's changes; again when the issue changes (an agent wrote) or another branch is picked. */
export function useChanges(id: string, updated: string, enabled: boolean, branch?: string) {
  const [data, setData] = useState<Changes | null>(null)
  const [error, setError] = useState('')
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

/** Whether the issue has anything the panel could show: an agent branch, or a GitHub PR link. */
export function hasChanges(d: { activity: ActivityEntry[]; attempts?: { branch?: string }[]; links: { url: string }[] }): boolean {
  return d.activity.some((e) => e.actor === 'agent' && e.branch) || !!d.attempts?.some((a) => a.branch)
    || d.links.some((l) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(l.url))
}

export const changeTotals = (c: Changes) => {
  const files = c.files ?? []
  return { files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) }
}

const MESSAGES: Partial<Record<Changes['state'], string>> = {
  'no-branch': 'No agent branch recorded on this issue yet.',
  'repo-unknown': "This branch's repo hasn't been seen on this Mac yet. It shows after the agent's next write from it.",
  'branch-gone': 'The branch no longer exists in the repo (merged or deleted).',
  'no-base': 'No base branch found (origin’s default, main or master).',
  same: 'The branch has no commits beyond its base.',
  pending: 'Fetching the PR’s diff with gh…',
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

function DiffBody({ patch }: { patch: string }) {
  const lines = patch.split('\n')
  // The `diff --git`, index and ---/+++ lines repeat the file name: start at the first hunk.
  const start = Math.max(0, lines.findIndex((l) => l.startsWith('@@')))
  return (
    <pre className="diff-body">
      {lines.slice(start).map((l, k) => (
        <span key={k} className={l.startsWith('@@') ? 'dl-hunk' : l.startsWith('+') ? 'dl-add' : l.startsWith('-') ? 'dl-del' : undefined}>{l}{'\n'}</span>
      ))}
    </pre>
  )
}

export function ChangesPanel({ data, error, activity, project, onBranch, onClose }: {
  data: Changes | null; error: string; activity: ActivityEntry[]; project: string
  onBranch: (b: string) => void; onClose: () => void
}) {
  const [zoom, setZoom] = useState<string | null>(null)
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

  const shots = data ? screenshotsOf(activity, project, data.branch) : []
  const t = data ? changeTotals(data) : null
  return (
    <aside className="changes-panel" aria-label="Changes">
      <header className="changes-head">
        <h2>Changes</h2>
        {data && <span className="changes-source">{data.source === 'github' ? <a href={data.url} target="_blank" rel="noreferrer">GitHub PR #{data.pr}{data.prState ? ` · ${data.prState.toLowerCase()}` : ''}</a> : data.repo ? <span title={data.repo}>Local · {data.repo.split('/').pop()}</span> : null}</span>}
        <button type="button" className="ghost-btn changes-close" aria-label="Close changes" onClick={onClose}>×</button>
      </header>
      {error && <div className="form-error" role="alert">{error}</div>}
      {!data && !error && <p className="muted small">Loading…</p>}
      {data && (
        <div className="changes-scroll">
          {data.branch && (
            <p className="changes-summary">
              <code>{data.branch}</code>{data.base && <> ▸ <code>{data.base}</code></>}
              {data.commits && <> · {data.commits.length} commit{data.commits.length === 1 ? '' : 's'}</>}
              {t && t.files > 0 && <> · {t.files} file{t.files === 1 ? '' : 's'} <span className="dl-add">+{t.added}</span> <span className="dl-del">−{t.removed}</span></>}
            </p>
          )}
          {data.branches.length > 1 && (
            <p className="changes-branches small">Other branches on this issue: {data.branches.filter((b) => b !== data.branch).map((b) => (
              <button key={b} type="button" className="ghost-btn inline" onClick={() => onBranch(b)}>{b}</button>
            ))}</p>
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
            <details className="changes-commits">
              <summary>Commits</summary>
              <ul>{data.commits.map((c) => <li key={c.sha}><code>{c.sha.slice(0, 7)}</code> {c.subject} <span className="muted">· {c.author}</span></li>)}</ul>
            </details>
          )}
          {data.files?.map((f) => (
            <details key={`${f.oldPath ?? ''}>${f.path}`} className="diff-file" open={(data.files?.length ?? 0) <= OPEN_FILES}>
              <summary>
                <span className="diff-path">{f.oldPath ? `${f.oldPath} → ` : ''}{f.path}</span>
                {f.binary ? <span className="muted">binary</span> : <><span className="dl-add">+{f.added}</span> <span className="dl-del">−{f.removed}</span></>}
              </summary>
              {f.patch ? <DiffBody patch={f.patch} /> : !f.binary && <p className="muted small">Not shown (the diff was cut off at 2 MB).</p>}
            </details>
          ))}
          {data.truncated && <p className="muted small">The diff is large and was cut off at 2 MB.</p>}
        </div>
      )}
      {zoom && <button type="button" className="shot-zoom" onClick={() => setZoom(null)} aria-label="Close image"><img src={zoom} alt="" /></button>}
    </aside>
  )
}
