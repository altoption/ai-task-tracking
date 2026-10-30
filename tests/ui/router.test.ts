import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { appHref, HISTORY_MAX_KEY, historyPosition, href, inTrackerApp, navigate, parseRoute, replaceRoute, trackHistory, untrackHistory } from '../../ui/router'

describe('parseRoute', () => {
  test('every route in the brief', () => {
    expect(parseRoute('')).toEqual({ name: 'home' })
    expect(parseRoute('#/')).toEqual({ name: 'home' })
    expect(parseRoute('#/new')).toEqual({ name: 'new' })
    expect(parseRoute('#/new?parent=q-269')).toEqual({ name: 'new', parent: 'Q-269' })
    expect(parseRoute('#/issue/q-269')).toEqual({ name: 'issue', id: 'Q-269' })
    expect(parseRoute('#/issues')).toEqual({ name: 'issues' })
    expect(parseRoute('#/view/acme-app')).toEqual({ name: 'view', slug: 'acme-app' })
    expect(parseRoute('#/project/support')).toEqual({ name: 'project', slug: 'support' })
    expect(parseRoute('#/search?q=docs%20quote')).toEqual({ name: 'search', q: 'docs quote' })
    expect(parseRoute('#/search')).toEqual({ name: 'search', q: '' })
    expect(parseRoute('#/nope/a/b')).toEqual({ name: 'notFound', path: '/nope/a/b' })
    expect(parseRoute('#/issues?v=1&layout=board')).toEqual({ name: 'issues', query: 'v=1&layout=board' })
    expect(parseRoute('#/view/acme-app?v=1')).toEqual({ name: 'view', slug: 'acme-app', query: 'v=1' })
    expect(parseRoute('#/project/support?v=1')).toEqual({ name: 'project', slug: 'support', query: 'v=1' })
  })
  test('href round-trips', () => {
    for (const h of ['#/', '#/new', '#/new?parent=Q-269', '#/issue/Q-1', '#/issues', '#/view/a%20b', '#/project/cdp', '#/search?q=a%20b', '#/issues?v=1&layout=board', '#/view/x?v=1&group=priority']) {
      expect(href(parseRoute(h))).toBe(h)
    }
  })
})

describe('app links', () => {
  test('appHref maps issue, project and new; everything else opens home', () => {
    expect(appHref({ name: 'issue', id: 'Q-12' })).toBe('aitt://issue/Q-12')
    expect(appHref({ name: 'project', slug: 'a b', query: 'v=1' })).toBe('aitt://project/a%20b')
    expect(appHref({ name: 'new' })).toBe('aitt://new')
    expect(appHref({ name: 'issues' })).toBe('aitt://home')
    expect(appHref({ name: 'home' })).toBe('aitt://home')
  })
  test('inTrackerApp detects the app web view by its user-agent suffix', () => {
    expect(inTrackerApp('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) TrackerApp/1')).toBe(true)
    expect(inTrackerApp('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15')).toBe(false)
  })
})

describe('history', () => {
  test('navigate adds a history entry; replaceRoute (view-option tweaks) does not', () => {
    const dom = new JSDOM('', { url: 'http://127.0.0.1:7477/#/' })
    const g = globalThis as Record<string, unknown>
    const keys = ['location', 'history', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'HashChangeEvent'] as const
    const saved = keys.map((k) => [k, g[k]] as const)
    const w = dom.window as unknown as Record<string, unknown>
    for (const k of keys) g[k] = typeof w[k] === 'function' && k !== 'HashChangeEvent' ? (w[k] as Function).bind(dom.window) : w[k]
    try {
      const start = dom.window.history.length
      navigate({ name: 'issue', id: 'Q-1' })
      navigate({ name: 'issues' })
      expect(dom.window.history.length).toBe(start + 2)
      let changes = 0
      dom.window.addEventListener('hashchange', () => changes++)
      replaceRoute({ name: 'issues', query: 'layout=board' })
      replaceRoute({ name: 'issues', query: 'layout=list' })
      expect(dom.window.history.length).toBe(start + 2)
      expect(dom.window.location.hash).toBe('#/issues?layout=list')
      expect(changes).toBe(2)
    } finally {
      for (const [k, v] of saved) g[k] = v
      dom.window.close()
    }
  })
})

/** Runs `f` with jsdom's window standing in for the browser globals the router uses. */
async function withDom(url: string, f: (w: JSDOM['window']) => Promise<void> | void, dom = new JSDOM('', { url })): Promise<void> {
  const g = globalThis as Record<string, unknown>
  const keys = ['location', 'history', 'sessionStorage', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'HashChangeEvent'] as const
  const saved = keys.map((k) => [k, g[k]] as const)
  const w = dom.window as unknown as Record<string, unknown>
  for (const k of keys) g[k] = typeof w[k] === 'function' && k !== 'HashChangeEvent' ? (w[k] as Function).bind(dom.window) : w[k]
  try {
    await f(dom.window)
  } finally {
    untrackHistory()
    for (const [k, v] of saved) g[k] = v
  }
}
/** history.back()/forward() and hash navigation finish in a later task. */
const settle = () => new Promise((r) => setTimeout(r, 20))
const can = () => ({ back: historyPosition().index > 0, forward: historyPosition().index < historyPosition().max })

describe('history position (Back / Forward enabled)', () => {
  test('new entries, back, forward, and a new entry after going back', async () => {
    await withDom('http://127.0.0.1:7477/#/', async (w) => {
      trackHistory()
      expect(can()).toEqual({ back: false, forward: false })
      navigate({ name: 'issues' }); await settle()
      navigate({ name: 'issue', id: 'Q-1' }); await settle()
      expect(historyPosition()).toEqual({ index: 2, max: 2 })
      expect(can()).toEqual({ back: true, forward: false })
      w.history.back(); await settle()
      expect(w.location.hash).toBe('#/issues')
      expect(can()).toEqual({ back: true, forward: true })
      w.history.back(); await settle()
      expect(can()).toEqual({ back: false, forward: true })
      w.history.forward(); await settle()
      expect(historyPosition()).toEqual({ index: 1, max: 2 })
      navigate({ name: 'project', slug: 'web' }); await settle() // drops Q-1 from history
      expect(historyPosition()).toEqual({ index: 2, max: 2 })
      expect(can()).toEqual({ back: true, forward: false })
    })
  })

  test('replaceRoute keeps the entry\'s index and adds none', async () => {
    await withDom('http://127.0.0.1:7477/#/', async (w) => {
      trackHistory()
      navigate({ name: 'issues' }); await settle()
      replaceRoute({ name: 'issues', query: 'layout=board' })
      replaceRoute({ name: 'issues', query: 'layout=list' })
      await settle()
      expect(historyPosition()).toEqual({ index: 1, max: 1 })
      w.history.back(); await settle()
      expect(w.location.hash).toBe('#/')
      expect(can()).toEqual({ back: false, forward: true })
      w.history.forward(); await settle()
      expect(w.location.hash).toBe('#/issues?layout=list')
      expect(historyPosition()).toEqual({ index: 1, max: 1 })
    })
  })

  test('a reload keeps the index from history.state and Forward from sessionStorage', async () => {
    const dom = new JSDOM('', { url: 'http://127.0.0.1:7477/#/' })
    await withDom('', async (w) => {
      trackHistory()
      navigate({ name: 'issues' }); await settle()
      navigate({ name: 'search', q: 'x' }); await settle()
      w.history.back(); await settle()
      expect(w.sessionStorage.getItem(HISTORY_MAX_KEY)).toBe('2')
      untrackHistory() // the page reloads: module state is gone, history.state and sessionStorage are not
      trackHistory()
      expect(historyPosition()).toEqual({ index: 1, max: 2 })
    }, dom)
  })

  test('a fresh page resets a stale saved max, so Forward stays off after a reload', async () => {
    const dom = new JSDOM('', { url: 'http://127.0.0.1:7477/#/' })
    dom.window.sessionStorage.setItem(HISTORY_MAX_KEY, '5') // left by an earlier page in this tab
    await withDom('', () => {
      trackHistory()
      expect(historyPosition()).toEqual({ index: 0, max: 0 })
      expect(dom.window.sessionStorage.getItem(HISTORY_MAX_KEY)).toBe('0')
      untrackHistory() // ⌘R
      trackHistory()
      expect(historyPosition()).toEqual({ index: 0, max: 0 })
    }, dom)
  })

  test('a fresh page with no index starts at 0 (Back would leave the app)', async () => {
    await withDom('http://127.0.0.1:7477/#/issue/Q-9', () => {
      trackHistory()
      expect(historyPosition()).toEqual({ index: 0, max: 0 })
      expect((history.state as { aittIndex: number }).aittIndex).toBe(0)
    })
  })
})
