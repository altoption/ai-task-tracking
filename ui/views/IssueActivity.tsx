import { useEffect, useMemo, useState } from 'react'
import type { FeedEvent } from '../../src/engine/eventlog'
import { callTool, type ActivityEntry } from '../client'
import { Markdown } from '../components/Markdown'
import { feedActor, relTime } from '../home'
import { activityItems, eventText } from '../issuePage'
import type { MdContext } from '../markdown'

const who = (e: ActivityEntry) => (e.actor === 'you' ? 'you' : (e.workspace ?? e.actor))
const stamp = (iso: string) => { const t = Date.parse(iso); return Number.isNaN(t) ? iso : new Date(t).toLocaleString() }
const ago = (iso: string, now: number) => { const r = relTime(iso, now); return r === 'now' || !r ? 'just now' : `${r} ago` }

/** Comments (markdown) interleaved with field changes from the feed, oldest first, then the comment box. */
export function IssueActivity({ issueId, activity, feed, ctx, onSaved }: {
  issueId: string; activity: ActivityEntry[]; feed: FeedEvent[]; ctx: MdContext; onSaved: () => void
}) {
  const items = useMemo(() => activityItems(activity, feed), [activity, feed])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t) }, [])
  useEffect(() => { setNow(Date.now()) }, [items])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (busy || !draft.trim()) return
    setBusy(true); setError('')
    try {
      await callTool('save_comment', { issueId, body: draft })
      setDraft('')
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    setBusy(false)
  }

  return (
    <section className="activity" aria-label="Activity">
      <h2>Activity</h2>
      {items.length === 0 && <div className="muted small">No activity yet.</div>}
      <ol className="activity-list">
        {items.map((x, n) => {
          if (x.kind === 'event') {
            const a = feedActor(x.event)
            return (
              <li key={`e${n}`} className="act-event">
                <span className="act-dot" />
                <span className={`ag ${a.kind}`}>{a.label}</span> <span className="muted">{eventText(x.event)}</span>
                <time className="tm" dateTime={x.at} title={stamp(x.at)}>· {ago(x.at, now)}</time>
              </li>
            )
          }
          const e = x.entry
          return (
            <li key={`c${n}`} className="act-comment">
              <div className="act-head">
                <span className={`act-avatar ${e.actor === 'you' ? 'you' : 'agent'}`}>{who(e).slice(0, 1).toUpperCase()}</span>
                <span className={`ag ${e.actor === 'you' ? 'you' : 'agent'}`}>{who(e)}</span>
                {e.branch && <span className="pill">{e.branch}</span>}
                <time className="tm" dateTime={e.at} title={stamp(e.at)}>{ago(e.at, now)}</time>
              </div>
              <Markdown source={e.body} ctx={ctx} className="act-body" />
            </li>
          )
        })}
      </ol>
      <form className="comment-box" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <textarea placeholder="Leave a comment… (markdown)" value={draft} rows={3} aria-label="Comment" onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit() } }} />
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="comment-foot">
          <span className="muted small">⌘↩ to send</span>
          <button type="submit" className="primary" disabled={busy || !draft.trim()}>{busy ? 'Sending…' : 'Comment'}</button>
        </div>
      </form>
    </section>
  )
}
