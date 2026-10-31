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
import { FEED_SINCE_MAX } from '../src/shared/feed'
import { extractLinks } from '../src/shared/links'

export type Range = 'today' | 'week'
/** `agents`: only agent sessions' cards (the Agents count); the others filter rows. */
export type ActivityFilter = 'all' | 'done' | 'started' | 'comments' | 'needs' | 'agents'
export type RowKind = 'done' | 'started' | 'needs' | 'comments'

/** A session wrote within this long ago: its card shows the live dot. */
export const LIVE_MS = 10 * 60_000

/** ISO timestamps compare as strings: oldest first / newest first. */
const asc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const desc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0)

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

/**
 * A GitHub pull request or commit URL: https, github.com, `/<owner>/<repo>/(pull|commit)/<ref>`. Links come from agents,
 * and only these become chips (a `javascript:` URL that merely contains `/pull/` never does).
 */
export function isGithubChange(url: string): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  return u.protocol === 'https:' && u.hostname.toLowerCase() === 'github.com' && !u.username && !u.password &&
    /^\/[^/]+\/[^/]+\/(pull|commit)\/[^/]+/.test(u.pathname)
}

const TOOLS: Record<string, [key: string, name: string]> = {
  'claude-code': ['cc', 'Claude Code'], codex: ['cx', 'Codex'], cursor: ['cu', 'Cursor'], gemini: ['gm', 'Gemini CLI'],
  vscode: ['vs', 'VS Code'], windsurf: ['ws', 'Windsurf'], 'claude-desktop': ['cd', 'Claude'],
}

/** The tool's badge key and name from the actor's `client`; without one, "Agent in <workspace>". */
export function toolOf(client: string | undefined, workspace: string | undefined): { key: string; name: string; badge: string } {
  // `client` is written by agents: an own-key check, so `constructor` or `__proto__` can't reach Object.prototype.
  const t = client && Object.hasOwn(TOOLS, client) ? TOOLS[client] : undefined
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
 * The card an event belongs to. An agent session is its tool, workspace and `session` id together (the session id is
 * a process id, which macOS reuses, so it alone could merge two sessions days apart); an agent write without one
 * groups by workspace and branch. The owner's own writes (the app, the browser, hand edits) share one "You" card per day:
 * they aren't sessions, and a day is how the feed is already divided.
 */
function cardKey(e: FeedEvent): { key: string; agentKey?: string } {
  if (!isAgent(e)) return { key: 'you' }
  const a = e.actor
  const k = a.session ? `s:${a.client ?? ''}|${a.workspace ?? ''}|${a.session}` : `w:${a.workspace ?? ''}|${a.branch ?? ''}`
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
  let moved: RowKind | undefined
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
          moved = t === 'completed' ? 'done' : needs.has(e.to) ? 'needs' : t === 'started' ? 'started' : undefined
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
  // What the row is follows its last move: finished then reopened is started, started then finished is finished.
  if (moved) kinds.add(moved)
  if (!path.length && edits.size) detail = `edited ${[...edits].join(', ')}`
  // Nothing the owner would care about: the whole row folds away (its writes still count on the card).
  if (!path.length && !detail && note === undefined) return null
  const links = extractLinks(notes.join('\n')).filter((l) => !l.title.startsWith('Branch') && isGithubChange(l.url))
  if (addedLinks && sum) {
    for (const l of sum.links) if (isGithubChange(l.url) && !links.some((x) => x.url === l.url)) links.push(l)
  }
  return {
    id, title: sum?.title || created || id, status: sum?.status ?? lastTo ?? '', path, ...(detail ? { detail } : {}),
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
    const evs = c.evs.reverse().sort((a, b) => asc(a.at, b.at))
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
    const newest = (a: ActivityRow, b: ActivityRow) => desc(a.at, b.at)
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
  out.sort((a, b) => desc(a.end, b.end))
  const days: DayGroup[] = []
  for (const card of out) {
    let d = days.find((x) => x.day === card.day)
    if (!d) { d = { day: card.day, label: dayLabel(card.day, ctx.now), cards: [] }; days.push(d) }
    d.cards.push(card)
  }
  days.sort((a, b) => desc(a.day, b.day))
  return { days, cards: out }
}

/** Every row of a card, children included. */
export function allRows(rows: ActivityRow[]): ActivityRow[] {
  return rows.flatMap((r) => [r, ...allRows(r.children)])
}

/** Does the row match the filter? `waiting`: ids pinned as waiting on you. */
export function rowMatches(r: ActivityRow, f: ActivityFilter, waiting: ReadonlySet<string>): boolean {
  if (f === 'all' || f === 'agents') return true
  if (f === 'needs') return r.kinds.includes('needs') || waiting.has(r.id)
  return r.kinds.includes(f)
}

/** A card's rows under a filter: an epic stays when it or one of its children matches; children are filtered too. */
export function filterRows(rows: ActivityRow[], f: ActivityFilter, waiting: ReadonlySet<string>): ActivityRow[] {
  if (f === 'all' || f === 'agents') return rows
  const out: ActivityRow[] = []
  for (const r of rows) {
    const children = filterRows(r.children, f, waiting)
    if (rowMatches(r, f, waiting) || children.length) out.push({ ...r, children })
  }
  return out
}

/** A card under a filter: its rows, or null when the card drops out (`agents` keeps agent cards whole). */
export function filterCard(c: SessionCard, f: ActivityFilter, waiting: ReadonlySet<string>): ActivityRow[] | null {
  if (f === 'agents') return c.kind === 'agent' ? c.rows : null
  const rows = filterRows(c.rows, f, waiting)
  return f === 'all' || rows.length ? rows : null
}

/** Where each issue's last status move left it today, across sessions: finished in one session and reopened in the next isn't finished. */
function lastStates(cards: SessionCard[]): Map<string, 'done' | 'started' | 'other'> {
  const last = new Map<string, { at: number; state: 'done' | 'started' | 'other' }>()
  for (const c of cards) {
    for (const r of allRows(c.rows)) {
      const state = r.kinds.includes('done') ? 'done' : r.kinds.includes('started') ? 'started' : r.kinds.includes('needs') || r.path.length ? 'other' : null
      if (!state) continue
      const at = Date.parse(r.at), prev = last.get(r.id)
      if (!prev || at > prev.at) last.set(r.id, { at, state })
    }
  }
  return new Map([...last].map(([id, v]) => [id, v.state]))
}

/** The overview: distinct issues finished and started, waiting on you, and agent sessions (how many live). */
export function activityCounts(cards: SessionCard[], waiting: number): { finished: number; started: number; waiting: number; agents: number; live: number } {
  const agents = new Set<string>(), live = new Set<string>()
  for (const c of cards) if (c.agentKey) { agents.add(c.agentKey); if (c.live) live.add(c.agentKey) }
  const states = [...lastStates(cards).values()]
  return { finished: states.filter((s) => s === 'done').length, started: states.filter((s) => s === 'started').length, waiting, agents: agents.size, live: live.size }
}

export interface RhythmBucket { start: number; end: number; total: number; byTool: Record<string, number>; top: string | null }

/**
 * Agent writes in the range, by tool, `top` being the busiest tool: Today in 24 hourly buckets from local midnight
 * (hours after now stay empty), 7 days in 7 daily buckets. Bucket edges are local clock times, so a DST day has the
 * right hours.
 */
export function rhythm(events: FeedEvent[], range: Range, now: number, skip?: (id: string) => boolean): RhythmBucket[] {
  const start = rangeStart(range, now)
  const n = range === 'today' ? 24 : 7
  const edge = (i: number) => {
    const d = new Date(start)
    if (range === 'today') d.setHours(i); else d.setDate(d.getDate() + i)
    return d.getTime()
  }
  const buckets: RhythmBucket[] = Array.from({ length: n }, (_, i) => ({ start: edge(i), end: edge(i + 1), total: 0, byTool: {}, top: null }))
  for (const e of events) {
    if (!isAgent(e) || skip?.(e.id)) continue
    const t = Date.parse(e.at)
    if (Number.isNaN(t) || t < start || t >= buckets[n - 1]!.end) continue
    const b = buckets.find((x) => t >= x.start && t < x.end)
    if (!b) continue
    const k = toolOf(e.actor.client, e.actor.workspace).key
    b.total++
    b.byTool[k] = (b.byTool[k] ?? 0) + 1
  }
  for (const b of buckets) {
    let best = 0
    for (const [k, c] of Object.entries(b.byTool)) if (c > best) { best = c; b.top = k }
  }
  return buckets
}

export interface WaitingItem { id: string; title: string; status: string; at: string }

/**
 * What the Needs you chip in Session details shows: issues an agent handed back within the range that still need the owner for a Needs-you
 * status or label (Home's Needs you list; stalled-only and CI-only items stay in that list). Handed back means an
 * agent's write that entered Needs you: a move to a Needs-you status, creating it there, or a labels change that
 * added a Needs-you label (the feed doesn't keep the old labels, so: the labels changed and the issue now carries
 * one, and it wasn't already waiting in a Needs-you status). The owner's own writes never count.
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
    const mine = events.filter((e) => e.id === i.id && Date.parse(e.at) >= since).sort((a, b) => desc(a.at, b.at))
    const hasLabel = i.labels.some((l) => labels.has(l))
    const labelEntry = (e: FeedEvent) => e.kind === 'updated' && hasLabel && (e.text ?? '').split(',').map((f) => f.trim()).includes('labels')
      // Waiting in a Needs-you status from before this write: a label edit then isn't the hand-back.
      && !statuses.has(statusBefore(mine, e, i.status))
    const entered = mine.find((e) => isAgent(e) && ((e.kind === 'status' && !!e.to && statuses.has(e.to)) || e.kind === 'created' || labelEntry(e)))
    if (!entered) continue
    out.push({ id: i.id, title: i.title, status: i.status, at: entered.at })
  }
  return out.sort((a, b) => desc(a.at, b.at))
}

/** The status an issue had just before `e`, from the status moves in `evs` (newest first); with none, `current`. */
function statusBefore(evs: FeedEvent[], e: FeedEvent, current: string): string {
  const i = evs.indexOf(e)
  // The nearest older status move tells where it was; with none, the oldest newer move's `from` does.
  const older = evs.slice(i + 1).find((x) => x.kind === 'status')
  if (older) return older.to ?? current
  const newer = evs.slice(0, i).reverse().find((x) => x.kind === 'status')
  return newer?.from ?? current
}

/** "7:10 pm – now", "8:52 – 8:57 pm" style span of a card. */
export function spanLabel(start: string, end: string, now: number): string {
  const fmt = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const e = now - Date.parse(end) < LIVE_MS ? 'now' : fmt(end)
  const s = fmt(start)
  return s === e ? s : `${s} – ${e}`
}

/**
 * Merge fetched (or already gathered) events with live ones (both newest first), without duplicates, keeping the newest
 * `max`. Home's activity folds every live update into what it has gathered, so writes stay after the store's live feed
 * (the newest 200) moves past them.
 */
export function mergeFeeds(fetched: FeedEvent[], live: FeedEvent[], since: number, max = FEED_SINCE_MAX): FeedEvent[] {
  const key = (e: FeedEvent) => `${e.at}|${e.id}|${e.kind}|${e.from ?? ''}|${e.to ?? ''}|${e.text ?? ''}`
  const seen = new Set<string>()
  const out: FeedEvent[] = []
  for (const e of [...live, ...fetched]) {
    if (Date.parse(e.at) < since) continue
    const k = key(e)
    if (seen.has(k)) continue
    seen.add(k); out.push(e)
  }
  return out.sort((a, b) => desc(a.at, b.at)).slice(0, max)
}


/** Home's Daily overview of one day's cards (ATT-53): the counts, the session to show, and what finished last. */
export interface DayOverview {
  finished: number; started: number; agents: number; live: number
  /** The live agent session (else the latest one) and the issue it wrote to last. */
  current: { card: SessionCard; row: ActivityRow } | null
  /** Issues finished, newest first, each once. */
  recent: ActivityRow[]
}

export function dayOverview(cards: SessionCard[], recentMax = 3): DayOverview {
  const { finished, started, agents, live } = activityCounts(cards, 0)
  const newest = (a: ActivityRow, b: ActivityRow) => desc(a.at, b.at)
  const agentCards = cards.filter((c) => c.kind === 'agent' && c.rows.length)
  const card = agentCards.find((c) => c.live) ?? agentCards[0]
  const row = card ? allRows(card.rows).filter((r) => !r.gone).sort(newest)[0] : undefined
  const seen = new Set<string>(), states = lastStates(cards)
  const recent = cards.flatMap((c) => allRows(c.rows)).filter((r) => r.kinds.includes('done') && states.get(r.id) === 'done').sort(newest)
    .filter((r) => !seen.has(r.id) && !!seen.add(r.id)).slice(0, recentMax)
  return { finished, started, agents, live, current: card && row ? { card, row } : null, recent }
}
