/** Pure helpers behind the issue page (tested without a DOM). */
import type { FeedEvent } from '../src/engine/eventlog'
import type { ActivityEntry, IssueSummary, LabelDef } from '../src/model'

// ---------- sub-issue tree ----------

export interface TreeNode { issue: IssueSummary; children: TreeNode[] }

/** `Q-2` before `Q-10`: key, then number. */
export function byIssueNumber(a: { id: string }, b: { id: string }): number {
  const [ka = '', na = '0'] = a.id.split('-')
  const [kb = '', nb = '0'] = b.id.split('-')
  return ka.localeCompare(kb) || Number(na) - Number(nb)
}

/** Pure: the sub-issues of `rootId` to any depth from the live summaries. A parent cycle stops at the first repeat. */
export function buildTree(issues: Map<string, IssueSummary>, rootId: string): TreeNode[] {
  const byParent = new Map<string, IssueSummary[]>()
  for (const i of issues.values()) {
    if (!i.parent) continue
    const list = byParent.get(i.parent)
    if (list) list.push(i)
    else byParent.set(i.parent, [i])
  }
  const seen = new Set<string>([rootId])
  const walk = (id: string): TreeNode[] =>
    (byParent.get(id) ?? []).slice().sort(byIssueNumber).filter((c) => !seen.has(c.id)).map((c) => {
      seen.add(c.id)
      return { issue: c, children: walk(c.id) }
    })
  return walk(rootId)
}

/** Pure: done/total over every node of a (sub)tree, like the engine's progress; `closed` says which statuses count as done. */
export function treeProgress(nodes: TreeNode[], closed: (status: string) => boolean): { done: number; total: number } {
  let done = 0, total = 0
  const walk = (ns: TreeNode[]) => { for (const n of ns) { total++; if (closed(n.issue.status)) done++; walk(n.children) } }
  walk(nodes)
  return { done, total }
}

/** Every node of a (sub)tree, parents before their children. */
export function flatten(nodes: TreeNode[]): IssueSummary[] {
  const out: IssueSummary[] = []
  const walk = (ns: TreeNode[]) => { for (const n of ns) { out.push(n.issue); walk(n.children) } }
  walk(nodes)
  return out
}

export interface StatusShare { status: string; count: number }

/**
 * Pure: how many of the issues sit in each status, in the order work moves through them backwards (`order`: the
 * config's statuses, closed ones first), so a bar of the shares reads done → in progress → not started.
 */
export function statusMix(issues: readonly Pick<IssueSummary, 'status'>[], order: readonly string[]): StatusShare[] {
  const counts = new Map<string, number>()
  for (const i of issues) counts.set(i.status, (counts.get(i.status) ?? 0) + 1)
  const rank = new Map(order.map((s, k) => [s, k]))
  return [...counts].map(([status, count]) => ({ status, count })).sort((a, b) => (rank.get(a.status) ?? order.length) - (rank.get(b.status) ?? order.length))
}

/** The issue's blockers that are still open (known to `issues` and not `closed`). */
export function openBlockers(i: Pick<IssueSummary, 'blockedBy'>, issues: ReadonlyMap<string, IssueSummary>, closed: (status: string) => boolean): IssueSummary[] {
  return (i.blockedBy ?? []).map((b) => issues.get(b)).filter((b): b is IssueSummary => !!b && !closed(b.status))
}

/**
 * The sub-issue to pick up next: the first, in the order given, that hasn't been started (`started` says which
 * statuses have, closed ones included) and has no open blocker. Undefined when everything is started or blocked.
 */
export function nextUp(list: readonly IssueSummary[], issues: ReadonlyMap<string, IssueSummary>, started: (status: string) => boolean, closed: (status: string) => boolean): IssueSummary | undefined {
  return list.find((i) => !started(i.status) && !closed(i.status) && openBlockers(i, issues, closed).length === 0)
}

// ---------- position among the parent's sub-issues ----------

export interface Position {
  parent: IssueSummary
  /** 1-based place among the parent's sub-issues, in id order (the order the issue page lists them). */
  index: number
  total: number
  done: number
  prev?: IssueSummary
  next?: IssueSummary
}

/** Pure: where `id` sits among its parent's sub-issues. Null without a parent the live store holds. */
export function positionInParent(issues: ReadonlyMap<string, IssueSummary>, id: string, closed: (status: string) => boolean): Position | null {
  const me = issues.get(id)
  const parent = me?.parent && me.parent !== id ? issues.get(me.parent) : undefined
  if (!me || !parent) return null
  const sibs: IssueSummary[] = []
  for (const i of issues.values()) if (i.parent === parent.id && i.id !== parent.id) sibs.push(i)
  sibs.sort(byIssueNumber)
  const at = sibs.findIndex((i) => i.id === id)
  if (at < 0) return null
  const prev = sibs[at - 1], next = sibs[at + 1]
  return { parent, index: at + 1, total: sibs.length, done: sibs.reduce((n, i) => n + (closed(i.status) ? 1 : 0), 0), ...(prev ? { prev } : {}), ...(next ? { next } : {}) }
}

// ---------- activity ----------

export type ActivityItem =
  | { kind: 'comment'; at: string; entry: ActivityEntry }
  | { kind: 'event'; at: string; event: FeedEvent }

/** Field changes shown between comments (comments come from the file; `updated` is too noisy). */
const SHOWN_EVENTS = new Set<FeedEvent['kind']>(['created', 'status', 'parent', 'blocked'])

/** Pure: the issue's comments interleaved with its field-change events, oldest first. */
export function activityItems(activity: ActivityEntry[], feed: FeedEvent[]): ActivityItem[] {
  const t = (s: string) => { const n = Date.parse(s); return Number.isNaN(n) ? 0 : n }
  const items: ActivityItem[] = [
    ...activity.map((entry) => ({ kind: 'comment' as const, at: entry.at, entry })),
    ...feed.filter((e) => SHOWN_EVENTS.has(e.kind)).map((event) => ({ kind: 'event' as const, at: event.at, event })),
  ]
  return items.map((x, n) => ({ x, n })).sort((a, b) => t(a.x.at) - t(b.x.at) || a.n - b.n).map((v) => v.x)
}

/** Text of a field-change event on the issue's own page. */
export function eventText(e: FeedEvent): string {
  switch (e.kind) {
    case 'created': return e.to ? `created the issue under ${e.to}` : 'created the issue'
    case 'status': return e.from ? `moved from ${e.from} to ${e.to ?? '?'}` : `moved to ${e.to ?? '?'}`
    case 'parent': return e.to ? `set parent to ${e.to}` : `removed parent ${e.from ?? ''}`.trim()
    case 'blocked': return e.to ? `marked blocked by ${e.to}` : 'cleared blockers'
    default: return 'updated the issue'
  }
}

// ---------- pickers ----------

export interface Option { value: string; label: string; group: string | null; color?: string; hint?: string }

/** Pure: labels as picker options, ungrouped first, then by group; the group prefix is dropped from the label. */
export function labelOptions(labels: LabelDef[]): Option[] {
  return labels
    .map((l) => ({ value: l.name, label: l.group && l.name.startsWith(l.group + '/') ? l.name.slice(l.group.length + 1) : l.name, group: l.group, color: l.color }))
    .sort((a, b) => (a.group === null ? 0 : 1) - (b.group === null ? 0 : 1) || (a.group ?? '').localeCompare(b.group ?? '') || a.label.localeCompare(b.label))
}

/** Pure: type-ahead — every word of the query appears in the option's label, group, value or hint. */
export function filterOptions<T extends Option>(opts: T[], q: string): T[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return opts
  return opts.filter((o) => {
    const hay = `${o.label} ${o.group ?? ''} ${o.value} ${o.hint ?? ''}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** "3 attempts · 2 tools" (one attempt per agent session; tools are distinct agent clients). Empty with none. */
export function attemptsSummary(list: readonly { client?: string }[]): string {
  if (!list.length) return ''
  const tools = new Set(list.map((a) => a.client ?? '?')).size
  return `${list.length} attempt${list.length === 1 ? '' : 's'} · ${tools} tool${tools === 1 ? '' : 's'}`
}
