/** Pure helpers behind the Home view (tested without a DOM). */
import type { FeedEvent } from '../src/engine/eventlog'
import type { Config, IssueSummary, PlanSlot } from '../src/model'
import { inScope, type Scope } from './client'

type Scoped = Pick<IssueSummary, 'project' | 'workspaces'>
type Cfg = Pick<Config, 'workspaces'> | null

/**
 * A Needs-you item; `stalled` is the engine's stalled reason when the issue stalled (config.yml `stalled:`), and
 * `ciReason` its failing-CI reason ("CI failing on PR #12").
 */
export type NeedsYouItem = IssueSummary & { stalled?: string; ciReason?: string }

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
  const own = needsYou?.statuses.includes(i.status) ? i.status : i.labels.find((l) => needsYou?.labels.includes(l))
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
