/**
 * Pure view logic behind the list and board (tested without a DOM): filter → sub-issue hiding → order →
 * group (columns) → rows (board swimlanes); list nesting; the view state in the URL query; board drops.
 *
 * Filtering uses the predicate shared with the engine's `filterIssues` (src/shared/filter.ts).
 */
import type { FeedEvent } from '../src/engine/eventlog'
import type { CompletedWindow, Filter, IssueSummary, LabelDef, StatusDef, View, ViewDisplay } from '../src/model'
import { CLOSED_TYPES, closedWindowDays, filterPredicate, matchesText, statusTypeOf } from '../src/shared/filter'
import { byIssueNumber } from './issuePage'

export interface ViewCtx {
  statuses: StatusDef[]
  /** For label-group columns (every label of the group is a candidate column). */
  labels?: Pick<LabelDef, 'name' | 'group'>[]
  /** For project names and candidate columns. */
  projects?: { slug: string; name: string }[]
  /** Every issue (parents, blockers and context rows resolve here); defaults to `issues`. */
  byId?: ReadonlyMap<string, IssueSummary>
  now?: number
}
export interface ViewRow { key: string; label: string; issues: IssueSummary[] }
export interface ViewGroup { key: string; label: string; rows?: ViewRow[]; issues: IssueSummary[] }
export interface ViewResult {
  groups: ViewGroup[]
  /** Candidate groups left out because they are empty (the board's "Hidden columns"). */
  hidden: { key: string; label: string }[]
  /** Issues shown (each counted once). */
  total: number
}
export interface ViewState { filter: Filter; display: ViewDisplay }

export const NONE = 'none'
const PRIORITY_LABELS = ['No priority', 'Urgent', 'High', 'Medium', 'Low']
const PRIORITY_ORDER = ['1', '2', '3', '4', '0']
const DAY = 86_400_000
const WINDOW_DAYS: Partial<Record<CompletedWindow, number>> = { day: 1, week: 7, month: 30 }

export const DEFAULT_DISPLAY: ViewDisplay = {
  layout: 'list', groupBy: 'status', orderBy: 'priority', showSubIssues: true, properties: ['id', 'status', 'priority', 'labels', 'project', 'updated'],
}
/** Display properties, in display order. */
export const PROPERTIES: { key: string; label: string }[] = [
  { key: 'id', label: 'ID' }, { key: 'status', label: 'Status' }, { key: 'priority', label: 'Priority' },
  { key: 'project', label: 'Project' }, { key: 'due', label: 'Due date' }, { key: 'milestone', label: 'Milestone' },
  { key: 'labels', label: 'Labels' }, { key: 'links', label: 'Links' }, { key: 'time', label: 'Time in status' },
  { key: 'created', label: 'Created' }, { key: 'updated', label: 'Updated' },
]
export const ORDERINGS = [
  { value: 'priority', label: 'Priority' }, { value: 'updated', label: 'Last updated' },
  { value: 'created', label: 'Created' }, { value: 'closed', label: 'Closed' }, { value: 'manual', label: 'Manual (ID)' },
]
/** Grouping choices: fixed ones plus one per label group. */
export function groupingOptions(labels: Pick<LabelDef, 'group'>[]): { value: string; label: string }[] {
  const groups = [...new Set(labels.map((l) => l.group).filter((g): g is string => !!g))].sort()
  return [
    { value: 'status', label: 'Status' }, { value: 'project', label: 'Project' }, { value: 'priority', label: 'Priority' },
    ...groups.map((g) => ({ value: `label-group:${g}`, label: `Label: ${g}` })),
    { value: 'parent', label: 'Parent issue' }, { value: NONE, label: 'No grouping' },
  ]
}
export const ROW_OPTIONS = [{ value: 'parent', label: 'Parent issue' }, { value: 'project', label: 'Project' }, { value: NONE, label: 'No rows' }]

// ---------- ordering ----------

const prioRank = (p: number) => (p === 0 ? 5 : p)
const desc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0)
export function comparator(orderBy: string): (a: IssueSummary, b: IssueSummary) => number {
  switch (orderBy) {
    case 'updated': return (a, b) => desc(a.updated, b.updated) || byIssueNumber(a, b)
    case 'created': return (a, b) => desc(a.created, b.created) || byIssueNumber(a, b)
    case 'closed': { // newest close first; by date, since imported close dates may be written differently
      const at = (i: IssueSummary) => Date.parse(i.closedAt ?? '') || 0
      return (a, b) => at(b) - at(a) || byIssueNumber(a, b)
    }
    case 'manual': return byIssueNumber
    default: return (a, b) => prioRank(a.priority) - prioRank(b.priority) || desc(a.updated, b.updated) || byIssueNumber(a, b)
  }
}

// ---------- dimensions (columns / rows) ----------

interface Dim {
  keysOf(i: IssueSummary): string[]
  label(key: string): string
  /** Known values in display order (candidates for empty columns). */
  candidates: string[]
  /** Order for keys outside `candidates`. */
  rest(a: string, b: string): number
}

function dimension(by: string, filter: Filter, ctx: Required<Pick<ViewCtx, 'statuses' | 'byId'>> & ViewCtx, cmp: (a: IssueSummary, b: IssueSummary) => number, showDone: boolean): Dim {
  const alpha = (a: string, b: string) => a.localeCompare(b)
  if (by === 'status') {
    const type = statusTypeOf(ctx.statuses)
    const cands = filter.status?.length
      ? [...ctx.statuses.map((s) => s.name).filter((n) => filter.status!.includes(n)), ...filter.status.filter((n) => !ctx.statuses.some((s) => s.name === n))]
      : ctx.statuses.filter((s) => showDone || !CLOSED_TYPES.has(type(s.name))).map((s) => s.name)
    // A rolling closed window shows closed issues only, so open columns could never fill.
    const candidates = closedWindowDays(filter) ? cands.filter((n) => CLOSED_TYPES.has(type(n))) : cands
    return { keysOf: (i) => [i.status], label: (k) => k, candidates, rest: alpha }
  }
  if (by === 'priority') {
    const cands = filter.priority?.length ? PRIORITY_ORDER.filter((p) => filter.priority!.includes(Number(p))) : PRIORITY_ORDER
    return { keysOf: (i) => [String(i.priority)], label: (k) => PRIORITY_LABELS[Number(k)] ?? k, candidates: cands, rest: alpha }
  }
  if (by === 'project') {
    const names = new Map((ctx.projects ?? []).map((p) => [p.slug, p.name]))
    const cands = (ctx.projects ?? []).filter((p) => p.slug !== '_none' && (!filter.project?.length || filter.project.includes(p.slug)))
      .sort((a, b) => a.name.localeCompare(b.name)).map((p) => p.slug)
    return {
      keysOf: (i) => [i.project], label: (k) => (k === '_none' ? 'No project' : names.get(k) ?? k), candidates: cands,
      rest: (a, b) => Number(a === '_none') - Number(b === '_none') || alpha(a, b),
    }
  }
  if (by.startsWith('label-group:')) {
    const g = by.slice('label-group:'.length)
    const prefix = `${g}/`
    const cands = (ctx.labels ?? []).filter((l) => l.group === g || l.name.startsWith(prefix)).map((l) => l.name).sort(alpha)
    return {
      keysOf: (i) => { const ks = i.labels.filter((l) => l.startsWith(prefix)); return ks.length ? ks : [NONE] },
      label: (k) => (k === NONE ? `No ${g}` : k.startsWith(prefix) ? k.slice(prefix.length) : k), candidates: cands,
      rest: (a, b) => Number(a === NONE) - Number(b === NONE) || alpha(a, b),
    }
  }
  if (by === 'parent') {
    const parentOf = (i: IssueSummary) => (i.parent && i.parent !== i.id && ctx.byId.has(i.parent) ? i.parent : NONE)
    return {
      keysOf: (i) => [parentOf(i)], label: (k) => (k === NONE ? 'No parent' : ctx.byId.get(k)?.title ?? k), candidates: [],
      rest: (a, b) => Number(a === NONE) - Number(b === NONE) || (a === NONE || b === NONE ? 0 : cmp(ctx.byId.get(a)!, ctx.byId.get(b)!)),
    }
  }
  return { keysOf: () => ['all'], label: () => 'All issues', candidates: [], rest: alpha }
}

/** Ordered buckets of already-ordered issues; an issue can sit in several (label groups). */
function bucket(issues: IssueSummary[], dim: Dim, keepEmpty: boolean): { buckets: { key: string; label: string; issues: IssueSummary[] }[]; hidden: { key: string; label: string }[] } {
  const m = new Map<string, IssueSummary[]>()
  for (const i of issues) for (const k of dim.keysOf(i)) {
    const list = m.get(k)
    if (list) list.push(i)
    else m.set(k, [i])
  }
  const cand = new Set(dim.candidates)
  const keys = [...dim.candidates.filter((k) => keepEmpty || m.has(k)), ...[...m.keys()].filter((k) => !cand.has(k)).sort(dim.rest)]
  return {
    buckets: keys.map((key) => ({ key, label: dim.label(key), issues: m.get(key) ?? [] })),
    hidden: keepEmpty ? [] : dim.candidates.filter((k) => !m.has(k)).map((key) => ({ key, label: dim.label(key) })),
  }
}

// ---------- applyView ----------

/** Pure: the issues of a view, grouped (and on a board, split into rows). */
export function applyView(issues: IssueSummary[], v: Pick<View, 'filter' | 'display'>, ctx: ViewCtx): ViewResult {
  const byId = ctx.byId ?? new Map(issues.map((i) => [i.id, i]))
  const { filter: f, display: d } = v
  const type = statusTypeOf(ctx.statuses)
  const closed = (i: IssueSummary) => CLOSED_TYPES.has(type(i.status))
  // Completed-issues window (display) applies when the filter doesn't name statuses or its own closed window.
  const rolling = !!closedWindowDays(f)
  const win = !f.status?.length && !rolling && d.completed ? d.completed : undefined
  const showDone = win ? win !== 'none' : !!f.includeDone
  const keep = filterPredicate<IssueSummary>({ ...f, includeDone: showDone }, {
    statuses: ctx.statuses, get: (id) => byId.get(id), workspaces: (i) => i.workspaces, blocks: (i) => i.blocks,
    closedAt: (i) => i.closedAt, ...(ctx.now !== undefined ? { now: ctx.now } : {}),
  })
  const days = win ? WINDOW_DAYS[win] : undefined
  const cutoff = days ? (ctx.now ?? Date.now()) - days * DAY : NaN
  const q = f.query?.trim()
  let out = issues.filter((i) => keep(i) && (!q || matchesText(i, q)) && (Number.isNaN(cutoff) || !closed(i) || Date.parse(i.updated) >= cutoff))
  if (!d.showSubIssues) {
    const shown = new Set(out.map((i) => i.id))
    out = out.filter((i) => !(i.parent && i.parent !== i.id && shown.has(i.parent)))
  }
  const cmp = comparator(d.orderBy)
  out.sort(cmp)
  const full = { ...ctx, byId }
  const cols = bucket(out, dimension(d.groupBy, f, full, cmp, showDone || rolling), !!d.showEmptyColumns)
  const rowsBy = d.layout === 'board' && d.rowsBy && d.rowsBy !== NONE ? d.rowsBy : null
  const rowDim = rowsBy ? dimension(rowsBy, f, full, cmp, showDone || rolling) : null
  const groups: ViewGroup[] = cols.buckets.map((b) => (rowDim ? { ...b, rows: bucket(b.issues, rowDim, false).buckets } : b))
  return { groups, hidden: cols.hidden, total: out.length }
}

/** Pure: board swimlanes across all columns, in order, with how many cards each holds. */
export function swimlanes(groups: ViewGroup[], rowsBy: string, ctx: ViewCtx & { byId: ReadonlyMap<string, IssueSummary> }, orderBy: string, keepEmpty = false): { key: string; label: string; count: number }[] {
  const counts = new Map<string, { label: string; count: number }>()
  for (const g of groups) for (const r of g.rows ?? []) {
    const c = counts.get(r.key)
    if (c) c.count += r.issues.length
    else counts.set(r.key, { label: r.label, count: r.issues.length })
  }
  const dim = dimension(rowsBy, {}, { ...ctx }, comparator(orderBy), true)
  const cand = dim.candidates.filter((k) => keepEmpty || counts.has(k))
  const known = new Set(dim.candidates)
  const keys = [...cand, ...[...counts.keys()].filter((k) => !known.has(k)).sort(dim.rest)]
  return keys.map((key) => ({ key, ...(counts.get(key) ?? { label: dim.label(key), count: 0 }) }))
}

// ---------- list nesting ----------

export interface ListRow { issue: IssueSummary; depth: number; /** an ancestor shown for context (not in this group) */ context: boolean }

/**
 * Pure: list rows of one group. With `nest`, sub-issues sit under their nearest ancestor and ancestors that are
 * not in the group appear as dimmed context rows. Parents land where their first row would be.
 * Cycle-safe: each issue appears once.
 */
export function listRows(group: IssueSummary[], byId: ReadonlyMap<string, IssueSummary>, nest: boolean): ListRow[] {
  if (!nest) return group.map((issue) => ({ issue, depth: 0, context: false }))
  interface Node { issue: IssueSummary; context: boolean; children: Node[] }
  const inGroup = new Set(group.map((i) => i.id))
  const nodes = new Map<string, Node>()
  const roots: Node[] = []
  for (const i of group) {
    const chain: IssueSummary[] = []
    const seen = new Set([i.id])
    for (let p = i.parent; p && !seen.has(p);) {
      seen.add(p)
      const a = byId.get(p)
      if (!a) break
      chain.push(a)
      p = a.parent
    }
    let parent: Node | null = null
    for (const x of [...chain.reverse(), i]) {
      let n = nodes.get(x.id)
      if (!n) {
        n = { issue: x, context: !inGroup.has(x.id), children: [] }
        nodes.set(x.id, n)
        ;(parent ? parent.children : roots).push(n)
      }
      parent = n
    }
  }
  const out: ListRow[] = []
  const stack: [Node, number][] = roots.map((n) => [n, 0] as [Node, number]).reverse()
  while (stack.length) {
    const [n, depth] = stack.pop()!
    out.push({ issue: n.issue, depth, context: n.context })
    for (let k = n.children.length - 1; k >= 0; k--) stack.push([n.children[k]!, depth + 1])
  }
  return out
}

// ---------- view state <-> URL query ----------

const FILTER_LISTS = [['status', 'status'], ['project', 'project'], ['labels', 'label'], ['milestone', 'milestone'], ['workspace', 'ws']] as const
const FILTER_BOOLS = [['blocked', 'blocked'], ['blocking', 'blocking'], ['hasRelated', 'related'], ['hasLinks', 'links'], ['includeDone', 'done']] as const
const FILTER_STRINGS = [['query', 'q'], ['updatedAfter', 'updated'], ['createdAfter', 'created']] as const
const WINDOWS: CompletedWindow[] = ['none', 'day', 'week', 'month', 'all']

/** Canonical JSON (sorted keys, undefined dropped) for equality checks. */
function canon(x: unknown): string {
  return JSON.stringify(x, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, y]) => y !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)))
    : v))
}
export function sameView(a: ViewState, b: ViewState): boolean { return canon(a) === canon(b) }

/** Pure: the query for `state`, or '' when it equals `base` (the saved view or the page default). */
export function viewToQuery(state: ViewState, base: ViewState): string {
  if (sameView(state, base)) return ''
  const p = new URLSearchParams({ v: '1' })
  const d = state.display, f = state.filter
  p.set('layout', d.layout); p.set('group', d.groupBy); p.set('order', d.orderBy)
  if (d.rowsBy) p.set('rows', d.rowsBy)
  p.set('sub', d.showSubIssues ? '1' : '0')
  p.set('props', d.properties.join(','))
  if (d.showEmptyColumns !== undefined) p.set('emptyCols', d.showEmptyColumns ? '1' : '0')
  if (d.showEmptyRows !== undefined) p.set('emptyRows', d.showEmptyRows ? '1' : '0')
  if (d.completed) p.set('completed', d.completed)
  for (const [k, q] of FILTER_LISTS) for (const x of f[k] ?? []) p.append(q, x)
  for (const x of f.priority ?? []) p.append('prio', String(x))
  if (f.parent !== undefined) p.set('parent', f.parent ?? '-')
  for (const [k, q] of FILTER_BOOLS) if (f[k] !== undefined) p.set(q, f[k] ? '1' : '0')
  for (const [k, q] of FILTER_STRINGS) if (f[k]) p.set(q, f[k]!)
  const closedDaysOut = closedWindowDays(f)
  if (closedDaysOut) p.set('closed', String(closedDaysOut))
  return p.toString()
}

/** Pure: the view state from a query written by `viewToQuery`; no query means `base`. Bad values fall back to defaults. */
export function viewFromQuery(query: string, base: ViewState): ViewState {
  const p = new URLSearchParams(query)
  if (!p.has('v')) return structuredClone(base)
  const bool = (q: string) => { const x = p.get(q); return x === '1' ? true : x === '0' ? false : undefined }
  const props = p.get('props')
  const completed = p.get('completed') as CompletedWindow | null
  const display: ViewDisplay = {
    layout: p.get('layout') === 'board' ? 'board' : 'list',
    groupBy: p.get('group') || DEFAULT_DISPLAY.groupBy,
    orderBy: p.get('order') || DEFAULT_DISPLAY.orderBy,
    showSubIssues: bool('sub') ?? true,
    properties: props === null ? [...base.display.properties] : props.split(',').filter(Boolean),
  }
  if (p.get('rows')) display.rowsBy = p.get('rows')!
  const ec = bool('emptyCols'), er = bool('emptyRows')
  if (ec !== undefined) display.showEmptyColumns = ec
  if (er !== undefined) display.showEmptyRows = er
  if (completed && WINDOWS.includes(completed)) display.completed = completed
  const filter: Filter = {}
  for (const [k, q] of FILTER_LISTS) { const xs = p.getAll(q).filter(Boolean); if (xs.length) filter[k] = xs }
  const prio = p.getAll('prio').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 4)
  if (prio.length) filter.priority = prio
  const parent = p.get('parent')
  if (parent) filter.parent = parent === '-' ? null : parent // empty = absent
  for (const [k, q] of FILTER_BOOLS) { const b = bool(q); if (b !== undefined) filter[k] = b }
  for (const [k, q] of FILTER_STRINGS) { const s = p.get(q); if (s) filter[k] = s }
  const closedDays = closedWindowDays({ closedWithinDays: Number(p.get('closed')) })
  if (closedDays) filter.closedWithinDays = closedDays
  return { filter, display }
}

// ---------- board drag ----------

/**
 * Pure: `save_issue` args for dropping `issue` on column `group` / row `row`, or null when nothing changes.
 * `fromRow` is the row the card was dragged from: the row field is only written when the drop changes row
 * (a card with a dangling parent sits in "No parent"; moving it between columns must not clear its parent).
 */
export function dropPatch(issue: IssueSummary, d: ViewDisplay, group: string, row: string, fromRow?: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = { id: issue.id }
  const apply = (by: string, key: string) => {
    if (by === 'status') { if (key !== issue.status) out.state = key }
    else if (by === 'priority') { const n = Number(key); if (Number.isInteger(n) && n !== issue.priority) out.priority = n }
    else if (by === 'project') { if (key !== '_none' && key !== issue.project) out.project = key }
    else if (by === 'parent') { const to = key === NONE ? null : key; if (to !== issue.parent && to !== issue.id) out.parentId = to }
    else if (by.startsWith('label-group:')) {
      const prefix = `${by.slice('label-group:'.length)}/`
      const cur = issue.labels.filter((l) => l.startsWith(prefix))
      if (key === NONE) { if (cur.length) out.removeLabels = cur }
      else if (!cur.includes(key)) { out.addLabels = [key]; if (cur.length) out.removeLabels = cur }
    }
  }
  apply(d.groupBy, group)
  if (d.layout === 'board' && d.rowsBy && d.rowsBy !== NONE && row !== fromRow) apply(d.rowsBy, row)
  return Object.keys(out).length > 1 ? out : null
}

// ---------- time in status ----------

/** Pure: when each issue entered its current status — its newest `status` feed event, else `updated`. */
export function timeInStatus(feed: FeedEvent[]): (i: Pick<IssueSummary, 'id' | 'updated'>) => string {
  const since = new Map<string, string>()
  for (const e of feed) if (e.kind === 'status' && !since.has(e.id)) since.set(e.id, e.at) // feed is newest first
  return (i) => since.get(i.id) ?? i.updated
}
