import { describe, expect, test } from 'bun:test'
import type { FeedEvent } from '../../src/engine/eventlog'
import type { Config, IssueSummary } from '../../src/model'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  blockedChains, boardColumns, daySummary, duration, feedActor, feedInScope, feedLine, listHref, needsYouCard, needsYouWhy, relTime,
  scopeHome, statusesOf, type HomeData, type NeedsYouItem,
} from '../../ui/home'
import { NeedsYouRequest } from '../../ui/views/Home'
import { parseRoute } from '../../ui/router'
import { viewFromQuery, DEFAULT_DISPLAY } from '../../ui/viewModel'

const AG = { actor: 'agent' as const, workspace: 'web-app' }
const ev = (over: Partial<FeedEvent>): FeedEvent => ({ at: '2026-10-28T12:00:00Z', actor: AG, id: 'Q-27', kind: 'updated', ...over })

describe('feedLine', () => {
  test('status move', () => expect(feedLine(ev({ kind: 'status', from: 'Todo', to: 'In Progress' }))).toBe('moved Q-27 → In Progress'))
  test('comment is quoted and cut at 80 chars', () => {
    expect(feedLine(ev({ id: 'Q-144', kind: 'comment', text: 'PR opened #1414' }))).toBe('on Q-144: "PR opened #1414"')
    expect(feedLine(ev({ id: 'Q-144', kind: 'comment', text: 'x'.repeat(200) }))).toBe(`on Q-144: "${'x'.repeat(80)}"`)
  })
  test('created under a parent, from the event or a lookup', () => {
    expect(feedLine(ev({ id: 'Q-276', kind: 'created', text: 'Title', to: 'Q-269' }))).toBe('created Q-276 under Q-269')
    expect(feedLine(ev({ id: 'Q-276', kind: 'created', text: 'Title' }), () => 'Q-269')).toBe('created Q-276 under Q-269')
    expect(feedLine(ev({ id: 'Q-276', kind: 'created', text: 'Title' }))).toBe('created Q-276')
  })
  test('blocked / unblocked / parent / updated', () => {
    expect(feedLine(ev({ id: 'Q-108', kind: 'blocked', from: '', to: 'Q-107' }))).toBe('blocked Q-108 by Q-107')
    expect(feedLine(ev({ id: 'Q-108', kind: 'blocked', from: 'Q-107', to: '' }))).toBe('unblocked Q-108')
    expect(feedLine(ev({ id: 'Q-8', kind: 'parent', to: 'Q-2' }))).toBe('moved Q-8 under Q-2')
    expect(feedLine(ev({ id: 'Q-8', kind: 'parent', from: 'Q-2' }))).toBe('moved Q-8 out of Q-2')
    expect(feedLine(ev({ id: 'Q-8', kind: 'updated' }))).toBe('updated Q-8')
  })
})

describe('feedActor', () => {
  test('workspace, hand edits, owner', () => {
    expect(feedActor(ev({}))).toEqual({ label: 'web-app', kind: 'agent' })
    expect(feedActor(ev({ actor: { actor: 'you', workspace: 'external' } }))).toEqual({ label: 'edited by hand', kind: 'hand' })
    expect(feedActor(ev({ actor: { actor: 'you' } }))).toEqual({ label: 'you', kind: 'you' })
    expect(feedActor(ev({ actor: { actor: 'agent' } }))).toEqual({ label: 'agent', kind: 'agent' })
  })
})

describe('relTime', () => {
  const now = Date.parse('2026-10-28T12:00:00Z')
  const at = (s: number) => new Date(now - s * 1000).toISOString()
  test('buckets', () => {
    expect(relTime(at(5), now)).toBe('now')
    expect(relTime(at(-30), now)).toBe('now') // clock skew
    expect(relTime(at(4 * 60), now)).toBe('4m')
    expect(relTime(at(2 * 3600 + 5), now)).toBe('2h')
    expect(relTime(at(3 * 86400 + 5), now)).toBe('3d')
    expect(relTime('garbage', now)).toBe('')
  })
})

const cfg: Pick<Config, 'workspaces'> = { workspaces: { 'web-app': 'shop' } }
const hi = (id: string, project: string, ws?: string) => ({ id, project, workspaces: ws ? [ws] : [] }) as never
describe('scopeHome', () => {
  const data: HomeData = {
    needsYou: [hi('A', 'shop'), hi('B', 'other')],
    inProgress: [hi('C', 'other', 'web-app')],
    readyNext: [{ issue: hi('D', 'shop'), unblocks: 2 }, { issue: hi('E', 'other'), unblocks: 0 }],
    blocked: [{ issue: hi('F', 'other'), blockers: ['X'] }],
  }
  test('all leaves it alone', () => expect(scopeHome(data, { kind: 'all' }, cfg)).toBe(data))
  test('workspace covers mapped project and touched issues', () => {
    const r = scopeHome(data, { kind: 'workspace', name: 'web-app' }, cfg)
    expect(r.needsYou.map((i) => i.id)).toEqual(['A'])
    expect(r.inProgress.map((i) => i.id)).toEqual(['C'])
    expect(r.readyNext.map((x) => x.issue.id)).toEqual(['D'])
    expect(r.blocked).toEqual([])
  })
  test('project', () => {
    const r = scopeHome(data, { kind: 'project', slug: 'other' }, cfg)
    expect(r.needsYou.map((i) => i.id)).toEqual(['B'])
    expect(r.blocked.length).toBe(1)
  })
})

describe('feedInScope', () => {
  const issue = hi('Q-1', 'shop')
  test('all keeps everything, even for deleted issues', () => expect(feedInScope(ev({}), undefined, { kind: 'all' }, cfg)).toBe(true))
  test('workspace: by actor workspace or by the issue', () => {
    const s = { kind: 'workspace' as const, name: 'web-app' }
    expect(feedInScope(ev({}), undefined, s, cfg)).toBe(true)
    expect(feedInScope(ev({ actor: { actor: 'you' } }), issue, s, cfg)).toBe(true)
    expect(feedInScope(ev({ actor: { actor: 'you' } }), hi('Q-2', 'other'), s, cfg)).toBe(false)
    expect(feedInScope(ev({ actor: { actor: 'you' } }), undefined, s, cfg)).toBe(false)
  })
  test('project: by the issue only', () => {
    const s = { kind: 'project' as const, slug: 'shop' }
    expect(feedInScope(ev({}), issue, s, cfg)).toBe(true)
    expect(feedInScope(ev({}), undefined, s, cfg)).toBe(false)
  })
})

describe('boardColumns', () => {
  const s = (id: string, plan: IssueSummary['plan'], over: Partial<IssueSummary> = {}) => ({ id, plan, priority: 0, updated: '2026-10-28T00:00:00Z', ...over }) as IssueSummary
  test('groups by plan, skips null, sorts by priority then recency', () => {
    const cols = boardColumns([s('A', 'now', { priority: 3 }), s('B', 'now', { priority: 1 }), s('C', null), s('D', 'later'), s('E', 'now', { priority: 3, updated: '2026-10-29T00:00:00Z' })], {})
    expect(cols.now.map((i) => i.id)).toEqual(['B', 'E', 'A'])
    expect(cols.next).toEqual([])
    expect(cols.later.map((i) => i.id)).toEqual(['D'])
  })
  test('optimistic overrides win, including clearing', () => {
    const cols = boardColumns([s('A', 'now'), s('B', 'next')], { A: 'later', B: null })
    expect(cols.now).toEqual([])
    expect(cols.next).toEqual([])
    expect(cols.later.map((i) => i.id)).toEqual(['A'])
  })
})

describe('Needs you: why and stalled', () => {
  const now = Date.parse('2026-10-29T12:00:00Z')
  const ny = { statuses: ['Waiting'], labels: ['Needs review'] }
  const item = (over: Partial<NeedsYouItem>): NeedsYouItem =>
    ({ id: 'Q-1', title: 'T', status: 'In Progress', labels: [], updated: '2026-10-26T12:00:00Z', ...over }) as NeedsYouItem
  test('status, then label, with the age', () => {
    expect(needsYouWhy(item({ status: 'Waiting' }), ny, now)).toEqual({ why: 'Waiting · 3d' })
    expect(needsYouWhy(item({ labels: ['Bug', 'Needs review'] }), ny, now)).toEqual({ why: 'Needs review · 3d' })
  })
  test('a malformed needsYou (null lists, missing) falls back to the status instead of throwing', () => {
    const broken = { statuses: null, labels: null } as unknown as typeof ny
    expect(needsYouWhy(item({ status: 'Waiting', labels: ['Needs review'] }), broken, now)).toEqual({ why: 'Waiting · 3d' })
    expect(needsYouWhy(item({ status: 'Waiting' }), {} as typeof ny, now)).toEqual({ why: 'Waiting · 3d' })
    expect(needsYouWhy(item({ status: 'Waiting' }), undefined, now)).toEqual({ why: 'Waiting · 3d' })
  })
  test('stalled only: no why, just the reason; stalled and waiting: both', () => {
    expect(needsYouWhy(item({ stalled: 'idle 72 h in In Progress' }), ny, now)).toEqual({ why: '', stalled: 'idle 72 h in In Progress' })
    expect(needsYouWhy(item({ status: 'Waiting', stalled: 'reopened 2× in 7 days' }), ny, now))
      .toEqual({ why: 'Waiting · 3d', stalled: 'reopened 2× in 7 days' })
  })
  test('the request card shows a "stalled" mark with the reason when the request is something else', () => {
    const html = (i: NeedsYouItem, featured = false) =>
      renderToStaticMarkup(createElement(NeedsYouRequest, { issue: i, card: needsYouCard(i, ny, now), featured, project: 'Support' }))
    const stalledOnly = html(item({ stalled: 'idle 31 h in In Progress' }))
    expect(stalledOnly).toContain('<span class="ov-status">Stalled</span>')
    expect(stalledOnly).toContain('<p>idle 31 h in In Progress</p>')
    expect(stalledOnly).not.toContain('pill stalled') // the reason is already the summary
    const stalledWithComment = html(item({ request: 'Reproduced it.', stalled: 'idle 31 h in In Progress' }))
    expect(stalledWithComment).toContain('<span class="ov-status">Stalled</span>')
    expect(stalledWithComment).toContain('<p class="stalled-why">idle 31 h in In Progress</p>')
    expect(stalledWithComment).not.toContain('pill stalled') // the status already says it
    const both = html(item({ status: 'Waiting', request: 'Which plan?', stalled: 'reopened 2× in 7 days' }), true)
    expect(both).toContain('<p>Which plan?</p>')
    expect(both).toContain('<span class="pill stalled">stalled</span>reopened 2× in 7 days')
    expect(both).toContain('class="ov-request featured"')
    expect(both).toContain('class="ov-action primary"')
    expect(both).toContain('href="#/issue/Q-1"')
    expect(both).toContain('Q-1<span class="ov-sep" aria-hidden="true">·</span>Support')
  })
})

describe('Daily overview', () => {
  const now = Date.parse('2026-10-30T12:00:00Z')
  const ny = { statuses: ['Waiting', 'In Review'], labels: ['Needs decision', 'Needs review'] }
  const item = (over: Partial<NeedsYouItem>): NeedsYouItem =>
    ({ id: 'Q-1', title: 'T', status: 'In Progress', labels: [], updated: '2026-10-23T12:00:00Z', ...over }) as NeedsYouItem

  test('durations', () => {
    expect(duration(10 * 60_000)).toBe('less than an hour')
    expect(duration(3_600_000)).toBe('1 hour')
    expect(duration(5 * 3_600_000)).toBe('5 hours')
    expect(duration(86_400_000)).toBe('1 day')
    expect(duration(8.5 * 86_400_000)).toBe('8 days')
    expect(duration(NaN)).toBe('less than an hour')
  })

  test('a Waiting request: Input needed, its request, waiting since the move, View request', () => {
    expect(needsYouCard(item({ status: 'Waiting', request: 'Needs: the password', waitingSince: '2026-10-29T11:00:00Z' }), ny, now))
      .toEqual({ status: 'Input needed', summary: 'Needs: the password', age: 'Waiting 1 day', action: 'View request' })
  })

  test('a review label: Review, and quiet time when there is no waitingSince', () => {
    expect(needsYouCard(item({ labels: ['Needs review'] }), ny, now)).toEqual({ status: 'Needs review', age: 'No activity for 7 days', action: 'Review' })
    expect(needsYouCard(item({ status: 'In Review' }), ny, now).action).toBe('Review')
    expect(needsYouCard(item({ labels: ['Needs decision'], updated: '2026-10-30T09:00:00Z' }), ny, now))
      .toMatchObject({ status: 'Needs decision', age: 'Updated 3 hours ago', action: 'Open' })
    expect(needsYouCard(item({ labels: ['Needs decision'], updated: '2026-10-30T11:50:00Z' }), ny, now).age).toBe('Updated just now')
    // Waiting without a logged move falls back to quiet time.
    expect(needsYouCard(item({ status: 'Waiting' }), ny, now).age).toBe('No activity for 7 days')
  })

  test('CI and stalled items; a broken needsYou config does not throw', () => {
    expect(needsYouCard(item({ ciReason: 'CI failing on PR #3' }), ny, now)).toMatchObject({ status: 'CI failing', summary: 'CI failing on PR #3', ci: 'CI failing on PR #3' })
    expect(needsYouCard(item({ stalled: 'idle 40 h' }), { statuses: null, labels: null } as never, now)).toMatchObject({ status: 'Stalled', summary: 'idle 40 h' })
  })

  test('the day summary', () => {
    expect(daySummary({ finished: 12, inProgress: 5, needsYou: 21 })).toBe('12 finished today. 5 in progress. 21 need you.')
    expect(daySummary({ finished: 0, inProgress: 1, needsYou: 1 })).toBe('0 finished today. 1 in progress. 1 needs you.')
    expect(daySummary({ finished: 3, inProgress: 0, needsYou: 0 })).toBe('3 finished today. 0 in progress. Nothing needs you.')
  })

  test('blocked chains: root blocker first, the inner chain folded into the longer one, cycle-safe', () => {
    const issues: Record<string, { id: string; blockedBy: string[] }> = {
      A: { id: 'A', blockedBy: [] }, B: { id: 'B', blockedBy: ['A'] }, C: { id: 'C', blockedBy: ['B', 'X'] },
      D: { id: 'D', blockedBy: ['Done1'] }, E: { id: 'E', blockedBy: ['F'] }, F: { id: 'F', blockedBy: ['E'] },
      X: { id: 'X', blockedBy: [] }, Done1: { id: 'Done1', blockedBy: [] },
    }
    const open = (id: string) => id !== 'Done1' && id in issues
    const blocked = ['B', 'C', 'D', 'E', 'F'].map((id) => ({ issue: { id } }))
    expect(blockedChains(blocked, (id) => issues[id], open)).toEqual([
      { ids: ['A', 'B', 'C'], more: 1 }, // C is also blocked by X
      { ids: ['D'], more: 0 }, // blocked by the label only, or by closed issues
      { ids: ['F', 'E'], more: 1 }, // E ⇄ F: the walk stops where it closes (the cycle's way back counts as another blocker)
      { ids: ['E', 'F'], more: 1 },
    ])
  })

  test('full-list links open All issues with the filter', () => {
    const r = parseRoute(listHref({ status: ['In Progress'] }))
    expect(r.name).toBe('issues')
    const v = viewFromQuery((r as { query?: string }).query ?? '', { filter: {}, display: DEFAULT_DISPLAY })
    expect(v.filter).toEqual({ status: ['In Progress'] })
    expect(viewFromQuery((parseRoute(listHref({ blocked: true })) as { query?: string }).query ?? '', { filter: {}, display: DEFAULT_DISPLAY }).filter)
      .toEqual({ blocked: true })
  })

  test('statusesOf leaves the Needs-you statuses out', () => {
    const config = {
      statuses: [{ name: 'Todo', type: 'unstarted' }, { name: 'In Progress', type: 'started' }, { name: 'Waiting', type: 'started' }, { name: 'Backlog', type: 'backlog' }],
      needsYou: { statuses: ['Waiting'], labels: [] },
    } as never
    expect(statusesOf(config, ['started'])).toEqual(['In Progress'])
    expect(statusesOf(config, ['backlog', 'unstarted'])).toEqual(['Todo', 'Backlog'])
    expect(statusesOf(null, ['started'])).toEqual([])
  })
})
