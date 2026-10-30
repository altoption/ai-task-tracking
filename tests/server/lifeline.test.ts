import { afterEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { miniCopy } from '../engine/helpers'

const cli = join(import.meta.dir, '../../src/cli.ts')
let root = ''
let proc: ReturnType<typeof Bun.spawn> | undefined

afterEach(async () => {
  if (proc && proc.exitCode === null) { proc.kill('SIGKILL'); await proc.exited }
  proc = undefined
  if (root) await rm(root, { recursive: true, force: true })
})

function freePort(): number {
  const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = s.port!
  s.stop(true)
  return port
}

/** `aitt serve` with a piped stdin, as the app runs it; resolves once it answers /api/health. */
async function startServe(env: Record<string, string>) {
  root = await miniCopy()
  const port = freePort()
  proc = Bun.spawn(['bun', cli, 'serve'], {
    env: { ...(process.env as Record<string, string>), AITT_HOME: root, AITT_PORT: String(port), ...env },
    stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) return base
    await Bun.sleep(100)
  }
  throw new Error('serve did not start')
}

const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: root }).stdout.toString()

describe('parent lifeline (AITT_PARENT_LIFELINE=1)', () => {
  test('stdin closing shuts serve down gracefully and commits the last write', async () => {
    const base = await startServe({ AITT_PARENT_LIFELINE: '1' })
    const r = await fetch(`${base}/api/tool/save_issue`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Tracker': '1' },
      body: JSON.stringify({ args: { title: 'Lifeline probe', project: 'support', labels: ['Feature'] } }),
    })
    expect(r.status).toBe(200)
    const { id } = (await r.json()) as { id: string }
    ;(proc!.stdin as import('bun').FileSink).end() // the app died: its end of the pipe closes
    const code = await Promise.race([proc!.exited, Bun.sleep(10_000).then(() => 'timeout')])
    expect(code).toBe(0)
    expect(git('status', '--porcelain')).toBe('')
    expect(git('log', '-1', '--format=%s')).toContain(id)
  }, 20_000)

  test('without the env var, stdin closing does not stop serve', async () => {
    await startServe({})
    ;(proc!.stdin as import('bun').FileSink).end()
    await Bun.sleep(1500)
    expect(proc!.exitCode).toBeNull()
  }, 20_000)
})
