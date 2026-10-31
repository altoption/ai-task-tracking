/**
 * The issue filter predicate, shared by the engine's `filterIssues` (tools) and the UI's `applyView`,
 * so a saved view shows the same issues to agents and the owner.
 *
 * Text search (`Filter.query`) is not part of the predicate: the engine ranks with its search index,
 * the UI matches every term against id + title (`matchesText`).
 */
import type { Filter, Issue, StatusDef } from '../model'

export type StatusType = StatusDef['type']
export const CLOSED_TYPES: ReadonlySet<StatusType> = new Set(['completed', 'canceled', 'duplicate'])
export const BLOCKED_LABEL = 'Blocked'

/** The fields the predicate reads (both `Issue` and `IssueSummary` have them). */
export type FilterIssue = Pick<Issue, 'id' | 'title' | 'status' | 'project' | 'labels' | 'priority' | 'parent' | 'blockedBy' | 'related' | 'milestone' | 'links' | 'created' | 'updated'>

export interface FilterCtx<T> {
  statuses: StatusDef[]
  /** Resolves blocker / blocked ids; missing issues count as closed. */
  get(id: string): T | undefined
  /** Workspaces that wrote to the issue. */
  workspaces(i: T): Iterable<string | undefined>
  /** Ids of the issues this one blocks. */
  blocks(i: T): string[]
  /** When a closed issue was closed, for `closedWithinDays`; defaults to its `updated`. */
  closedAt?(i: T): string | undefined
  /** The clock `closedWithinDays` counts back from (ms); defaults to now. */
  now?: number
}

/** Status name -> type. Unknown names count as 'backlog' (open). */
export function statusTypeOf(statuses: StatusDef[]): (name: string) => StatusType {
  const m = new Map(statuses.map((d) => [d.name, d.type]))
  return (name) => m.get(name) ?? 'backlog'
}

/** Pure: every criterion must match; list criteria match any listed value. Closed issues pass only with `includeDone`, an explicit `status` list or `closedWithinDays`. */
export function filterPredicate<T extends FilterIssue>(f: Filter, ctx: FilterCtx<T>): (i: T) => boolean {
  const type = statusTypeOf(ctx.statuses)
  const open = (i: T | undefined) => !!i && !CLOSED_TYPES.has(type(i.status))
  const set = <X>(xs?: X[]) => (xs && xs.length ? new Set(xs) : null)
  const status = set(f.status), project = set(f.project), labels = set(f.labels)
  const workspace = set(f.workspace), priority = set(f.priority), milestone = set(f.milestone)
  const date = (s?: string) => (s ? Date.parse(s) : NaN)
  const updatedAfter = date(f.updatedAfter), createdAfter = date(f.createdAfter)
  const days = f.closedWithinDays
  const closedSince = typeof days === 'number' && days > 0 && Number.isFinite(days) ? (ctx.now ?? Date.now()) - days * 86_400_000 : NaN
  const rolling = !Number.isNaN(closedSince)
  return (i) => {
    if (status) { if (!status.has(i.status)) return false } else if (!f.includeDone && !rolling && !open(i)) return false
    if (rolling && (open(i) || !(Date.parse(ctx.closedAt?.(i) ?? i.updated) >= closedSince))) return false
    if (project && !project.has(i.project)) return false
    if (labels && !i.labels.some((l) => labels.has(l))) return false
    if (priority && !priority.has(i.priority)) return false
    if (milestone && !(i.milestone && milestone.has(i.milestone))) return false
    if (f.parent !== undefined && i.parent !== f.parent) return false
    if (workspace) {
      let hit = false
      for (const w of ctx.workspaces(i)) if (w && workspace.has(w)) { hit = true; break }
      if (!hit) return false
    }
    if (f.blocked !== undefined) {
      const isBlocked = i.labels.includes(BLOCKED_LABEL) || i.blockedBy.some((b) => open(ctx.get(b)))
      if (isBlocked !== f.blocked) return false
    }
    if (f.blocking !== undefined && ctx.blocks(i).some((b) => open(ctx.get(b))) !== f.blocking) return false
    if (f.hasRelated !== undefined && (i.related.length > 0) !== f.hasRelated) return false
    if (f.hasLinks !== undefined && (i.links.length > 0) !== f.hasLinks) return false
    if (!Number.isNaN(updatedAfter) && !(Date.parse(i.updated) > updatedAfter)) return false
    if (!Number.isNaN(createdAfter) && !(Date.parse(i.created) > createdAfter)) return false
    return true
  }
}

/** Pure: every whitespace-separated term occurs (case-insensitive) in the id or title. */
export function matchesText(i: Pick<FilterIssue, 'id' | 'title'>, q: string): boolean {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const hay = `${i.id} ${i.title}`.toLowerCase()
  return terms.every((t) => hay.includes(t))
}
