/** The Settings page's wiring in a real DOM: the app bridge hook, the tablist's keyboard, messages to the engine. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement, useState, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { appBridge, notifyAppOfTheme, useAppSettings, type AppSettingsApi } from '../../ui/appSettings'
import { fromSnapshot, setProjectHidden, setTheme, type Snapshot } from '../../ui/client'
import type { SettingsTab } from '../../ui/settingsModel'
import { SettingsView } from '../../ui/views/Settings'

const g = globalThis as unknown as Record<string, unknown>
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'fetch', 'webkit', 'IS_REACT_ACT_ENVIRONMENT']
const saved = new Map(GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]))
let createRoot: typeof import('react-dom/client').createRoot
let dom: JSDOM
let root: Root | null = null

const define = (k: string, value: unknown) => Object.defineProperty(g, k, { value, configurable: true, writable: true })

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:7499/#/settings', pretendToBeVisual: true })
  const w = dom.window as unknown as Record<string, unknown> & { addEventListener: unknown; removeEventListener: unknown; dispatchEvent: unknown }
  for (const k of ['HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent']) define(k, w[k])
  define('window', dom.window); define('document', dom.window.document); define('navigator', dom.window.navigator)
  define('addEventListener', dom.window.addEventListener.bind(dom.window))
  define('removeEventListener', dom.window.removeEventListener.bind(dom.window))
  define('dispatchEvent', dom.window.dispatchEvent.bind(dom.window))
  define('IS_REACT_ACT_ENVIRONMENT', true)
  createRoot = (await import('react-dom/client')).createRoot
})

afterEach(async () => {
  if (root) { const r = root; root = null; await act(async () => r.unmount()) }
  delete g.webkit
})

afterAll(() => {
  for (const [k, d] of saved) { if (d) Object.defineProperty(g, k, d); else delete g[k] }
  dom.window.close()
})

const mount = async (node: ReactNode) => {
  const el = dom.window.document.getElementById('root')!
  root = createRoot(el)
  await act(async () => { root!.render(node) })
  return el
}

const STATE = { values: { launchAtLogin: false, showInDock: true }, presets: {} }

/** The app's message handler: records messages, answers with the state. */
function fakeBridge(state: unknown = STATE) {
  const sent: { op: string; key?: string; value?: unknown }[] = []
  const bridge = {
    answer: state,
    postMessage: async (m: { op: string }) => { sent.push(m); return bridge.answer },
  }
  define('webkit', { messageHandlers: { aittSettings: bridge } })
  return { bridge, sent }
}

function Hook({ out }: { out: { api: AppSettingsApi | null } }) {
  out.api = useAppSettings()
  return null
}

describe('useAppSettings', () => {
  test('a browser has no bridge, so no api', async () => {
    const out = { api: {} as AppSettingsApi | null }
    await mount(createElement(Hook, { out }))
    expect(out.api).toBeNull()
  })

  test('asks for the state when it mounts', async () => {
    const { sent } = fakeBridge()
    const out = { api: null as AppSettingsApi | null }
    await mount(createElement(Hook, { out }))
    expect(sent).toEqual([{ op: 'get' }])
    expect(out.api?.state?.values.showInDock).toBe(true)
  })

  test('set sends the key and value, and takes the reply as the new state', async () => {
    const { bridge, sent } = fakeBridge()
    const out = { api: null as AppSettingsApi | null }
    await mount(createElement(Hook, { out }))
    bridge.answer = { values: { showInDock: false }, presets: {} }
    await act(async () => { out.api!.set('showInDock', false) })
    expect(sent.at(-1)).toEqual({ op: 'set', key: 'showInDock', value: false })
    expect(out.api?.state?.values.showInDock).toBe(false)
  })

  test('a refused set shows the error; the state stays', async () => {
    const { bridge } = fakeBridge()
    const out = { api: null as AppSettingsApi | null }
    await mount(createElement(Hook, { out }))
    bridge.postMessage = async () => { throw new Error('unknown setting or invalid value') }
    await act(async () => { out.api!.set('nope', true) })
    expect(out.api?.error).toBe('unknown setting or invalid value')
    expect(out.api?.state?.values.showInDock).toBe(true)
  })

  test('the window coming back into focus asks again (System Settings can change Launch at login)', async () => {
    const { bridge, sent } = fakeBridge()
    const out = { api: null as AppSettingsApi | null }
    await mount(createElement(Hook, { out }))
    bridge.answer = { values: { launchAtLogin: true }, presets: {} }
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event('focus')) })
    expect(sent).toEqual([{ op: 'get' }, { op: 'get' }])
    expect(out.api?.state?.values.launchAtLogin).toBe(true)
  })

  test('a change event from the app updates the state; a malformed one is ignored', async () => {
    fakeBridge()
    const out = { api: null as AppSettingsApi | null }
    await mount(createElement(Hook, { out }))
    await act(async () => { dom.window.dispatchEvent(new dom.window.CustomEvent('aitt:app-settings', { detail: { values: { showInDock: false }, presets: {} } })) })
    expect(out.api?.state?.values.showInDock).toBe(false)
    await act(async () => { dom.window.dispatchEvent(new dom.window.CustomEvent('aitt:app-settings', { detail: 'nonsense' })) })
    expect(out.api?.state?.values.showInDock).toBe(false)
  })

  test('after unmounting it no longer listens', async () => {
    const { sent } = fakeBridge()
    const out = { api: null as AppSettingsApi | null }
    await mount(createElement(Hook, { out }))
    await act(async () => { root!.unmount() })
    root = null
    dom.window.dispatchEvent(new dom.window.Event('focus'))
    expect(sent).toHaveLength(1)
  })

  test('a problem from the app comes through', async () => {
    fakeBridge({ ...STATE, problems: { launchAtLogin: 'Operation not permitted' } })
    const out = { api: null as AppSettingsApi | null }
    await mount(createElement(Hook, { out }))
    expect(out.api?.state?.problems?.launchAtLogin).toBe('Operation not permitted')
  })
})

describe('the tablist\'s keyboard', () => {
  const state = fromSnapshot({ issues: [], labels: [], views: [], errors: [], projects: [], config: { statuses: [], hiddenProjects: [] } as unknown as Snapshot['config'] })
  function Page({ start }: { start: SettingsTab }) {
    const [tab, setTab] = useState<SettingsTab>(start)
    return createElement(SettingsView, { tab, state, app: null, onTab: setTab })
  }
  const press = async (key: string, init: Record<string, boolean> = {}) => {
    const active = dom.window.document.activeElement!
    let notPrevented = true
    await act(async () => { notPrevented = active.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
    return notPrevented
  }
  const focused = () => dom.window.document.activeElement?.id
  const selected = () => dom.window.document.querySelector('[role=tab][aria-selected=true]')?.id
  const start = async (t: SettingsTab) => {
    await mount(createElement(Page, { start: t }))
    await act(async () => { (dom.window.document.getElementById(`settings-tab-${t}`) as unknown as HTMLElement).focus() })
  }

  test('arrows move the selection and the focus together, and wrap', async () => {
    await start('appearance')
    expect(await press('ArrowRight')).toBe(false)
    expect(selected()).toBe('settings-tab-notifications')
    expect(focused()).toBe('settings-tab-notifications')
    await press('ArrowLeft'); await press('ArrowLeft')
    expect(focused()).toBe('settings-tab-general')
  })

  test('Home and End', async () => {
    await start('projects')
    await press('End')
    expect(focused()).toBe('settings-tab-backup')
    await press('ArrowRight')
    expect(selected()).toBe('settings-tab-general')
  })

  test('modified arrows and other keys are left alone', async () => {
    await start('projects')
    expect(await press('ArrowRight', { metaKey: true })).toBe(true)
    expect(await press('ArrowRight', { altKey: true })).toBe(true)
    expect(await press('ArrowRight', { ctrlKey: true })).toBe(true)
    expect(await press('a')).toBe(true)
    expect(selected()).toBe('settings-tab-projects')
  })

  test('only the selected tab is in the tab order after a move', async () => {
    await start('projects')
    await press('ArrowRight')
    const stops = [...dom.window.document.querySelectorAll('[role=tab]')].filter((t) => t.getAttribute('tabindex') === '0').map((t) => t.id)
    expect(stops).toEqual(['settings-tab-shortcuts'])
    expect(dom.window.document.getElementById('settings-panel')?.getAttribute('aria-labelledby')).toBe('settings-tab-shortcuts')
  })
})

describe('messages', () => {
  test('a post with no reply says the engine isn\'t answering, not "Failed to fetch"', async () => {
    define('fetch', async () => { throw new TypeError('Failed to fetch') })
    expect(setTheme('dark')).rejects.toThrow('The engine isn\'t answering')
    expect(setProjectHidden('a', true)).rejects.toThrow('The engine isn\'t answering')
  })
  test('a refusal keeps the engine\'s own words', async () => {
    define('fetch', async () => Response.json({ error: 'no such theme' }, { status: 400 }))
    expect(setTheme('x')).rejects.toThrow('no such theme')
  })
  test('the app hears of a theme change; a browser has nobody to tell; a refusal is harmless', async () => {
    const { sent, bridge } = fakeBridge()
    notifyAppOfTheme(appBridge(globalThis))
    expect(sent).toEqual([{ op: 'themeChanged' }])
    notifyAppOfTheme(null)
    bridge.postMessage = async () => { throw new Error('not allowed') }
    notifyAppOfTheme(appBridge(globalThis))
    await Bun.sleep(0)
  })
})
