import { describe, expect, test } from 'bun:test'
import type { IssueSummary } from '../../src/model'
import { firstLine, milestoneProgress, shortTarget, targetLabel } from '../../ui/projectPage'

const iss = (id: string, project: string, status: string, milestone: string | null): IssueSummary => ({ id, project, status, milestone }) as IssueSummary
const closed = (s: string) => s === 'Done' || s === 'Canceled'

describe('milestoneProgress', () => {
  test('counts done/total per milestone for the project only', () => {
    const issues = [
      iss('Q-1', 'a', 'Done', 'MVP'), iss('Q-2', 'a', 'Todo', 'MVP'), iss('Q-3', 'a', 'Canceled', 'MVP'),
      iss('Q-4', 'a', 'Todo', 'Beta'), iss('Q-5', 'b', 'Done', 'MVP'), iss('Q-6', 'a', 'Done', null),
    ]
    const p = milestoneProgress(issues, 'a', ['MVP', 'Beta', 'GA'], closed)
    expect(p.get('MVP')).toEqual({ done: 2, total: 3 })
    expect(p.get('Beta')).toEqual({ done: 0, total: 1 })
    expect(p.get('GA')).toEqual({ done: 0, total: 0 })
  })
  test('issues on a milestone the project does not list are ignored', () => {
    expect([...milestoneProgress([iss('Q-1', 'a', 'Done', 'Ghost')], 'a', ['MVP'], closed).keys()]).toEqual(['MVP'])
  })
})

describe('targetLabel', () => {
  test('formats a date, passes through odd text, empty for none', () => {
    expect(targetLabel('2026-12-01')).toMatch(/2026/)
    expect(targetLabel('Q3 maybe')).toBe('Q3 maybe')
    expect(targetLabel(undefined)).toBe('')
  })
})

describe('the summary line', () => {
  test('firstLine: the first line with text, without markdown marks', () => {
    expect(firstLine('\n# The **marketing** site\nmore')).toBe('The marketing site')
    expect(firstLine('- see [the plan](https://example.com/p) and `code`')).toBe('see the plan and code')
    expect(firstLine('  \n')).toBe('')
  })
  test('shortTarget: no year in the current year, the year otherwise, odd text as written', () => {
    const now = new Date('2026-03-12T12:00:00')
    expect(shortTarget('2026-03-27', now)).toBe('Mar 27')
    expect(shortTarget('2027-01-05', now)).toBe('Jan 5, 2027')
    expect(shortTarget('Q3 maybe', now)).toBe('Q3 maybe')
    expect(shortTarget(undefined, now)).toBe('')
  })
})

describe('final fix: embedded view has a bounded scroll container', () => {
  // jsdom has no layout; this pins the CSS contract the virtualizer depends on (verified in a browser at 10k).
  test('the project page has a definite (viewport) height and its ViewScreen flexes inside it, not a % of an auto-height parent', async () => {
    const css = await Bun.file(new URL('../../ui/styles.css', import.meta.url)).text()
    const decl = (rule: RegExpExecArray | null, prop: string) => new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(rule?.[1] ?? '')?.[1]?.trim() ?? ''
    const page = /\.project-page\s*\{([^}]*)\}/.exec(css)
    expect(decl(page, 'height')).toMatch(/vh|cqh/)
    expect(decl(page, 'display')).toBe('flex')
    expect(decl(page, 'flex-direction')).toBe('column')
    const view = /\.project-page\s*>\s*\.view-screen\s*\{([^}]*)\}/.exec(css)
    expect(decl(view, 'flex')).toBe('1 1 0') // takes what the header leaves; a zero basis keeps it from growing with its rows
  })
})
