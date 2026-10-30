import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { IssueSummary, PlanSlot } from '../../src/model'
import { callTool, inScope, useScope, useTracker, type TrackerState } from '../client'
import { PLAN_SLOTS, boardColumns, feedActor, feedInScope, feedLine, needsYouWhy, relTime, scopeHome, type HomeData, type NeedsYouItem } from '../home'
import { href } from '../router'
import { CiDot } from '../components/Ci'
import { isOpen } from './Sidebar'

const FEED_SHOWN = 50
const COLUMN_TITLE = { now: 'Now', next: 'Next', later: 'Later' } as const

async function fetchHome(): Promise<HomeData> {
  const r = await fetch('/api/home')
  if (!r.ok) throw new Error(`/api/home failed (${r.status})`)
  return (await r.json()) as HomeData
}

/** `/api/home`, refetched (debounced 100 ms) whenever an issue, removal or meta event changes the live store. */
function useHomeData(state: TrackerState): { data: HomeData | null; error: string } {
  const [data, setData] = useState<HomeData | null>(null)
  const [error, setError] = useState('')
  const seq = useRef(0)
  useEffect(() => {
    if (!state.ready) return
    const mine = ++seq.current
    const t = setTimeout(() => {
      fetchHome().then(
        (d) => { if (mine === seq.current) { setData(d); setError('') } },
        (e: unknown) => { if (mine === seq.current) setError(String(e instanceof Error ? e.message : e)) },
      )
    }, 100)
    return () => clearTimeout(t)
  }, [state.ready, state.issues, state.config])
  return { data, error }
}

const SECTION_SHOWN = 8

/** A bucket list; long ones show the first few with a "show all" toggle. */
function Section({ color, title, items }: { color: string; title: string; items: React.ReactNode[] }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, SECTION_SHOWN)
  return (
    <section className="home-section">
      <h4><span className="dot" style={{ background: color }} />{title} <span className="n">{items.length}</span></h4>
      {items.length === 0 ? <div className="home-empty">Nothing here.</div> : shown}
      {items.length > SECTION_SHOWN && (
        <button className="home-more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${items.length}`}</button>
      )}
    </section>
  )
}

function HomeRow({ issue, right }: { issue: Pick<IssueSummary, 'id' | 'title' | 'ci'>; right?: React.ReactNode }) {
  return (
    <a className="home-row" href={href({ name: 'issue', id: issue.id })}>
      <span className="id">{issue.id}</span>
      <span className="t">{issue.title}</span>
      <CiDot ci={issue.ci} />
      {right}
    </a>
  )
}

/** Why an issue needs the owner: the matching status or label and its age; stalled ones add a "stalled" mark and the reason. */
export function NeedsYouWhy({ state, issue, now }: { state: TrackerState; issue: NeedsYouItem; now: number }) {
  const { why, stalled, ci } = needsYouWhy(issue, state.config?.needsYou, now)
  return (
    <>
      {why && <span className="why">{why}</span>}
      {ci && <span className="ci-why" title={ci}>{ci}</span>}
      {stalled && <span className="stalled-why" title={`Stalled: ${stalled}`}><span className="pill stalled">stalled</span>{stalled}</span>}
    </>
  )
}

export function Home() {
  const state = useTracker()
  const scope = useScope()
  const { data, error } = useHomeData(state)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])
  // Re-render relative times when a live event arrives.
  useEffect(() => { setNow(Date.now()) }, [state.feed])

  const [overrides, setOverrides] = useState<Record<string, PlanSlot>>({})
  const [toast, setToast] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [dragOver, setDragOver] = useState<string | null>(null)
  // Drop an optimistic override once the engine's event confirms it.
  useEffect(() => {
    setOverrides((o) => {
      const keys = Object.keys(o).filter((id) => state.issues.get(id)?.plan === o[id])
      if (!keys.length) return o
      const next = { ...o }
      for (const k of keys) delete next[k]
      return next
    })
  }, [state.issues])

  const home = useMemo(() => (data ? scopeHome(data, scope, state.config) : null), [data, scope, state.config])
  const bucketOf = useMemo(() => {
    const m = new Map<string, 'needs' | 'stalled' | 'ci' | 'blocked'>()
    for (const i of data?.needsYou ?? []) {
      const w = needsYouWhy(i, state.config?.needsYou, 0)
      m.set(i.id, w.why ? 'needs' : w.ci ? 'ci' : 'stalled')
    }
    for (const b of data?.blocked ?? []) m.set(b.issue.id, 'blocked')
    return m
  }, [data, state.config])

  const feed = useMemo(() => state.feed
    .filter((e) => feedInScope(e, state.issues.get(e.id), scope, state.config))
    .slice(0, FEED_SHOWN), [state.feed, state.issues, scope, state.config])

  const columns = useMemo(() => boardColumns(
    [...state.issues.values()].filter((i) => isOpen(state, i.status) && inScope(i, scope, state.config)), overrides,
  ), [state.issues, state.config, scope, overrides]) // eslint-disable-line react-hooks/exhaustive-deps

  const showError = (msg: string) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 6000)
  }
  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const move = async (id: string, plan: PlanSlot) => {
    const current = id in overrides ? overrides[id] : state.issues.get(id)?.plan
    if (current === plan) return
    setOverrides((o) => ({ ...o, [id]: plan }))
    try {
      await callTool('set_plan', { id, plan })
    } catch (e) {
      setOverrides((o) => { const n = { ...o }; delete n[id]; return n })
      showError(`Couldn't move ${id} to ${plan ? COLUMN_TITLE[plan] : 'no plan'}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const onDrop = (slot: PlanSlot) => (ev: DragEvent) => {
    ev.preventDefault()
    setDragOver(null)
    const id = ev.dataTransfer.getData('text/plain')
    if (id && state.issues.has(id)) void move(id, slot)
  }

  return (
    <section className="page home">
      <header className="page-head"><h1>Home</h1><span className="muted">Updates live</span></header>
      {error && <div className="form-error home-pad">{error}</div>}
      <div className="home-top">
        <div className="home-up">
          {!home ? <div className="home-empty">{state.ready ? 'Loading…' : 'Connecting…'}</div> : (
            <>
              <Section color="var(--warn)" title="Needs you" items={home.needsYou.map((i) => (
                <HomeRow key={i.id} issue={i} right={<NeedsYouWhy state={state} issue={i} now={now} />} />
              ))} />
              <Section color="var(--in-progress)" title="In progress" items={home.inProgress.map((i) => (
                <HomeRow key={i.id} issue={i} right={i.touchedBy?.actor === 'agent'
                  ? <span className="pill">{i.touchedBy.workspace ?? 'agent'} · {relTime(i.updated, now)}</span> : undefined} />
              ))} />
              <Section color="var(--ok)" title="Ready next" items={home.readyNext.map(({ issue, unblocks }) => (
                <HomeRow key={issue.id} issue={issue} right={unblocks > 0 ? <span className="ok">unblocks {unblocks}</span> : undefined} />
              ))} />
              <Section color="var(--danger)" title="Blocked" items={home.blocked.map(({ issue, blockers }) => (
                <HomeRow key={issue.id} issue={issue} right={<span className="blk">{blockers.length ? `by ${blockers.join(', ')}` : 'blocked'}</span>} />
              ))} />
            </>
          )}
        </div>
        <aside className="home-feed">
          <h4>Agent activity · live</h4>
          {feed.length === 0 && <div className="home-empty">No activity yet.</div>}
          {feed.map((e, n) => {
            const who = feedActor(e)
            return (
              <a key={`${n}|${e.at}|${e.id}|${e.kind}`} className="home-row feed-row" href={href({ name: 'issue', id: e.id })}>
                <span className="tm">{relTime(e.at, now)}</span>
                <span><span className={who.kind === 'agent' ? 'ag' : 'ag hand'}>{who.label}</span> {feedLine(e, (id) => state.issues.get(id)?.parent)}</span>
              </a>
            )
          })}
        </aside>
      </div>
      <div className="home-board">
        {PLAN_SLOTS.map((slot) => (
          <div
            key={slot}
            className={`board-col${dragOver === slot ? ' over' : ''}`}
            data-plan={slot}
            onDragOver={(ev) => { ev.preventDefault(); if (dragOver !== slot) setDragOver(slot) }}
            onDragLeave={(ev) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setDragOver((d) => (d === slot ? null : d)) }}
            onDrop={onDrop(slot)}
          >
            <h4>{COLUMN_TITLE[slot]} <span className="n">{columns[slot].length}</span></h4>
            {columns[slot].map((i) => <PlanCard key={i.id} issue={i} tag={bucketOf.get(i.id)} />)}
            {columns[slot].length === 0 && <div className="home-empty">Drop issues here.</div>}
          </div>
        ))}
      </div>
      {toast && <div className="toast" role="alert">{toast}<button className="icon-button" aria-label="Dismiss" onClick={() => setToast('')}>×</button></div>}
    </section>
  )
}

function PlanCard({ issue, tag }: { issue: IssueSummary; tag?: 'needs' | 'stalled' | 'ci' | 'blocked' }) {
  return (
    <a
      className="card"
      href={href({ name: 'issue', id: issue.id })}
      draggable
      onDragStart={(ev) => { ev.dataTransfer.setData('text/plain', issue.id); ev.dataTransfer.effectAllowed = 'move' }}
    >
      <span className="id">{issue.id}</span>
      {issue.title}
      {tag === 'needs' && <span className="why"> · decision</span>}
      {tag === 'stalled' && <span className="blk"> · stalled</span>}
      {tag === 'ci' && <span className="blk"> · CI failing</span>}
      {tag === 'blocked' && <span className="blk"> · blocked</span>}
    </a>
  )
}
