import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/engine/store'
import { summarize } from '../../src/server/http'
import { activeChips } from '../../ui/views/FilterMenu'
import { initFolder } from '../../src/store/metaFiles'

const cli = join(import.meta.dir, '../../src/cli.ts')
let root = ''
let proc: ReturnType<typeof Bun.spawn> | undefined

afterEach(async () => {
  if (proc && proc.exitCode === null) { proc.kill('SIGKILL'); await proc.exited }
  proc = undefined
  if (root) { await chmod(join(root, 'views'), 0o755).catch(() => {}); await rm(root, { recursive: true, force: true }) }
})

function freePort(): number {
  const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = s.port!
  s.stop(true)
  return port
}

async function serve(): Promise<string> {
  const port = freePort()
  proc = Bun.spawn(['bun', cli, 'serve'], {
    env: { ...(process.env as Record<string, string>), AITT_HOME: root, AITT_PORT: String(port) },
    stdout: 'ignore', stderr: 'ignore',
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) return base
    await Bun.sleep(100)
  }
  throw new Error('serve did not start')
}
const viewSlugs = async (base: string) => ((await (await fetch(`${base}/api/snapshot`)).json()) as { views: { slug: string }[] }).views.map((v) => v.slug).sort()

describe('aitt serve and the default views', () => {
  test('a new folder gets them at engine start, and clients see them', async () => {
    root = await mkdtemp(join(tmpdir(), 'aitt-serve-'))
    const base = await serve()
    let slugs: string[] = []
    for (let i = 0; i < 50 && slugs.length < 4; i++) { slugs = await viewSlugs(base); await Bun.sleep(100) }
    expect(slugs).toEqual(['active-by-project', 'high-priority', 'shipped-this-week', 'unblock-first'])
  }, 20_000)

  test('saving a view from the UI keeps the window', async () => {
    root = await mkdtemp(join(tmpdir(), 'aitt-serve-'))
    const base = await serve()
    const display = { layout: 'list', groupBy: 'project', orderBy: 'updated', showSubIssues: true, properties: ['id'] }
    const r = await fetch(`${base}/api/tool/save_view`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-tracker': '1' },
      body: JSON.stringify({ args: { name: 'Last month', filter: { closedWithinDays: 30 }, display } }),
    })
    expect(r.status).toBe(200)
    expect(await readFile(join(root, 'views', 'last-month.yml'), 'utf8')).toContain('closedWithinDays: 30')
  }, 20_000)

  test('a read-only views folder does not stop the engine', async () => {
    root = await mkdtemp(join(tmpdir(), 'aitt-serve-'))
    await initFolder(root)
    await chmod(join(root, 'views'), 0o555)
    const base = await serve()
    await Bun.sleep(500)
    expect((await fetch(`${base}/api/health`)).ok).toBe(true)
    expect(await viewSlugs(base)).toEqual([])
    expect((await readdir(join(root, 'views')))).toEqual([])
  }, 20_000)
})

describe('showing the window', () => {
  test('summaries carry closedAt for closed issues only', async () => {
    root = await mkdtemp(join(tmpdir(), 'aitt-serve-'))
    await initFolder(root)
    const s = await Store.open(root)
    await s.upsertProject({ name: 'Web' })
    const i = await s.createIssue({ title: 'x', project: 'web' }, { actor: 'you' })
    expect(summarize(s, i).closedAt).toBeUndefined()
    const done = await s.updateIssue(i.id, { status: 'Done' }, { actor: 'you' })
    expect(summarize(s, done).closedAt).toBe(done.updated)
  })

  test('the filter bar names the window, and it can be removed like any filter', () => {
    const chips = activeChips({ status: ['Done'], closedWithinDays: 7 }, [], { projects: [], issues: new Map() })
    expect(chips.map((c) => c.text)).toEqual(['Status is Done', 'Closed in the last 7 days'])
    expect(chips[1]!.keys).toEqual(['closedWithinDays'])
    expect(activeChips({ closedWithinDays: 1 }, [], { projects: [], issues: new Map() })[0]!.text).toBe('Closed in the last day')
  })
})
