import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ThemeOut } from '../../src/engine/themes'
import { appBridge, parseAppSettings, type AppSettingsApi } from '../../ui/appSettings'
import { emptyState, fromSnapshot, type Snapshot } from '../../ui/client'
import { appHref, href, parseRoute } from '../../ui/router'
import {
  agentStatus, APP_GROUPS, backupStatus, engineStatus, LOGIN_KEY, nextSettingsTab, relativeAge, SETTINGS_TABS, type SettingsTab,
} from '../../ui/settingsModel'
import { hiddenCount, settingsProjects, SettingsView, themePreview } from '../../ui/views/Settings'
import { SettingsGear } from '../../ui/views/Sidebar'

const NOW = Date.parse('2026-10-31T12:00:00Z')
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  issues: [], labels: [], views: [], errors: [],
  config: { statuses: [{ name: 'Todo', type: 'unstarted' }, { name: 'Done', type: 'completed' }], hiddenProjects: [] } as unknown as Snapshot['config'],
  projects: [{ slug: 'beta', name: 'Beta' }, { slug: 'alpha', name: 'Alpha', color: 'var(--ok)' }] as Snapshot['projects'],
  ...over,
})
const render = (tab: SettingsTab, app: AppSettingsApi | null = null, s = snap()) =>
  renderToStaticMarkup(createElement(SettingsView, { tab, state: fromSnapshot(s), app, onTab: () => {} }))
const appApi = (values: Record<string, boolean | string> = {}): AppSettingsApi => ({
  state: { values, presets: { openWindowHotKeyPreset: [{ id: 'optCmdI', label: '⌥⌘I' }, { id: 'optCmdT', label: '⌥⌘T' }], quickCaptureHotKeyPreset: [] } },
  error: '', set: () => {}, backupNow: async () => 'ok',
})
const appKeys = () => Object.values(APP_GROUPS).flat().flatMap((g) => g.rows).flatMap((r) => ('key' in r ? [r.key] : []))

describe('the settings route', () => {
  test('#/settings and #/settings/<tab> parse and round-trip', () => {
    expect(parseRoute('#/settings')).toEqual({ name: 'settings' })
    for (const t of SETTINGS_TABS) {
      expect(parseRoute(`#/settings/${t.id}`)).toEqual({ name: 'settings', tab: t.id })
      expect(href({ name: 'settings', tab: t.id })).toBe(`#/settings/${t.id}`)
    }
    expect(href({ name: 'settings' })).toBe('#/settings')
  })
  test('an unknown tab is Not found, not a blank page', () => {
    expect(parseRoute('#/settings/nope').name).toBe('notFound')
    expect(parseRoute('#/settings/general/extra').name).toBe('notFound')
  })
  test('Open in AI Task Tracking takes the settings page to the app', () => {
    expect(appHref({ name: 'settings', tab: 'backup' })).toBe('aitt://settings')
  })
})

describe('the sidebar gear', () => {
  const gear = (active: boolean) => renderToStaticMarkup(createElement(SettingsGear, { active }))
  test('goes to the page, not aitt://', () => expect(gear(false)).toContain('href="#/settings"'))
  test('shows as selected only there', () => {
    expect(gear(true)).toContain('aria-current="page"')
    expect(gear(true)).toContain('active')
    expect(gear(false)).not.toContain('aria-current')
    expect(gear(false)).not.toContain('active')
  })
})

describe('tabs', () => {
  test('every tab is a real tab; only the current one is in the tab order', () => {
    const h = render('notifications')
    expect(h).toContain('role="tablist"')
    expect(h.match(/role="tab"/g)).toHaveLength(6)
    expect(h.match(/tabindex="0"[^>]*>Notifications|aria-selected="true"[^>]*tabindex="0"/)).not.toBeNull()
    expect(h.match(/aria-selected="true"/g)).toHaveLength(1)
    expect(h.match(/tabindex="-1"/g)).toHaveLength(5)
    expect(h).toContain('role="tabpanel"')
    expect(h).toContain('aria-labelledby="settings-tab-notifications"')
  })
  test('arrows wrap, Home and End jump, other keys do nothing', () => {
    expect(nextSettingsTab('general', 'ArrowRight')).toBe('appearance')
    expect(nextSettingsTab('general', 'ArrowLeft')).toBe('backup')
    expect(nextSettingsTab('backup', 'ArrowRight')).toBe('general')
    expect(nextSettingsTab('projects', 'Home')).toBe('general')
    expect(nextSettingsTab('projects', 'End')).toBe('backup')
    expect(nextSettingsTab('projects', 'a')).toBeNull()
  })
})

describe('app-only settings', () => {
  const browserTabs: SettingsTab[] = ['general', 'notifications', 'shortcuts', 'backup']
  test('in a browser: "Only in the app" and no control', () => {
    for (const tab of browserTabs) {
      const h = render(tab)
      expect(h).toContain('Only in the app')
      expect(h).not.toContain('role="switch"')
      expect(h).not.toContain('<select')
      expect(h).not.toContain('settings-btn')
    }
  })
  test('stalled and CI are app-only: nothing but the app stores them, and the app would overrule a browser', () => {
    const h = render('general')
    const row = (label: string) => new RegExp(`${label}.*?</div></div>(.*?)</div>`).exec(h)?.[1] ?? ''
    expect(row('Show stalled work in Needs you')).toContain('Only in the app')
    expect(row('Show CI status')).toContain('Only in the app')
    expect(h).toContain('Home still marks it')
  })
  test('in the app: switches with their values, and shortcut menus from the app', () => {
    const h = render('general', appApi({ [LOGIN_KEY]: true, showInDock: false }))
    expect(h).not.toContain('Only in the app')
    expect(h).toMatch(/role="switch" aria-checked="true" aria-label="Launch at login"/)
    expect(h).toMatch(/role="switch" aria-checked="false" aria-label="Show in the Dock"/)
    const s = render('shortcuts', appApi({ openWindowHotKeyPreset: 'optCmdT' }))
    expect(s).toContain('<select')
    expect(s).toContain('⌥⌘T')
  })
  test('the per-event notification switches are off limits while notifications are off', () => {
    const switchOf = (h: string, label: string) => new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(h)![0]
    const off = render('notifications', appApi({ notifications: false, notifyDone: true }))
    expect(switchOf(off, 'An agent finished an issue')).toContain('disabled')
    expect(switchOf(off, 'Notify me about agent activity')).not.toContain('disabled')
    expect(switchOf(render('notifications', appApi({ notifications: true })), 'An agent finished an issue')).not.toContain('disabled')
  })
  test('the app\'s web view has a bridge; a browser, or a handler that can\'t be called, has none', () => {
    const b = { postMessage: async () => ({}) }
    expect(appBridge({ webkit: { messageHandlers: { aittSettings: b } } })).toBe(b)
    expect(appBridge({})).toBeNull()
    expect(appBridge({ webkit: { messageHandlers: {} } })).toBeNull()
    expect(appBridge({ webkit: { messageHandlers: { aittSettings: {} } } })).toBeNull()
  })
  test('a reply that isn\'t a state is ignored', () => {
    expect(parseAppSettings(null)).toBeNull()
    expect(parseAppSettings({ values: {} })).toBeNull()
    expect(parseAppSettings({ values: { a: true }, presets: {} })).toEqual({ values: { a: true }, presets: {} })
  })
  test('the page\'s keys are exactly what the app\'s bridge accepts', () => {
    const swift = readFileSync(join(import.meta.dir, '../../app/Sources/TrackerCore/SettingsBridge.swift'), 'utf8')
    const list = (name: string) => [...(new RegExp(`${name}: \\[String\\] = \\[([^\\]]*)\\]`).exec(swift)?.[1] ?? '').matchAll(/SettingKey\.(\w+)/g)].map((m) => m[1]!)
    expect(list('boolKeys').length).toBeGreaterThan(5)
    expect([...list('boolKeys'), ...list('presetKeys'), LOGIN_KEY].sort()).toEqual([...appKeys()].sort())
  })
})

describe('Projects tab', () => {
  const state = (hiddenProjects: string[], hidden: { slug: string; name: string }[] = []) => fromSnapshot(snap({
    config: { statuses: [{ name: 'Todo', type: 'unstarted' }, { name: 'Done', type: 'completed' }], hiddenProjects } as unknown as Snapshot['config'],
    hidden: { projects: hidden, issues: [] },
    issues: [
      { id: 'A-1', project: 'alpha', status: 'Todo' }, { id: 'A-2', project: 'alpha', status: 'Done' },
    ] as unknown as Snapshot['issues'],
  }))
  test('every project by name, hidden ones included, then No project; a hidden one claims no count', () => {
    const rows = settingsProjects(state(['gamma', '_none'], [{ slug: 'gamma', name: 'Gamma' }]))
    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Beta', 'Gamma', 'No project'])
    expect(rows.map((r) => r.desc)).toEqual(['1 open', 'No open issues', 'Hidden', 'Issues that have no project.'])
    expect(rows.map((r) => r.hidden)).toEqual([false, false, true, true])
  })
  test('the count ignores a slug that names no project (the engine ignores it too)', () => {
    expect(hiddenCount(settingsProjects(state(['gone'])))).toBe(0)
    expect(hiddenCount(settingsProjects(state(['gamma', '_none'], [{ slug: 'gamma', name: 'Gamma' }])))).toBe(2)
  })
  test('the tab shows the count, only when something is hidden; the switches work in a browser', () => {
    const shown = (h: string) => /settings-tab-count/.test(h)
    expect(shown(render('projects'))).toBe(false)
    const s = snap({ config: { statuses: [], hiddenProjects: ['_none'] } as unknown as Snapshot['config'] })
    const h = render('general', null, s)
    expect(shown(h)).toBe(true)
    expect(h).toContain('aria-label="1 hidden"')
    const p = render('projects')
    expect(p).toMatch(/role="switch" aria-checked="false" aria-label="Hide Alpha"/)
    expect(p).not.toContain('Only in the app')
  })
})

describe('Appearance tab', () => {
  const colors = (panel: string) => ({ panel, accent: 'A', text: 'T' })
  const list = [
    { id: 'graphite', name: 'Graphite', base: 'dark', builtin: true, colors: colors('g'), statuses: {} },
    { id: 'dark', name: 'Dark', base: 'dark', builtin: true, colors: colors('d'), statuses: {} },
    { id: 'light', name: 'Light', base: 'light', builtin: true, colors: colors('l'), statuses: {} },
    { id: 'system', name: 'Match macOS', base: 'system', builtin: true },
    { id: 'ocean', name: 'Ocean', base: 'dark', builtin: false, colors: colors('o'), statuses: {} },
  ] as ThemeOut[]
  test('a card for every theme, Match macOS and theme files included; the current one is marked', () => {
    const h = render('appearance', null, snap({ themes: { selected: 'ocean', effective: 'ocean', list } }))
    expect(h.match(/class="settings-theme[ "]/g)).toHaveLength(5)
    expect(h).toContain('Match macOS')
    expect(h).toContain('Ocean')
    expect(h.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(h).toContain('Ocean<em>Current</em>')
    expect(h).toContain('1 custom theme')
    expect(h).toContain('href="/docs/guides/themes/"')
    expect(h).not.toContain('Only in the app')
  })
  test('Match macOS previews Dark and Light together, from the themes\' own colors', () => {
    expect(themePreview(list[3]!, list)?.background).toBe('linear-gradient(90deg, d 50%, l 50%)')
    expect(themePreview(list[4]!, list)?.background).toBe('o')
    expect(themePreview(list[3]!, [list[3]!])).toBeNull()
  })
  test('before the first snapshot: no empty group', () => {
    expect(renderToStaticMarkup(createElement(SettingsView, { tab: 'appearance', state: emptyState(), app: null, onTab: () => {} }))).toContain('Loading')
  })
})

describe('the status strip says only what is known', () => {
  const age = (ms: number) => new Date(NOW - ms).toISOString()
  test('engine', () => {
    expect(engineStatus({ home: '/data' }, true)).toEqual({ text: 'Running · data in /data', tone: 'ok' })
    expect(engineStatus(null, true).text).toBe('Not reachable')
    expect(engineStatus({ home: '/data' }, false).tone).toBe('danger')
  })
  test('backup, as the app menu says it', () => {
    const line = (git: NonNullable<Parameters<typeof backupStatus>[0]>['git']) => backupStatus({ git }, NOW).text
    expect(line({ pushError: 'x', remote: true })).toBe('Backup error')
    expect(line({ commitError: 'x' })).toBe('Can\'t commit your changes')
    expect(line({ remote: false })).toBe('No GitHub backup (no remote)')
    expect(line({ remote: true, lastPush: age(3 * 60_000) })).toBe('Last backed up 3 min ago')
    expect(line({ remote: true, ahead: 0 })).toBe('Backed up')
    expect(line({ remote: true, ahead: 2 })).toBe('Not backed up yet')
    expect(backupStatus(null, NOW).text).toBe('Status unavailable')
  })
  test('relative ages match the app\'s wording', () => {
    expect(relativeAge(age(5_000), NOW)).toBe('just now')
    expect(relativeAge(age(2 * 3_600_000), NOW)).toBe('2 h ago')
    expect(relativeAge(age(30 * 3_600_000), NOW)).toBe('yesterday')
    expect(relativeAge(age(4 * 86_400_000), NOW)).toBe('4 days ago')
  })
  test('agents: the last recorded write, never "connected"', () => {
    const you = { at: age(1000), actor: { actor: 'you' } }
    const agent = { at: age(5 * 60_000), actor: { actor: 'agent', client: 'codex' } }
    expect(agentStatus([you, agent], NOW).text).toBe('Last write 5 min ago · codex')
    expect(agentStatus([you], NOW).text).toBe('No agent activity yet')
    expect(agentStatus([], NOW).text).not.toMatch(/connected/i)
  })
  test('General shows the strip; other tabs don\'t', () => {
    expect(render('general')).toContain('settings-status')
    expect(render('backup')).not.toContain('settings-status')
  })
})
