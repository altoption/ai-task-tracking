import { describe, expect, test } from 'bun:test'
import type { FeedEvent } from '../../src/engine/eventlog'
import type { IssueSummary, StatusDef } from '../../src/model'
import {
  activityCounts, allRows, buildActivity, dayLabel, dayOverview, filterCard, filterRows, isGithubChange, LIVE_MS, localDay, mergeFeeds, rangeStart, rhythm, toolOf,
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
    expect(rhythm([ev(CC, 1, 'H-1', 'comment', { text: 'x' })], 'today', NOW, skip).reduce((n, h) => n + h.total, 0)).toBe(0)
  })

  test('a session is its tool, workspace and session id together (macOS reuses process ids)', () => {
    const { cards: c } = buildActivity([
      ev({ ...CC, session: '7' }, 1, 'B-1', 'comment', { text: 'a' }),
      ev({ ...CX, session: '7' }, 2, 'B-1', 'comment', { text: 'b' }),
      ev({ ...CC, workspace: 'other', session: '7' }, 3, 'B-1', 'comment', { text: 'c' }),
    ], ctx, TODAY)
    expect(c).toHaveLength(3)
    expect(activityCounts(c, 0).agents).toBe(3)
  })

  test('a title falls back past an empty one, and a deleted issue\'s row is marked gone', () => {
    const { cards: c } = buildActivity([ev(CC, 1, 'D-9', 'created', { text: 'Deleted thing' })], { ...ctx, issue: (id) => (id === 'E-1' ? { ...ISSUES.get('B-1')!, title: '' } : ISSUES.get(id)) }, TODAY)
    expect(c[0]!.rows[0]).toMatchObject({ id: 'D-9', title: 'Deleted thing', gone: true })
    const { cards: e } = buildActivity([ev(CC, 1, 'E-1', 'created', { text: 'From the feed' })], { ...ctx, issue: (id) => (id === 'E-1' ? { ...ISSUES.get('B-1')!, title: '' } : undefined) }, TODAY)
    expect(e[0]!.rows[0]!.title).toBe('From the feed')
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
    expect(waiting).toEqual([{ id: 'W-1', title: 'Title of W-1', status: 'Waiting', at: at(60) }])
    // Waiting since before the range: Home's Needs you has it; the strip doesn't.
    expect(waitingOnYou(events, needsYou, { needsYou: ctx.needsYou! }, NOW - 30 * 60_000)).toEqual([])
  })

  test('counts: distinct issues finished and started, waiting, agents and live ones', () => {
    expect(activityCounts(cards, waiting.length)).toEqual({ finished: 2, started: 1, waiting: 1, agents: 2, live: 1 })
  })

  test('finished in one session and reopened in a later one is not finished', () => {
    const done = ev(CC, 30, 'A-2', 'status', { from: 'In Progress', to: 'Done' })
    const reopen = (to: string) => buildActivity([ev(CX, 10, 'A-2', 'status', { from: 'Done', to }), done], ctx, TODAY).cards
    const started = reopen('In Progress')
    expect(activityCounts(started, 0)).toMatchObject({ finished: 0, started: 1 })
    expect(dayOverview(started).recent).toEqual([])
    expect(activityCounts(reopen('Todo'), 0)).toMatchObject({ finished: 0, started: 0 })
    // A comment afterwards isn't a move: still finished.
    const commented = buildActivity([ev(CX, 10, 'A-2', 'comment', { text: 'Shipped.' }), done], ctx, TODAY).cards
    expect(activityCounts(commented, 0)).toMatchObject({ finished: 1, started: 0 })
    expect(dayOverview(commented).recent.map((r) => r.id)).toEqual(['A-2'])
  })

  test('started and finished in one session counts (and filters) as finished only', () => {
    const { cards: c } = buildActivity([
      ev(CC, 3, 'A-2', 'status', { from: 'In Progress', to: 'Done' }),
      ev(CC, 4, 'A-2', 'status', { from: 'Todo', to: 'In Progress' }),
    ], ctx, TODAY)
    expect(c[0]!.rows[0]!.path).toEqual(['Todo', 'In Progress', 'Done'])
    expect(activityCounts(c, 0)).toMatchObject({ finished: 1, started: 0 })
    expect(filterRows(c[0]!.rows, 'started', new Set())).toEqual([])
    expect(filterRows(c[0]!.rows, 'done', new Set()).map((r) => r.id)).toEqual(['A-2'])
  })

  test('waits on you counts only an agent\'s hand-back: not an owner\'s move, not an unrelated label edit', () => {
    const cfg = { needsYou: ctx.needsYou! }
    // The owner moved it to Waiting: they know; it isn't a question for them.
    expect(waitingOnYou([ev({ actor: 'you' }, 5, 'W-1', 'status', { from: 'Todo', to: 'Waiting' })], [ISSUES.get('W-1')!], cfg, TODAY)).toEqual([])
    // Already Waiting (from before the range), an agent edits an unrelated label: not a hand-back.
    expect(waitingOnYou([ev(CC, 5, 'W-1', 'updated', { text: 'labels' })], [ISSUES.get('W-1')!], cfg, TODAY)).toEqual([])
    // Already Waiting and now also labelled Needs decision by an agent: still not new (it was waiting anyway).
    const labelled = { ...ISSUES.get('W-1')!, labels: ['Needs decision'] }
    expect(waitingOnYou([ev(CC, 5, 'W-1', 'updated', { text: 'labels' })], [labelled], cfg, TODAY)).toEqual([])
    // In progress, an agent adds Needs decision: handed back.
    const asked = { ...ISSUES.get('B-1')!, labels: ['Needs decision'] }
    expect(waitingOnYou([ev(CC, 5, 'B-1', 'updated', { text: 'labels' })], [asked], cfg, TODAY).map((w) => w.id)).toEqual(['B-1'])
  })

  test('the Agents count filters to agent cards', () => {
    const { cards: c } = buildActivity([ev({ actor: 'you' }, 1, 'B-1', 'comment', { text: 'mine' }), ev(CC, 2, 'B-1', 'comment', { text: 'x' })], ctx, TODAY)
    expect(c.filter((x) => filterCard(x, 'agents', new Set())).map((x) => x.kind)).toEqual(['agent'])
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
  const evs = [
    ev(CC, 1, 'B-1', 'comment'), ev(CC, 2, 'B-1', 'comment'), ev(CX, 3, 'B-1', 'comment'),
    ev(CX, 61, 'B-1', 'comment'), ev({ actor: 'you' }, 1, 'B-1', 'comment'), ev(CC, 25 * 60, 'B-1', 'comment'),
  ]
  test('Today: 24 hourly buckets from local midnight, by tool, the busiest on top; owner writes don\'t count', () => {
    const h = rhythm(evs, 'today', NOW)
    expect(h).toHaveLength(24)
    expect(h[0]!.start).toBe(new Date(2026, 9, 30, 0).getTime())
    expect(h[23]!.start).toBe(new Date(2026, 9, 30, 23).getTime())
    expect(h[20]!).toMatchObject({ total: 3, byTool: { cc: 2, cx: 1 }, top: 'cc' }) // 8 pm (NOW is 9:00 sharp)
    expect(h[19]!).toMatchObject({ total: 1, top: 'cx' })
    expect(h.reduce((n, x) => n + x.total, 0)).toBe(4) // 25 h ago is yesterday
  })

  test('7 days: 7 daily buckets ending today', () => {
    const d = rhythm(evs, 'week', NOW)
    expect(d).toHaveLength(7)
    expect(d[0]!.start).toBe(new Date(2026, 9, 24).getTime())
    expect(d[6]!).toMatchObject({ start: new Date(2026, 9, 30).getTime(), total: 4 })
    expect(d[5]!.total).toBe(1) // yesterday, 25 h ago
  })
})

describe('merging fetched and live events', () => {
  test('folding every live update keeps writes after the store\'s live feed (200) moves past them', () => {
    const fetched = [ev(CC, 300, 'B-1', 'comment', { text: 'fetched' })]
    let gathered = mergeFeeds(fetched, [], TODAY)
    const live: FeedEvent[] = []
    for (let i = 0; i < 260; i++) {
      live.unshift(ev(CC, 250 - i, 'B-1', 'comment', { text: `live ${i}` }))
      gathered = mergeFeeds(gathered, live.slice(0, 200), TODAY) // the store keeps its newest 200
    }
    expect(gathered).toHaveLength(261)
    expect(gathered.some((e) => e.text === 'live 0')).toBe(true) // fell out of the store's 200 long ago
    expect(gathered.at(-1)!.text).toBe('fetched')
  })

  test('the UI keeps as many as one ?since= read returns (one shared cap)', async () => {
    const { FEED_SINCE_MAX: server } = await import('../../src/server/http')
    const { FEED_SINCE_MAX: shared } = await import('../../src/shared/feed')
    expect(server).toBe(shared)
    const many = Array.from({ length: shared + 5 }, (_, i) => ({ ...ev(CC, 0, 'B-1', 'comment'), at: new Date(NOW - i * 1000).toISOString() }))
    expect(mergeFeeds(many, [], TODAY)).toHaveLength(shared)
  })

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

describe('agent-written data stays inert (security review)', () => {
  test('a client named like an Object.prototype key is just an unknown tool', () => {
    for (const c of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const t = toolOf(c, 'repo')
      expect(t.key).toBe('other')
      expect(t.name).toBe(c)
    }
  })
  test('only https GitHub pull request and commit URLs become chips', () => {
    expect(isGithubChange('https://github.com/o/r/pull/12')).toBe(true)
    expect(isGithubChange('https://github.com/o/r/commit/abc123')).toBe(true)
    expect(isGithubChange('javascript:alert(1)//github.com/o/r/pull/1')).toBe(false)
    expect(isGithubChange('javascript:/pull/1')).toBe(false)
    expect(isGithubChange('http://github.com/o/r/pull/1')).toBe(false)
    expect(isGithubChange('https://evil.example/o/r/pull/1')).toBe(false)
    expect(isGithubChange('https://github.com.evil.example/o/r/pull/1')).toBe(false)
    expect(isGithubChange('https://user:pw@github.com/o/r/pull/1')).toBe(false)
    expect(isGithubChange('https://github.com/o/r/issues/1')).toBe(false)
    expect(isGithubChange('not a url')).toBe(false)
  })
})

describe('dayOverview (Home, ATT-53)', () => {
  test('started in one session and finished in another counts as finished only', () => {
    const events = [ev(CC, 60, 'B-1', 'status', { from: 'Todo', to: 'In Progress' }), ev(CX, 30, 'B-1', 'status', { from: 'In Progress', to: 'Done' })].reverse()
    expect(dayOverview(buildActivity(events, ctx, TODAY).cards)).toMatchObject({ finished: 1, started: 0 })
  })

  test('a row\'s kind follows its last move: finished then reopened is started, not finished', () => {
    const events = [
      ev(CC, 60, 'B-1', 'status', { from: 'Todo', to: 'In Progress' }), ev(CC, 40, 'B-1', 'status', { from: 'In Progress', to: 'Done' }),
      ev(CC, 20, 'B-1', 'status', { from: 'Done', to: 'In Progress' }),
    ].reverse()
    const o = dayOverview(buildActivity(events, ctx, TODAY).cards)
    expect(o).toMatchObject({ finished: 0, started: 1 })
    expect(o.recent).toEqual([])
  })

  test('moved on then parked: asking and being put back count for what it is now', () => {
    const asked = [ev(CC, 60, 'B-1', 'status', { from: 'Todo', to: 'In Progress' }), ev(CC, 40, 'B-1', 'status', { from: 'In Progress', to: 'Waiting' })].reverse()
    expect(buildActivity(asked, ctx, TODAY).cards[0]!.rows[0]!.kinds).toEqual(['needs'])
    const parked = [ev(CC, 60, 'B-1', 'status', { from: 'Todo', to: 'In Progress' }), ev(CC, 40, 'B-1', 'status', { from: 'In Progress', to: 'Todo' })].reverse()
    expect(buildActivity(parked, ctx, TODAY).cards[0]!.rows[0]!.kinds).toEqual([])
  })

  test('counts, the live session and what it wrote last, and what finished, newest first', () => {
    const events: FeedEvent[] = [
      ev(CX, 300, 'A-3', 'status', { from: 'In Progress', to: 'Done' }),
      ev(CC, 60, 'A-2', 'status', { from: 'In Progress', to: 'Done' }),
      ev(CC, 30, 'A-1', 'status', { from: 'In Progress', to: 'Done' }),
      ev(CC, 3, 'B-1', 'comment', { text: 'Working on it' }),
      ev({ actor: 'you' }, 2, 'W-1', 'status', { from: 'Todo', to: 'Waiting' }),
    ].reverse()
    const o = dayOverview(buildActivity(events, ctx, TODAY).cards, 2)
    expect(o).toMatchObject({ finished: 3, agents: 2, live: 1 })
    expect(o.current?.card.label).toBe('Claude Code')
    expect(o.current?.row.id).toBe('B-1')
    expect(o.recent.map((r) => r.id)).toEqual(['A-1', 'A-2'])
  })

  test('no live session: the latest agent session; none at all: null', () => {
    const old = [ev(CX, 120, 'B-1', 'comment', { text: 'note' })]
    const o = dayOverview(buildActivity(old, ctx, TODAY).cards)
    expect(o.current?.card.live).toBe(false)
    expect(o.current?.row.id).toBe('B-1')
    expect(dayOverview(buildActivity([ev({ actor: 'you' }, 5, 'B-1', 'comment', { text: 'mine' })], ctx, TODAY).cards).current).toBeNull()
  })
})
