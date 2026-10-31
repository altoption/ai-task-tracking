import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hiddenHealth, visibleParts } from '../../src/engine/hidden'
import { Store, type ChangeEvent } from '../../src/engine/store'
import { readConfig } from '../../src/store/metaFiles'
import { callTool } from '../../src/tools/handlers'
import { startServer, wireEvent, type RunningServer } from '../../src/server/http'
import { miniCopy } from '../engine/helpers'

// The fixture: acme-app holds Q-1..Q-4, support holds Q-5 (Waiting, Needs you) and Q-6 (Done). Labels
// Scope/Support and Env/Prod occur only in support; config maps workspace web-app to support.

let root: string, store: Store, srv: RunningServer, base: string, events: ChangeEvent[]
beforeEach(async () => {
  root = await miniCopy()
  store = await Store.open(root, { port: 0 })
  events = []
  store.on((e) => events.push(e))
  srv = startServer(store, { port: 0, version: 'test', git: { status: () => ({ lastCommit: 'x' }) } })
  base = `http://127.0.0.1:${srv.port}`
})
afterEach(async () => {
  await srv.stop()
  await Bun.sleep(50)
  await rm(root, { recursive: true, force: true })
})

const get = async (path: string) => (await fetch(`${base}${path}`)).json() as Promise<any>
const hide = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/hidden-projects`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Tracker': '1', ...headers }, body: JSON.stringify(body) })
const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort()

describe('config.yml hiddenProjects', () => {
  test('defaults to [] and is not written until set; round-trips; junk is dropped', async () => {
    expect(store.config.hiddenProjects).toEqual([])
    await store.setProjectHidden('support', true)
    expect(await readFile(join(root, 'config.yml'), 'utf8')).toMatch(/^hiddenProjects:\n {2}- support$/m)
    expect((await readConfig(root)).hiddenProjects).toEqual(['support'])
    await store.setProjectHidden('support', false)
    expect((await readConfig(root)).hiddenProjects).toEqual([])
    const text = await readFile(join(root, 'config.yml'), 'utf8')
    await writeFile(join(root, 'config.yml'), `${text.replace(/^hiddenProjects:.*$/m, '')}\nhiddenProjects: [" support ", support, 3, "", gone]\n`)
    expect((await readConfig(root)).hiddenProjects).toEqual(['support', 'gone'])
    await writeFile(join(root, 'config.yml'), `${text.replace(/^hiddenProjects:.*$/m, '')}\nhiddenProjects: support\n`)
    expect((await readConfig(root)).hiddenProjects).toEqual([])
  })

  test('setProjectHidden: unknown projects are refused when hiding, unhiding any slug clears it, _none can be hidden', async () => {
    await expect(store.setProjectHidden('nope', true)).rejects.toThrow(/unknown project "nope"/)
    await store.setProjectHidden('_none', true)
    expect(store.config.hiddenProjects).toEqual(['_none'])
    store.config.hiddenProjects = ['_none', 'gone']
    await store.setProjectHidden('gone', false)
    expect(store.config.hiddenProjects).toEqual(['_none'])
    const metas = events.filter((e) => e.kind === 'meta').length
    await store.setProjectHidden('_none', true) // no change: no write, no event
    expect(events.filter((e) => e.kind === 'meta').length).toBe(metas)
  })
})

describe('the engine filter (visibleParts)', () => {
  test('nothing hidden: everything, the same objects', () => {
    const v = visibleParts(store)
    expect(v.issues.length).toBe(6)
    expect(v.labels).toBe(store.labels)
    expect(v.workspaces).toBe(store.config.workspaces)
    expect(v.hiddenIds).toEqual([])
  })

  test('hiding support drops its issues, the project, labels only it uses and the workspace mapped to it', () => {
    store.config.hiddenProjects = ['support', 'not-a-project']
    const v = visibleParts(store)
    expect(ids(v.issues)).toEqual(['Q-1', 'Q-2', 'Q-3', 'Q-4'])
    expect(v.hiddenIds.sort()).toEqual(['Q-5', 'Q-6'])
    expect(v.projects.map((p) => p.slug)).not.toContain('support')
    expect(v.projects.map((p) => p.slug)).toContain('acme-app')
    const names = v.labels.map((l) => l.name)
    expect(names).not.toContain('Scope/Support')
    expect(names).not.toContain('Env/Prod')
    expect(names).not.toContain('Bug') // Q-5 and Q-6 only: it occurs only in the hidden project
    expect(names).toContain('Env/Staging') // used nowhere: still listed
    expect(names).toContain('Feature')
    expect(v.workspaces).toEqual({})
  })

  test('a label also used by a visible issue stays', () => {
    store.config.hiddenProjects = ['acme-app']
    const names = visibleParts(store).labels.map((l) => l.name)
    expect(names).not.toContain('Scope/Assistant')
    expect(names).not.toContain('Feature') // Q-1 and Q-4 only
    expect(names).toContain('Bug') // Q-5
  })
})

describe('UI endpoints leave hidden projects out', () => {
  beforeEach(async () => { await store.setProjectHidden('support', true) })

  test('snapshot', async () => {
    const snap = await get('/api/snapshot')
    expect(ids(snap.issues)).toEqual(['Q-1', 'Q-2', 'Q-3', 'Q-4'])
    expect(snap.projects.map((p: any) => p.slug)).not.toContain('support')
    expect(snap.labels.map((l: any) => l.name)).not.toContain('Scope/Support')
    expect(snap.config.workspaces).toEqual({})
    expect(snap.config.hiddenProjects).toEqual(['support'])
    expect(snap.hidden).toEqual({ projects: [{ slug: 'support', name: expect.any(String) }], issues: expect.arrayContaining(['Q-5', 'Q-6']) })
    expect(JSON.stringify(snap.issues)).not.toContain('Q-5')
  })

  test('home, needs-you, health', async () => {
    const h = await get('/api/home')
    const all = [...h.needsYou, ...h.inProgress, ...h.readyNext.map((x: any) => x.issue), ...h.blocked.map((x: any) => x.issue)]
    expect(all.some((i: any) => i.project === 'support')).toBe(false)
    expect((await get('/api/needs-you')).map((r: any) => r.id)).not.toContain('Q-5')
    const health = await get('/api/health')
    expect(health.needsYou).toBe(h.needsYou.length)
    expect(health.hiddenProjects).toEqual(hiddenHealth(store))
    expect(health.hiddenProjects.selected).toEqual(['support'])
    expect(health.hiddenProjects.projects.map((p: any) => p.slug)).toEqual(expect.arrayContaining(['support', 'acme-app', '_none']))
    expect(health.hiddenProjects.projects.at(-1)).toEqual({ slug: '_none', name: 'No project' })
  })

  test('stalled ids in health leave hidden projects out', async () => {
    store.config.stalled = { idleHours: 24, windowDays: 7, reopens: 2, sessions: 3 } // Q-1 stalls
    expect((await get('/api/health')).stalledAll).toEqual(['Q-1'])
    await store.setProjectHidden('acme-app', true)
    const health = await get('/api/health')
    expect(health.stalledAll).toEqual([])
    expect(health.needsYou).toBe(0)
    expect(await get('/api/needs-you')).toEqual([])
  })

  test('search: hidden hits are dropped, an exact id still finds its issue', async () => {
    expect(ids(await get('/api/search?q=warranty'))).toEqual([])
    expect(ids(await get('/api/search?q=q-5'))).toEqual(['Q-5'])
    expect(ids(await get('/api/search?q=Q-5'))).toEqual(['Q-5'])
  })

  test('feed: the general feed leaves hidden issues out; one issue\'s history still answers', async () => {
    await store.updateIssue('Q-5', { status: 'Todo' }, { actor: 'you' })
    await store.updateIssue('Q-2', { status: 'In Progress' }, { actor: 'you' })
    await Bun.sleep(50)
    const feed = await get('/api/feed?limit=50')
    expect(feed.map((e: any) => e.id)).toContain('Q-2')
    expect(feed.map((e: any) => e.id)).not.toContain('Q-5')
    expect((await get('/api/feed?id=Q-5')).length).toBeGreaterThan(0)
  })

  test('direct reads: an issue and a project by id', async () => {
    const i = await get('/api/issues/Q-5')
    expect(i.id).toBe('Q-5')
    expect(i.project).toBe('support')
    const p = await get('/api/projects/support')
    expect(p.hidden).toBe(true)
    expect(p.project.slug).toBe('support')
    expect(ids(p.issues)).toEqual(['Q-5', 'Q-6'])
    expect((await get('/api/projects/acme-app')).hidden).toBe(false)
    expect((await fetch(`${base}/api/projects/nope`)).status).toBe(404)
  })

  test('the event stream: hidden issues go out as { kind: hidden } only; CI changes leave them out', () => {
    const q5 = store.get('Q-5')!, q2 = store.get('Q-2')!
    const actor = { actor: 'agent' as const }
    expect(wireEvent(store, { kind: 'issue', issue: q5, prev: q5, actor })).toEqual({ kind: 'hidden', id: 'Q-5', project: 'support' })
    expect((wireEvent(store, { kind: 'issue', issue: q2, actor }) as any).issue.id).toBe('Q-2')
    // Moved out of a hidden project: a normal event, so the UI adds it.
    expect((wireEvent(store, { kind: 'issue', issue: q2, prev: { ...q2, project: 'support' }, actor }) as any).kind).toBe('issue')
    expect(wireEvent(store, { kind: 'feed', event: { at: 'x', actor, id: 'Q-5', kind: 'status' } })).toEqual({ kind: 'hidden', id: 'Q-5', project: 'support' })
    expect((wireEvent(store, { kind: 'feed', event: { at: 'x', actor, id: 'Q-2', kind: 'status' } }) as any).kind).toBe('feed')
    expect(wireEvent(store, { kind: 'ci', changes: { 'Q-5': null } })).toBeNull()
    expect(wireEvent(store, { kind: 'ci', changes: { 'Q-5': null, 'Q-2': null } })).toEqual({ kind: 'ci', changes: { 'Q-2': null } })
  })

  test('the live stream over HTTP carries no hidden summary (what the app\'s notifications read)', async () => {
    const res = await fetch(`${base}/api/events`)
    const reader = res.body!.getReader()
    await store.updateIssue('Q-5', { title: 'Secret title' }, { actor: 'agent', workspace: 'w' })
    await store.updateIssue('Q-2', { title: 'Visible title' }, { actor: 'agent', workspace: 'w' })
    let buf = ''
    const dec = new TextDecoder()
    while (!buf.includes('Visible title')) buf += dec.decode((await reader.read()).value)
    await reader.cancel()
    expect(buf).not.toContain('Secret title')
    expect(buf).toContain('"kind":"hidden","id":"Q-5"')
  })

  test('unhiding restores everything (the meta event makes clients refetch)', async () => {
    const r = await hide({ project: 'support', hidden: false })
    expect(r.status).toBe(200)
    expect(events.some((e) => e.kind === 'meta')).toBe(true)
    expect(ids((await get('/api/snapshot')).issues)).toHaveLength(6)
    expect((await get('/api/needs-you')).map((r: any) => r.id)).toContain('Q-5')
  })
})

describe('POST /api/hidden-projects', () => {
  test('hides and unhides one project, writes config.yml and answers with the health shape', async () => {
    const r = await hide({ project: 'support', hidden: true })
    expect(r.status).toBe(200)
    const body: any = await r.json()
    expect(body.selected).toEqual(['support'])
    expect(body.projects.some((p: any) => p.slug === 'support')).toBe(true)
    expect(await readFile(join(root, 'config.yml'), 'utf8')).toMatch(/^hiddenProjects:/m)
    expect((await Store.open(root, { port: 0 })).config.hiddenProjects).toEqual(['support'])
    expect((await hide({ project: '_none', hidden: true })).status).toBe(200)
    expect(store.config.hiddenProjects).toEqual(['support', '_none'])
    expect(((await (await hide({ project: 'support', hidden: false })).json()) as any).selected).toEqual(['_none'])
  })

  test('protections: agents, a missing X-Tracker header and a foreign Host are refused', async () => {
    expect((await hide({ project: 'support', hidden: true }, { 'x-tracker-agent': '1' })).status).toBe(403)
    const noHeader = await fetch(`${base}/api/hidden-projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'support', hidden: true }) })
    expect(noHeader.status).toBe(403)
    const res = await new Promise<number>((resolve, reject) => {
      // fetch() won't send a custom Host; a raw request does.
      const http = require('node:http') as typeof import('node:http')
      const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/hidden-projects', method: 'POST', headers: { host: 'evil.example', 'x-tracker': '1', 'content-type': 'application/json' } }, (r) => { r.resume(); resolve(r.statusCode!) })
      req.on('error', reject)
      req.end(JSON.stringify({ project: 'support', hidden: true }))
    })
    expect(res).toBe(403)
    expect(store.config.hiddenProjects).toEqual([])
  })

  test('validation: body shape, slug form and unknown projects', async () => {
    for (const body of [{}, { project: 'support' }, { project: 'support', hidden: 'yes' }, { project: '', hidden: true }, { project: '../x', hidden: true }, { project: 3, hidden: true }]) {
      expect((await hide(body)).status).toBe(400)
    }
    const bad = await fetch(`${base}/api/hidden-projects`, { method: 'POST', headers: { 'X-Tracker': '1' }, body: 'not json' })
    expect(bad.status).toBe(400)
    const unknown = await hide({ project: 'nope', hidden: true })
    expect(unknown.status).toBe(400)
    expect(((await unknown.json()) as any).error).toMatch(/unknown project "nope"/)
    expect((await hide({ project: 'nope', hidden: false })).status).toBe(200) // unhiding a stale slug is fine
    expect(store.config.hiddenProjects).toEqual([])
  })
})

describe('agents see no change', () => {
  test('tool results (as MCP and /api/tool get them) are identical with a project hidden', async () => {
    const calls: [string, Record<string, unknown>][] = [
      ['list_issues', { includeArchived: true }], ['list_issues', { project: 'support' }], ['search', { query: 'warranty' }],
      ['get_issue', { id: 'Q-5' }], ['whats_next', {}], ['list_projects', {}], ['get_project', { query: 'support' }],
      ['list_issue_labels', {}],
    ]
    const run = async () => Promise.all(calls.map(([n, a]) => callTool(store, n, a, { actor: { actor: 'agent', workspace: 'w' } })))
    const viaHttp = async () => Promise.all(calls.map(async ([n, a]) => (await fetch(`${base}/api/tool/${n}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Tracker': '1' }, body: JSON.stringify({ args: a }),
    })).json()))
    const before = JSON.stringify(await run()), beforeHttp = JSON.stringify(await viaHttp())
    await store.setProjectHidden('support', true)
    expect(JSON.stringify(await run())).toBe(before)
    expect(JSON.stringify(await viaHttp())).toBe(beforeHttp)
    const listed: any = await callTool(store, 'list_issues', { project: 'support', includeArchived: true }, { actor: { actor: 'agent' } })
    expect(ids(listed.issues)).toEqual(['Q-5', 'Q-6'])
  })
})
