import { describe, expect, test } from 'bun:test'
import { shutdown } from '../../src/server/shutdown'
import { sseResponse } from '../../src/server/http'

function parts(flush: () => Promise<void>, status: () => { commitError?: string } = () => ({}), deadlineMs = 100) {
  const calls: string[] = []
  const logs: string[] = []
  return {
    calls, logs,
    p: {
      server: { stop: async () => { calls.push('server.stop') } },
      watcher: { close: () => { calls.push('watcher.close') } },
      git: { flush: () => { calls.push('git.flush'); return flush() }, stop: () => { calls.push('git.stop') }, status },
      deadlineMs, log: (m: string) => logs.push(m),
    },
  }
}

describe('shutdown', () => {
  test('stops server and watcher before the final flush; exit 0', async () => {
    const t = parts(async () => {})
    expect(await shutdown(t.p)).toBe(0)
    expect(t.calls).toEqual(['server.stop', 'watcher.close', 'git.flush', 'git.stop'])
  })
  test('rejecting flush is caught: exit 1', async () => {
    const t = parts(() => Promise.reject(new Error('boom')))
    expect(await shutdown(t.p)).toBe(1)
    expect(t.calls).toContain('git.stop')
    expect(t.logs.join()).toContain('boom')
  })
  test('hung flush returns after the deadline', async () => {
    const t = parts(() => new Promise<void>(() => {}), () => ({}), 80)
    const t0 = performance.now()
    expect(await shutdown(t.p)).toBe(0)
    const ms = performance.now() - t0
    expect(ms).toBeGreaterThanOrEqual(70)
    expect(ms).toBeLessThan(500)
    expect(t.logs.join()).toContain('exceeded')
  })
  test('commit error in status: exit 1', async () => {
    const t = parts(async () => {}, () => ({ commitError: 'index.lock' }))
    expect(await shutdown(t.p)).toBe(1)
  })
})

describe('sse backpressure', () => {
  test('a client that never reads is dropped and unsubscribed', () => {
    let fn: ((e: unknown) => void) | undefined
    let unsubbed = 0
    const store = { on: (f: (e: unknown) => void) => { fn = f; return () => { unsubbed++ } } } as any
    sseResponse(store, new AbortController().signal)
    for (let i = 0; i < 1000; i++) fn!({ kind: 'meta' })
    expect(unsubbed).toBeGreaterThanOrEqual(1)
  })
})

describe('shutdown drains in-flight requests', () => {
  test('flush starts after a slow in-flight tool write finished, and includes it', async () => {
    const { miniCopy } = await import('../engine/helpers')
    const { Store } = await import('../../src/engine/store')
    const { startServer } = await import('../../src/server/http')
    const { rm } = await import('node:fs/promises')
    const root = await miniCopy()
    const store = await Store.open(root, { port: 0 })
    const orig = store.createIssue.bind(store)
    ;(store as any).createIssue = async (...a: Parameters<typeof orig>) => { await Bun.sleep(300); return orig(...a) }
    const srv = startServer(store, { port: 0, version: 't' })
    const calls: string[] = []
    let seenAtFlush = false
    const req = fetch(`http://127.0.0.1:${srv.port}/api/tool/save_issue`, {
      method: 'POST', headers: { 'X-Tracker': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ args: { title: 'slow one', project: 'support', labels: ['Feature'] } }),
    })
    await Bun.sleep(80) // request is in the handler, write not finished
    const code = await shutdown({
      server: { stop: async () => { calls.push('stop'); await srv.stop(3000) } },
      watcher: { close: () => { calls.push('close') } },
      git: {
        flush: async () => { calls.push('flush'); seenAtFlush = store.all().some((i) => i.title === 'slow one') },
        stop: () => {}, status: () => ({}),
      },
      deadlineMs: 5000, log: () => {},
    })
    expect(code).toBe(0)
    expect(calls).toEqual(['stop', 'close', 'flush'])
    expect(seenAtFlush).toBe(true)
    expect((await req).status).toBe(200)
    await rm(root, { recursive: true, force: true })
  })

  test('hung server stop is bounded by the deadline', async () => {
    const t = parts(async () => {}, () => ({}), 80)
    t.p.server.stop = () => new Promise<void>(() => {})
    const t0 = performance.now()
    expect(await shutdown(t.p)).toBe(0)
    expect(performance.now() - t0).toBeLessThan(500)
    expect(t.calls).toContain('git.flush')
  })

  test('flush timeout with commitError in status exits 1', async () => {
    const t = parts(() => new Promise<void>(() => {}), () => ({ commitError: 'locked' }), 50)
    expect(await shutdown(t.p)).toBe(1)
  })
})
