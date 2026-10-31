import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CiStatus, IssueSummary } from '../../src/model'
import { ciDetail, ciTitle, ciTone } from '../../ui/ci'
import { applyEvent, emptyState, fromSnapshot } from '../../ui/client'
import { CiBadgeLine, CiDot } from '../../ui/components/Ci'
import { needsYouCard, needsYouWhy, type NeedsYouItem } from '../../ui/home'
import { NeedsYouRequest } from '../../ui/views/Home'

const summary = (id: string, over: Partial<IssueSummary> = {}): IssueSummary => ({
  id, title: `Issue ${id}`, status: 'In Progress', priority: 0, labels: [], parent: null, blockedBy: [], related: [],
  milestone: null, due: null, plan: null, links: [], created: '2026-10-28T00:00:00Z', updated: '2026-10-28T00:00:00Z',
  project: 'p', childCount: 0, progress: { done: 0, total: 0 }, blocks: [], workspaces: [], ...over,
})

describe('CI status in the UI', () => {
  test('a ci event sets and clears row badges; unknown ids are ignored', () => {
    const s0 = fromSnapshot({ issues: [summary('Q-1'), summary('Q-2')], config: null, labels: [], projects: [], views: [], errors: [] })
    const s1 = applyEvent(s0, { kind: 'ci', changes: { 'Q-1': { pr: 12, state: 'open', checks: 'failing' }, 'Q-9': null } })
    expect(s1.issues.get('Q-1')!.ci).toEqual({ pr: 12, state: 'open', checks: 'failing' })
    expect(s0.issues.get('Q-1')!.ci).toBeUndefined()
    const s2 = applyEvent(s1, { kind: 'ci', changes: { 'Q-1': null } })
    expect('ci' in s2.issues.get('Q-1')!).toBe(false)
    expect(applyEvent(s2, { kind: 'ci', changes: { 'Q-9': null } })).toBe(s2)
    expect(applyEvent(emptyState(), { kind: 'ci', changes: {} })).toEqual(emptyState())
  })

  test('dot: tone from checks, title from PR and state; nothing without a PR', () => {
    expect(ciTone({ checks: 'failing', state: 'open' })).toBe('fail')
    expect(ciTitle({ pr: 3, state: 'merged', checks: 'passing' })).toBe('PR #3 merged · checks passing')
    expect(renderToStaticMarkup(createElement(CiDot, { ci: { pr: 3, state: 'merged', checks: 'passing' } })))
      .toBe('<span class="ci-dot pass merged" title="PR #3 merged · checks passing" aria-label="PR #3 merged · checks passing" role="img"></span>')
    expect(renderToStaticMarkup(createElement(CiDot, { ci: undefined }))).toBe('')
  })

  test('a merged PR whose checks failed says so; bad data never throws', () => {
    const now = Date.parse('2026-10-29T12:00:00Z')
    const merged: CiStatus = { pr: 9, state: 'merged', checks: 'failing', failing: ['test'], checkedAt: '2026-10-29T11:00:00Z' }
    expect(ciDetail(merged, now)).toMatchObject({ state: 'merged', checks: 'checks failed', failing: 'test' })
    expect(renderToStaticMarkup(createElement(CiBadgeLine, { status: merged, now }))).toContain('merged</span>')
    expect(ciDetail({ pr: 1, state: 'open' } as unknown as CiStatus, now)).toEqual({ state: 'open', checks: '', failing: '', checked: '' })
    expect(ciDetail({ pr: 1, state: 'open', checks: 'weird', failing: [1, 'x'], checkedAt: 5 } as unknown as CiStatus, now))
      .toEqual({ state: 'open', checks: '', failing: 'x', checked: '' })
  })

  test('issue page line: state, checks, failing names, last checked', () => {
    const s: CiStatus = { pr: 12, state: 'open', checks: 'failing', failing: ['test', 'lint'], checkedAt: '2026-10-29T11:58:00Z' }
    const now = Date.parse('2026-10-29T12:00:00Z')
    expect(ciDetail(s, now)).toEqual({ state: 'open', checks: 'checks failing', failing: 'test, lint', checked: 'checked 2m ago' })
    const html = renderToStaticMarkup(createElement(CiBadgeLine, { status: s, now }))
    expect(html).toContain('<span class="pill ci-state open">open</span>')
    expect(html).toContain('<span class="ci-failing">test, lint</span>')
    expect(html).toContain('checked 2m ago')
  })

  test('Needs you: the CI reason, alone or after the Waiting why', () => {
    const ny = { statuses: ['Waiting'], labels: [] }
    const now = Date.parse('2026-10-29T12:00:00Z')
    const item = (over: Partial<NeedsYouItem>) => ({ ...summary('Q-1'), ...over }) as NeedsYouItem
    expect(needsYouWhy(item({ ciReason: 'CI failing on PR #12' }), ny, now)).toEqual({ why: '', ci: 'CI failing on PR #12' })
    expect(needsYouWhy(item({ status: 'Waiting', ciReason: 'CI failing on PR #12' }), ny, now))
      .toEqual({ why: 'Waiting · 1d', ci: 'CI failing on PR #12' })
    // Home's request card: CI failing is the status chip and the reason is what it asks.
    const issue = item({ ciReason: 'CI failing on PR #12' })
    const html = renderToStaticMarkup(createElement(NeedsYouRequest, { issue, card: needsYouCard(issue, ny, now), featured: false, project: '' }))
    expect(html).toContain('<span class="ov-status">CI failing</span>')
    expect(html).toContain('<p>CI failing on PR #12</p>')
  })
})
