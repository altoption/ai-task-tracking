import { describe, expect, test } from 'bun:test'
import type { FeedEvent } from '../../src/engine/eventlog'
import type { IssueSummary, StatusDef } from '../../src/model'
import {
  activityCounts, allRows, buildActivity, dayLabel, filterRows, LIVE_MS, localDay, mergeFeeds, rangeStart, rhythm, toolOf,
  waitingOnYou, type Ctx,
} from '../../ui/activity'

const STATUSES: StatusDef[] = [
  { name: 'Backlog', type: 'backlog', color: '' }, { name: 'Todo', type: 'unstarted', color: '' },
  { name: 'In Progress', type: 'started', color: '' }, { name: 'Waiting', type: 'started', color: '' },
  { name: 'Done', type: 'completed', color: '' },
]
const NOW = new Date(2026, 9, 30, 21, 0, 0).getTime() // Oct 30, 9 pm local
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()
const CC = { actor: 'agent' as const, workspace: 'my-repo', branch: 'feat/x', session: '101', client: 'claude-code' }
const CX = { actor: 'agent' as const, workspace: 'my-repo', session: '202', client: 'codex' }
const ev = (actor: FeedEvent['actor'], minAgo: number, id: string, kind: FeedEvent['kind'], extra: Partial<FeedEvent> = {}): FeedEvent =>
  ({ at: at(minAgo), actor, id, kind, ...extra })

function summary(id: string, over: Partial<IssueSummary> = {}): IssueSummary {
  return {
    id, title: `Title of ${id}`, status: 'Todo', priority: 0, labels: [], parent: null, blockedBy: [], related: [], milestone: null,
    due: null, plan: null, links: [], created: '', updated: '', project: 'p', childCount: 0, progress: { done: 0, total: 0 }, blocks: [],
    workspaces: [], ...over,
  }
}
const ISSUES = new Map<string, IssueSummary>([
  ['A-1', summary('A-1', { status: 'Done', progress: { done: 2, total: 2 }, childCount: 2 })],
  ['A-2', summary('A-2', { status: 'Done', parent: 'A-1' })],
  ['A-3', summary('A-3', { status: 'Done', parent: 'A-2' })],
  ['B-1', summary('B-1', { status: 'In Progress', links: [{ title: 'PR #7', url: 'https://github.com/o/r/pull/7' }] })],
  ['W-1', summary('W-1', { status: 'Waiting' })],
])
const ctx: Ctx = { issue: (id) => ISSUES.get(id), statuses: STATUSES, needsYou: { statuses: ['Waiting'], labels: ['Needs decision'] }, now: NOW }
const TODAY = rangeStart('today', NOW)

describe('grouping', () => {
  const events: FeedEvent[] = [
    ev(CC, 50, 'B-1', 'status', { from: 'Backlog', to: 'In Progress' }),
    ev(CC, 49, 'B-1', 'updated', { text: 'plan' }),
    ev(CC, 48, 'B-1', 'updated', { text: 'links' }),
    ev(CC, 47, 'B-1', 'status', { from: 'In Progress', to: 'In Progress' }),
    ev(CC, 40, 'B-1', 'comment', { text: 'First note' }),
    ev(CC, 5, 'B-1', 'comment', { text: 'Opened https://github.com/o/r/pull/7 and https://github.com/o/r/commit/abcdef1234' }),
    ev(CC, 30, 'C-9', 'updated', { text: 'plan' }), // only an internal write: folds away
    ev(CX, 120, 'A-1', 'status', { from: 'In Progress', to: 'Done' }),
    ev(CX, 125, 'A-2', 'created', { text: 'Title of A-2' }),
    ev(CX, 124, 'A-2', 'status', { from: 'Backlog', to: 'Done' }),
    ev(CX, 123, 'A-3', 'status', { from: 'Todo', to: 'Done' }),
  ]
  const { days, cards } = buildActivity(events, ctx, TODAY)

  test('one card per session, newest first, all today', () => {
    expect(days.map((d) => d.label)).toEqual(['Today'])
    expect(cards.map((c) => c.label)).toEqual(['Claude Code', 'Codex'])
    const cc = cards[0]!
    expect(cc.where).toBe('my-repo · feat/x')
    expect(cc.writes).toBe(7)
    expect(cc.live).toBe(true) // wrote 5 min ago
    expect(cards[1]!.live).toBe(false)
  })

  test('one row per issue: bursts merged, internal writes folded, the status path, the latest note and its PR/commit chips', () => {
    const rows = cards[0]!.rows
    expect(rows.map((r) => r.id)).toEqual(['B-1']) // C-9 had only a plan write
    const b = rows[0]!
    expect(b.path).toEqual(['Backlog', 'In Progress'])
    expect(b.note).toMatch(/^Opened/)
    expect(b.writes).toBe(6)
    expect(b.folded).toBe(2)
    expect(b.links.map((l) => l.title)).toEqual(['PR #7', 'Commit abcdef1'])
    expect(b.kinds.sort()).toEqual(['comments', 'started'])
    expect(b.title).toBe('Title of B-1')
  })

  test('sub-issues nest under their epic, grandchildren under the nearest ancestor row; the epic carries its progress', () => {
    const rows = cards[1]!.rows
    expect(rows.map((r) => r.id)).toEqual(['A-1'])
    expect(rows[0]!.progress).toEqual({ done: 2, total: 2 })
    expect(rows[0]!.children.map((r) => r.id)).toEqual(['A-2'])
    expect(rows[0]!.children[0]!.children.map((r) => r.id)).toEqual(['A-3'])
    expect(rows[0]!.children[0]!.path).toEqual(['created', 'Done'])
    expect(cards[1]!.finished).toBe(3)
    expect(cards[1]!.touched).toBe(3)
  })

  test('writes in the same second keep the feed order (created, then moved)', () => {
    const t = at(1)
    const feed: FeedEvent[] = [ // newest first, as the feed sends them
      { at: t, actor: CC, id: 'A-2', kind: 'status', from: 'Backlog', to: 'Done' },
      { at: t, actor: CC, id: 'A-2', kind: 'created', text: 'x' },
    ]
    expect(buildActivity(feed, ctx, TODAY).cards[0]!.rows[0]!.path).toEqual(['created', 'Done'])
    // Created straight into a started status, then moved: that status shows.
    const started: FeedEvent[] = [
      { at: t, actor: CC, id: 'W-1', kind: 'status', from: 'In Progress', to: 'Waiting' },
      { at: t, actor: CC, id: 'W-1', kind: 'created', text: 'x' },
    ]
    expect(buildActivity(started, ctx, TODAY).cards[0]!.rows[0]!.path).toEqual(['created', 'In Progress', 'Waiting'])
  })

  test('the tool falls back to "Agent in <workspace>" without a client', () => {
    expect(toolOf(undefined, 'my-repo')).toEqual({ key: 'other', name: 'Agent in my-repo', badge: 'AG' })
    expect(toolOf('codex', 'x').name).toBe('Codex')
    expect(toolOf('zed', 'x')).toEqual({ key: 'other', name: 'zed', badge: 'ZE' })
    const { cards: c } = buildActivity([ev({ actor: 'agent', workspace: 'acme', session: '9' }, 3, 'B-1', 'comment', { text: 'hi' })], ctx, TODAY)
    expect(c[0]!.label).toBe('Agent in acme')
  })

  test('the owner\'s writes (app, browser, hand edits) share one "You" card per day; agents without a session group by workspace and branch', () => {
    const { cards: c } = buildActivity([
      ev({ actor: 'you' }, 10, 'B-1', 'comment', { text: 'mine' }),
      ev({ actor: 'you', workspace: 'external' }, 20, 'W-1', 'status', { from: 'Todo', to: 'Waiting' }),
      ev({ actor: 'agent', workspace: 'w', branch: 'b' }, 30, 'A-1', 'comment', { text: 'x' }),
      ev({ actor: 'agent', workspace: 'w', branch: 'b' }, 31, 'A-2', 'comment', { text: 'y' }),
    ], ctx, TODAY)
    expect(c.map((x) => [x.label, x.kind, x.rows.length])).toEqual([['You', 'you', 2], ['Agent in w', 'agent', 1]])
    expect(c[0]!.live).toBe(false) // the owner's card never shows the live dot
  })

  test('a session that crosses midnight has a card on each day, with day labels', () => {
    const late = new Date(2026, 9, 29, 23, 50).toISOString(), early = new Date(2026, 9, 30, 0, 10).toISOString()
    const { days: d } = buildActivity([
      { at: late, actor: CC, id: 'B-1', kind: 'comment', text: 'late' }, { at: early, actor: CC, id: 'B-1', kind: 'comment', text: 'early' },
    ], ctx, rangeStart('week', NOW))
    expect(d.map((x) => x.label)).toEqual(['Today', 'Yesterday'])
    expect(dayLabel(localDay(new Date(2026, 9, 27).getTime()), NOW)).toMatch(/27/)
  })

  test('events before the range, and of issues the UI hides, are left out', () => {
    const old = { at: new Date(2026, 9, 29, 12).toISOString(), actor: CC, id: 'B-1', kind: 'comment' as const, text: 'yesterday' }
    expect(buildActivity([old], ctx, TODAY).cards).toEqual([])
    expect(buildActivity([old], ctx, rangeStart('week', NOW)).cards).toHaveLength(1)
    const skip = (id: string) => id === 'H-1'
    const { cards: c } = buildActivity([ev(CC, 1, 'H-1', 'status', { from: 'Todo', to: 'Done' }), ev(CC, 2, 'B-1', 'comment', { text: 'x' })], ctx, TODAY, skip)
    expect(allRows(c[0]!.rows).map((r) => r.id)).toEqual(['B-1'])
    expect(c[0]!.writes).toBe(1)
    expect(rhythm([ev(CC, 1, 'H-1', 'comment', { text: 'x' })], NOW, skip).reduce((n, h) => n + h.total, 0)).toBe(0)
  })
})

describe('counts and filters', () => {
  const events: FeedEvent[] = [
    ev(CC, 3, 'B-1', 'status', { from: 'Todo', to: 'In Progress' }),
    ev(CC, 60, 'W-1', 'status', { from: 'In Progress', to: 'Waiting' }),
    ev(CC, 59, 'W-1', 'comment', { text: 'Which provider should I use?' }),
    ev(CX, 100, 'A-1', 'status', { from: 'In Progress', to: 'Done' }),
    ev(CX, 101, 'A-2', 'status', { from: 'Todo', to: 'Done' }),
    ev(CX, 99, 'B-1', 'comment', { text: 'also here' }),
  ]
  const { cards } = buildActivity(events, ctx, TODAY)
  const needsYou = [ISSUES.get('W-1')!, summary('S-1', { status: 'In Progress', stalled: 'idle' } as Partial<IssueSummary>)]
  const waiting = waitingOnYou(events, needsYou, { needsYou: ctx.needsYou! }, TODAY)

  test('waits on you: issues that entered a Needs-you status in the range, with the latest agent note as the question', () => {
    expect(waiting).toEqual([{ id: 'W-1', title: 'Title of W-1', status: 'Waiting', at: at(60), who: 'Claude Code', note: 'Which provider should I use?' }])
    // Waiting since before the range: Home's Needs you has it; the strip doesn't.
    expect(waitingOnYou(events, needsYou, { needsYou: ctx.needsYou! }, NOW - 30 * 60_000)).toEqual([])
  })

  test('counts: distinct issues finished and started, waiting, agents and live ones', () => {
    expect(activityCounts(cards, waiting.length)).toEqual({ finished: 2, started: 1, waiting: 1, agents: 2, live: 1 })
  })

  test('filters keep matching rows; an epic stays for a matching child', () => {
    const ids = (f: Parameters<typeof filterRows>[1]) => cards.flatMap((c) => allRows(filterRows(c.rows, f, new Set(waiting.map((w) => w.id)))).map((r) => r.id)).sort()
    expect(ids('all')).toEqual(['A-1', 'A-2', 'B-1', 'B-1', 'W-1'])
    expect(ids('done')).toEqual(['A-1', 'A-2'])
    expect(ids('started')).toEqual(['B-1'])
    expect(ids('comments')).toEqual(['B-1', 'W-1'])
    expect(ids('needs')).toEqual(['W-1'])
    const onlyChild = cards[1]!.rows.map((r) => ({ ...r, kinds: [] as typeof r.kinds }))
    expect(filterRows(onlyChild, 'done', new Set()).map((r) => r.id)).toEqual(['A-1'])
  })
})

describe('rhythm', () => {
  test('24 hourly buckets ending with the current hour, by tool, with the busiest tool on top; owner writes don\'t count', () => {
    const h = rhythm([
      ev(CC, 1, 'B-1', 'comment'), ev(CC, 2, 'B-1', 'comment'), ev(CX, 3, 'B-1', 'comment'),
      ev(CX, 61, 'B-1', 'comment'), ev({ actor: 'you' }, 1, 'B-1', 'comment'), ev(CC, 25 * 60, 'B-1', 'comment'),
    ], NOW)
    expect(h).toHaveLength(24)
    expect(h[23]!.start).toBe(new Date(2026, 9, 30, 21).getTime())
    expect(h[23]!.total).toBe(0) // NOW is exactly 9:00: these writes fall in the 8 pm hour
    expect(h[22]!).toMatchObject({ total: 3, byTool: { cc: 2, cx: 1 }, top: 'cc' })
    expect(h[21]!).toMatchObject({ total: 1, top: 'cx' })
    expect(h.reduce((n, x) => n + x.total, 0)).toBe(4) // 25 h ago is outside
  })
})

describe('merging fetched and live events', () => {
  test('no duplicates, newest first, nothing before the range', () => {
    const a = ev(CC, 1, 'B-1', 'comment', { text: 'x' }), b = ev(CC, 2, 'B-1', 'comment', { text: 'y' })
    const old = { ...b, at: new Date(TODAY - 1000).toISOString() }
    expect(mergeFeeds([b, a, old], [a], TODAY)).toEqual([a, b])
  })

  test('a session is live for LIVE_MS after its last write', () => {
    const { cards } = buildActivity([ev(CC, LIVE_MS / 60_000 + 1, 'B-1', 'comment', { text: 'x' })], ctx, TODAY)
    expect(cards[0]!.live).toBe(false)
  })
})
