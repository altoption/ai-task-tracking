/**
 * Home's Agent activity (the Daily overview, ATT-53): today's counts, the live session and what it is working on, what
 * finished last, and Session details: the range, the rhythm, filter chips, then one card per agent session per day
 * with one row per issue. Grouping is pure (ui/activity.ts). Needs you, on Home's left, covers what waits on you.
 *
 * Data: `/api/feed?since=` for the range (visibility-filtered by the engine, up to FEED_SINCE_MAX entries). Every live
 * update is folded into what the column has gathered, so new writes slot into their session's card as they happen and
 * stay there after the store's live feed (its newest 200) moves on.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { FeedEvent } from '../../src/engine/eventlog'
import { FEED_SINCE_MAX } from '../../src/shared/feed'
import {
  buildActivity, dayOverview, filterCard, mergeFeeds, rangeStart, rhythm, spanLabel, waitingOnYou,
  type ActivityFilter, type ActivityRow, type DayGroup, type DayOverview, type Range, type RhythmBucket, type SessionCard,
} from '../activity'
import { useScope, useTracker, type TrackerState } from '../client'
import { Icon, ProgressPill, StatusIcon } from '../components/icons'
import { feedInScope, relTime, type NeedsYouItem } from '../home'
import { href, navigate } from '../router'

/** Rows a card shows before "Show N more". */
const ROWS_SHOWN = 10
const RANGE_KEY = 'tracker.activityRange'

function readRange(): Range {
  try { return globalThis.localStorage?.getItem(RANGE_KEY) === 'week' ? 'week' : 'today' } catch { return 'today' }
}

/**
 * The range's events: fetched per range (and after a snapshot reload: hiding changes what's visible), then every live
 * update folded in, so nothing drops out when the store's live feed (200) moves past it.
 */
function useRangeFeed(state: TrackerState, range: Range, now: number): { events: FeedEvent[]; capped: boolean; since: number; loaded: boolean } {
  const since = rangeStart(range, now)
  const [gathered, setGathered] = useState<{ since: number; events: FeedEvent[]; capped: boolean } | null>(null)
  const feed = useRef(state.feed)
  feed.current = state.feed
  useEffect(() => {
    if (!state.ready) return
    let live = true
    fetch(`/api/feed?since=${encodeURIComponent(new Date(since).toISOString())}&limit=${FEED_SINCE_MAX}`)
      .then((r) => (r.ok ? r.json() as Promise<FeedEvent[]> : []))
      .then((events) => { if (live) setGathered({ since, events: mergeFeeds(events, feed.current, since), capped: events.length >= FEED_SINCE_MAX }) }, () => {})
    return () => { live = false }
  }, [state.ready, since, state.config, state.connected])
  useEffect(() => {
    setGathered((g) => (g && g.since === since ? { ...g, events: mergeFeeds(g.events, state.feed, since) } : g))
  }, [state.feed, since])
  const events = useMemo(() => (gathered?.since === since ? gathered.events : mergeFeeds([], state.feed, since)), [gathered, state.feed, since])
  return { events, capped: gathered?.since === since && gathered.capped, since, loaded: gathered?.since === since }
}

const PATH_LIMIT = 4

function Path({ path }: { path: string[] }) {
  const shown = path.length > PATH_LIMIT ? [path[0]!, '…', ...path.slice(-(PATH_LIMIT - 2))] : path
  return (
    <span className="act-path" aria-label={`Went ${path.join(' to ')}`}>
      {shown.map((s, i) => <span key={i}>{i > 0 && <i aria-hidden="true">→</i>}{s}</span>)}
    </span>
  )
}

function Row({ row, state, now, child }: { row: ActivityRow; state: TrackerState; now: number; child?: boolean }) {
  const [open, setOpen] = useState(false)
  // The row opens the issue; its links, chips and the note keep their own behaviour.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (row.gone || (e.target as HTMLElement).closest('a, button')) return
    navigate({ name: 'issue', id: row.id })
  }
  return (
    <div className={`act-row${child ? ' child' : ''}${row.gone ? ' gone' : ''}`} onClick={onClick}>
      <StatusIcon status={row.status} config={state.config} />
      <div className="act-main">
        {row.gone
          ? <span className="act-line gone"><span className="act-id">{row.id}</span><s className="act-title">{row.title}</s><span className="sr-only"> (deleted)</span></span>
          : <a className="act-line" href={href({ name: 'issue', id: row.id })}><span className="act-id">{row.id}</span><span className="act-title">{row.title}</span></a>}
        {(row.path.length > 0 || row.detail || row.progress || row.links.length > 0) && (
          <div className="act-sub">
            {row.path.length > 0 && <Path path={row.path} />}
            {row.detail && <span>{row.detail}</span>}
            {row.progress && <ProgressPill done={row.progress.done} total={row.progress.total} config={state.config} />}
            {row.links.map((l) => <a key={l.url} className="act-chip" href={l.url} target="_blank" rel="noreferrer">{l.title}</a>)}
          </div>
        )}
        {row.note !== undefined && (
          <button type="button" className={`act-quote${open ? ' open' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
            {row.note}{!open && <span className="sr-only"> (expand)</span>}
          </button>
        )}
      </div>
      <span className="act-time">{relTime(row.at, now)}</span>
    </div>
  )
}

function Card({ card, rows, state, now, open, toggle }: {
  card: SessionCard; rows: ActivityRow[]; state: TrackerState; now: number; open: boolean; toggle: () => void
}) {
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, ROWS_SHOWN)
  return (
    <section className="act-card" aria-label={`${card.label}, ${card.where}`}>
      <button type="button" className="act-head" aria-expanded={open} onClick={toggle}>
        <span className={`act-tool tool-${card.tool}`} aria-hidden="true">{card.badge}</span>
        <span className="act-who"><b>{card.label}</b>{card.where && <span>{card.where}</span>}</span>
        <span className="act-meta">
          {card.live && <span className="act-live" role="img" aria-label="Writing now" />}
          <span>{spanLabel(card.start, card.end, now)}</span>
          <span className="act-writes">{card.writes} {card.writes === 1 ? 'write' : 'writes'}</span>
          <span className={`act-chev${open ? '' : ' shut'}`}><Icon name="chevron" size={12} /></span>
        </span>
      </button>
      {open && (
        <div className="act-body">
          <div className="act-summary"><span><b>{card.finished}</b> finished</span><span><b>{card.touched}</b> {card.touched === 1 ? 'issue' : 'issues'} touched</span></div>
          {shown.map((r) => (
            <div key={r.id}>
              <Row row={r} state={state} now={now} />
              {r.children.map((c) => <Row key={c.id} row={c} state={state} now={now} child />)}
            </div>
          ))}
          {rows.length === 0 && <div className="home-empty">Only internal writes in this session.</div>}
          {rows.length > ROWS_SHOWN && (
            <button type="button" className="home-more" aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show ${rows.length - ROWS_SHOWN} more`}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

const hourLabel = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric' }).toLowerCase()
const dayName = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short' })

/** Today: 24 hourly bars from midnight; hours still to come are blank, so the bars stop at now. 7 days: one bar per day, labeled by weekday. */
function Rhythm({ buckets, range, now }: { buckets: ReturnType<typeof rhythm>; range: Range; now: number }) {
  const max = Math.max(1, ...buckets.map((h) => h.total))
  const total = buckets.reduce((n, h) => n + h.total, 0)
  const tools = [...new Set(buckets.flatMap((h) => Object.keys(h.byTool)))]
  const today = range === 'today'
  const name = (ms: number) => (today ? hourLabel(ms) : dayName(ms))
  return (
    <div className="act-rhythm">
      <div className="act-rhythm-label">
        <span>{today ? 'Today, by hour' : 'The last 7 days, by day'}</span>
        <span>{tools.map((k) => <span key={k} className="act-legend"><span className={`act-swatch tool-${k}`} aria-hidden="true" />{toolName(k)}</span>)}</span>
      </div>
      <div className={`act-bars${today ? '' : ' days'}`} role="img" aria-label={`${total} agent ${total === 1 ? 'write' : 'writes'} ${today ? 'today' : 'in the last 7 days'}`}>
        {buckets.map((h) => (
          <span key={h.start} className={h.top ? `tool-${h.top}` : h.start > now ? 'future' : 'empty'} style={{ height: h.total ? `${Math.max(8, (h.total / max) * 100)}%` : undefined }}
            title={`${name(h.start)}: ${h.total} ${h.total === 1 ? 'write' : 'writes'}`} />
        ))}
      </div>
      <div className={`act-rhythm-label${today ? '' : ' days'}`} aria-hidden="true">
        {today
          ? <><span>12 am</span><span>6 am</span><span>12 pm</span><span>6 pm</span><span>12 am</span></>
          : buckets.map((b) => <span key={b.start}>{dayName(b.start)}</span>)}
      </div>
    </div>
  )
}

const TOOL_NAMES: Record<string, string> = { cc: 'Claude Code', cx: 'Codex', cu: 'Cursor', gm: 'Gemini CLI', vs: 'VS Code', ws: 'Windsurf', cd: 'Claude', other: 'Other' }
const toolName = (k: string) => TOOL_NAMES[k] ?? k

const FILTERS: [ActivityFilter, string][] = [['all', 'Everything'], ['done', 'Finished'], ['started', 'Started'], ['comments', 'With notes'], ['needs', 'Needs you']]

/** Everything Home's Agent activity shows, from one feed: today's overview (also the heading's summary) and the range's cards. */
export interface ActivityData {
  range: Range
  setRange: (r: Range) => void
  today: DayOverview
  days: DayGroup[]
  buckets: RhythmBucket[]
  waitingIds: ReadonlySet<string>
  capped: boolean
  /** The range's feed has arrived; until then the counts and empty states would be claims about nothing. */
  loaded: boolean
}

/**
 * The activity behind Home (ui/activity.ts): the range's feed in scope, grouped into session cards, and today's
 * overview. Today is the start of either range, so one feed serves both.
 */
export function useActivity(needsYou: NeedsYouItem[] | null, now: number): ActivityData {
  const state = useTracker()
  const scope = useScope()
  const [range, setRangeState] = useState<Range>(readRange)
  const setRange = (r: Range) => { setRangeState(r); try { globalThis.localStorage?.setItem(RANGE_KEY, r) } catch { /* ignore */ } }
  const { events: raw, capped, since, loaded } = useRangeFeed(state, range, now)

  const events = useMemo(() => raw.filter((e) => feedInScope(e, state.issues.get(e.id), scope, state.config)), [raw, state.issues, scope, state.config])
  const skip = useMemo(() => (id: string) => state.hidden.issues.has(id), [state.hidden])
  const ctx = useMemo(() => ({
    issue: (id: string) => state.issues.get(id), statuses: state.config?.statuses ?? [], needsYou: state.config?.needsYou, now,
  }), [state.issues, state.config, now])
  const { days } = useMemo(() => buildActivity(events, ctx, since, skip), [events, ctx, since, skip])
  const todayStart = rangeStart('today', now)
  const today = useMemo(() => dayOverview(buildActivity(events, ctx, todayStart, skip).cards), [events, ctx, todayStart, skip])
  const waiting = useMemo(() => waitingOnYou(events, needsYou ?? [], state.config, since), [events, needsYou, state.config, since])
  const waitingIds = useMemo(() => new Set(waiting.map((w) => w.id)), [waiting])
  const buckets = useMemo(() => rhythm(events, range, now, skip), [events, range, now, skip])
  return { range, setRange, today, days, buckets, waitingIds, capped, loaded }
}

/** "4m ago", "just now". */
const ago = (iso: string, now: number) => { const r = relTime(iso, now); return r === 'now' ? 'just now' : r ? `${r} ago` : '' }

/**
 * Home's Agent activity: today's counts (each opens Session details on that filter), the live session and what it is
 * working on, what finished last, and Session details (the range, the rhythm, filters and a card per session).
 */
export function Activity({ data, now }: { data: ActivityData; now: number }) {
  return <ActivityView data={data} now={now} state={useTracker()} />
}

export function ActivityView({ data, now, state }: { data: ActivityData; now: number; state: TrackerState }) {
  const { range, setRange, today, days, buckets, waitingIds, capped, loaded } = data
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [open, setOpen] = useState(false)
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set())
  const toggle = (key: string) => setShut((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })
  const projectName = (slug: string) => state.projects.find((p) => p.slug === slug)?.name ?? (slug === '_none' ? 'No project' : slug)
  const issueProject = (id: string) => { const p = state.issues.get(id)?.project; return p ? projectName(p) : '' }

  const stat = (f: ActivityFilter, n: number, label: string) => (
    <button type="button" className="ov-stat" aria-pressed={open && filter === f} aria-controls="ov-sessions"
      onClick={() => { const off = open && filter === f; setFilter(off ? 'all' : f); if (!off) { setRange('today'); setOpen(true) } }}>
      <strong>{loaded ? n : '–'}</strong><span>{label}</span>
    </button>
  )
  const onKey = (e: KeyboardEvent<HTMLElement>) => { if (e.key === 'Escape' && filter !== 'all') setFilter('all') }
  const cur = today.current

  return (
    <section className="ov-activity" aria-labelledby="ov-activity-h" onKeyDown={onKey}>
      <div className="ov-title">
        <h2 id="ov-activity-h">Agent activity</h2>
        {today.live > 0 && <span className="ov-subtle"><span className="act-live" aria-hidden="true" /> {today.live} live</span>}
      </div>
      <div className="ov-stats" role="group" aria-label="Today at a glance">
        {stat('done', today.finished, 'Finished')}
        {stat('started', today.started, 'Started')}
        {stat('agents', today.agents, today.agents === 1 ? 'Agent' : 'Agents')}
      </div>
      {cur ? (
        <>
          <div className="ov-session">
            <span className={`ov-agent tool-${cur.card.tool}`} aria-hidden="true">{cur.card.badge}</span>
            <div>
              <h3>{cur.card.label}{cur.card.live && <span className="act-live" role="img" aria-label="Writing now" />}</h3>
              {cur.card.where && <span className="ov-subtle">{cur.card.where}</span>}
            </div>
          </div>
          <div className="ov-current">
            <span className="ov-eyebrow">{cur.card.live ? 'Working on' : 'Last worked on'}</span>
            <a href={href({ name: 'issue', id: cur.row.id })}>{cur.row.title}</a>
            <span className="ov-subtle">{cur.row.id} · Updated {ago(cur.row.at, now)}</span>
          </div>
        </>
      ) : loaded && today.agents === 0 && <p className="home-empty">No agent sessions today yet.</p>}
      <div className="ov-title ov-recent-title"><h3>Recently finished</h3><span className="ov-subtle">Today</span></div>
      {loaded && today.recent.length === 0 && <p className="home-empty">Nothing finished today yet.</p>}
      {today.recent.length > 0 && (
        <ul className="ov-events">
          {today.recent.map((r) => (
            <li key={r.id}>
              <StatusIcon status={r.status} config={state.config} />
              {r.gone
                ? <span className="ov-event-main"><s>{r.title}</s><small>{r.id} · deleted</small></span>
                : <a className="ov-event-main" href={href({ name: 'issue', id: r.id })}>{r.title}<small>{r.id}{issueProject(r.id) && ` · ${issueProject(r.id)}`}</small></a>}
              <span className="ov-time">{relTime(r.at, now)}</span>
            </li>
          ))}
        </ul>
      )}
      <details className="ov-details" id="ov-sessions" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>Session details</summary>
        <div className="act">
          <div className="act-headline">
            <span className="ov-subtle">{range === 'today' ? 'Sessions today' : 'Sessions in the last 7 days'}</span>
            <div className="act-range" role="group" aria-label="Time range">
              <button type="button" aria-pressed={range === 'today'} onClick={() => setRange('today')}>Today</button>
              <button type="button" aria-pressed={range === 'week'} onClick={() => setRange('week')}>7 days</button>
            </div>
          </div>
          <Rhythm buckets={buckets} range={range} now={now} />
          <div className="act-filters" role="group" aria-label="Show">
            {FILTERS.map(([f, label]) => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{label}</button>)}
            {filter === 'agents' && <button type="button" aria-pressed="true" onClick={() => setFilter('all')}>Agents</button>}
          </div>
          {capped && <div className="home-empty">Showing the latest {FEED_SINCE_MAX} writes.</div>}
          {loaded && days.length === 0 && <div className="home-empty">{range === 'today' ? 'No activity today yet. Switch to 7 days to see earlier work.' : 'No activity in the last 7 days.'}</div>}
          {days.map((d) => {
            const shown = d.cards.flatMap((c) => { const rows = filterCard(c, filter, waitingIds); return rows ? [{ c, rows }] : [] })
            if (!shown.length) return null
            return (
              <div key={d.day} className="act-day">
                <h4>{d.label}</h4>
                {shown.map(({ c, rows }) => <Card key={c.key} card={c} rows={rows} state={state} now={now} open={!shut.has(c.key)} toggle={() => toggle(c.key)} />)}
              </div>
            )
          })}
          {days.length > 0 && filter !== 'all' && days.every((d) => d.cards.every((c) => !filterCard(c, filter, waitingIds))) && (
            <div className="home-empty">Nothing matches in this range.</div>
          )}
        </div>
      </details>
    </section>
  )
}
