import { describe, expect, test } from 'bun:test'
import type { FeedEvent } from '../../src/engine/eventlog'
import type { Config, IssueSummary } from '../../src/model'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { boardColumns, feedActor, feedInScope, feedLine, needsYouWhy, relTime, scopeHome, type HomeData, type NeedsYouItem } from '../../ui/home'
import { NeedsYouWhy } from '../../ui/views/Home'
import { emptyState } from '../../ui/client'

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
  test('the row shows a "stalled" mark with the reason, apart from the Waiting/label why', () => {
    const state = { ...emptyState(), config: { needsYou: ny } } as never
    const html = (i: NeedsYouItem) => renderToStaticMarkup(createElement(NeedsYouWhy, { state, issue: i, now }))
    expect(html(item({ stalled: 'idle 31 h in In Progress' })))
      .toBe('<span class="stalled-why" title="Stalled: idle 31 h in In Progress"><span class="pill stalled">stalled</span>idle 31 h in In Progress</span>')
    expect(html(item({ status: 'Waiting' }))).toBe('<span class="why">Waiting · 3d</span>')
    expect(html(item({ status: 'Waiting', stalled: 'reopened 2× in 7 days' }))).toContain('<span class="why">Waiting · 3d</span><span class="stalled-why"')
  })
})
