import { useState } from 'react'
import type { AttemptOut } from '../../src/engine/attempts'
import { relTime } from '../home'
import { attemptsSummary } from '../issuePage'

const ago = (iso: string, now: number) => { const r = relTime(iso, now); return !r || r === 'now' ? 'just now' : `${r} ago` }

/**
 * "3 attempts · 2 tools", expandable to one line per attempt (newest first): tool, repo and branch, when, writes and
 * the status it left the issue in. Nothing without attempts.
 */
export function IssueAttempts({ attempts, now }: { attempts: AttemptOut[] | undefined; now: number }) {
  const [open, setOpen] = useState(false)
  if (!attempts?.length) return null
  return (
    <section className="attempts" aria-label="Attempts">
      <button type="button" className="attempts-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`chev${open ? ' open' : ''}`}>›</span>{attemptsSummary(attempts)}
      </button>
      {open && (
        <ol className="attempts-list">
          {[...attempts].reverse().map((a, k) => (
            <li key={`${a.first}-${k}`}>
              <span className="tool">{a.client ?? 'agent'}</span>
              {a.workspace && <span className="ws">{a.workspace}</span>}
              {a.branch && <span className="pill">{a.branch}</span>}
              <span className="when" title={`${a.first} – ${a.last}`}>{ago(a.last, now)}</span>
              <span className="writes">{a.writes} write{a.writes === 1 ? '' : 's'}</span>
              {a.leftStatus && <span className="left">left it {a.leftStatus}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
