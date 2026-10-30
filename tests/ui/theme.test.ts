import { describe, expect, test } from 'bun:test'
import { allThemes, parseThemeFile } from '../../src/engine/themes'
import { applyEvent, fromSnapshot, type Snapshot } from '../../ui/client'
import { effectiveTheme, themeVars } from '../../ui/theme'

const list = allThemes([parseThemeFile('name: Ocean\nbase: light\ncolors:\n  accent: "#0a84ff"\n', 'ocean.yml')])

describe('ui theme', () => {
  test('the chosen theme; Match macOS follows the system; an unknown id falls back to Dark; no info, nothing', () => {
    expect(effectiveTheme({ selected: 'ocean', list }, true)?.id).toBe('ocean')
    expect(effectiveTheme({ selected: 'system', list }, true)?.id).toBe('dark')
    expect(effectiveTheme({ selected: 'system', list }, false)?.id).toBe('light')
    expect(effectiveTheme({ selected: 'gone', list }, false)?.id).toBe('dark')
    expect(effectiveTheme(null, true)).toBeNull()
  })

  test('vars: every token, plus --status-<type> for overrides', () => {
    const light = effectiveTheme({ selected: 'light', list }, true)!
    const vars = themeVars(light)
    expect(vars['--bg']).toBe('#f4f4f6')
    expect(vars['--status-unstarted']).toBe('#8a9099')
    expect(Object.keys(vars).filter((k) => k.startsWith('--status-')).sort()).toEqual(['--status-backlog', '--status-unstarted'])
    expect(Object.keys(themeVars(effectiveTheme({ selected: 'dark', list }, true)!)).some((k) => k.startsWith('--status-'))).toBe(false)
  })

  test('the snapshot carries the themes; a meta event (theme changed) asks for a new snapshot', () => {
    const snap: Snapshot = { issues: [], config: null, labels: [], projects: [], views: [], errors: [], themes: { selected: 'light', list } }
    const s = fromSnapshot(snap)
    expect(s.themes?.selected).toBe('light')
    expect(applyEvent(s, { kind: 'meta' }).needsSnapshot).toBe(true)
    expect(fromSnapshot({ ...snap, themes: undefined }).themes).toBeNull() // an older engine
  })
})
