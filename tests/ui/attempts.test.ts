import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { attemptsSummary } from '../../ui/issuePage'
import { IssueAttempts } from '../../ui/views/IssueAttempts'

describe('attempts on the issue page', () => {
  test('summary: attempts and distinct tools', () => {
    expect(attemptsSummary([])).toBe('')
    expect(attemptsSummary([{ client: 'codex' }])).toBe('1 attempt · 1 tool')
    expect(attemptsSummary([{ client: 'codex' }, { client: 'claude-code' }, { client: 'codex' }])).toBe('3 attempts · 2 tools')
  })
  test('collapsed by default to the summary; nothing without attempts', () => {
    const a = { client: 'codex', branch: 'fix/x', first: '2026-10-29T10:00:00Z', last: '2026-10-29T11:00:00Z', leftStatus: 'Waiting', writes: 4 }
    const html = renderToStaticMarkup(createElement(IssueAttempts, { attempts: [a], now: Date.parse('2026-10-29T12:00:00Z') }))
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('1 attempt · 1 tool')
    expect(html).not.toContain('attempts-list')
    expect(renderToStaticMarkup(createElement(IssueAttempts, { attempts: [], now: 0 }))).toBe('')
  })
})
