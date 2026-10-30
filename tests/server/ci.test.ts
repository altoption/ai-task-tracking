import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { CiRefresher, type GhRunner } from '../../src/engine/ci'
import { Store } from '../../src/engine/store'
import { startServer, type RunningServer } from '../../src/server/http'
import { callTool } from '../../src/tools/handlers'
import { miniCopy } from '../engine/helpers'

/** CI status over HTTP and the tools. The fake gh counts calls: requests must never make one. */
const PR = (n: number) => `https://github.com/acme/web/pull/${n}`
const prJson = (n: number, failing: boolean) => JSON.stringify({
  number: n, url: PR(n), state: 'OPEN', isDraft: false, mergedAt: null,
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: failing ? 'FAILURE' : 'SUCCESS' },
    { __typename: 'StatusContext', context: 'ci/lint', state: 'SUCCESS' },
  ],
})

let root: string, store: Store, srv: RunningServer, ci: CiRefresher, base: string
let calls = 0
const runner: GhRunner = async (args) => {
  calls++
  const n = Number(/pull\/(\d+)/.exec(args[2]!)![1])
  return { code: 0, stdout: prJson(n, n === 12), stderr: '' }
}

beforeEach(async () => {
  root = await miniCopy()
  store = await Store.open(root, { port: 0 })
  await store.updateIssue('Q-1', { links: [{ title: 'PR #12', url: PR(12) }, { title: 'PR #13', url: PR(13) }] }, { actor: 'you' })
  await store.updateIssue('Q-2', { links: [{ title: 'PR #13', url: PR(13) }] }, { actor: 'you' })
  calls = 0
  ci = await CiRefresher.start(store, { run: runner, tickMs: 0, saveDelayMs: 5, log: () => {} })
  srv = startServer(store, { port: 0, version: 'test', ci })
  base = `http://127.0.0.1:${srv.port}`
  await ci.pass()
})
afterEach(async () => {
  await ci.stop()
  await srv.stop()
  await rm(root, { recursive: true, force: true })
})

const get = async (p: string) => (await fetch(`${base}${p}`)).json() as Promise<any>
const postCi = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/ci`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Tracker': '1', ...headers }, body: JSON.stringify(body) })

describe('CI status over HTTP', () => {
  test('rows carry the worst badge, the issue page every PR, Needs you the reason; no request runs gh', async () => {
    expect(calls).toBe(2)
    const snap = await get('/api/snapshot')
    const q1 = snap.issues.find((i: any) => i.id === 'Q-1')
    expect(q1.ci).toEqual({ pr: 12, state: 'open', checks: 'failing' })
    expect(snap.issues.find((i: any) => i.id === 'Q-2').ci).toEqual({ pr: 13, state: 'open', checks: 'passing' })
    expect(snap.issues.find((i: any) => i.id === 'Q-3').ci).toBeUndefined()

    const detail = await get('/api/issues/Q-1')
    expect(detail.ci[PR(12)]).toEqual({ pr: 12, state: 'open', checks: 'failing', failing: ['test'], checkedAt: expect.any(String) })
    expect(detail.ci[PR(13)].checks).toBe('passing')

    const h = await get('/api/home')
    expect(h.needsYou.find((i: any) => i.id === 'Q-1').ciReason).toBe('CI failing on PR #12')
    const rows = await get('/api/needs-you')
    expect(rows.find((r: any) => r.id === 'Q-1')).toMatchObject({ why: 'CI failing on PR #12', ci: 'CI failing on PR #12' })

    const health = await get('/api/health')
    expect(health.ci).toEqual({ enabled: true, setting: true })
    expect(health.needsYou).toBe(h.needsYou.length)

    const issue: any = await callTool(store, 'get_issue', { id: 'Q-1' }, { actor: { actor: 'agent', workspace: 'w' } })
    expect(issue.links).toEqual([
      { title: 'PR #12', url: PR(12), ci: { state: 'open', checks: 'failing', failing: ['test'] } },
      { title: 'PR #13', url: PR(13), ci: { state: 'open', checks: 'passing', failing: [] } },
    ])
    const next: any = await callTool(store, 'whats_next', {}, { actor: { actor: 'agent', workspace: 'w' } })
    expect(next.inProgress.find((i: any) => i.id === 'Q-1').ci).toBe('CI failing on PR #12')
    expect(next.needsYou.map((i: any) => i.id)).not.toContain('Q-1')

    for (let k = 0; k < 5; k++) {
      for (const p of ['/api/health', '/api/home', '/api/snapshot', '/api/needs-you', '/api/issues/Q-1', '/api/issues/Q-2']) await get(p)
    }
    expect(calls).toBe(2)
  })

  test("the app's setting: POST /api/ci turns it off everywhere (owner only), and health reports it", async () => {
    expect((await postCi({ enabled: false }, { 'X-Tracker-Agent': '1' })).status).toBe(403)
    expect((await postCi({ enabled: 'no' })).status).toBe(400)
    const r = await postCi({ enabled: false })
    expect(await r.json()).toEqual({ enabled: false, setting: false, reason: 'CI status off in Settings' })
    expect((await get('/api/health')).ci).toEqual({ enabled: false, setting: false, reason: 'CI status off in Settings' })
    expect((await get('/api/snapshot')).issues.some((i: any) => i.ci)).toBe(false)
    expect((await get('/api/issues/Q-1')).ci).toBeUndefined()
    expect((await get('/api/home')).needsYou.some((i: any) => i.ciReason)).toBe(false)
    const issue: any = await callTool(store, 'get_issue', { id: 'Q-1' }, { actor: { actor: 'agent' } })
    expect(issue.links.every((l: any) => !l.ci)).toBe(true)
    await postCi({ enabled: true })
    expect((await get('/api/snapshot')).issues.find((i: any) => i.id === 'Q-1').ci.checks).toBe('failing')
  })

  test('/api/health stays fast with 2,000 PR-linked issues in the cache (bench)', async () => {
    for (let k = 0; k < 400; k++) {
      const { id } = await store.createIssue({ title: `t${k}`, project: 'support', status: 'In Progress',
        links: [1, 2, 3, 4, 5].map((j) => ({ title: 'PR', url: PR(1000 + k * 5 + j) })) }, { actor: 'you' })
      void id
    }
    // Fill the cache through the refresher (the fake gh answers instantly).
    for (let k = 0; k < 80; k++) await ci.pass()
    const before = calls
    const t0 = performance.now()
    for (let k = 0; k < 20; k++) await get('/api/health')
    const per = (performance.now() - t0) / 20
    console.log(`health with CI: ${per.toFixed(1)} ms per request`)
    expect(per).toBeLessThan(50)
    expect(calls).toBe(before)
  }, 60_000)
})
