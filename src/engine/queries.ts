import type { Filter, Issue } from '../model'
import { compareIds, type Store } from './store'
import { BLOCKED_LABEL, CLOSED_TYPES, filterPredicate, statusTypeOf } from '../shared/filter'
import { stalledCtx, stalledReason } from './stalled'
import { ciReasonOf } from './ci'



/** Status name -> type from config. Unknown names count as 'backlog' (open, backlog-like). */
const statusTypes = (s: Store) => statusTypeOf(s.config.statuses)

/** "open" = status type not completed/canceled/duplicate. Missing issues count as closed. */
function openTest(s: Store): (id: string | Issue) => boolean {
  const type = statusTypes(s)
  return (x) => {
    const i = typeof x === 'string' ? s.get(x) : x
    return !!i && !CLOSED_TYPES.has(type(i.status))
  }
}

/** Priority order: urgent(1), high(2), medium(3), low(4), then none(0). */
const prioRank = (p: number) => (p === 0 ? 5 : p)
const byPriorityThenId = (a: Issue, b: Issue) => prioRank(a.priority) - prioRank(b.priority) || compareIds(a.id, b.id)

function mustGet(s: Store, id: string): Issue {
  const i = s.get(id)
  if (!i) throw new Error(`issue ${id} not found`)
  return i
}

/** Count of open issues transitively waiting on `id` (via blocked_by). Cycle-safe. */
export function unblocks(s: Store, id: string): number {
  return countWaiting(s, id, openTest(s))
}

function countWaiting(s: Store, id: string, isOpen: (id: string) => boolean): number {
  const seen = new Set([id])
  const stack = [id]
  let n = 0
  while (stack.length) {
    for (const w of s.blocks(stack.pop()!)) {
      if (seen.has(w)) continue
      seen.add(w)
      if (isOpen(w)) n++
      stack.push(w)
    }
  }
  return n
}

/** Workspaces that ever wrote to the issue, in first-seen order; owner file edits (`external`) don't count. */
export function writerWorkspaces(i: Issue): string[] {
  const out = new Set<string>()
  for (const w of [i.touchedBy?.workspace, ...i.activity.map((a) => a.workspace)]) if (w && w !== 'external') out.add(w)
  return [...out]
}

/** Needs-you test (status or label in config.needsYou); the first home bucket, so it takes every match. */
function needsYouOf(s: Store): (i: Issue) => boolean {
  const nyStatus = new Set(s.config.needsYou.statuses)
  const nyLabels = new Set(s.config.needsYou.labels)
  return (i) => nyStatus.has(i.status) || i.labels.some((l) => nyLabels.has(l))
}

/** Has an open blocker or the Blocked label (the Blocked bucket's test). */
function blockedTest(isOpen: (id: string) => boolean): (i: Issue) => boolean {
  return (i) => i.labels.includes(BLOCKED_LABEL) || i.blockedBy.some((b) => isOpen(b))
}

/**
 * Stalled test (config.stalled, src/engine/stalled.ts) at `now`: the reason, or null. Reads only memory.
 * Blocked wins: an issue with an open blocker (or the Blocked label) is waiting, not stalled.
 * An epic's work happens in its children, so for idle time an issue with children counts its newest change among
 * itself and all its descendants, and one whose open children all need the owner or are blocked is waiting on them,
 * not idle. The churn rules stay per issue.
 */
export function stalledOf(s: Store, now = Date.now()): (i: Issue) => string | null {
  const ctx = stalledCtx({ rules: s.config.stalled, statuses: s.config.statuses, needsYouStatuses: s.config.needsYou.statuses, now })
  const isOpen = openTest(s)
  const isBlocked = blockedTest(isOpen)
  const needsYou = needsYouOf(s)
  // Waiting on its sub-issues: it has open ones, and each needs the owner, is blocked, or is itself waiting on its own.
  const waiting = (i: Issue, seen: Set<string>): boolean => {
    if (seen.has(i.id)) return false // a parent cycle
    seen.add(i.id)
    const open = s.children(i.id).filter((c) => isOpen(c))
    return open.length > 0 && open.every((c) => needsYou(c) || isBlocked(c) || waiting(c, seen))
  }
  const activeAt = (i: Issue): number => {
    // Only the working status can be idle; skip the walk for everything else.
    if (i.status !== ctx.working) return s.lastChange(i)
    if (waiting(i, new Set())) return now
    let t = s.lastChange(i)
    const seen = new Set([i.id])
    const stack = s.children(i.id)
    while (stack.length) {
      const c = stack.pop()!
      if (seen.has(c.id)) continue
      seen.add(c.id)
      const ct = s.lastChange(c)
      if (ct > t || Number.isNaN(t)) t = ct
      stack.push(...s.children(c.id))
    }
    return t
  }
  return (i) => (isBlocked(i) ? null : stalledReason(i, activeAt(i), s.history(i.id), ctx))
}

/**
 * `home(s).needsYou.length` without building the buckets (for the menu-bar poll of /api/health), plus the ids that
 * are there only because they are stalled (the app leaves those out when its stalled setting is off) and every
 * stalled id (the app notifies once per stalled episode, so a Waiting round trip doesn't notify twice).
 */
export function needsYouCount(
  s: Store, now = Date.now(), visible?: (i: Issue) => boolean,
): { count: number; stalledOnly: string[]; stalledAll: string[] } {
  const isOpen = openTest(s)
  const test = needsYouOf(s)
  const stalled = stalledOf(s, now)
  const ci = ciReasonOf(s, now)
  let count = 0
  const stalledOnly: string[] = [], stalledAll: string[] = []
  for (const i of s.all()) {
    if (visible && !visible(i)) continue // a hidden project (src/engine/hidden.ts), for the app's poll
    if (!isOpen(i)) { if (ci(i)) count++; continue } // Done within the window with failing CI
    const needs = test(i) || ci(i) !== null
    const reason = stalled(i)
    if (reason) stalledAll.push(i.id)
    if (needs) count++
    else if (reason) { count++; stalledOnly.push(i.id) }
  }
  return { count, stalledOnly: stalledOnly.sort(compareIds), stalledAll: stalledAll.sort(compareIds) }
}

/**
 * The Needs-you bucket in home order, each with why it needs you: its Needs-you status, else its first Needs-you
 * label, else its CI reason ("CI failing on PR #12"), else `stalled`. `stalled` and `ci` carry those reasons
 * whenever they apply.
 */
export function needsYouList(
  s: Store, limit = 50, now = Date.now(), opts: { stalled?: boolean; visible?: (i: Issue) => boolean } = {},
): { issue: Issue; why: string; stalled?: string; ci?: string }[] {
  const nyStatus = new Set(s.config.needsYou.statuses)
  const nyLabels = new Set(s.config.needsYou.labels)
  const h = home(s, now, { visible: opts.visible })
  const rows = h.needsYou.map((issue) => {
    const reason = h.stalled.get(issue.id)
    const ci = h.ci.get(issue.id)
    const why = nyStatus.has(issue.status) ? issue.status : issue.labels.find((l) => nyLabels.has(l)) ?? ci ?? (reason ? 'stalled' : issue.status)
    return { issue, why, ...(reason ? { stalled: reason } : {}), ...(ci ? { ci } : {}) }
  })
  // Without stalled work, stalled-only rows go before the cut, so the list still holds `limit` real ones.
  return (opts.stalled === false ? rows.filter((r) => r.why !== 'stalled') : rows).slice(0, limit)
}

/**
 * Home "Up next" buckets (spec §7.3), mutually exclusive, in precedence order:
 * needsYou (status or label in config.needsYou, stalled, or failing CI) > blocked (any open blocker, or label
 * Blocked) > inProgress (started) > readyNext (backlog/unstarted; missing blockers count as closed).
 * Only open issues appear, plus Done issues with failing CI (src/engine/ci.ts) in needsYou. `stalled` and `ci` map
 * every stalled open issue / failing-CI issue to its reason (computed in the same pass); with
 * `stalledInNeedsYou: false` (whats_next) stalled and failing-CI issues stay in their usual bucket and are only
 * marked there (Done ones then appear nowhere). `visible` leaves issues out entirely (hidden projects, for the UI).
 */
export function home(s: Store, now = Date.now(), opts: { stalledInNeedsYou?: boolean; visible?: (i: Issue) => boolean } = {}): {
  needsYou: Issue[]; inProgress: Issue[]; readyNext: { issue: Issue; unblocks: number }[]; blocked: { issue: Issue; blockers: string[] }[]
  stalled: Map<string, string>; ci: Map<string, string>
} {
  const type = statusTypes(s)
  const isOpen = openTest(s)
  const needsYouTest = needsYouOf(s)
  const stalledTest = stalledOf(s, now)
  const ciTest = ciReasonOf(s, now)
  const flagged = opts.stalledInNeedsYou !== false
  const needsYou: Issue[] = [], inProgress: Issue[] = []
  const readyNext: { issue: Issue; unblocks: number }[] = []
  const blocked: { issue: Issue; blockers: string[] }[] = []
  const stalled = new Map<string, string>()
  const ci = new Map<string, string>()
  const visible = opts.visible
  for (const i of s.all()) {
    if (visible && !visible(i)) continue
    const ciReason = ciTest(i)
    if (ciReason) ci.set(i.id, ciReason)
    if (!isOpen(i)) { if (ciReason && flagged) needsYou.push(i); continue }
    const reason = stalledTest(i)
    if (reason) stalled.set(i.id, reason)
    if (((reason || ciReason) && flagged) || needsYouTest(i)) { needsYou.push(i); continue }
    const blockers = i.blockedBy.filter((b) => isOpen(b))
    if (blockers.length || i.labels.includes(BLOCKED_LABEL)) { blocked.push({ issue: i, blockers }); continue }
    const t = type(i.status)
    if (t === 'started') inProgress.push(i)
    else if (t === 'backlog' || t === 'unstarted') readyNext.push({ issue: i, unblocks: countWaiting(s, i.id, isOpen) })
  }
  needsYou.sort(byPriorityThenId)
  inProgress.sort(byPriorityThenId)
  blocked.sort((a, b) => byPriorityThenId(a.issue, b.issue))
  readyNext.sort((a, b) => prioRank(a.issue.priority) - prioRank(b.issue.priority) || b.unblocks - a.unblocks || compareIds(a.issue.id, b.issue.id))
  return { needsYou, inProgress, readyNext, blocked, stalled, ci }
}

export interface Tree { issue: Issue; children: Tree[] }

/** The issue and all descendants. Each issue appears once; a parent cycle is cut where it closes. */
export function subtree(s: Store, id: string): Tree {
  const root = mustGet(s, id)
  const seen = new Set<string>([id])
  const build = (issue: Issue): Tree => ({
    issue,
    children: s.children(issue.id).filter((c) => !seen.has(c.id) && seen.add(c.id)).map(build),
  })
  return build(root)
}

/** Parent chain, nearest first. Stops at a missing parent or a cycle. */
export function ancestors(s: Store, id: string): Issue[] {
  const out: Issue[] = []
  const seen = new Set([id])
  let p = s.get(id)?.parent
  while (p && !seen.has(p)) {
    seen.add(p)
    const i = s.get(p)
    if (!i) break
    out.push(i)
    p = i.parent
  }
  return out
}

/** Descendants (any depth, cycle-safe): how many are closed (completed/canceled/duplicate) out of all. */
export function progress(s: Store, id: string): { done: number; total: number } {
  const isOpen = openTest(s)
  const seen = new Set([id])
  const stack = [id]
  let done = 0, total = 0
  while (stack.length) {
    for (const c of s.children(stack.pop()!)) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      total++
      if (!isOpen(c)) done++
      stack.push(c.id)
    }
  }
  return { done, total }
}

/**
 * Issues matching every given criterion. Closed issues are excluded unless `includeDone` or an explicit
 * `status` list is given. `labels`, `workspace`, `status`, `project`, `priority` match any listed value.
 * `workspace` matches touched_by or any activity entry. Predicate shared with the UI (src/shared/filter.ts). Order: search score when `query` is set, else id.
 */
export function filterIssues(s: Store, f: Filter): Issue[] {
  const keep = filterPredicate<Issue>(f, {
    statuses: s.config.statuses,
    get: (id) => s.get(id),
    workspaces: function* (i) { yield i.touchedBy?.workspace; for (const e of i.activity) yield e.workspace },
    blocks: (i) => s.blocks(i.id),
  })
  const q = f.query?.trim()
  const scores = q ? s.index.query(q) : null
  const pool = scores ? [...scores.keys()].map((id) => s.get(id)!).filter(Boolean) : s.all()
  const out = pool.filter(keep)
  return scores
    ? out.sort((a, b) => scores.get(b.id)! - scores.get(a.id)! || compareIds(a.id, b.id))
    : out.sort((a, b) => compareIds(a.id, b.id))
}

/**
 * Full-text search over title > description > activity (every term must match; terms match word prefixes).
 * An exact id ("q-12") ranks first. Ties: most recently updated first. `visible` drops other hits (hidden projects,
 * for the UI) but never the exact id: typing an issue's id still finds it.
 */
export function search(s: Store, q: string, limit = 50, visible?: (i: Issue) => boolean): Issue[] {
  const query = q.trim()
  if (!query) return []
  const scores = s.index.query(query)
  const exact = s.get(query.toUpperCase())
  if (exact) scores.set(exact.id, Number.MAX_SAFE_INTEGER)
  const hits: { i: Issue; score: number; t: number }[] = []
  for (const [id, score] of scores) {
    const i = s.get(id)
    if (i && (!visible || i === exact || visible(i))) hits.push({ i, score, t: Date.parse(i.updated) || 0 })
  }
  hits.sort((a, b) => b.score - a.score || b.t - a.t || compareIds(a.i.id, b.i.id))
  return hits.slice(0, limit).map((h) => h.i)
}
