import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DayOverview } from '../../ui/activity'
import { emptyState } from '../../ui/client'
import { ActivityView, type ActivityData } from '../../ui/views/Activity'

const none: DayOverview = { finished: 0, started: 0, agents: 0, live: 0, current: null, recent: [] }
const data = (over: Partial<ActivityData>): ActivityData => ({
  range: 'today', setRange: () => {}, today: none, days: [], buckets: [], waitingIds: new Set(), capped: false, loaded: true, ...over,
})
const html = (d: ActivityData) => renderToStaticMarkup(createElement(ActivityView, { data: d, now: 0, state: emptyState() }))

describe('Agent activity on Home', () => {
  test('before the feed arrives: no zeros and no empty-state claims', () => {
    const h = html(data({ loaded: false }))
    expect(h).not.toContain('<strong>0</strong>')
    expect(h).not.toContain('No agent sessions today')
    expect(h).not.toContain('Nothing finished today')
  })

  test('loaded and empty: it says so', () => {
    const h = html(data({}))
    expect(h).toContain('<strong>0</strong>')
    expect(h).toContain('No agent sessions today')
    expect(h).toContain('Nothing finished today')
  })

  test('"No agent sessions" never sits beside "1 Agent"', () => {
    const h = html(data({ today: { ...none, agents: 1 } }))
    expect(h).toContain('Agent')
    expect(h).not.toContain('No agent sessions today')
  })
})
