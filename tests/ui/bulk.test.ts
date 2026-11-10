import { describe, expect, test } from 'bun:test'
import { asksReason, bulkItems, clickSelect, visibleSelection } from '../../ui/bulk'

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
