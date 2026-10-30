import { describe, expect, test } from 'bun:test'
import type { IssueSummary } from '../../src/model'
import { milestoneProgress, targetLabel } from '../../ui/projectPage'

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

describe('final fix: embedded view has a bounded scroll container', () => {
  // jsdom has no layout; this pins the CSS contract the virtualizer depends on (verified in a browser at 10k).
  test('the project page gives its ViewScreen a definite (viewport) height, not a % of an auto-height parent', async () => {
    const css = await Bun.file(new URL('../../ui/styles.css', import.meta.url)).text()
    const rule = /\.project-page\s*>\s*\.view-screen\s*\{([^}]*)\}/.exec(css)
    expect(rule).not.toBeNull()
    const height = /(?:^|;)\s*height:\s*([^;]+)/.exec(rule![1]!)?.[1]?.trim() ?? ''
    expect(height).toMatch(/vh|cqh/)
  })
})
