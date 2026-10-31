import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { Store } from '../../src/engine/store'
import { startServer, type RunningServer } from '../../src/server/http'
import type { IssueSummary } from '../../src/model'
import { applyEvent, emptyState, fromSnapshot, inScope, isHiddenProject, listedProjects, projectName, type Snapshot, type WireEvent } from '../../ui/client'
import { miniCopy } from '../engine/helpers'

const YOU = { actor: 'you' as const }
const EXTERNAL = { actor: 'you' as const, workspace: 'external' }

function summary(id: string, over: Partial<IssueSummary> = {}): IssueSummary {
  return {
    id, title: `Issue ${id}`, status: 'Todo', priority: 0, labels: [], parent: null, blockedBy: [], related: [],
    milestone: null, due: null, plan: null, links: [], created: '2026-10-28T00:00:00Z', updated: '2026-10-28T00:00:00Z',
    project: 'p', childCount: 0, progress: { done: 0, total: 0 }, blocks: [], workspaces: [], ...over,
  }
}
const snap = (issues: IssueSummary[]): Snapshot => ({ issues, config: null, labels: [], projects: [], views: [], errors: [] })

describe('applyEvent (pure reducer)', () => {
  test('client applies snapshot then SSE issue event', () => {
    const s0 = fromSnapshot(snap([summary('Q-1'), summary('Q-2')]))
    expect(s0.ready).toBe(true)
    expect(s0.issues.size).toBe(2)

    // An event for an existing id replaces the summary (and leaves the input state untouched).
    const s1 = applyEvent(s0, { kind: 'issue', issue: summary('Q-1', { title: 'Renamed', status: 'In Progress' }), actor: YOU })
    expect(s1.issues.get('Q-1')!.title).toBe('Renamed')
    expect(s1.issues.get('Q-1')!.status).toBe('In Progress')
    expect(s0.issues.get('Q-1')!.title).toBe('Issue Q-1')
    expect(s1.issues).not.toBe(s0.issues)

    // A new id is added.
    const s2 = applyEvent(s1, { kind: 'issue', issue: summary('Q-3'), actor: YOU })
    expect([...s2.issues.keys()].sort()).toEqual(['Q-1', 'Q-2', 'Q-3'])

    // `removed` deletes.
    const s3 = applyEvent(s2, { kind: 'removed', id: 'Q-2', actor: YOU })
    expect(s3.issues.has('Q-2')).toBe(false)
    expect(s3.issues.size).toBe(2)

    // `meta` triggers the re-snapshot flag.
    expect(s3.needsSnapshot).toBe(false)
    const s4 = applyEvent(s3, { kind: 'meta' })
    expect(s4.needsSnapshot).toBe(true)
    expect(s4.issues).toBe(s3.issues)
  })

  test('error events add or replace the file error by path', () => {
    let s = fromSnapshot(snap([]))
    s = applyEvent(s, { kind: 'error', path: '/x/a.md', message: 'bad yaml' })
    s = applyEvent(s, { kind: 'error', path: '/x/a.md', message: 'still bad' })
    s = applyEvent(s, { kind: 'error', path: '/x/b.md', message: 'dup' })
    expect(s.errors).toEqual([{ path: '/x/a.md', message: 'still bad' }, { path: '/x/b.md', message: 'dup' }])
  })

  test('an external issue change while file errors are shown asks for a re-snapshot (errors may have cleared)', () => {
    const s = fromSnapshot({ ...snap([summary('Q-1')]), errors: [{ path: '/x/Q-1.md', message: 'bad' }] })
    expect(applyEvent(s, { kind: 'issue', issue: summary('Q-1'), actor: EXTERNAL }).needsSnapshot).toBe(true)
    expect(applyEvent(s, { kind: 'issue', issue: summary('Q-1'), actor: YOU }).needsSnapshot).toBe(false)
    const clean = fromSnapshot(snap([summary('Q-1')]))
    expect(applyEvent(clean, { kind: 'issue', issue: summary('Q-1'), actor: EXTERNAL }).needsSnapshot).toBe(false)
  })

  test('feed events are prepended newest first and capped', () => {
    let s = fromSnapshot(snap([]))
    for (let n = 0; n < 205; n++) s = applyEvent(s, { kind: 'feed', event: { at: `t${n}`, actor: YOU, id: 'Q-1', kind: 'updated' } })
    expect(s.feed.length).toBe(200)
    expect(s.feed[0]!.at).toBe('t204')
  })

  test('events before the first snapshot are ignored by the reducer (the client queues them)', () => {
    const s = applyEvent(emptyState(), { kind: 'issue', issue: summary('Q-1'), actor: YOU })
    expect(s.ready).toBe(false)
  })
})

describe('hidden projects in the client (the engine leaves them out; the client keeps only ids and names)', () => {
  const base = (): Snapshot => ({
    ...snap([summary('Q-1'), summary('Q-2')]),
    hidden: { projects: [{ slug: 'secret', name: 'Secret' }], issues: ['Q-9'] },
  })

  test('the snapshot\'s hidden ids and names are kept for links only', () => {
    const s = fromSnapshot(base())
    expect(s.hidden.issues.has('Q-9')).toBe(true)
    expect(s.issues.has('Q-9')).toBe(false)
    expect(projectName(s, 'secret')).toBe('Secret')
    expect(projectName(s, 'gone')).toBe('gone')
    expect(fromSnapshot(snap([])).hidden.issues.size).toBe(0) // an engine without hidden projects
  })

  test('a hidden event drops the issue, remembers its id and bumps hiddenRev', () => {
    const s0 = fromSnapshot(base())
    const s1 = applyEvent(s0, { kind: 'hidden', id: 'Q-2', project: 'secret' })
    expect(s1.issues.has('Q-2')).toBe(false)
    expect(s1.hidden.issues.has('Q-2')).toBe(true)
    expect(s1.hiddenRev).toBe(1)
    const s2 = applyEvent(s1, { kind: 'hidden', id: 'Q-9', project: 'secret' })
    expect(s2.hidden).toBe(s1.hidden) // already known
    expect(s2.hiddenRev).toBe(2)
  })

  test('an issue event (moved out of a hidden project) or a removal clears the hidden id', () => {
    const s0 = fromSnapshot(base())
    const s1 = applyEvent(s0, { kind: 'issue', issue: summary('Q-9'), actor: YOU } as WireEvent)
    expect(s1.issues.has('Q-9')).toBe(true)
    expect(s1.hidden.issues.has('Q-9')).toBe(false)
    const s2 = applyEvent(s0, { kind: 'removed', id: 'Q-9', actor: YOU })
    expect(s2.hidden.issues.has('Q-9')).toBe(false)
  })

  test('isHiddenProject reads config.hiddenProjects', () => {
    expect(isHiddenProject({ config: null }, 'x')).toBe(false)
    expect(isHiddenProject({ config: { hiddenProjects: ['x'] } as any }, 'x')).toBe(true)
  })
})

describe('inScope (workspace switcher)', () => {
  const config = { workspaces: { 'web-app': 'support' } }
  test('all, project and workspace scopes', () => {
    const a = summary('Q-1', { project: 'support' })
    const b = summary('Q-2', { project: 'cdp', workspaces: ['web-app'] })
    const c = summary('Q-3', { project: 'cdp' })
    expect([a, b, c].filter((i) => inScope(i, { kind: 'all' }, config)).length).toBe(3)
    expect([a, b, c].filter((i) => inScope(i, { kind: 'project', slug: 'cdp' }, config)).map((i) => i.id)).toEqual(['Q-2', 'Q-3'])
    expect([a, b, c].filter((i) => inScope(i, { kind: 'workspace', name: 'web-app' }, config)).map((i) => i.id)).toEqual(['Q-1', 'Q-2'])
  })
  test('an owner edit after an agent touched the issue keeps it in the workspace scope; unrelated issues stay out', () => {
    const touched = summary('Q-4', { project: 'cdp', workspaces: ['web-app'], touchedBy: { actor: 'you' } })
    const unrelated = summary('Q-5', { project: 'cdp', workspaces: ['other-ws'], touchedBy: { actor: 'you' } })
    const s = { kind: 'workspace' as const, name: 'web-app' }
    expect(inScope(touched, s, config)).toBe(true)
    expect(inScope(unrelated, s, config)).toBe(false)
    expect(inScope(unrelated, s, null)).toBe(false)
  })
})

test('listedProjects hides the _none bucket and sorts by name', () => {
  const p = (slug: string, name: string) => ({ slug, name } as any)
  expect(listedProjects([p('support', 'Support'), p('_none', 'No project'), p('cdp', 'CDP')]).map((x) => x.slug)).toEqual(['cdp', 'support'])
})

describe('against a test server', () => {
  let root: string
  let store: Store
  let srv: RunningServer
  let base: string
  beforeEach(async () => {
    root = await miniCopy()
    store = await Store.open(root, { port: 0 })
    srv = startServer(store, { port: 0, version: 'test' })
    base = `http://127.0.0.1:${srv.port}`
  })
  afterEach(async () => {
    await srv.stop()
    await rm(root, { recursive: true, force: true })
  })

  test('snapshot from /api/snapshot, then a live SSE issue event for a UI write', async () => {
    let state = fromSnapshot((await (await fetch(`${base}/api/snapshot`)).json()) as Snapshot)
    expect(state.ready).toBe(true)
    const before = state.issues.size
    expect(before).toBeGreaterThan(0)
    const existing = [...state.issues.values()][0]!

    const res = await fetch(`${base}/api/events`)
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const nextIssueEvent = async (): Promise<any> => {
      const deadline = Date.now() + 2000
      for (;;) {
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
          if (!chunk.startsWith('data: ')) continue
          const e = JSON.parse(chunk.slice(6))
          if (e.kind === 'issue') return e
        }
        const r = await Promise.race([reader.read(), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null)])
        if (!r || r.done) throw new Error('no SSE issue event')
        buf += dec.decode(r.value)
      }
    }

    const post = await fetch(`${base}/api/tool/save_issue`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Tracker': '1' },
      body: JSON.stringify({ args: { id: existing.id, title: 'Retitled from the UI' } }),
    })
    expect(post.status).toBe(200)
    state = applyEvent(state, await nextIssueEvent())
    await reader.cancel()
    expect(state.issues.size).toBe(before)
    expect(state.issues.get(existing.id)!.title).toBe('Retitled from the UI')
  })

  test('hidden projects end to end: hide, a change inside it, unhide (the UI choke point is what the engine sends)', async () => {
    await store.setProjectHidden('support', true)
    let state = fromSnapshot((await (await fetch(`${base}/api/snapshot`)).json()) as Snapshot)
    expect([...state.issues.values()].some((i) => i.project === 'support')).toBe(false)
    expect(state.projects.some((p) => p.slug === 'support')).toBe(false)
    expect(state.hidden.issues.has('Q-5')).toBe(true)
    expect(isHiddenProject(state, 'support')).toBe(true)

    const res = await fetch(`${base}/api/events`)
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    // A visible issue moves into the hidden project: the client drops it.
    await store.updateIssue('Q-2', { project: 'support' }, { actor: 'agent', workspace: 'w' })
    while (!buf.includes('"kind":"hidden","id":"Q-2"')) buf += dec.decode((await reader.read()).value)
    await reader.cancel()
    for (const chunk of buf.split('\n\n')) if (chunk.startsWith('data: ')) state = applyEvent(state, JSON.parse(chunk.slice(6)))
    expect(state.issues.has('Q-2')).toBe(false)
    expect(state.hidden.issues.has('Q-2')).toBe(true)

    // Unhide: the client refetches the snapshot on `meta` and everything is back.
    await store.setProjectHidden('support', false)
    state = fromSnapshot((await (await fetch(`${base}/api/snapshot`)).json()) as Snapshot)
    expect(['Q-2', 'Q-5', 'Q-6'].every((id) => state.issues.has(id))).toBe(true)
    expect(state.hidden.issues.size).toBe(0)
  })
})
