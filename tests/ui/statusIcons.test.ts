import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Config } from '../../src/model'
import { defaultConfig } from '../../src/store/metaFiles'
import { ProgressPill, ProgressRing, progressArc, RING_MIN, StatusIcon, statusGlyph } from '../../ui/components/icons'

const config = defaultConfig()
const icon = (status: string, c: Config | null = config) => renderToStaticMarkup(createElement(StatusIcon, { status, config: c }))
const ring = (done: number, total: number) => renderToStaticMarkup(createElement(ProgressRing, { done, total, config }))
const DEFAULTS = ['Backlog', 'Todo', 'In Progress', 'Waiting', 'Done', 'Canceled', 'Duplicate']

describe('status glyphs', () => {
  test('the default statuses each get their own glyph and their own drawing', () => {
    expect(DEFAULTS.map((s) => statusGlyph(s, config))).toEqual(['backlog', 'todo', 'progress', 'waiting', 'done', 'canceled', 'duplicate'])
    // Distinct shapes, not just distinct colors: compare the markup with the colors taken out.
    const shapes = DEFAULTS.map((s) => icon(s).replace(/var\(--status-[a-z]+, [^)]+\)/g, 'C').replace(/aria-label="[^"]*"/, ''))
    expect(new Set(shapes).size).toBe(DEFAULTS.length)
  })

  test('a started status is paused when it is a needs-you status, else it has the center dot', () => {
    const c: Config = {
      ...config,
      statuses: [...config.statuses, { name: 'Building', type: 'started', color: '#123456' }, { name: 'Blocked on owner', type: 'started', color: '#654321' }],
      needsYou: { ...config.needsYou, statuses: [...config.needsYou.statuses, 'Blocked on owner'] },
    }
    expect(statusGlyph('Building', c)).toBe('progress')
    expect(statusGlyph('Blocked on owner', c)).toBe('waiting')
    expect(statusGlyph('In Progress', c)).toBe('progress')
    // Taking Waiting out of needs-you turns it into a plain started status.
    expect(statusGlyph('Waiting', { ...c, needsYou: { ...c.needsYou, statuses: [] } })).toBe('progress')
    expect(icon('Building', c)).toContain('r="2.25"')
    expect(icon('Blocked on owner', c)).toContain('M5.75 5.1v3.8M8.25 5.1v3.8')
  })

  test('the old position-based pie is gone', () => {
    for (const s of DEFAULTS) expect(icon(s)).not.toContain(' A3 3 ')
  })

  test('colors come from the theme override with the status color as fallback; marks in discs use --bg', () => {
    expect(icon('In Progress')).toContain('var(--status-started, #f2c94c)')
    expect(icon('Done')).toContain('var(--status-completed, #5e6ad2)')
    expect(icon('Done')).toContain('stroke="var(--bg)"')
    expect(icon('Canceled')).toContain('stroke="var(--bg)"')
    expect(icon('Canceled')).toContain('M4.6 7h4.8')
  })

  test('an unknown status (or no config yet) is an open ring', () => {
    expect(statusGlyph('Mystery', config)).toBe('todo')
    expect(statusGlyph('Waiting', null)).toBe('todo')
    expect(icon('Mystery', null)).toContain('var(--status-unstarted, var(--muted))')
  })

  test('every glyph has an accessible label', () => {
    for (const s of DEFAULTS) { expect(icon(s)).toContain(`aria-label="${s}"`); expect(icon(s)).toContain(`role="img"`) }
    expect(ring(3, 6)).toContain('aria-label="3 of 6 sub-issues done"')
    expect(ring(3, 6)).toContain('<title>3 of 6 sub-issues done</title>')
  })
})

describe('progress ring', () => {
  test('the arc: 0, a 20° minimum, a 20° gap below 100%, exact in between, closed when all done', () => {
    expect(progressArc(0, 6)).toBe(0)
    expect(progressArc(0, 0)).toBe(0)
    expect(progressArc(1, 40)).toBe(RING_MIN)
    expect(RING_MIN * 360).toBeCloseTo(20)
    expect(progressArc(39, 40)).toBe(1 - RING_MIN)
    expect(progressArc(1, 2)).toBe(0.5)
    expect(progressArc(6, 6)).toBe(1)
  })

  test('at 0 only the track shows', () => {
    const svg = ring(0, 4)
    expect(svg.match(/<circle/g)?.length).toBe(1)
    expect(svg).toContain('stroke="var(--text)" stroke-opacity=".18"')
  })

  test('a partial arc starts at 12 o\'clock, runs clockwise with round caps, in the accent color', () => {
    const svg = ring(1, 2)
    expect(svg).toContain('stroke="var(--accent)"')
    expect(svg).toContain('stroke-linecap="round"')
    expect(svg).toContain('transform="rotate(-90 7 7)"')
    // The visible half (caps included) is the dash plus one stroke width: 2π·5.25 / 2 = 16.493.
    const dash = Number(/stroke-dasharray="([\d.]+) /.exec(svg)![1])
    expect(dash + 2).toBeCloseTo(Math.PI * 5.25, 2)
    // 1 of 40 is a single round dot of 20°: a zero-length dash with round caps.
    expect(ring(1, 40)).toContain('stroke-dasharray="0.000 ')
  })

  test('all done closes the ring in the Done color', () => {
    const svg = ring(6, 6)
    expect(svg).toContain('stroke="var(--status-completed, #5e6ad2)"')
    expect(svg).not.toContain('stroke-dasharray')
    expect(svg).not.toContain('var(--accent)')
  })

  test('the pill shows the ring and the exact count, and nothing without sub-issues', () => {
    const pill = renderToStaticMarkup(createElement(ProgressPill, { done: 3, total: 6, config }))
    expect(pill).toContain('title="3 of 6 sub-issues done"')
    expect(pill).toContain('3/6')
    expect(pill).toContain('progress-ring')
    expect(renderToStaticMarkup(createElement(ProgressPill, { done: 0, total: 0, config }))).toBe('')
  })
})
