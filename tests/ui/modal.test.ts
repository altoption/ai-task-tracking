import { expect, test } from 'bun:test'
import { onBackdrop } from '../../ui/components/Modal'

// A dialog box at (100, 50), 400 x 200. A click on the backdrop targets the dialog element itself.
const dialog = { getBoundingClientRect: () => ({ top: 50, left: 100, width: 400, height: 200 }) } as unknown as Element
const child = {} as EventTarget

test('onBackdrop: only a click on the dialog element outside its box', () => {
  expect(onBackdrop(dialog, dialog, 20, 20)).toBe(true)
  expect(onBackdrop(dialog, dialog, 600, 100)).toBe(true)
  expect(onBackdrop(dialog, dialog, 300, 300)).toBe(true)
  expect(onBackdrop(dialog, dialog, 300, 100)).toBe(false) // the box's own padding
  expect(onBackdrop(dialog, dialog, 100, 50)).toBe(false) // its edge
  expect(onBackdrop(child, dialog, 20, 20)).toBe(false) // something inside it
  expect(onBackdrop(null, dialog, 20, 20)).toBe(false)
})
