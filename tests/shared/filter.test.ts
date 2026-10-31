import { describe, expect, test } from 'bun:test'
import type { Filter, StatusDef } from '../../src/model'
import { filterPredicate, matchesText, type FilterIssue } from '../../src/shared/filter'

const statuses: StatusDef[] = [
  { name: 'Backlog', type: 'backlog', color: '' }, { name: 'Todo', type: 'unstarted', color: '' },
  { name: 'In Progress', type: 'started', color: '' }, { name: 'Done', type: 'completed', color: '' },
  { name: 'Canceled', type: 'canceled', color: '' },
]
type T = FilterIssue & { ws: string[]; blocks: string[] }
const mk = (id: string, over: Partial<T> = {}): T => ({
  id, title: `Issue ${id}`, status: 'Todo', project: 'p', labels: [], priority: 0, parent: null, blockedBy: [], related: [],
  milestone: null, links: [], created: '2026-10-01T00:00:00Z', updated: '2026-10-01T00:00:00Z', ws: [], blocks: [], ...over,
})
const issues = [
  mk('Q-1', { priority: 1, labels: ['Scope/App'], ws: ['web-app'], blocks: ['Q-2'] }),
  mk('Q-2', { blockedBy: ['Q-1'], parent: 'Q-1', milestone: 'M1', updated: '2026-10-20T00:00:00Z' }),
  mk('Q-3', { status: 'Done', related: ['Q-1'], project: 'other' }),
  mk('Q-4', { labels: ['Blocked'], links: [{ title: 'pr', url: 'https://x' }], created: '2026-10-25T00:00:00Z' }),
  mk('Q-5', { status: 'Mystery', blockedBy: ['Q-3', 'Q-404'] }), // unknown status = open; closed and missing blockers don't block
]
const byId = new Map(issues.map((i) => [i.id, i]))
const run = (f: Filter) => issues.filter(filterPredicate<T>(f, { statuses, get: (id) => byId.get(id), workspaces: (i) => i.ws, blocks: (i) => i.blocks })).map((i) => i.id)

describe('filterPredicate (shared by engine filterIssues and the UI applyView)', () => {
  test('closed issues hidden unless includeDone or an explicit status list', () => {
    expect(run({})).toEqual(['Q-1', 'Q-2', 'Q-4', 'Q-5'])
    expect(run({ includeDone: true })).toEqual(['Q-1', 'Q-2', 'Q-3', 'Q-4', 'Q-5'])
    expect(run({ status: ['Done'] })).toEqual(['Q-3'])
  })
  test('any-of lists: project, labels, priority, workspace, milestone', () => {
    expect(run({ project: ['other'], includeDone: true })).toEqual(['Q-3'])
    expect(run({ labels: ['Scope/App', 'Blocked'] })).toEqual(['Q-1', 'Q-4'])
    expect(run({ priority: [1] })).toEqual(['Q-1'])
    expect(run({ workspace: ['web-app'] })).toEqual(['Q-1'])
    expect(run({ milestone: ['M1'] })).toEqual(['Q-2'])
  })
  test('parent: id or null (no parent)', () => {
    expect(run({ parent: 'Q-1' })).toEqual(['Q-2'])
    expect(run({ parent: null })).toEqual(['Q-1', 'Q-4', 'Q-5'])
  })
  test('relations: blocked (open blocker or Blocked label), blocking, has related', () => {
    expect(run({ blocked: true })).toEqual(['Q-2', 'Q-4'])
    expect(run({ blocked: false })).toEqual(['Q-1', 'Q-5'])
    expect(run({ blocking: true })).toEqual(['Q-1'])
    expect(run({ hasRelated: true, includeDone: true })).toEqual(['Q-3'])
  })
  test('dates and links', () => {
    expect(run({ updatedAfter: '2026-10-10' })).toEqual(['Q-2'])
    expect(run({ createdAfter: '2026-10-10' })).toEqual(['Q-4'])
    expect(run({ hasLinks: true })).toEqual(['Q-4'])
    expect(run({ hasLinks: false })).toEqual(['Q-1', 'Q-2', 'Q-5'])
  })
  test('matchesText: every term, case-insensitive, against id and title', () => {
    expect(matchesText(mk('Q-12', { title: 'Docs-to-quote engine' }), 'quote ENG')).toBe(true)
    expect(matchesText(mk('Q-12', { title: 'Docs-to-quote engine' }), 'q-12')).toBe(true)
    expect(matchesText(mk('Q-12', { title: 'Docs-to-quote engine' }), 'quote fan')).toBe(false)
  })
})

describe('closedWithinDays', () => {
  const NOW = Date.parse('2026-10-31T12:00:00Z')
  const DAY = 86_400_000
  const closing = [
    { name: 'Todo', type: 'unstarted', color: '#000000' }, { name: 'Done', type: 'completed', color: '#000000' },
    { name: 'Canceled', type: 'canceled', color: '#000000' },
  ] as StatusDef[]
  const mk = (id: string, status: string, updated: string): FilterIssue => ({
    id, title: id, status, project: 'p', labels: [], priority: 0, parent: null, blockedBy: [], related: [], milestone: null, links: [], created: updated, updated,
  })
  const iso = (ms: number) => new Date(ms).toISOString()
  const keep = (f: Filter, closedAt?: (i: FilterIssue) => string | undefined) => filterPredicate<FilterIssue>(f, {
    statuses: closing, get: () => undefined, workspaces: () => [], blocks: () => [], now: NOW, ...(closedAt ? { closedAt } : {}),
  })

  test('the boundary is inclusive: exactly 7 days ago is in, a second more is out', () => {
    const k = keep({ closedWithinDays: 7 })
    expect(k(mk('A', 'Done', iso(NOW - 7 * DAY)))).toBe(true)
    expect(k(mk('B', 'Done', iso(NOW - 7 * DAY - 1000)))).toBe(false)
  })
  test('open issues are out, however recently they changed (a reopened issue drops out)', () => {
    expect(keep({ closedWithinDays: 7 })(mk('A', 'Todo', iso(NOW)))).toBe(false)
    expect(keep({ closedWithinDays: 7, includeDone: true })(mk('A', 'Todo', iso(NOW)))).toBe(false)
    expect(keep({ closedWithinDays: 7, status: ['Todo', 'Done'] })(mk('A', 'Todo', iso(NOW)))).toBe(false)
  })
  test('uses the close time when given: a comment on an old issue does not bring it back', () => {
    expect(keep({ closedWithinDays: 7 }, () => iso(NOW - 30 * DAY))(mk('A', 'Done', iso(NOW)))).toBe(false)
    expect(keep({ closedWithinDays: 7 }, () => iso(NOW - DAY))(mk('A', 'Done', iso(NOW - 60 * DAY)))).toBe(true)
  })
  test('without a status list any closed type counts; a status list narrows it', () => {
    expect(keep({ closedWithinDays: 7 })(mk('A', 'Canceled', iso(NOW)))).toBe(true)
    expect(keep({ closedWithinDays: 7, status: ['Done'] })(mk('A', 'Canceled', iso(NOW)))).toBe(false)
  })
  test('nonsense values are no window (a hand-edited file): the filter behaves as without it', () => {
    for (const bad of [0, -1, Number.NaN, '7' as unknown as number]) {
      expect(keep({ closedWithinDays: bad })(mk('A', 'Todo', iso(NOW)))).toBe(true)
      expect(keep({ closedWithinDays: bad })(mk('B', 'Done', iso(NOW)))).toBe(false)
    }
  })
})
