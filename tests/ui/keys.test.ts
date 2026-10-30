import { expect, test } from 'bun:test'
import { keyAction, type KeyState } from '../../ui/keys'
import { matchIssues } from '../../ui/views/Palette'
import { newIssueArgs } from '../../ui/views/NewIssue'
import { initials } from '../../ui/views/Sidebar'

const press = (keys: [string, number][]) => {
  let s: KeyState = { pendingG: null }
  const out: (string | null)[] = []
  for (const [k, t] of keys) { const r = keyAction(s, k, t); out.push(r.action); s = r.next }
  return out
}

test('c, /, g h, g i; a stale or broken chord does nothing', () => {
  expect(press([['c', 0]])).toEqual(['new'])
  expect(press([['/', 0]])).toEqual(['search'])
  expect(press([['g', 0], ['h', 300]])).toEqual([null, 'home'])
  expect(press([['g', 0], ['i', 300]])).toEqual([null, 'issues'])
  expect(press([['g', 0], ['h', 2000]])).toEqual([null, null])
  expect(press([['g', 0], ['x', 100], ['h', 200]])).toEqual([null, null, null])
  expect(press([['h', 0]])).toEqual([null])
})

test('palette issue matching: exact id, id prefix, then title words', () => {
  const mk = (id: string, title: string, updated = '2026-10-28') => ({ id, title, updated } as any)
  const issues = [mk('Q-27', 'Docs reader'), mk('Q-2', 'Quote engine'), mk('Q-270', 'Composer package'), mk('LC-1', 'quote docs')]
  expect(matchIssues(issues, 'q-27').map((i) => i.id)).toEqual(['Q-27', 'Q-270'])
  expect(matchIssues(issues, 'quote').map((i) => i.id).sort()).toEqual(['LC-1', 'Q-2'])
  expect(matchIssues(issues, 'docs quote').map((i) => i.id)).toEqual(['LC-1'])
  expect(matchIssues(issues, '  ')).toEqual([])
})

test('new-issue form maps to save_issue args', () => {
  expect(newIssueArgs({ title: ' Fix it ', project: 'cdp', labels: ['Bug'], status: 'Todo', priority: 2, parent: 'q-269', description: '' }))
    .toEqual({ title: 'Fix it', project: 'cdp', labels: ['Bug'], state: 'Todo', priority: 2, parentId: 'Q-269' })
})

test('switcher avatar initials', () => {
  expect(initials('All workspaces')).toBe('AW')
  expect(initials('web-app')).toBe('WA')
  expect(initials('Support')).toBe('SU')
})
