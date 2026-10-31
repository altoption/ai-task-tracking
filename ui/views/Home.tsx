/**
 * Home, the Daily overview (ATT-53): the date and a one-line summary; Needs you first (each request with what it asks
 * and how long it has waited), then In progress and Ready next with their full lists, Agent activity beside them, and
 * Blocked work as dependency chains; the Now / Next / Later plan below. Two columns, one on a phone (styles.css `.ov-`).
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { IssueSummary, PlanSlot } from '../../src/model'
import { callTool, inScope, useScope, useTracker, type TrackerState } from '../client'
import {
  PLAN_SLOTS, blockedChains, boardColumns, dayHeading, daySummary, listHref, needsYouCard, needsYouWhy, relTime, scopeHome,
  statusesOf, type HomeData, type NeedsYouCard, type NeedsYouItem,
} from '../home'
import { href, navigate } from '../router'
import { CiDot } from '../components/Ci'
import { Icon, StatusIcon } from '../components/icons'
import { Activity, useActivity } from './Activity'
import { isOpen } from './Sidebar'

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

/** How many rows each overview list shows before its "Show all" / full-list link. */
const NEEDS_SHOWN = 3
const LIST_SHOWN = 3

/** A list section's title: the heading, its count, and "Showing N" when the list is cut. */
function SectionTitle({ id, title, count, shown, mark }: { id: string; title: string; count: number; shown: number; mark?: boolean }) {
  return (
    <div className="ov-title">
      <h2 id={id}>{mark && <span className="ov-mark" aria-hidden="true" />}{title} <span className="ov-count">{count}</span></h2>
      {count > shown && <span className="ov-subtle">Showing {shown}</span>}
    </div>
  )
}

/** One Needs-you request: issue and project, the status chip, the title, what it asks, how long it waited, and the action. */
export function NeedsYouRequest({ issue, card, featured, project }: { issue: NeedsYouItem; card: NeedsYouCard; featured: boolean; project: string }) {
  const open = () => navigate({ name: 'issue', id: issue.id })
  return (
    <article className={`ov-request${featured ? ' featured' : ''}`} aria-labelledby={`ny-${issue.id}`}>
      <div className="ov-meta">
        <span>{issue.id}{project && <><span className="ov-sep" aria-hidden="true">·</span>{project}</>}</span>
        <span className="ov-status">{card.status}</span>
      </div>
      <h3 id={`ny-${issue.id}`}><a href={href({ name: 'issue', id: issue.id })}>{issue.title}</a></h3>
      {card.summary && <p>{card.summary}</p>}
      {card.stalled && card.summary !== card.stalled && <p className="stalled-why">{card.status !== 'Stalled' && <span className="pill stalled">stalled</span>}{card.stalled}</p>}
      <div className="ov-action-line">
        <span className="ov-subtle">{card.age}</span>
        <button type="button" className={`ov-action${featured ? ' primary' : ''}`} onClick={open}
          aria-label={`${card.action}: ${issue.id} ${issue.title}`}>
          {card.action} <Icon name="forward" size={12} />
        </button>
      </div>
    </article>
  )
}

function WorkRow({ issue, state, right }: { issue: IssueSummary; state: TrackerState; right?: React.ReactNode }) {
  const project = state.projects.find((p) => p.slug === issue.project)?.name
  return (
    <li className="ov-row">
      <StatusIcon status={issue.status} config={state.config} />
      <a className="ov-row-main" href={href({ name: 'issue', id: issue.id })}>
        <span className="ov-row-title">{issue.title}</span>
        <small>{issue.id}{project && ` · ${project}`}</small>
      </a>
      <CiDot ci={issue.ci} />
      {right}
    </li>
  )
}

const PRIORITY = ['', 'Urgent', 'High', 'Medium', 'Low']

export function Home() {
  const state = useTracker()
  const scope = useScope()
  const { data, error } = useHomeData(state)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])
  // Re-render relative times when a live event arrives.
  useEffect(() => { setNow(Date.now()) }, [state.feed])
  const [allNeeds, setAllNeeds] = useState(false)

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
  const activity = useActivity(home?.needsYou ?? null, now)
  const bucketOf = useMemo(() => {
    const m = new Map<string, 'needs' | 'stalled' | 'ci' | 'blocked'>()
    for (const i of data?.needsYou ?? []) {
      const w = needsYouWhy(i, state.config?.needsYou, 0)
      m.set(i.id, w.why ? 'needs' : w.ci ? 'ci' : 'stalled')
    }
    for (const b of data?.blocked ?? []) m.set(b.issue.id, 'blocked')
    return m
  }, [data, state.config])
  const chains = useMemo(() => (home ? blockedChains(home.blocked, (id) => state.issues.get(id), (id) => {
    const i = state.issues.get(id)
    return !!i && isOpen(state, i.status)
  }) : []), [home, state.issues]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const projectName = (slug: string) => state.projects.find((p) => p.slug === slug)?.name ?? ''
  const titleOf = (id: string) => state.issues.get(id)?.title
  const needs = home ? (allNeeds ? home.needsYou : home.needsYou.slice(0, NEEDS_SHOWN)) : []
  const working = statusesOf(state.config, ['started'])
  const ready = statusesOf(state.config, ['backlog', 'unstarted'])

  return (
    <section className="page home" aria-labelledby="home-title">
      <header className="ov-heading">
        <div className="ov-eyebrow">{dayHeading(now)}</div>
        <h1 id="home-title">Your work, in motion.</h1>
        <p>{home ? daySummary({ finished: activity.today.finished, inProgress: home.inProgress.length, needsYou: home.needsYou.length }) : state.ready ? 'Loading…' : 'Connecting…'}</p>
      </header>
      {error && <div className="form-error home-pad">{error}</div>}
      <div className="ov-layout">
        <section className="ov-needs" aria-labelledby="ov-needs-h">
          <SectionTitle id="ov-needs-h" title="Needs you" count={home?.needsYou.length ?? 0} shown={needs.length} mark />
          {home && home.needsYou.length === 0 && <p className="home-empty">Nothing needs you right now.</p>}
          {needs.map((i, n) => (
            <NeedsYouRequest key={i.id} issue={i} card={needsYouCard(i, state.config?.needsYou, now)} featured={n === 0} project={projectName(i.project)} />
          ))}
          {home && home.needsYou.length > NEEDS_SHOWN && (
            <button type="button" className="ov-more" aria-expanded={allNeeds} onClick={() => setAllNeeds(!allNeeds)}>
              {allNeeds ? 'Show fewer' : `Show all ${home.needsYou.length}`}
            </button>
          )}
        </section>

        <section className="ov-progress" aria-labelledby="ov-progress-h">
          <SectionTitle id="ov-progress-h" title="In progress" count={home?.inProgress.length ?? 0} shown={Math.min(LIST_SHOWN, home?.inProgress.length ?? 0)} />
          {home && home.inProgress.length === 0 && <p className="home-empty">Nothing in progress.</p>}
          <ul className="ov-rows">
            {home?.inProgress.slice(0, LIST_SHOWN).map((i) => (
              <WorkRow key={i.id} issue={i} state={state} right={<span className="ov-row-time" title={`Updated ${new Date(i.updated).toLocaleString()}`}>{relTime(i.updated, now)}</span>} />
            ))}
          </ul>
          {working.length > 0 && <a className="ov-more" href={listHref({ status: working })}>All in progress</a>}
        </section>

        <Activity data={activity} now={now} />

        <section className="ov-next" aria-labelledby="ov-next-h">
          <SectionTitle id="ov-next-h" title="Ready next" count={home?.readyNext.length ?? 0} shown={Math.min(LIST_SHOWN, home?.readyNext.length ?? 0)} />
          {home && home.readyNext.length === 0 && <p className="home-empty">Nothing ready.</p>}
          <ul className="ov-rows">
            {home?.readyNext.slice(0, LIST_SHOWN).map(({ issue, unblocks }) => (
              <WorkRow key={issue.id} issue={issue} state={state} right={
                <span className="ov-chips">
                  {unblocks > 0 && <span className="ov-unblocks">Unblocks {unblocks}</span>}
                  {issue.priority > 0 && issue.priority <= 2 && <span className="ov-priority">{PRIORITY[issue.priority]}</span>}
                </span>
              } />
            ))}
          </ul>
          {ready.length > 0 && <a className="ov-more" href={listHref({ status: ready, blocked: false })}>All ready</a>}
          {home && home.blocked.length > 0 && (
            <details className="ov-blocked">
              <summary>Blocked work <span className="ov-count">{home.blocked.length}</span></summary>
              <ul className="ov-chains">
                {chains.map((c) => (
                  <li key={c.ids.join('>')} aria-label={`${c.ids.join(' blocks ')}`}>
                    {c.ids.map((id, n) => (
                      <span key={id} className="ov-link">
                        {n > 0 && <span className="ov-arrow" aria-hidden="true">→</span>}
                        <a href={href({ name: 'issue', id })}><span className="ov-chain-id">{id}</span> {titleOf(id) ?? ''}</a>
                      </span>
                    ))}
                    {c.more > 0 && <span className="ov-subtle"> (+{c.more} more {c.more === 1 ? 'blocker' : 'blockers'})</span>}
                  </li>
                ))}
              </ul>
              <a className="ov-more" href={listHref({ blocked: true })}>All blocked</a>
            </details>
          )}
        </section>
      </div>

      <section className="ov-plan" aria-labelledby="ov-plan-h">
        <div className="ov-title"><h2 id="ov-plan-h">Plan</h2><span className="ov-subtle">Drag issues between Now, Next and Later</span></div>
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
              <h3>{COLUMN_TITLE[slot]} <span className="n">{columns[slot].length}</span></h3>
              {columns[slot].map((i) => <PlanCard key={i.id} issue={i} tag={bucketOf.get(i.id)} />)}
              {columns[slot].length === 0 && <div className="home-empty">Drop issues here.</div>}
            </div>
          ))}
        </div>
      </section>
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
