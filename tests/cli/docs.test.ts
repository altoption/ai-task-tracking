import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { docsCommand, engineHealthy, type DocsDeps } from '../../src/cli/docs'

function deps(over: Partial<DocsDeps> = {}) {
  const opened: string[] = [], out: string[] = [], err: string[] = []
  const d: DocsDeps = {
    port: async () => 7499, healthy: async () => true, open: async (u) => { opened.push(u); return 0 },
    log: (l) => out.push(l), error: (l) => err.push(l), ...over,
  }
  return { d, opened, out, err }
}

describe('aitt docs', () => {
  test('opens the running engine\'s /docs/', async () => {
    const t = deps()
    expect(await docsCommand([], t.d)).toBe(0)
    expect(t.opened).toEqual(['http://127.0.0.1:7499/docs/'])
  })

  test('extra arguments are refused, nothing is opened', async () => {
    const t = deps()
    expect(await docsCommand(['search'], t.d)).toBe(2)
    expect(t.err).toEqual(['usage: aitt docs'])
    expect(t.opened).toEqual([])
  })

  test('no engine: says so instead of opening a dead URL', async () => {
    const t = deps({ healthy: async () => false })
    expect(await docsCommand([], t.d)).toBe(1)
    expect(t.err[0]).toStartWith("AI Task Tracking isn't running — open it from the menu bar")
    expect(t.opened).toEqual([])
  })
})

describe('engineHealthy', () => {
  let server: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => (new URL(r.url).pathname === '/api/health' ? Response.json({ ok: true }) : new Response('x', { status: 404 })) })
  })
  afterAll(() => server.stop(true))

  test('true for an engine, false for anything else or nothing listening', async () => {
    expect(await engineHealthy(`http://127.0.0.1:${server.port}/api/health`)).toBe(true)
    expect(await engineHealthy(`http://127.0.0.1:${server.port}/other`)).toBe(false)
    const closed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
    const port = closed.port
    closed.stop(true)
    expect(await engineHealthy(`http://127.0.0.1:${port}/api/health`)).toBe(false)
  })
})
