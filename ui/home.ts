/** Pure helpers behind the Home view (tested without a DOM). */
import type { FeedEvent } from '../src/engine/eventlog'
import type { Config, Filter, IssueSummary, PlanSlot, StatusDef } from '../src/model'
import { inScope, type Scope } from './client'
import { href } from './router'
import { applyView, DEFAULT_DISPLAY, viewToQuery } from './viewModel'

type Scoped = Pick<IssueSummary, 'project' | 'workspaces'>
type Cfg = Pick<Config, 'workspaces'> | null

/**
 * A Needs-you item; `stalled` is the engine's stalled reason when the issue stalled (config.yml `stalled:`), and
 * `ciReason` its failing-CI reason ("CI failing on PR #12"). `request` is its newest comment on one line and
 * `waitingSince` when it moved into its Needs-you status, when the engine knows (src/engine/queries.ts needsYouRequest).
 */
export type NeedsYouItem = IssueSummary & { stalled?: string; ciReason?: string; request?: string; waitingSince?: string }

/** `/api/home` payload: issue summaries in buckets. */
export interface HomeData {
  needsYou: NeedsYouItem[]
  inProgress: IssueSummary[]
  readyNext: { issue: IssueSummary; unblocks: number }[]
  blocked: { issue: IssueSummary; blockers: string[] }[]
}

/** The feed text after the actor: `moved Q-27 → In Progress`, `on Q-144: "…"`, `created Q-276 under Q-269`, `blocked Q-108 by Q-107`. */
export function feedLine(e: FeedEvent, parentOf?: (id: string) => string | null | undefined): string {
  switch (e.kind) {
    case 'status': return `moved ${e.id} → ${e.to ?? '?'}`
    case 'comment': return `on ${e.id}: "${(e.text ?? '').slice(0, 80)}"`
    case 'created': {
      const parent = e.to || parentOf?.(e.id)
      return parent ? `created ${e.id} under ${parent}` : `created ${e.id}`
    }
    case 'blocked': return e.to ? `blocked ${e.id} by ${e.to}` : `unblocked ${e.id}`
    case 'parent': return e.to ? `moved ${e.id} under ${e.to}` : `moved ${e.id} out of ${e.from ?? '?'}`
    default: return `updated ${e.id}`
  }
}

/** Who the line is attributed to; watcher reloads (workspace `external`) are the owner editing files by hand. */
export function feedActor(e: FeedEvent): { label: string; kind: 'agent' | 'you' | 'hand' } {
  if (e.actor.workspace === 'external') return { label: 'edited by hand', kind: 'hand' }
  if (e.actor.actor === 'agent') return { label: e.actor.workspace ?? 'agent', kind: 'agent' }
  return { label: 'you', kind: 'you' }
}

/** `now`, `4m`, `2h`, `3d`; empty for an unparseable time. */
export function relTime(iso: string, nowMs: number): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.floor((nowMs - t) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/**
 * Why a Needs-you item needs the owner: its Needs-you status, else its first Needs-you label, plus how long ago it
 * last changed (`Waiting · 3d`). A stalled item gets `stalled` (the engine's reason); when stalling is the only
 * reason, `why` is empty and the row shows just the stalled mark and reason.
 */
export function needsYouWhy(
  i: NeedsYouItem, needsYou: Config['needsYou'] | undefined, nowMs: number,
): { why: string; stalled?: string; ci?: string } {
  // A hand-edited config.yml may hold anything here (`statuses: null`): only an array counts.
  const statuses = Array.isArray(needsYou?.statuses) ? needsYou.statuses : []
  const labels = Array.isArray(needsYou?.labels) ? needsYou.labels : []
  const own = statuses.includes(i.status) ? i.status : i.labels.find((l) => labels.includes(l))
  const stalled = { ...(i.stalled ? { stalled: i.stalled } : {}), ...(i.ciReason ? { ci: i.ciReason } : {}) }
  if (!own && (i.stalled || i.ciReason)) return { why: '', ...stalled }
  const why = own ?? i.status
  const age = relTime(i.updated, nowMs)
  return { why: age && age !== 'now' ? `${why} · ${age}` : why, ...stalled }
}

/** The Up-next sections limited to the workspace/project switcher. Returns `data` itself for "all". */
export function scopeHome(d: HomeData, scope: Scope, config: Cfg): HomeData {
  if (scope.kind === 'all') return d
  const keep = (i: Scoped) => inScope(i, scope, config)
  return {
    needsYou: d.needsYou.filter(keep),
    inProgress: d.inProgress.filter(keep),
    readyNext: d.readyNext.filter((x) => keep(x.issue)),
    blocked: d.blocked.filter((x) => keep(x.issue)),
  }
}

/** A feed line is in scope when its issue is, or (workspace scope) the acting workspace is. `issue` is undefined for deleted issues. */
export function feedInScope(e: FeedEvent, issue: Scoped | undefined, scope: Scope, config: Cfg): boolean {
  if (scope.kind === 'all') return true
  if (scope.kind === 'workspace' && e.actor.workspace === scope.name) return true
  return !!issue && inScope(issue, scope, config)
}

export const PLAN_SLOTS = ['now', 'next', 'later'] as const
export type BoardColumns = Record<(typeof PLAN_SLOTS)[number], IssueSummary[]>

/** Now/Next/Later columns from `plan` (null stays off the board). `overrides` are optimistic drops not yet confirmed by the engine. */
export function boardColumns(issues: Iterable<IssueSummary>, overrides: Record<string, PlanSlot>): BoardColumns {
  const cols: BoardColumns = { now: [], next: [], later: [] }
  for (const i of issues) {
    const plan = i.id in overrides ? overrides[i.id]! : i.plan
    if (plan) cols[plan].push(i)
  }
  const rank = (p: number) => p || 5
  for (const k of PLAN_SLOTS) cols[k].sort((a, b) => rank(a.priority) - rank(b.priority) || b.updated.localeCompare(a.updated))
  return cols
}

// ---------- the Daily overview (ATT-53) ----------

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** "less than an hour", "1 hour", "5 hours", "1 day", "8 days". */
export function duration(ms: number): string {
  if (!(ms >= HOUR)) return 'less than an hour'
  if (ms < DAY) { const h = Math.floor(ms / HOUR); return `${h} ${h === 1 ? 'hour' : 'hours'}` }
  const d = Math.floor(ms / DAY)
  return `${d} ${d === 1 ? 'day' : 'days'}`
}

/** One Needs-you card: the status chip, the request, how long it has waited and the action's label. */
export interface NeedsYouCard {
  /** "Input needed" (Waiting), another Needs-you status, a Needs-you label ("Needs review"), "CI failing" or "Stalled". */
  status: string
  /** What it asks: the newest comment, else the failing CI or the stalled reason. */
  summary?: string
  /** "Waiting 3 days" (since it moved into its Needs-you status), else "No activity for 7 days" / "Updated 2 hours ago". */
  age: string
  /** "View request" when there is a request to read, "Review" for a review, else "Open". */
  action: string
  stalled?: string
  ci?: string
}

export function needsYouCard(i: NeedsYouItem, needsYou: Config['needsYou'] | undefined, nowMs: number): NeedsYouCard {
  const statuses = Array.isArray(needsYou?.statuses) ? needsYou.statuses : []
  const labels = Array.isArray(needsYou?.labels) ? needsYou.labels : []
  const byStatus = statuses.includes(i.status)
  const label = i.labels.find((l) => labels.includes(l))
  const status = byStatus ? (i.status === 'Waiting' ? 'Input needed' : i.status) : label ?? (i.ciReason ? 'CI failing' : i.stalled ? 'Stalled' : i.status)
  const since = i.waitingSince ? Date.parse(i.waitingSince) : NaN
  let age: string
  if (byStatus && !Number.isNaN(since)) age = `Waiting ${duration(nowMs - since)}`
  else {
    const quiet = nowMs - Date.parse(i.updated)
    age = Number.isNaN(quiet) ? '' : quiet >= DAY ? `No activity for ${duration(quiet)}` : quiet >= HOUR ? `Updated ${duration(quiet)} ago` : 'Updated just now'
  }
  const summary = i.request ?? i.ciReason ?? i.stalled
  const review = /review/i.test(status)
  return {
    status, age, action: review ? 'Review' : i.request ? 'View request' : 'Open',
    ...(summary ? { summary } : {}), ...(i.stalled ? { stalled: i.stalled } : {}), ...(i.ciReason ? { ci: i.ciReason } : {}),
  }
}

/** "12 finished today. 5 in progress. 3 need you." with each count's own wording. */
export function daySummary(c: { finished: number; inProgress: number; needsYou: number }): string {
  const needs = c.needsYou === 0 ? 'Nothing needs you.' : `${c.needsYou} ${c.needsYou === 1 ? 'needs' : 'need'} you.`
  return `${c.finished} finished today. ${c.inProgress} in progress. ${needs}`
}

/**
 * The heading's line. It waits for both sources: `home` from /api/home and the count finished today from the feed
 * (null until it has arrived), so it never claims "0 finished" before knowing.
 */
export function overviewLine(home: Pick<HomeData, 'inProgress' | 'needsYou'> | null, finished: number | null, ready: boolean): string {
  if (!ready) return 'Connecting…'
  if (!home || finished === null) return 'Loading…'
  return daySummary({ finished, inProgress: home.inProgress.length, needsYou: home.needsYou.length })
}

/** "Friday, October 30" (the eyebrow; CSS capitalizes it). */
export function dayHeading(nowMs: number): string {
  return new Date(nowMs).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

/**
 * Blocked work as dependency chains, root blocker first: each blocked issue walks back through its first open blocker,
 * and a chain that a longer one contains is left out. `more` counts the other open blockers along the chain, which it
 * doesn't show. `cycle`: the walk came back to itself (E blocks F blocks E), so nothing in it can start; a cycle shows
 * as one chain, not one per member.
 */
export function blockedChains(
  blocked: { issue: Pick<IssueSummary, 'id'> }[], get: (id: string) => Pick<IssueSummary, 'id' | 'blockedBy'> | undefined,
  isOpen: (id: string) => boolean,
): { ids: string[]; more: number; cycle?: true }[] {
  const chains = blocked.map(({ issue }) => {
    const ids = [issue.id]
    let more = 0, cycle = false
    let cur = get(issue.id)
    while (cur) {
      const open = cur.blockedBy.filter((b) => isOpen(b))
      const fresh = open.filter((b) => !ids.includes(b))
      if (fresh.length < open.length) cycle = true
      more += Math.max(0, fresh.length - 1)
      if (!fresh.length) break
      ids.unshift(fresh[0]!)
      cur = get(fresh[0]!)
    }
    return { ids, more, ...(cycle ? { cycle: true as const } : {}) }
  })
  // A chain that a longer one starts with (A → B, and A → B → C) is part of the longer one.
  const startsWith = (d: string[], c: string[]) => d.length > c.length && c.every((id, n) => d[n] === id)
  const out = chains.filter((c) => !chains.some((d) => startsWith(d.ids, c.ids)))
  // The same cycle read from another member, or from an issue waiting on it: only the longest, first one stays.
  return out.filter((c, n) => !c.cycle || !out.some((d, m) => d !== c && d.cycle && c.ids.every((id) => d.ids.includes(id))
    && (d.ids.length > c.ids.length || (d.ids.length === c.ids.length && m < n))))
}

/** The All issues list with `filter` (the page's default display), as a link. */
/** How many issues a Home link's full list shows, in scope: it can be more than Home's section, since Needs you takes stalled and failing issues first. */
export function listCount(issues: IssueSummary[], filter: Filter, statuses: StatusDef[]): number {
  return applyView(issues, { filter, display: DEFAULT_DISPLAY }, { statuses }).total
}

export function listHref(filter: Filter): string {
  const base = { filter: {}, display: DEFAULT_DISPLAY }
  return href({ name: 'issues', query: viewToQuery({ filter, display: DEFAULT_DISPLAY }, base) })
}

/** Status names of the given types, without the Needs-you statuses (Waiting is in Needs you, not In progress). */
export function statusesOf(config: Pick<Config, 'statuses' | 'needsYou'> | null, types: string[]): string[] {
  const needs = new Set(Array.isArray(config?.needsYou?.statuses) ? config.needsYou.statuses : [])
  return (config?.statuses ?? []).filter((s) => types.includes(s.type) && !needs.has(s.name)).map((s) => s.name)
}
