import { describe, expect, test } from 'bun:test'
import { allThemes, parseThemeFile } from '../../src/engine/themes'
import { applyEvent, fromSnapshot, type Snapshot } from '../../ui/client'
import { effectiveTheme, themeVars } from '../../ui/theme'
import { makeThemePick, orderGroups, themeCommands } from '../../ui/views/Palette'

const list = allThemes([parseThemeFile('name: Ocean\nbase: light\ncolors:\n  accent: "#0a84ff"\n', 'ocean.yml')])

describe('ui theme', () => {
  test('the chosen theme; Match macOS follows the system; an unknown id falls back to Graphite; no info, nothing', () => {
    expect(effectiveTheme({ selected: 'ocean', list }, true)?.id).toBe('ocean')
    expect(effectiveTheme({ selected: 'system', list }, true)?.id).toBe('dark')
    expect(effectiveTheme({ selected: 'system', list }, false)?.id).toBe('light')
    expect(effectiveTheme({ selected: 'gone', list }, false)?.id).toBe('graphite')
    expect(effectiveTheme({ selected: 'dark', list }, false)?.id).toBe('dark')
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

  test('⌘K: "Theme: <name>" commands for a matching query, the current one marked', () => {
    const info = { selected: 'light', list }
    expect(themeCommands(info, '')).toEqual([])
    expect(themeCommands(info, 'theme').map((t) => t.label)).toEqual(
      ['Theme: Graphite', 'Theme: Dark', 'Theme: Light', 'Theme: Match macOS', 'Theme: Midnight', 'Theme: Plum', 'Theme: Paper', 'Theme: High contrast', 'Theme: Ocean'])
    expect(themeCommands(info, 'light')).toEqual([{ id: 'light', label: 'Theme: Light', current: true }])
    expect(themeCommands(info, 'theme oce')).toEqual([{ id: 'ocean', label: 'Theme: Ocean', current: false }])
    expect(themeCommands(null, 'theme')).toEqual([])
    // A configured id that no longer exists: the theme shown (Dark) is the current one.
    expect(themeCommands({ selected: 'gone', effective: 'dark', list }, 'theme dark')[0]?.current).toBe(true)
  })

  test('⌘K theme pick: one request at a time, and a reply after the bar is gone does nothing', async () => {
    const replies: Array<{ ok: () => void; no: (e: Error) => void }> = []
    const send = (_id: string) => new Promise<void>((ok, no) => { replies.push({ ok, no }) })
    let alive = true
    const log: string[] = []
    const pick = makeThemePick(send, {
      alive: () => alive, pending: (id) => log.push(`pending ${id}`), done: () => log.push('done'), fail: (m) => log.push(`fail ${m}`),
    })
    expect(pick('paper')).toBe(true)
    expect(pick('light')).toBe(false) // ignored while paper is out: no second POST
    expect(replies.length).toBe(1)
    replies[0]!.ok(); await Bun.sleep(0)
    expect(log).toEqual(['pending paper', 'pending null', 'done'])

    log.length = 0
    expect(pick('light')).toBe(true)
    replies[1]!.no(new Error('unknown theme "light"')); await Bun.sleep(0)
    expect(log).toEqual(['pending light', 'pending null', 'fail unknown theme "light"'])

    log.length = 0
    pick('dark')
    alive = false // the bar was closed (and maybe reopened) before the reply
    replies[2]!.ok(); await Bun.sleep(0)
    expect(log).toEqual(['pending dark']) // no done: it would close the new bar
    expect(pick('dark')).toBe(true) // and the next pick isn't blocked
  })

  test('⌘K order: a query starting with "theme" puts themes before issues; otherwise issues lead', () => {
    const g = { issues: ['issue'], themes: ['theme'], actions: ['search'], views: ['view'], projects: ['project'] }
    expect(orderGroups('theme paper', g)).toEqual(['theme', 'issue', 'search', 'view', 'project'])
    expect(orderGroups('  Theme', g)[0]).toBe('theme')
    expect(orderGroups('paper', g)).toEqual(['issue', 'theme', 'search', 'view', 'project'])
  })

  test('the snapshot carries the themes; a meta event (theme changed) asks for a new snapshot', () => {
    const snap: Snapshot = { issues: [], config: null, labels: [], projects: [], views: [], errors: [], themes: { selected: 'light', list } }
    const s = fromSnapshot(snap)
    expect(s.themes?.selected).toBe('light')
    expect(applyEvent(s, { kind: 'meta' }).needsSnapshot).toBe(true)
    expect(fromSnapshot({ ...snap, themes: undefined }).themes).toBeNull() // an older engine
  })
})
