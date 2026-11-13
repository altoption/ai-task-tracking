import { describe, expect, test } from 'bun:test'
import { asksReason, bulkItems, clickSelect, commonProject, familyClose, listKey, families, missingKids, setMany, statusItems, visibleSelection } from '../../ui/bulk'

const ids = ['A-1', 'A-2', 'A-3', 'A-4', 'A-5']
const set = (...x: string[]) => new Set(x)

describe('clickSelect', () => {
  test('a click toggles one row', () => {
    expect([...clickSelect(set(), ids, 1, null, false)]).toEqual(['A-2'])
    expect([...clickSelect(set('A-2'), ids, 1, 1, false)]).toEqual([])
  })
  test('shift-click selects the range from the last clicked row, either direction', () => {
    expect([...clickSelect(set('A-2'), ids, 3, 1, true)].sort()).toEqual(['A-2', 'A-3', 'A-4'])
    expect([...clickSelect(set('A-5'), ids, 2, 4, true)].sort()).toEqual(['A-3', 'A-4', 'A-5'])
  })
  test('shift-click on a selected row clears the range; with no anchor it is a plain click', () => {
    expect([...clickSelect(set('A-1', 'A-2', 'A-3', 'A-4'), ids, 3, 1, true)]).toEqual(['A-1'])
    expect([...clickSelect(set(), ids, 2, null, true)]).toEqual(['A-3'])
    expect([...clickSelect(set(), ids, 2, 9, true)]).toEqual(['A-3'])
  })
})

test('visibleSelection keeps visible selected rows in order, once', () => {
  expect(visibleSelection(set('A-4', 'GONE-1', 'A-1'), [...ids, 'A-1'])).toEqual(['A-1', 'A-4'])
})

test('asksReason: Done, Canceled and Duplicate types only', () => {
  expect(asksReason({ name: 'Canceled', type: 'canceled' } as any)).toBe(true)
  expect(asksReason({ name: 'Done', type: 'completed' } as any)).toBe(true)
  expect(asksReason({ name: 'Todo', type: 'unstarted' } as any)).toBe(false)
  expect(asksReason(undefined)).toBe(false)
})

test('bulkItems: one item per id, the reason as a comment when given', () => {
  expect(bulkItems(['A-1', 'A-2'], { state: 'Canceled' }, '  dropped  ')).toEqual([
    { id: 'A-1', state: 'Canceled', comment: 'dropped' }, { id: 'A-2', state: 'Canceled', comment: 'dropped' },
  ])
  expect(bulkItems(['A-1'], { addLabels: ['Bug'] }, ' ')).toEqual([{ id: 'A-1', addLabels: ['Bug'] }])
})

describe('a parent and its sub-issues', () => {
  // E-1 > S-1 > T-1, E-1 > S-2, E-2 > S-3; H-1 (not listed) > T-9 > U-9; a cycle C-1 <> C-2.
  const parents: Record<string, string> = { 'S-1': 'E-1', 'T-1': 'S-1', 'S-2': 'E-1', 'S-3': 'E-2', 'T-9': 'H-1', 'U-9': 'T-9', 'C-1': 'C-2', 'C-2': 'C-1' }
  const fam = families(['E-1', 'S-1', 'T-1', 'S-2', 'X-1', 'E-2', 'S-3', 'T-9', 'U-9', 'C-1', 'C-2'], (id) => parents[id])
  test('families: every listed sub-issue at any depth, whatever its group; unlisted parents are skipped, cycles end', () => {
    expect(fam.get('E-1')).toEqual(['S-1', 'T-1', 'S-2'])
    expect(fam.get('S-1')).toEqual(['T-1'])
    expect(fam.get('E-2')).toEqual(['S-3'])
    expect(fam.get('T-9')).toEqual(['U-9'])
    expect(fam.has('H-1')).toBe(false)
    expect(fam.get('C-1')).toEqual(['C-2'])
    expect(fam.has('X-1')).toBe(false)
  })
  test('missingKids: unselected sub-issues of selected rows, once each', () => {
    expect(missingKids(set('E-1', 'S-1', 'X-1'), fam)).toEqual(['T-1', 'S-2'])
    expect(missingKids(set('X-1', 'S-3'), fam)).toEqual([])
  })
  test('setMany takes or drops a set of rows', () => {
    expect([...setMany(set('A-1'), ['A-2', 'A-3'], true)].sort()).toEqual(['A-1', 'A-2', 'A-3'])
    expect([...setMany(set('A-1', 'A-2'), ['A-2', 'A-3'], false)]).toEqual(['A-1'])
  })
})

test('listKey: arrows and j/k move (shift extends), x or space selects, X takes the family, Enter or o opens', () => {
  expect([listKey('j', false), listKey('ArrowDown', false), listKey('k', false), listKey('ArrowUp', false)]).toEqual(['down', 'down', 'up', 'up'])
  expect([listKey('ArrowDown', true), listKey('J', true), listKey('ArrowUp', true)]).toEqual(['extendDown', 'extendDown', 'extendUp'])
  expect([listKey('x', false), listKey(' ', false), listKey('X', true), listKey('Enter', false), listKey('o', false)]).toEqual(['toggle', 'toggle', 'family', 'open', 'open'])
  expect(listKey('c', false)).toBeNull()
})

test('commonProject: the project when every selected issue shares it', () => {
  const p: Record<string, string> = { 'A-1': 'web', 'A-2': 'web', 'B-1': 'app' }
  expect(commonProject(['A-1', 'A-2'], (id) => p[id])).toBe('web')
  expect(commonProject(['A-1', 'B-1'], (id) => p[id])).toBeNull()
  expect(commonProject(['A-1', 'GONE'], (id) => p[id])).toBeNull()
  expect(commonProject([], (id) => p[id])).toBeNull()
})

test('bulkItems carries a parent or a milestone, and null to clear one', () => {
  expect(bulkItems(['A-1'], { parentId: 'E-1' })).toEqual([{ id: 'A-1', parentId: 'E-1' }])
  expect(bulkItems(['A-1'], { milestone: null })).toEqual([{ id: 'A-1', milestone: null }])
})

describe('familyClose: the open sub-issues a closing status takes along', () => {
  const statuses = [
    { name: 'Todo', type: 'unstarted' as const, color: '' }, { name: 'Done', type: 'completed' as const, color: '' },
    { name: 'Shipped', type: 'completed' as const, color: '' }, { name: 'Canceled', type: 'canceled' as const, color: '' },
  ]
  const st = (name: string) => statuses.find((s) => s.name === name)
  // E-1 > A-1 (Todo), A-2 (Done) > A-3 (Todo); B-1 alone
  const issues = [
    { id: 'E-1', parent: null, status: 'Todo' }, { id: 'A-1', parent: 'E-1', status: 'Todo' }, { id: 'A-2', parent: 'E-1', status: 'Done' },
    { id: 'A-3', parent: 'A-2', status: 'Todo' }, { id: 'B-1', parent: null, status: 'Todo' },
  ]
  test('completing a parent needs its open sub-issues at every depth; canceling takes them along', () => {
    expect(familyClose(['E-1'], st('Done'), issues, statuses)).toEqual({ kind: 'complete', kids: ['A-1', 'A-3'] })
    expect(familyClose(['E-1'], st('Canceled'), issues, statuses)).toEqual({ kind: 'cancel', kids: ['A-1', 'A-3'] })
  })
  test('selected sub-issues are not counted twice; leaves and open statuses ask nothing', () => {
    expect(familyClose(['E-1', 'A-1'], st('Done'), issues, statuses)).toEqual({ kind: 'complete', kids: ['A-3'] })
    expect(familyClose(['E-1', 'A-1', 'A-3'], st('Done'), issues, statuses)).toBeNull()
    expect(familyClose(['B-1', 'A-1'], st('Done'), issues, statuses)).toBeNull()
    expect(familyClose(['E-1'], st('Todo'), issues, statuses)).toBeNull()
    expect(familyClose(['E-1'], undefined, issues, statuses)).toBeNull()
  })
  test('a parent that is already completed, or already in that status, asks nothing', () => {
    expect(familyClose(['A-2'], st('Shipped'), issues, statuses)).toBeNull()
    expect(familyClose(['A-2'], st('Canceled'), issues, statuses)).toEqual({ kind: 'cancel', kids: ['A-3'] })
    const canceled = issues.map((i) => (i.id === 'E-1' ? { ...i, status: 'Canceled' } : i))
    expect(familyClose(['E-1'], st('Canceled'), canceled, statuses)).toBeNull()
  })
  test('statusItems sends the sub-issues of a completed parent first, and none for a canceled one', () => {
    expect(statusItems(['E-1'], 'Done', { kind: 'complete', kids: ['A-1'] }, 'Shipped')).toEqual([
      { id: 'A-1', state: 'Done', comment: 'Shipped' }, { id: 'E-1', state: 'Done', comment: 'Shipped' },
    ])
    expect(statusItems(['E-1'], 'Canceled', { kind: 'cancel', kids: ['A-1'] })).toEqual([{ id: 'E-1', state: 'Canceled' }])
    expect(statusItems(['B-1'], 'Done', null)).toEqual([{ id: 'B-1', state: 'Done' }])
  })
})
