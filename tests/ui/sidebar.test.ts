import { describe, expect, test } from 'bun:test'
import { isCollapsed, isSidebarShortcut, loadCollapsed, saveCollapsed, SIDEBAR_KEY, toggled, type SidebarState } from '../../ui/sidebarState'

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, m }
}

describe('collapse persistence', () => {
  test('saved and loaded through storage; nothing saved means expanded', () => {
    const s = memory()
    expect(loadCollapsed(s)).toBe(false)
    saveCollapsed(true, s)
    expect(s.m.get(SIDEBAR_KEY)).toBe('1')
    expect(loadCollapsed(s)).toBe(true)
    saveCollapsed(false, s)
    expect(loadCollapsed(s)).toBe(false)
  })
  test('storage that throws (private mode, blocked) or is missing: expanded, and saving is a no-op', () => {
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(loadCollapsed(broken)).toBe(false)
    expect(() => saveCollapsed(true, broken)).not.toThrow()
    expect(loadCollapsed(null)).toBe(false)
  })
})

describe('toggle and narrow windows', () => {
  const wide = false, narrow = true
  test('wide: the toggle flips the saved preference', () => {
    let s: SidebarState = { saved: false, narrowOpen: false }
    s = toggled(s, wide)
    expect(s).toEqual({ saved: true, narrowOpen: false })
    expect(isCollapsed(s, wide)).toBe(true)
    expect(isCollapsed(toggled(s, wide), wide)).toBe(false)
  })
  test('narrow: collapsed whatever the preference; the toggle opens it without changing the preference', () => {
    const s: SidebarState = { saved: false, narrowOpen: false }
    expect(isCollapsed(s, narrow)).toBe(true)
    const opened = toggled(s, narrow)
    expect(isCollapsed(opened, narrow)).toBe(false)
    expect(opened.saved).toBe(false)
    expect(isCollapsed(opened, wide)).toBe(false) // back to wide: the preference applies
  })
})

describe('shortcut', () => {
  const key = (over: Partial<KeyboardEvent>) => ({ key: '\\', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over })
  test('⌘\\ or Ctrl+\\ only', () => {
    expect(isSidebarShortcut(key({ metaKey: true }))).toBe(true)
    expect(isSidebarShortcut(key({ ctrlKey: true }))).toBe(true)
    expect(isSidebarShortcut(key({}))).toBe(false)
    expect(isSidebarShortcut(key({ metaKey: true, shiftKey: true }))).toBe(false)
    expect(isSidebarShortcut(key({ metaKey: true, altKey: true }))).toBe(false)
    expect(isSidebarShortcut(key({ metaKey: true, key: ']' }))).toBe(false)
  })
})
