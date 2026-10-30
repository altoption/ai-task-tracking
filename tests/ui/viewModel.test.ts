import { describe, expect, test } from 'bun:test'
import type { IssueSummary, StatusDef, View } from '../../src/model'
import { applyView, dropPatch, listRows, swimlanes, timeInStatus, viewFromQuery, viewToQuery, type ViewState } from '../../ui/viewModel'

const statuses: StatusDef[] = [
  { name: 'Backlog', type: 'backlog', color: '#bec2c8' }, { name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
  { name: 'In Progress', type: 'started', color: '#f2c94c' }, { name: 'Waiting', type: 'started', color: '#4cb782' },
  { name: 'Done', type: 'completed', color: '#5e6ad2' }, { name: 'Canceled', type: 'canceled', color: '#95a2b3' },
  { name: 'Duplicate', type: 'duplicate', color: '#95a2b3' },
]
const T0 = '2026-10-20T00:00:00Z'
const mk = (id: string, status: string, priority: number, parent: string | null, over: Partial<IssueSummary> = {}): IssueSummary => ({
  id, title: `Title ${id}`, status, priority: priority as IssueSummary['priority'], labels: [], parent, blockedBy: [], related: [],
  milestone: null, due: null, plan: null, links: [], created: T0, updated: T0, project: 'acme-app',
  childCount: 0, progress: { done: 0, total: 0 }, blocks: [], workspaces: [], ...over,
})
/** Synthetic 12-issue set shaped like a real project board. */
const issues: IssueSummary[] = [
  mk('Q-78', 'Done', 2, null),
  mk('Q-93', 'Waiting', 3, 'Q-78', { labels: ['Scope/App', 'Scope/CDP'] }),
  mk('Q-80', 'Backlog', 0, 'Q-78', { labels: ['Scope/App'] }),
  mk('Q-269', 'Todo', 2, null),
  mk('Q-272', 'Todo', 0, 'Q-269'),
  mk('Q-271', 'Todo', 2, 'Q-269'),
  mk('Q-275', 'Todo', 1, 'Q-269'),
  mk('Q-200', 'Backlog', 4, null, { labels: ['Bug'] }),
  mk('Q-201', 'Backlog', 1, null),
  mk('Q-300', 'Todo', 1, null, { project: 'support' }),
  mk('Q-301', 'Canceled', 0, 'Q-269'),
  mk('Q-302', 'Waiting', 0, 'Q-404'), // dangling parent
]
const board: View = {
  slug: 'acme-app', name: 'Acme App',
  filter: { project: ['acme-app'], status: ['Backlog', 'Todo', 'In Progress', 'Waiting'] },
  display: { layout: 'board', groupBy: 'status', rowsBy: 'parent', orderBy: 'priority', showSubIssues: true, properties: ['id', 'priority', 'labels', 'milestone'] },
}
const ctx = { statuses }
const ids = (xs: IssueSummary[]) => xs.map((i) => i.id)
const shape = (r: ReturnType<typeof applyView>) =>
  r.groups.map((g) => ({ key: g.key, issues: ids(g.issues), rows: g.rows?.map((x) => ({ key: x.key, issues: ids(x.issues) })) }))

describe('applyView', () => {
  test('imported "Acme App" view: board, columns by status, rows by parent, priority order', () => {
    const r = applyView(issues, board, ctx)
    expect(shape(r)).toEqual([
      { key: 'Backlog', issues: ['Q-201', 'Q-200', 'Q-80'], rows: [{ key: 'Q-78', issues: ['Q-80'] }, { key: 'none', issues: ['Q-201', 'Q-200'] }] },
      { key: 'Todo', issues: ['Q-275', 'Q-269', 'Q-271', 'Q-272'], rows: [{ key: 'Q-269', issues: ['Q-275', 'Q-271', 'Q-272'] }, { key: 'none', issues: ['Q-269'] }] },
      { key: 'Waiting', issues: ['Q-93', 'Q-302'], rows: [{ key: 'Q-78', issues: ['Q-93'] }, { key: 'none', issues: ['Q-302'] }] },
    ])
    expect(r.hidden).toEqual([{ key: 'In Progress', label: 'In Progress' }])
    expect(r.total).toBe(9)
    expect(r.groups[0]!.rows!.map((x) => x.label)).toEqual(['Title Q-78', 'No parent'])
  })

  test('show empty columns keeps the hidden statuses in config order', () => {
    const r = applyView(issues, { ...board, display: { ...board.display, showEmptyColumns: true } }, ctx)
    expect(r.groups.map((g) => g.key)).toEqual(['Backlog', 'Todo', 'In Progress', 'Waiting'])
    expect(r.hidden).toEqual([])
  })

  test('showSubIssues false hides children whose parent is in the result', () => {
    const r = applyView(issues, { ...board, display: { ...board.display, rowsBy: 'none', showSubIssues: false } }, ctx)
    // Q-269's children go; Q-80 / Q-93 stay because their parent Q-78 (Done) is filtered out.
    expect(shape(r)).toEqual([
      { key: 'Backlog', issues: ['Q-201', 'Q-200', 'Q-80'], rows: undefined },
      { key: 'Todo', issues: ['Q-269'], rows: undefined },
      { key: 'Waiting', issues: ['Q-93', 'Q-302'], rows: undefined },
    ])
  })

  test('groupBy label-group:Scope (an issue with two scope labels is in both; none last)', () => {
    const v: View = { ...board, filter: { project: ['acme-app'] }, display: { ...board.display, layout: 'list', groupBy: 'label-group:Scope', rowsBy: undefined } }
    const r = applyView(issues, v, ctx)
    expect(r.groups.map((g) => [g.key, g.label, ids(g.issues)])).toEqual([
      ['Scope/App', 'App', ['Q-93', 'Q-80']],
      ['Scope/CDP', 'CDP', ['Q-93']],
      ['none', 'No Scope', ['Q-201', 'Q-269', 'Q-271', 'Q-275', 'Q-200', 'Q-302', 'Q-272'].sort(byPrioThenId)],
    ])
  })

  test('orderBy priority puts 1 before 2 before 0', () => {
    const three = [mk('Q-1', 'Todo', 0, null), mk('Q-2', 'Todo', 2, null), mk('Q-3', 'Todo', 1, null)]
    const r = applyView(three, { ...board, filter: {}, display: { ...board.display, layout: 'list', groupBy: 'none', rowsBy: undefined } }, ctx)
    expect(ids(r.groups[0]!.issues)).toEqual(['Q-3', 'Q-2', 'Q-1'])
  })

  test('orderBy updated / created: newest first; manual: issue number', () => {
    const three = [mk('Q-10', 'Todo', 0, null, { updated: '2026-10-21T00:00:00Z', created: '2026-10-01T00:00:00Z' }), mk('Q-2', 'Todo', 0, null, { created: '2026-10-05T00:00:00Z' }), mk('Q-3', 'Todo', 0, null, { updated: '2026-10-25T00:00:00Z' })]
    const order = (orderBy: string) => ids(applyView(three, { ...board, filter: {}, display: { ...board.display, groupBy: 'none', rowsBy: undefined, orderBy } }, ctx).groups[0]!.issues)
    expect(order('updated')).toEqual(['Q-3', 'Q-10', 'Q-2'])
    expect(order('created')).toEqual(['Q-3', 'Q-2', 'Q-10'])
    expect(order('manual')).toEqual(['Q-2', 'Q-3', 'Q-10'])
  })

  test('completed window: closed issues updated within the window only (explicit status list wins)', () => {
    const now = Date.parse('2026-10-28T12:00:00Z')
    const set = [mk('Q-1', 'Done', 0, null, { updated: '2026-10-28T06:00:00Z' }), mk('Q-2', 'Done', 0, null, { updated: '2026-10-24T00:00:00Z' }), mk('Q-3', 'Todo', 0, null)]
    const run = (completed: View['display']['completed']) =>
      ids(applyView(set, { ...board, filter: {}, display: { ...board.display, layout: 'list', groupBy: 'none', rowsBy: undefined, orderBy: 'manual', completed } }, { statuses, now }).groups[0]?.issues ?? [])
    expect(run('none')).toEqual(['Q-3'])
    expect(run('day')).toEqual(['Q-1', 'Q-3'])
    expect(run('week')).toEqual(['Q-1', 'Q-2', 'Q-3'])
    expect(run('all')).toEqual(['Q-1', 'Q-2', 'Q-3'])
  })

  test('content filter matches id/title terms; priority and project groups are labelled', () => {
    const v: View = { ...board, filter: { query: 'title q-27' }, display: { ...board.display, layout: 'list', groupBy: 'priority', rowsBy: undefined } }
    expect(applyView(issues, v, ctx).groups.map((g) => [g.label, ids(g.issues)])).toEqual([['Urgent', ['Q-275']], ['High', ['Q-271']], ['No priority', ['Q-272']]])
    const p = applyView(issues, { ...v, filter: {}, display: { ...v.display, groupBy: 'project' } }, { statuses, projects: [{ slug: 'acme-app', name: 'Acme App' }, { slug: 'support', name: 'Support' }] })
    expect(p.groups.map((g) => [g.key, g.label])).toEqual([['acme-app', 'Acme App'], ['support', 'Support']])
  })

  test('cycles and dangling parents never hang', () => {
    const loop = [mk('Q-1', 'Todo', 0, 'Q-2'), mk('Q-2', 'Todo', 0, 'Q-1')]
    const r = applyView(loop, { ...board, filter: {} }, ctx)
    expect(r.total).toBe(2)
    const rows = listRows(r.groups[0]!.issues, new Map(loop.map((i) => [i.id, i])), true)
    expect(rows.map((x) => x.issue.id).sort()).toEqual(['Q-1', 'Q-2'])
  })
})

function byPrioThenId(a: string, b: string): number {
  const p = (id: string) => { const n = issues.find((i) => i.id === id)!.priority; return n === 0 ? 5 : n }
  return p(a) - p(b) || Number(a.slice(2)) - Number(b.slice(2))
}

describe('listRows (list view nesting)', () => {
  const byId = new Map(issues.map((i) => [i.id, i]))
  test('children nest under a parent in the group; ancestors outside it are dimmed context rows', () => {
    const todo = applyView(issues, { ...board, display: { ...board.display, layout: 'list', rowsBy: undefined } }, ctx).groups.find((g) => g.key === 'Todo')!
    expect(listRows(todo.issues, byId, true).map((r) => [r.issue.id, r.depth, r.context])).toEqual([
      ['Q-269', 0, false], ['Q-275', 1, false], ['Q-271', 1, false], ['Q-272', 1, false],
    ])
    const waiting = applyView(issues, { ...board, display: { ...board.display, layout: 'list', rowsBy: undefined } }, ctx).groups.find((g) => g.key === 'Waiting')!
    expect(listRows(waiting.issues, byId, true).map((r) => [r.issue.id, r.depth, r.context])).toEqual([
      ['Q-78', 0, true], ['Q-93', 1, false], ['Q-302', 0, false],
    ])
  })
  test('flat when sub-issues are off', () => {
    const g = applyView(issues, { ...board, display: { ...board.display, layout: 'list', rowsBy: undefined } }, ctx).groups.find((x) => x.key === 'Todo')!
    expect(listRows(g.issues, byId, false).map((r) => [r.issue.id, r.depth])).toEqual([['Q-275', 0], ['Q-269', 0], ['Q-271', 0], ['Q-272', 0]])
  })
})

describe('view state in the URL query', () => {
  const base: ViewState = { filter: board.filter, display: board.display }
  test('unchanged state is an empty query; a change round-trips', () => {
    expect(viewToQuery(base, base)).toBe('')
    expect(viewFromQuery('', base)).toEqual(base)
    const changed: ViewState = {
      filter: { project: ['acme-app'], labels: ['Scope/CDP', 'Bug'], priority: [1, 0], parent: null, blocked: true, hasLinks: false, query: 'a b', createdAfter: '2026-10-01', milestone: ['M 1'], workspace: ['web-app'] },
      display: { layout: 'list', groupBy: 'label-group:Scope', orderBy: 'updated', showSubIssues: false, properties: ['id', 'status'], completed: 'week', showEmptyColumns: true },
    }
    const q = viewToQuery(changed, base)
    expect(q).not.toBe('')
    expect(viewFromQuery(q, base)).toEqual(changed)
    // removing a filter the base has is expressible
    const noStatus: ViewState = { filter: { project: ['acme-app'] }, display: base.display }
    expect(viewFromQuery(viewToQuery(noStatus, base), base)).toEqual(noStatus)
  })
  test('an empty parent= is absent, not a filter matching nothing', () => {
    expect(viewFromQuery('v=1&parent=', base).filter.parent).toBeUndefined()
    expect('parent' in viewFromQuery('v=1&parent=', base).filter).toBe(false)
    expect(viewFromQuery('v=1&parent=-', base).filter.parent).toBeNull()
    expect(viewFromQuery('v=1&parent=Q-1', base).filter.parent).toBe('Q-1')
  })
  test('garbage in the query falls back to defaults instead of throwing', () => {
    const s = viewFromQuery('v=1&layout=weird&prio=x&sub=maybe', base)
    expect(s.display.layout).toBe('list')
    expect(s.filter.priority).toBeUndefined()
  })
})

describe('dropPatch (board drag)', () => {
  const i = mk('Q-5', 'Todo', 2, 'Q-1', { labels: ['Scope/App', 'Bug'] })
  const d = board.display
  test('column by status sets state; row by parent sets parentId', () => {
    expect(dropPatch(i, d, 'Waiting', 'Q-1')).toEqual({ id: 'Q-5', state: 'Waiting' })
    expect(dropPatch(i, d, 'Todo', 'Q-9')).toEqual({ id: 'Q-5', parentId: 'Q-9' })
    expect(dropPatch(i, d, 'Done', 'none')).toEqual({ id: 'Q-5', state: 'Done', parentId: null })
    expect(dropPatch(i, d, 'Todo', 'Q-1')).toBeNull()
    expect(dropPatch(i, d, 'Todo', 'Q-5')).toBeNull() // never its own parent
  })
  test('a dangling parent (card in the "No parent" row): a status-only drag sends no parentId', () => {
    const orphan = mk('Q-6', 'Todo', 2, 'Q-404')
    expect(dropPatch(orphan, d, 'Waiting', 'none', 'none')).toEqual({ id: 'Q-6', state: 'Waiting' })
    expect(dropPatch(orphan, d, 'Todo', 'none', 'none')).toBeNull()
    // an actual row change still moves it
    expect(dropPatch(orphan, d, 'Todo', 'Q-1', 'none')).toEqual({ id: 'Q-6', parentId: 'Q-1' })
  })
  test('priority, project and label-group columns', () => {
    expect(dropPatch(i, { ...d, groupBy: 'priority', rowsBy: 'none' }, '1', 'all')).toEqual({ id: 'Q-5', priority: 1 })
    expect(dropPatch(i, { ...d, groupBy: 'project', rowsBy: 'none' }, 'support', 'all')).toEqual({ id: 'Q-5', project: 'support' })
    expect(dropPatch(i, { ...d, groupBy: 'label-group:Scope', rowsBy: 'none' }, 'Scope/CDP', 'all')).toEqual({ id: 'Q-5', addLabels: ['Scope/CDP'], removeLabels: ['Scope/App'] })
    expect(dropPatch(i, { ...d, groupBy: 'label-group:Scope', rowsBy: 'none' }, 'none', 'all')).toEqual({ id: 'Q-5', removeLabels: ['Scope/App'] })
  })
})

describe('timeInStatus', () => {
  test('last status event for the issue, else updated', () => {
    const feed = [
      { at: '2026-10-27T00:00:00Z', actor: { actor: 'you' as const }, id: 'Q-5', kind: 'status' as const, to: 'Todo' },
      { at: '2026-10-26T00:00:00Z', actor: { actor: 'you' as const }, id: 'Q-5', kind: 'status' as const, to: 'Backlog' },
    ]
    const since = timeInStatus(feed)
    expect(since(mk('Q-5', 'Todo', 0, null))).toBe('2026-10-27T00:00:00Z')
    expect(since(mk('Q-6', 'Todo', 0, null))).toBe(T0)
  })
})

describe('swimlanes', () => {
  test('rows across all columns in parent order, counted; empty project rows only when asked', () => {
    const byId = new Map(issues.map((i) => [i.id, i]))
    const r = applyView(issues, board, ctx)
    expect(swimlanes(r.groups, 'parent', { statuses, byId }, 'priority')).toEqual([
      { key: 'Q-78', label: 'Title Q-78', count: 2 }, { key: 'Q-269', label: 'Title Q-269', count: 3 }, { key: 'none', label: 'No parent', count: 4 },
    ])
    const projects = [{ slug: 'acme-app', name: 'Acme App' }, { slug: 'support', name: 'Support' }]
    const p = applyView(issues, { ...board, display: { ...board.display, rowsBy: 'project' } }, { statuses, projects })
    expect(swimlanes(p.groups, 'project', { statuses, byId, projects }, 'priority').map((l) => [l.key, l.count])).toEqual([['acme-app', 9]])
    expect(swimlanes(p.groups, 'project', { statuses, byId, projects }, 'priority', true).map((l) => [l.key, l.count])).toEqual([['acme-app', 9], ['support', 0]])
  })
})
