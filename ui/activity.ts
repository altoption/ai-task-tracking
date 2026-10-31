/**
 * Pure logic behind Home's Agent activity (tested without a DOM): feed events grouped into one card per agent session
 * and day, one row per issue per card (bursts merged, internal writes folded, the status path it took, the latest
 * note, PR and commit chips), sub-issues under their epic, the overview counts, the filters and the hourly rhythm.
 *
 * The events come from the visibility-filtered feed (`/api/feed?since=`, plus the live stream), and titles and
 * statuses from the snapshot, so hidden projects never reach here (src/engine/hidden.ts).
 */
import type { FeedEvent } from '../src/engine/eventlog'
import type { Config, IssueSummary, Link, StatusDef } from '../src/model'
import { extractLinks } from '../src/shared/links'

export type Range = 'today' | 'week'
export type ActivityFilter = 'all' | 'done' | 'started' | 'comments' | 'needs'
export type RowKind = 'done' | 'started' | 'needs' | 'comments'

/** A session wrote within this long ago: its card shows the live dot. */
export const LIVE_MS = 10 * 60_000
const HOUR_MS = 3_600_000

/** `updated` fields the owner cares about; any other update (plan, links, imported metadata) folds away. */
const MEANINGFUL_UPDATES = new Set(['title', 'description', 'labels', 'priority', 'due', 'milestone', 'project'])

export interface ActivityRow {
  id: string
  title: string
  /** Current status (snapshot), else the last one this session moved it to. */
  status: string
  /** The statuses it went through in this session, `created` first when it was created then; empty when none. */
  path: string[]
  /** What else happened, when there's no path: "edited title, labels", "moved under Q-1", "blocked by Q-3". */
  detail?: string
  /** The latest comment of this session (the feed keeps its first 200 characters). */
  note?: string
  /** GitHub PR and commit links from this session's notes, or the issue's when this session added links. */
  links: Link[]
  kinds: RowKind[]
  /** Latest write. */
  at: string
  writes: number
  /** Writes with no meaning to the owner (internal updates), folded into the row. */
  folded: number
  children: ActivityRow[]
  /** The epic's progress (visible children only), when it has children. */
  progress?: { done: number; total: number }
  /** The issue no longer exists (deleted). */
  gone: boolean
  parent: string | null
}

export interface SessionCard {
  key: string
  /** Local day `YYYY-MM-DD` (a session that crosses midnight has a card on each day). */
  day: string
  kind: 'agent' | 'you'
  /** Tool key for the badge color: cc, cx, cu, gm, vs, ws, cd, other; `you` for the owner's card. */
  tool: string
  /** "Claude Code", "Agent in my-repo", "You". */
  label: string
  /** Two letters on the tool badge: CC, CX, AG (unknown tool), YO. */
  badge: string
  /** "workspace · branch", or for the owner "in the app and by hand". */
  where: string
  start: string
  end: string
  writes: number
  live: boolean
  /** Top-level rows (sub-issues sit in their epic's `children`), newest first. */
  rows: ActivityRow[]
  /** Distinct issues touched. */
  touched: number
  finished: number
  /** The session's identity across days (for counting agents). */
  agentKey?: string
}

export interface DayGroup { day: string; label: string; cards: SessionCard[] }

export interface Ctx {
  issue: (id: string) => Pick<IssueSummary, 'title' | 'status' | 'parent' | 'progress' | 'childCount' | 'links'> | undefined
  statuses: StatusDef[]
  needsYou: Config['needsYou'] | undefined
  now: number
}

const TOOLS: Record<string, [key: string, name: string]> = {
  'claude-code': ['cc', 'Claude Code'], codex: ['cx', 'Codex'], cursor: ['cu', 'Cursor'], gemini: ['gm', 'Gemini CLI'],
  vscode: ['vs', 'VS Code'], windsurf: ['ws', 'Windsurf'], 'claude-desktop': ['cd', 'Claude'],
}

/** The tool's badge key and name from the actor's `client`; without one, "Agent in <workspace>". */
export function toolOf(client: string | undefined, workspace: string | undefined): { key: string; name: string; badge: string } {
  const t = client ? TOOLS[client] : undefined
  if (t) return { key: t[0], name: t[1], badge: t[0].toUpperCase() }
  if (client) return { key: 'other', name: client, badge: client.slice(0, 2).toUpperCase() }
  return { key: 'other', name: workspace ? `Agent in ${workspace}` : 'Agent', badge: 'AG' }
}

/** Local `YYYY-MM-DD`. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Where the range starts: local midnight today, or six days before it (7 days including today). */
export function rangeStart(range: Range, now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  if (range === 'week') d.setDate(d.getDate() - 6)
  return d.getTime()
}

/** "Today", "Yesterday", else "Mon, Oct 27". */
export function dayLabel(day: string, now: number): string {
  if (day === localDay(now)) return 'Today'
  const y = new Date(now); y.setDate(y.getDate() - 1)
  if (day === localDay(y.getTime())) return 'Yesterday'
  const [yy, mm, dd] = day.split('-').map(Number)
  return new Date(yy!, mm! - 1, dd!).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

const isExternal = (e: FeedEvent) => e.actor.workspace === 'external'
const isAgent = (e: FeedEvent) => e.actor.actor === 'agent' && !isExternal(e)

/**
 * The card an event belongs to. An agent session is its `session` id; an agent write without one groups by
 * workspace and branch. The owner's own writes (the app, the browser, hand edits) share one "You" card per day:
 * they aren't sessions, and a day is how the feed is already divided.
 */
function cardKey(e: FeedEvent): { key: string; agentKey?: string } {
  if (!isAgent(e)) return { key: 'you' }
  const k = e.actor.session ? `s:${e.actor.session}` : `w:${e.actor.workspace ?? ''}|${e.actor.branch ?? ''}`
  return { key: k, agentKey: k }
}

function typeOf(statuses: StatusDef[]): (s: string | undefined) => string | undefined {
  const m = new Map(statuses.map((s) => [s.name, s.type]))
  return (s) => (s ? m.get(s) : undefined)
}

function buildRow(id: string, evs: FeedEvent[], ctx: Ctx): ActivityRow | null {
  // evs: oldest first.
  const type = typeOf(ctx.statuses)
  const needs = new Set(Array.isArray(ctx.needsYou?.statuses) ? ctx.needsYou.statuses : [])
  const sum = ctx.issue(id)
  const path: string[] = []
  const push = (s: string) => { if (path[path.length - 1] !== s) path.push(s) }
  const kinds = new Set<RowKind>()
  const edits = new Set<string>()
  let note: string | undefined
  let created: string | undefined
  let lastTo: string | undefined
  let folded = 0
  let addedLinks = false
  let detail: string | undefined
  const notes: string[] = []
  for (const e of evs) {
    switch (e.kind) {
      case 'created':
        created = e.text
        push('created')
        break
      case 'status':
        // Where it came from: the first status, or, right after "created", a started one it was created in
        // ("created → In Progress → Waiting"; created in Backlog or Todo reads simply "created → Done").
        if (e.from && (!path.length || (path[path.length - 1] === 'created' && type(e.from) === 'started'))) push(e.from)
        if (e.to) {
          push(e.to); lastTo = e.to
          const t = type(e.to)
          if (t === 'completed') kinds.add('done')
          else if (needs.has(e.to)) kinds.add('needs')
          else if (t === 'started') kinds.add('started')
        }
        break
      case 'comment':
        note = e.text
        if (e.text) notes.push(e.text)
        kinds.add('comments')
        break
      case 'parent':
        detail = e.to ? `moved under ${e.to}` : `moved out of ${e.from ?? 'its parent'}`
        break
      case 'blocked':
        detail = e.to ? `blocked by ${e.to}` : 'unblocked'
        break
      default: {
        const fields = (e.text ?? '').split(',').map((f) => f.trim()).filter(Boolean)
        if (fields.includes('links')) addedLinks = true
        const shown = fields.filter((f) => MEANINGFUL_UPDATES.has(f))
        if (shown.length) for (const f of shown) edits.add(f)
        else folded++
      }
    }
  }
  if (!path.length && edits.size) detail = `edited ${[...edits].join(', ')}`
  // Nothing the owner would care about: the whole row folds away (its writes still count on the card).
  if (!path.length && !detail && note === undefined) return null
  const links = extractLinks(notes.join('\n')).filter((l) => !l.title.startsWith('Branch'))
  if (addedLinks && sum) {
    for (const l of sum.links) if (/\/(pull|commit)\//.test(l.url) && !links.some((x) => x.url === l.url)) links.push(l)
  }
  return {
    id, title: sum?.title ?? created ?? id, status: sum?.status ?? lastTo ?? '', path, ...(detail ? { detail } : {}),
    ...(note !== undefined ? { note } : {}), links, kinds: [...kinds], at: evs[evs.length - 1]!.at, writes: evs.length, folded,
    children: [], ...(sum && sum.progress.total > 0 ? { progress: sum.progress } : {}), gone: !sum, parent: sum?.parent ?? null,
  }
}

/**
 * Group feed events (newest first, as the feed sends them; ties in time keep that order) into day groups of session cards, newest first. Events before `since` are left out,
 * and so are events whose issue the UI doesn't show (`skip`: a hidden project's, as the snapshot names them).
 */
export function buildActivity(events: FeedEvent[], ctx: Ctx, since: number, skip?: (id: string) => boolean): { days: DayGroup[]; cards: SessionCard[] } {
  const cards = new Map<string, { day: string; key: string; agentKey?: string; evs: FeedEvent[] }>()
  for (const e of events) {
    const t = Date.parse(e.at)
    if (Number.isNaN(t) || t < since || skip?.(e.id)) continue
    const day = localDay(t)
    const { key, agentKey } = cardKey(e)
    const k = `${key}|${day}`
    let c = cards.get(k)
    if (!c) { c = { day, key: k, ...(agentKey ? { agentKey } : {}), evs: [] }; cards.set(k, c) }
    c.evs.push(e)
  }
  const out: SessionCard[] = []
  for (const c of cards.values()) {
    // Oldest first. Writes in the same second (created, then moved) keep the feed's order: it is newest first, so
    // reverse before the (stable) sort.
    const evs = c.evs.reverse().sort((a, b) => a.at.localeCompare(b.at))
    const byIssue = new Map<string, FeedEvent[]>()
    for (const e of evs) { const l = byIssue.get(e.id); if (l) l.push(e); else byIssue.set(e.id, [e]) }
    const rows = new Map<string, ActivityRow>()
    for (const [id, list] of byIssue) { const r = buildRow(id, list, ctx); if (r) rows.set(id, r) }
    // Sub-issues touched in the same session sit under their epic (nearest ancestor row; a cycle stays flat).
    const top: ActivityRow[] = []
    for (const r of rows.values()) {
      const seen = new Set([r.id])
      let p = r.parent, host: ActivityRow | undefined
      while (p && !seen.has(p)) { seen.add(p); const h = rows.get(p); if (h) { host = h; break } p = ctx.issue(p)?.parent ?? null }
      if (host) host.children.push(r); else top.push(r)
    }
    const newest = (a: ActivityRow, b: ActivityRow) => b.at.localeCompare(a.at)
    top.sort(newest)
    for (const r of rows.values()) r.children.sort(newest)
    const first = evs[0]!, last = evs[evs.length - 1]!
    const agent = c.agentKey !== undefined
    const tool = agent ? toolOf(last.actor.client ?? evs.find((e) => e.actor.client)?.actor.client, last.actor.workspace) : null
    out.push({
      key: c.key, day: c.day, kind: agent ? 'agent' : 'you', tool: tool?.key ?? 'you', label: tool?.name ?? 'You', badge: tool?.badge ?? 'YO',
      where: agent ? [last.actor.workspace, last.actor.branch].filter(Boolean).join(' · ') : 'in the app and by hand',
      start: first.at, end: last.at, writes: evs.length, live: agent && ctx.now - Date.parse(last.at) < LIVE_MS,
      rows: top, touched: rows.size, finished: [...rows.values()].filter((r) => r.kinds.includes('done')).length,
      ...(c.agentKey ? { agentKey: c.agentKey } : {}),
    })
  }
  out.sort((a, b) => b.end.localeCompare(a.end))
  const days: DayGroup[] = []
  for (const card of out) {
    let d = days.find((x) => x.day === card.day)
    if (!d) { d = { day: card.day, label: dayLabel(card.day, ctx.now), cards: [] }; days.push(d) }
    d.cards.push(card)
  }
  days.sort((a, b) => b.day.localeCompare(a.day))
  return { days, cards: out }
}

/** Every row of a card, children included. */
export function allRows(rows: ActivityRow[]): ActivityRow[] {
  return rows.flatMap((r) => [r, ...allRows(r.children)])
}

/** Does the row match the filter? `waiting`: ids pinned as waiting on you. */
export function rowMatches(r: ActivityRow, f: ActivityFilter, waiting: ReadonlySet<string>): boolean {
  if (f === 'all') return true
  if (f === 'needs') return r.kinds.includes('needs') || waiting.has(r.id)
  return r.kinds.includes(f)
}

/** A card's rows under a filter: an epic stays when it or one of its children matches; children are filtered too. */
export function filterRows(rows: ActivityRow[], f: ActivityFilter, waiting: ReadonlySet<string>): ActivityRow[] {
  if (f === 'all') return rows
  const out: ActivityRow[] = []
  for (const r of rows) {
    const children = filterRows(r.children, f, waiting)
    if (rowMatches(r, f, waiting) || children.length) out.push({ ...r, children })
  }
  return out
}

/** The overview: distinct issues finished and started, waiting on you, and agent sessions (how many live). */
export function activityCounts(cards: SessionCard[], waiting: number): { finished: number; started: number; waiting: number; agents: number; live: number } {
  const done = new Set<string>(), started = new Set<string>(), agents = new Set<string>(), live = new Set<string>()
  for (const c of cards) {
    for (const r of allRows(c.rows)) {
      if (r.kinds.includes('done')) done.add(r.id)
      if (r.kinds.includes('started')) started.add(r.id)
    }
    if (c.agentKey) { agents.add(c.agentKey); if (c.live) live.add(c.agentKey) }
  }
  return { finished: done.size, started: started.size, waiting, agents: agents.size, live: live.size }
}

export interface RhythmHour { start: number; total: number; byTool: Record<string, number>; top: string | null }

/** Agent writes per hour over the last 24 hours (the current hour last), by tool; `top` is the busiest tool. */
export function rhythm(events: FeedEvent[], now: number, skip?: (id: string) => boolean): RhythmHour[] {
  const end = new Date(now); end.setMinutes(0, 0, 0)
  const first = end.getTime() - 23 * HOUR_MS
  const hours: RhythmHour[] = Array.from({ length: 24 }, (_, h) => ({ start: first + h * HOUR_MS, total: 0, byTool: {}, top: null }))
  for (const e of events) {
    if (!isAgent(e) || skip?.(e.id)) continue
    const t = Date.parse(e.at)
    if (Number.isNaN(t) || t < first || t >= first + 24 * HOUR_MS) continue
    const h = hours[Math.floor((t - first) / HOUR_MS)]!
    const k = toolOf(e.actor.client, e.actor.workspace).key
    h.total++
    h.byTool[k] = (h.byTool[k] ?? 0) + 1
  }
  for (const h of hours) {
    let best = 0
    for (const [k, n] of Object.entries(h.byTool)) if (n > best) { best = n; h.top = k }
  }
  return hours
}

export interface WaitingItem { id: string; title: string; status: string; at: string; who: string; note?: string }

/**
 * The "waits on you" strip: issues that still need the owner for a Needs-you status or label (Home's Needs you list;
 * stalled-only and CI-only items stay in that list) and that entered it within the range: moved to a Needs-you
 * status, given labels, or created. The question is the latest agent note in the range on it.
 */
export function waitingOnYou(
  events: FeedEvent[], needsYou: (IssueSummary & { stalled?: string; ciReason?: string })[], config: Pick<Config, 'needsYou'> | null,
  since: number,
): WaitingItem[] {
  const statuses = new Set(Array.isArray(config?.needsYou?.statuses) ? config.needsYou.statuses : [])
  const labels = new Set(Array.isArray(config?.needsYou?.labels) ? config.needsYou.labels : [])
  const out: WaitingItem[] = []
  for (const i of needsYou) {
    if (!statuses.has(i.status) && !i.labels.some((l) => labels.has(l))) continue
    const mine = events.filter((e) => e.id === i.id && Date.parse(e.at) >= since).sort((a, b) => b.at.localeCompare(a.at))
    const entered = mine.find((e) => (e.kind === 'status' && e.to && statuses.has(e.to)) || e.kind === 'created'
      || (e.kind === 'updated' && (e.text ?? '').split(',').map((f) => f.trim()).includes('labels')))
    if (!entered) continue
    const note = mine.find((e) => e.kind === 'comment' && isAgent(e))?.text ?? mine.find((e) => e.kind === 'comment')?.text
    const who = isAgent(entered) ? toolOf(entered.actor.client, entered.actor.workspace).name : 'You'
    out.push({ id: i.id, title: i.title, status: i.status, at: entered.at, who, ...(note ? { note } : {}) })
  }
  return out.sort((a, b) => b.at.localeCompare(a.at))
}

/** "7:10 pm – now", "8:52 – 8:57 pm" style span of a card. */
export function spanLabel(start: string, end: string, now: number): string {
  const fmt = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const e = now - Date.parse(end) < LIVE_MS ? 'now' : fmt(end)
  const s = fmt(start)
  return s === e ? s : `${s} – ${e}`
}

/** Merge fetched events with live ones (both newest first), without duplicates. */
export function mergeFeeds(fetched: FeedEvent[], live: FeedEvent[], since: number): FeedEvent[] {
  const key = (e: FeedEvent) => `${e.at}|${e.id}|${e.kind}|${e.from ?? ''}|${e.to ?? ''}|${e.text ?? ''}`
  const seen = new Set<string>()
  const out: FeedEvent[] = []
  for (const e of [...live, ...fetched]) {
    if (Date.parse(e.at) < since) continue
    const k = key(e)
    if (seen.has(k)) continue
    seen.add(k); out.push(e)
  }
  return out.sort((a, b) => b.at.localeCompare(a.at))
}

