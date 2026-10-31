import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rm, writeFile, readFile } from 'node:fs/promises'
import { Store } from '../../src/engine/store'
import { watchFolder } from '../../src/engine/watch'
import { startServer, type RunningServer } from '../../src/server/http'
import { issuePath, miniCopy } from '../engine/helpers'

let root: string
let store: Store
let srv: RunningServer
let watcher: { close(): void }
let base: string

beforeEach(async () => {
  root = await miniCopy()
  store = await Store.open(root, { port: 0 })
  watcher = watchFolder(store)
  srv = startServer(store, { port: 0, version: 'test', git: { status: () => ({ lastCommit: 'x' }) } })
  base = `http://127.0.0.1:${srv.port}`
  await Bun.sleep(200) // let FSEvents replay of the fixture copy settle
})
afterEach(async () => {
  watcher.close()
  await srv.stop()
  await Bun.sleep(100)
  await rm(root, { recursive: true, force: true })
})

const post = (name: string, body: unknown, headers: Record<string, string> = { 'X-Tracker': '1' }) =>
  fetch(`${base}/api/tool/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

/** Open the SSE stream; returns a reader of parsed `data:` events. */
async function sse() {
  const res = await fetch(`${base}/api/events`)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const next = async (pred: (e: any) => boolean, ms = 2000): Promise<any> => {
    const deadline = Date.now() + ms
    for (;;) {
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
        if (!chunk.startsWith('data: ')) continue
        const e = JSON.parse(chunk.slice(6))
        if (pred(e)) return e
      }
      const left = deadline - Date.now()
      if (left <= 0) throw new Error('SSE timeout')
      const r = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)])
      if (!r) throw new Error('SSE timeout')
      if (r.done) throw new Error('SSE closed')
      buf += dec.decode(r.value)
    }
  }
  return { next, close: () => reader.cancel() }
}

describe('http api', () => {
  test('health', async () => {
    const r = await fetch(`${base}/api/health`)
    expect(r.status).toBe(200)
    expect(r.headers.get('access-control-allow-origin')).toBeNull()
    const body: any = await r.json()
    expect(body).toEqual({
      ok: true, version: 'test', home: root, needsYou: expect.any(Number), stalled: [], stalledAll: [], git: { lastCommit: 'x' },
      // What the app's notifications treat as "needs you" and "done" (same rule as the Needs-you list), and the
      // stalled thresholds (the fixture turns idle off; `stalled` above is the engine's result).
      rules: {
        needsYouStatuses: ['Waiting', 'In Review'], needsYouLabels: ['Needs decision', 'Needs review'], doneStatuses: ['Done'],
        stalled: { idleHours: 0, windowDays: 7, reopens: 2, sessions: 3 },
      },
      // For the app's window and Settings popup: the theme shown and each theme's base and background.
      theme: { selected: 'dark', effective: 'dark', themes: expect.arrayContaining([{ id: 'dark', name: 'Dark', base: 'dark', bg: '#101012' }, { id: 'system', name: 'Match macOS', base: 'system' }]) },
      // For the app's Settings ▸ Hidden projects: every project by name, then "No project", and the hidden slugs.
      hiddenProjects: { selected: [], projects: [expect.objectContaining({ slug: expect.any(String) }), expect.anything(), { slug: '_none', name: 'No project' }] },
    })
    const h: any = await (await fetch(`${base}/api/home`)).json()
    expect(body.needsYou).toBe(h.needsYou.length)
  })

  test('health needsYou counts the home Needs-you bucket and follows changes', async () => {
    const count = async () => ((await (await fetch(`${base}/api/health`)).json()) as any).needsYou as number
    const before = await count()
    const target = store.all().find((i) => !['Waiting', 'In Review', 'Done', 'Canceled', 'Duplicate'].includes(i.status))!
    await store.updateIssue(target.id, { status: 'Waiting' }, { actor: 'you' })
    expect(await count()).toBe(before + 1)
  })

  test('stalled work: health lists stalled-only ids, home and needs-you carry the reason', async () => {
    store.config.stalled = { idleHours: 24, windowDays: 7, reopens: 2, sessions: 3 } // Q-1: In Progress since 2026-10-01
    const health: any = await (await fetch(`${base}/api/health`)).json()
    const h: any = await (await fetch(`${base}/api/home`)).json()
    expect(health.stalled).toEqual(['Q-1'])
    expect(health.stalledAll).toEqual(['Q-1'])
    expect(health.needsYou).toBe(h.needsYou.length)
    expect(health.rules.stalled).toEqual({ idleHours: 24, windowDays: 7, reopens: 2, sessions: 3 })
    const q1 = h.needsYou.find((i: any) => i.id === 'Q-1')
    expect(q1.stalled).toMatch(/^idle \d+ d in In Progress$/)
    expect(h.needsYou.find((i: any) => i.id === 'Q-5').stalled).toBeUndefined()
    const rows: any[] = await (await fetch(`${base}/api/needs-you`)).json()
    expect(rows.find((r) => r.id === 'Q-1')).toEqual({ id: 'Q-1', title: expect.any(String), why: 'stalled', updated: expect.any(String), stalled: q1.stalled })
    expect(rows.find((r) => r.id === 'Q-5')).not.toHaveProperty('stalled')
    // ?stalled=0 (the menu with the stalled setting off) leaves stalled-only rows out before the 50-row cut.
    const plain: any[] = await (await fetch(`${base}/api/needs-you?stalled=0`)).json()
    expect(plain.map((r) => r.id)).toEqual(['Q-5'])
    // Waiting and still stalled (churn): in stalledAll, not in the stalled-only list.
    await store.updateIssue('Q-1', { status: 'Waiting' }, { actor: 'you' })
    const after: any = await (await fetch(`${base}/api/health`)).json()
    expect(after.stalled).toEqual([])
  })

  test('health?fresh=1 refreshes git status first', async () => {
    let refreshed = 0
    const git = { status: () => ({ ahead: refreshed }), refresh: async () => { refreshed++; return { ahead: refreshed } } }
    const s2 = startServer(store, { port: 0, version: 'test', git })
    try {
      const h: any = await (await fetch(`http://127.0.0.1:${s2.port}/api/health?fresh=1`)).json()
      expect(h.git).toEqual({ ahead: 1 })
      const plain: any = await (await fetch(`http://127.0.0.1:${s2.port}/api/health`)).json()
      expect(refreshed).toBe(1)
      expect(plain.git).toEqual({ ahead: 1 })
    } finally { await s2.stop() }
  })

  test('POST /api/sync runs git sync (push flag passed through), owner-only, 503 without git', async () => {
    const calls: unknown[] = []
    const git = {
      status: () => ({ pending: false, ahead: 0, remote: false }),
      sync: async (o?: { push?: boolean }) => { calls.push(o); return { ok: false, committed: true, pushed: false, pushError: 'nope' } },
    }
    const s2 = startServer(store, { port: 0, version: 'test', git })
    try {
      const url = `http://127.0.0.1:${s2.port}/api/sync`
      expect((await fetch(url, { method: 'POST' })).status).toBe(403)
      expect(calls).toEqual([])
      const r = await fetch(url, { method: 'POST', headers: { 'X-Tracker': '1' } })
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ ok: false, committed: true, pushed: false, pushError: 'nope' })
      await fetch(url, { method: 'POST', headers: { 'X-Tracker': '1', 'content-type': 'application/json' }, body: JSON.stringify({ push: false }) })
      expect(calls).toEqual([{ push: true }, { push: false }])
      const agent = await fetch(url, { method: 'POST', headers: { 'X-Tracker': '1', 'X-Tracker-Agent': '1' } })
      expect(agent.status).toBe(403)
      expect(calls).toHaveLength(2)
      const h: any = await (await fetch(`http://127.0.0.1:${s2.port}/api/health`)).json()
      expect(h.git).toEqual({ pending: false, ahead: 0, remote: false })
      // The app's quit check: health?fresh=1 awaits git.refresh() when there is one.
      const fresh: any = await (await fetch(`http://127.0.0.1:${s2.port}/api/health?fresh=1`)).json()
      expect(fresh.git).toEqual({ pending: false, ahead: 0, remote: false })
    } finally { await s2.stop() }
    const none = await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'X-Tracker': '1' } }) // `base` has a status-only git
    expect(none.status).toBe(503)
  })

  test('GET /api/needs-you lists the Needs-you bucket with why, light fields only', async () => {
    const open = store.all().filter((i) => !['Waiting', 'In Review', 'Done', 'Canceled', 'Duplicate'].includes(i.status))
    await store.updateIssue(open[0]!.id, { status: 'Waiting' }, { actor: 'you' })
    await store.updateIssue(open[1]!.id, { labels: [...open[1]!.labels, 'Needs review'] }, { actor: 'you' })
    const list: any[] = await (await fetch(`${base}/api/needs-you`)).json()
    const h: any = await (await fetch(`${base}/api/home`)).json()
    expect(list.map((x) => x.id)).toEqual(h.needsYou.map((i: any) => i.id))
    for (const x of list) expect(Object.keys(x).sort()).toEqual(['id', 'title', 'updated', 'why'])
    expect(list.find((x) => x.id === open[0]!.id).why).toBe('Waiting')
    expect(list.find((x) => x.id === open[1]!.id).why).toBe('Needs review')
  })

  test('snapshot has 6 issues as summaries', async () => {
    const s: any = await (await fetch(`${base}/api/snapshot`)).json()
    expect(s.issues).toHaveLength(6)
    const i = s.issues[0]
    for (const k of ['description', 'activity', 'extra', 'path']) expect(k in i).toBe(false)
    expect(typeof i.childCount).toBe('number')
    expect(i.progress).toEqual({ done: expect.any(Number), total: expect.any(Number) })
    expect(Array.isArray(i.blocks)).toBe(true)
    expect(s.config.port).toBe(7477)
    expect(s.labels.length).toBeGreaterThan(0)
    expect(s.projects.length).toBe(2)
    expect(Array.isArray(s.views)).toBe(true)
    expect(Array.isArray(s.errors)).toBe(true)
  })

  test('issue detail, home, feed, search', async () => {
    const d: any = await (await fetch(`${base}/api/issues/Q-1`)).json()
    expect(d.id).toBe('Q-1')
    expect(typeof d.description).toBe('string')
    expect(Array.isArray(d.children)).toBe(true)
    expect(Array.isArray(d.ancestors)).toBe(true)
    expect(Array.isArray(d.blocks)).toBe(true)
    expect(d.path).toBeUndefined()
    expect((await fetch(`${base}/api/issues/Q-999`)).status).toBe(404)
    const bad = await fetch(`${base}/api/issues/%E0%A4%A`)
    expect(bad.status).toBe(400)
    expect(typeof ((await bad.json()) as any).error).toBe('string')
    const h: any = await (await fetch(`${base}/api/home`)).json()
    expect(h).toHaveProperty('needsYou')
    expect(Array.isArray(await (await fetch(`${base}/api/feed?limit=5`)).json())).toBe(true)
    const q = await (await fetch(`${base}/api/search?q=${encodeURIComponent(d.title.split(' ')[0])}`)).json()
    expect(Array.isArray(q)).toBe(true)
  })

  test('summaries list every workspace that wrote to the issue, owner edits keep it', async () => {
    const agent = { 'X-Tracker': '1', 'X-Tracker-Agent': '1' }
    await post('save_comment', { args: { issueId: 'Q-1', body: 'from a' }, ctx: { actor: { actor: 'agent', workspace: 'ws-a' } } }, agent)
    await post('save_comment', { args: { issueId: 'Q-1', body: 'from b' }, ctx: { actor: { actor: 'agent', workspace: 'ws-b' } } }, agent)
    await post('set_plan', { args: { id: 'Q-1', plan: 'later' } }) // owner edit: touchedBy becomes `you`
    const s: any = await (await fetch(`${base}/api/snapshot`)).json()
    expect(s.issues.find((i: any) => i.id === 'Q-1').workspaces).toEqual(expect.arrayContaining(['ws-a', 'ws-b']))
    expect(s.issues.find((i: any) => i.id === 'Q-2').workspaces).toEqual([])
    const h: any = await (await fetch(`${base}/api/home`)).json()
    const all = [...h.needsYou, ...h.inProgress, ...h.readyNext.map((x: any) => x.issue), ...h.blocked.map((x: any) => x.issue)]
    expect(all.every((i: any) => Array.isArray(i.workspaces) && !('activity' in i))).toBe(true)
  })

  test('feed filters by id', async () => {
    await post('save_comment', { args: { issueId: 'Q-1', body: 'hello' } })
    await post('save_comment', { args: { issueId: 'Q-2', body: 'other' } })
    const f = (await (await fetch(`${base}/api/feed?id=Q-1`)).json()) as any[]
    expect(f.length).toBeGreaterThan(0)
    expect(f.every((e) => e.id === 'Q-1')).toBe(true)
  })

  test('tool call creates issue and SSE delivers it in < 200 ms', async () => {
    const c = await sse()
    const t0 = performance.now()
    const r = await post('save_issue', { args: { title: 'From http', project: 'support', labels: ['Feature'] } })
    expect(r.status).toBe(200)
    const out: any = await r.json()
    const ev = await c.next((e) => e.kind === 'issue' && e.issue.title === 'From http')
    const ms = performance.now() - t0
    console.log(`tool->SSE latency: ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(200)
    expect(ev.issue.id).toBe(out.id)
    expect('description' in ev.issue).toBe(false)
    expect(typeof ev.issue.childCount).toBe('number')
    await c.next((e) => e.kind === 'feed' && e.event.id === out.id)
    await c.close()
  })

  test('ToolError -> 400 with message', async () => {
    const r = await post('save_issue', { args: { project: 'support' } })
    expect(r.status).toBe(400)
    expect(typeof ((await r.json()) as any).error).toBe('string')
  })

  test('unknown tool -> 404', async () => {
    const r = await post('nope', {})
    expect(r.status).toBe(404)
    expect(typeof ((await r.json()) as any).error).toBe('string')
  })

  test('POST without X-Tracker -> 403', async () => {
    const r = await post('save_issue', { args: { title: 'x', project: 'support' } }, {})
    expect(r.status).toBe(403)
    expect(store.all().length).toBe(6)
  })

  test('wrong Host -> 403', async () => {
    const r = await fetch(`${base}/api/health`, { headers: { Host: 'evil.example.com' } })
    expect(r.status).toBe(403)
    const ok = await fetch(`http://localhost:${srv.port}/api/health`)
    expect(ok.status).toBe(200)
  })

  test('UI ctx cannot claim agent; agent header can', async () => {
    const ctx = { actor: { actor: 'agent', workspace: 'w' } }
    const r = await post('save_comment', { args: { issueId: 'Q-1', body: 'ui says agent' }, ctx })
    expect(r.status).toBe(200)
    const last = store.get('Q-1')!.activity.at(-1)!
    expect(last.body).toContain('ui says agent')
    expect(last.actor).toBe('you')
    const r2 = await post('save_comment', { args: { issueId: 'Q-1', body: 'real agent' }, ctx }, { 'X-Tracker': '1', 'X-Tracker-Agent': '1' })
    expect(r2.status).toBe(200)
    const last2 = store.get('Q-1')!.activity.at(-1)!
    expect(last2.actor).toBe('agent')
    expect(last2.workspace).toBe('w')
    const r3 = await post('save_comment', { args: { issueId: 'Q-1', body: 'x' }, ctx: { actor: { actor: 'you' } } }, { 'X-Tracker': '1', 'X-Tracker-Agent': '1' })
    expect(r3.status).toBe(400)
  })

  test('external file edit reaches SSE', async () => {
    const c = await sse()
    const p = issuePath(root, 'acme-app', 'Q-1')
    const text = await readFile(p, 'utf8')
    await writeFile(p, text.replace(/^title: .*$/m, 'title: Edited outside'))
    const ev = await c.next((e) => e.kind === 'issue' && e.issue.id === 'Q-1', 3000)
    expect(ev.issue.title).toBe('Edited outside')
    await c.close()
  })

  test('unsubscribes from the store when the client disconnects', async () => {
    const before = (store as any).listeners.size
    const c = await sse()
    await Bun.sleep(50)
    expect((store as any).listeners.size).toBe(before + 1)
    await c.close()
    await Bun.sleep(100)
    expect((store as any).listeners.size).toBe(before)
  })

  test('serves a placeholder page at / and 404 for unknown asset, no traversal', async () => {
    const r = await fetch(`${base}/`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
    expect((await fetch(`${base}/nope.js`)).status).toBe(404)
    const t = await fetch(`${base}/..%2f..%2fpackage.json`)
    expect(t.status).not.toBe(200)
  })

  test('serves project files at /files/<slug>/<name>, sandboxed, with no way out of files/', async () => {
    const { mkdir, symlink } = await import('node:fs/promises')
    const dir = `${root}/projects/support/files`
    await mkdir(dir, { recursive: true })
    await writeFile(`${dir}/shot one.png`, 'PNGDATA')
    await writeFile(`${dir}/.hidden`, 'x')
    await symlink(`${root}/config.yml`, `${dir}/link.yml`)
    const r = await fetch(`${base}/files/support/shot%20one.png`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(r.headers.get('content-security-policy')).toContain('sandbox')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await r.text()).toBe('PNGDATA')
    const bad = ['/files/support/..%2f..%2fconfig.yml', '/files/..%2f..%2f/config.yml', '/files/support/.hidden', '/files/support/link.yml',
      '/files/..%2fsupport%2ffiles/shot%20one.png', '/files/support/nope.png', '/files/support/%E0%A4%A']
    const statuses = await Promise.all(bad.map(async (p) => [p, (await fetch(`${base}${p}`)).status] as const))
    for (const [p, s] of statuses) expect(`${p} → ${s}`).toMatch(/→ 4\d\d$/)
  })
})
