/**
 * Home's Agent activity column: the overview (counts that filter, the hourly rhythm), what waits on you, filter chips,
 * then one card per agent session per day with one row per issue. Grouping is pure (ui/activity.ts).
 *
 * Data: `/api/feed?since=` for the range (visibility-filtered by the engine, up to FEED_SINCE_MAX entries). Every live
 * update is folded into what the column has gathered, so new writes slot into their session's card as they happen and
 * stay there after the store's live feed (its newest 200) moves on.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { FeedEvent } from '../../src/engine/eventlog'
import { FEED_SINCE_MAX } from '../../src/shared/feed'
import {
  activityCounts, buildActivity, filterCard, mergeFeeds, rangeStart, rhythm, spanLabel, waitingOnYou,
  type ActivityFilter, type ActivityRow, type Range, type SessionCard,
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
function useRangeFeed(state: TrackerState, range: Range, now: number): { events: FeedEvent[]; capped: boolean; since: number } {
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
  return { events, capped: gathered?.since === since && gathered.capped, since }
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

export function Activity({ needsYou, now }: { needsYou: NeedsYouItem[] | null; now: number }) {
  const state = useTracker()
  const scope = useScope()
  const [range, setRangeState] = useState<Range>(readRange)
  const setRange = (r: Range) => { setRangeState(r); try { globalThis.localStorage?.setItem(RANGE_KEY, r) } catch { /* ignore */ } }
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set())
  const { events: raw, capped, since } = useRangeFeed(state, range, now)

  const events = useMemo(() => raw.filter((e) => feedInScope(e, state.issues.get(e.id), scope, state.config)), [raw, state.issues, scope, state.config])
  const skip = useMemo(() => (id: string) => state.hidden.issues.has(id), [state.hidden])
  const ctx = useMemo(() => ({
    issue: (id: string) => state.issues.get(id), statuses: state.config?.statuses ?? [], needsYou: state.config?.needsYou, now,
  }), [state.issues, state.config, now])
  const { days, cards } = useMemo(() => buildActivity(events, ctx, since, skip), [events, ctx, since, skip])
  const waiting = useMemo(() => waitingOnYou(events, needsYou ?? [], state.config, since), [events, needsYou, state.config, since])
  const waitingIds = useMemo(() => new Set(waiting.map((w) => w.id)), [waiting])
  const counts = useMemo(() => activityCounts(cards, waiting.length), [cards, waiting])
  const buckets = useMemo(() => rhythm(events, range, now, skip), [events, range, now, skip])

  const toggle = (key: string) => setShut((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })
  const stat = (f: ActivityFilter, n: number, label: string, attn = false) => (
    <button type="button" className={`act-stat${attn && n > 0 ? ' attn' : ''}`} aria-pressed={filter === f}
      onClick={() => setFilter(filter === f ? 'all' : f)}>
      <span className="n">{n}</span><span className="l">{label}</span>
    </button>
  )
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Enter on a focused row's title link already opens it; nothing else to do here.
    if (e.key === 'Escape' && filter !== 'all') setFilter('all')
  }

  return (
    <aside className="home-feed act" onKeyDown={onKey}>
      <div className="act-headline">
        <h4>{counts.live > 0 && <span className="act-live" aria-hidden="true" />}Agent activity</h4>
        <div className="act-range" role="group" aria-label="Time range">
          <button type="button" aria-pressed={range === 'today'} onClick={() => setRange('today')}>Today</button>
          <button type="button" aria-pressed={range === 'week'} onClick={() => setRange('week')}>7 days</button>
        </div>
      </div>
      <div className="act-stats" role="group" aria-label={range === 'today' ? 'Today at a glance' : 'The last 7 days at a glance'}>
        {stat('done', counts.finished, 'Finished')}
        {stat('started', counts.started, 'Started')}
        {stat('needs', counts.waiting, 'Waiting on you', true)}
        {stat('agents', counts.agents, `Agents${counts.live ? ` · ${counts.live} live` : ''}`)}
      </div>
      <Rhythm buckets={buckets} range={range} now={now} />
      {waiting.length > 0 && (
        <div className="act-waiting" aria-label="Waits on you">
          {waiting.map((w) => (
            <div key={w.id} className="act-attn">
              <StatusIcon status={w.status} config={state.config} />
              <div className="act-attn-text">
                <a href={href({ name: 'issue', id: w.id })}><span className="act-id">{w.id}</span> {w.title}</a>
                <span className="why-line">{w.who} · {w.status} · {relTime(w.at, now)}</span>
                {w.note && <span className="act-question">{w.note}</span>}
              </div>
              <button type="button" className="act-open" onClick={() => navigate({ name: 'issue', id: w.id })}>Open</button>
            </div>
          ))}
        </div>
      )}
      <div className="act-filters" role="group" aria-label="Show">
        {FILTERS.map(([f, label]) => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{label}</button>)}
      </div>
      {capped && <div className="home-empty">Showing the latest {FEED_SINCE_MAX} writes.</div>}
      {days.length === 0 && <div className="home-empty">{range === 'today' ? 'No activity today yet. Switch to 7 days to see earlier work.' : 'No activity in the last 7 days.'}</div>}
      {days.map((d) => {
        const shown = d.cards.flatMap((c) => { const rows = filterCard(c, filter, waitingIds); return rows ? [{ c, rows }] : [] })
        if (!shown.length) return null
        return (
          <div key={d.day} className="act-day">
            <h5>{d.label}</h5>
            {shown.map(({ c, rows }) => <Card key={c.key} card={c} rows={rows} state={state} now={now} open={!shut.has(c.key)} toggle={() => toggle(c.key)} />)}
          </div>
        )
      })}
      {days.length > 0 && filter !== 'all' && days.every((d) => d.cards.every((c) => !filterCard(c, filter, waitingIds))) && (
        <div className="home-empty">Nothing matches in this range.</div>
      )}
    </aside>
  )
}
