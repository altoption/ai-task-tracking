import { describe, expect, test } from 'bun:test'
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { feedPath } from '../../src/engine/eventlog'
import { startGit } from '../../src/engine/git'
import { filterIssues } from '../../src/engine/queries'
import { Store } from '../../src/engine/store'
import type { Actor, Config, Issue, View } from '../../src/model'
import { defaultConfig, defaultViews, initFolder, OFFERED_VIEWS, readConfig, SETUP_LOCK, writeConfig } from '../../src/store/metaFiles'
import { miniCopy } from './helpers'

const you: Actor = { actor: 'you' }
const SLUGS = ['active-by-project', 'high-priority', 'shipped-this-week', 'unblock-first']
const blank = async () => {
  const root = await mkdtemp(join(tmpdir(), 'aitt-views-'))
  await initFolder(root)
  return root
}
const yml = async (root: string) => (await readdir(join(root, 'views'))).filter((n) => n.endsWith('.yml')).sort()
const seeded = async (root: string) => {
  const s = await Store.open(root)
  await s.seedDefaultViews()
  return s
}
const exists = (p: string) => stat(p).then(() => true, () => false)
const by = (views: View[], slug: string) => views.find((v) => v.slug === slug)!

describe('defaultViews', () => {
  test('derives the four views from the default config', () => {
    const v = defaultViews(defaultConfig())
    expect(v.map((x) => x.slug).sort()).toEqual(SLUGS)
    expect(by(v, 'active-by-project')).toEqual({
      slug: 'active-by-project', name: 'Active by Project', filter: { status: ['In Progress'] },
      display: { layout: 'board', groupBy: 'project', orderBy: 'priority', showSubIssues: true, properties: ['id', 'status', 'priority', 'labels', 'project', 'updated'] },
    })
    expect(by(v, 'unblock-first').filter).toEqual({ blocking: true })
    expect(by(v, 'unblock-first').display).toMatchObject({ layout: 'list', orderBy: 'priority' })
    expect(by(v, 'high-priority').filter).toEqual({ priority: [1, 2] })
    expect(by(v, 'high-priority').display).toMatchObject({ layout: 'board', groupBy: 'project' })
    expect(by(v, 'shipped-this-week').filter).toEqual({ status: ['Done'], closedWithinDays: 7 })
    expect(by(v, 'shipped-this-week').display).toMatchObject({ groupBy: 'project' })
  })

  test('renamed statuses are followed by type; Needs-you statuses stay out of Active', () => {
    const c: Config = defaultConfig()
    c.statuses = [
      { name: 'Doing', type: 'started', color: '#111111' }, { name: 'Building', type: 'started', color: '#111111' },
      { name: 'Over to you', type: 'started', color: '#111111' }, { name: 'Shipped', type: 'completed', color: '#111111' },
      { name: 'Dropped', type: 'canceled', color: '#111111' },
    ]
    c.needsYou = { statuses: ['Over to you'], labels: [] }
    const v = defaultViews(c)
    expect(by(v, 'active-by-project').filter.status).toEqual(['Doing', 'Building'])
    expect(by(v, 'shipped-this-week').filter.status).toEqual(['Shipped'])
  })

  test('a view whose statuses do not exist is left out (an empty status list would mean every status)', () => {
    const c: Config = defaultConfig()
    c.statuses = [{ name: 'Open', type: 'unstarted', color: '#111111' }]
    expect(defaultViews(c).map((x) => x.slug).sort()).toEqual(['high-priority', 'unblock-first'])
  })
})

describe('Store.seedDefaultViews', () => {
  test('adds the views once, loads them and records the slugs', async () => {
    const root = await blank()
    const s = await seeded(root)
    expect(await yml(root)).toEqual(SLUGS.map((x) => `${x}.yml`))
    expect(s.views.map((v) => v.slug).sort()).toEqual(SLUGS)
    expect((await readFile(join(root, 'views', OFFERED_VIEWS), 'utf8')).trim().split('\n').sort()).toEqual(SLUGS)
    // Ordinary saved-view files: what the UI writes, without the slug.
    const raw = YAML.parse(await readFile(join(root, 'views', 'active-by-project.yml'), 'utf8'))
    expect(raw.slug).toBeUndefined()
    expect(raw.name).toBe('Active by Project')
  })

  test('the marker is not a view, and a restart loads the views without errors', async () => {
    const root = await blank()
    await seeded(root)
    const again = await Store.open(root)
    expect(again.errors.size).toBe(0)
    expect(again.views.map((v) => v.slug).sort()).toEqual(SLUGS)
  })

  test('a deleted default stays deleted across restarts', async () => {
    const root = await blank()
    await seeded(root)
    await rm(join(root, 'views', 'high-priority.yml'))
    const s = await seeded(root)
    expect(await exists(join(root, 'views', 'high-priority.yml'))).toBe(false)
    expect(s.views.map((v) => v.slug)).not.toContain('high-priority')
  })

  test('an edited default keeps the edit across restarts', async () => {
    const root = await blank()
    await seeded(root)
    const p = join(root, 'views', 'unblock-first.yml')
    await writeFile(p, 'name: Mine\nfilter: {}\ndisplay: {layout: list, groupBy: none, orderBy: updated, showSubIssues: true, properties: [id]}\n')
    const before = await readFile(p, 'utf8')
    await seeded(root)
    expect(await readFile(p, 'utf8')).toBe(before)
  })

  test('an existing file with the same slug stays byte-identical and counts as offered', async () => {
    const root = await blank()
    const p = join(root, 'views', 'active-by-project.yml')
    const mine = '# my comment\nname:   Mine\nfilter:\n  status: [Todo]\ndisplay: {layout: list, groupBy: status, orderBy: updated, showSubIssues: false, properties: [id]}\n'
    await writeFile(p, mine)
    await seeded(root)
    expect(await readFile(p, 'utf8')).toBe(mine)
    expect(await readFile(join(root, 'views', OFFERED_VIEWS), 'utf8')).toContain('active-by-project')
    await rm(p)
    await seeded(root)
    expect(await exists(p)).toBe(false)
  })

  test('an existing view with the same name is not doubled in the sidebar', async () => {
    const root = await blank()
    await writeFile(join(root, 'views', 'urgent.yml'), 'name: high priority\nfilter: {}\ndisplay: {layout: list, groupBy: none, orderBy: updated, showSubIssues: true, properties: [id]}\n')
    const s = await seeded(root)
    expect(await exists(join(root, 'views', 'high-priority.yml'))).toBe(false)
    expect(s.views.filter((v) => v.name.toLowerCase() === 'high priority')).toHaveLength(1)
  })

  test('a later version offers a new default without re-adding deleted ones', async () => {
    const root = await blank()
    await seeded(root)
    await rm(join(root, 'views', 'high-priority.yml'))
    // As if unblock-first shipped later: it is not in the marker yet.
    const marker = join(root, 'views', OFFERED_VIEWS)
    await writeFile(marker, (await readFile(marker, 'utf8')).split('\n').filter((l) => l !== 'unblock-first').join('\n'))
    await rm(join(root, 'views', 'unblock-first.yml'))
    await seeded(root)
    expect(await exists(join(root, 'views', 'unblock-first.yml'))).toBe(true)
    expect(await exists(join(root, 'views', 'high-priority.yml'))).toBe(false)
  })

  test('the views use the statuses in this folder', async () => {
    const root = await blank()
    const c = await readConfig(root)
    c.statuses = c.statuses.map((x) => (x.name === 'In Progress' ? { ...x, name: 'Doing' } : x))
    await writeConfig(root, c)
    const s = await seeded(root)
    expect(by(s.views, 'active-by-project').filter.status).toEqual(['Doing'])
  })

  test('a failed write does not throw, records nothing, and is retried at the next start', async () => {
    const root = await blank()
    const dir = join(root, 'views')
    await chmod(dir, 0o555)
    try {
      const s = await Store.open(root)
      await s.seedDefaultViews() // resolves
      expect(s.views).toEqual([])
      expect(await exists(join(dir, OFFERED_VIEWS))).toBe(false)
    } finally {
      await chmod(dir, 0o755)
    }
    await seeded(root)
    expect(await yml(root)).toHaveLength(4)
  })

  test('a marker that cannot be read means nothing is added (it may list deleted views)', async () => {
    const root = await blank()
    await mkdir(join(root, 'views', OFFERED_VIEWS))
    const s = await seeded(root)
    expect(s.views).toEqual([])
    expect(await yml(root)).toEqual([])
  })

  test('skipped while setup is writing the folder, and when config.yml is missing or broken', async () => {
    const locked = await blank()
    await mkdir(join(locked, '.tracker'), { recursive: true })
    await writeFile(join(locked, SETUP_LOCK), '')
    await seeded(locked)
    expect(await yml(locked)).toEqual([])
    expect(await exists(join(locked, 'views', OFFERED_VIEWS))).toBe(false)

    const empty = await mkdtemp(join(tmpdir(), 'aitt-views-'))
    await seeded(empty)
    expect(await exists(join(empty, 'config.yml'))).toBe(false)
    expect(await exists(join(empty, 'views'))).toBe(false)

    const broken = await blank()
    await writeFile(join(broken, 'config.yml'), 'statuses: [\n')
    await seeded(broken)
    expect(await yml(broken)).toEqual([])
    expect(await exists(join(broken, 'views', OFFERED_VIEWS))).toBe(false)
  })

  test('two engines starting together leave one good copy of each', async () => {
    const root = await blank()
    const [a, b] = await Promise.all([Store.open(root), Store.open(root)])
    await Promise.all([a.seedDefaultViews(), b.seedDefaultViews()])
    expect(await yml(root)).toHaveLength(4)
    expect((await readdir(join(root, 'views'))).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect((await readFile(join(root, 'views', OFFERED_VIEWS), 'utf8')).trim().split('\n').sort()).toEqual(SLUGS)
    const c = await Store.open(root)
    expect(c.errors.size).toBe(0)
    expect(c.views).toHaveLength(4)
  })

  test('Store.open alone adds nothing (aitt setup and the CLI open the store too)', async () => {
    const root = await blank()
    await Store.open(root)
    expect(await yml(root)).toEqual([])
  })

  test('the auto-commit makes one commit with a readable message', async () => {
    const root = await blank()
    const run = async (...args: string[]) => {
      const p = Bun.spawn(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      const out = await new Response(p.stdout).text()
      await p.exited
      return out.trim()
    }
    await run('init', '-q', '-b', 'main')
    await run('add', '-A')
    await run('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'start')
    const s = await Store.open(root)
    const handle = startGit(s, { commitDelayMs: 60_000, pushDelayMs: 60_000 })
    await handle.ready
    await s.seedDefaultViews()
    await handle.flush()
    handle.stop()
    expect(await run('log', '--format=%s')).toBe('external: add default views\nstart')
    expect(await run('status', '--porcelain')).toBe('')
    expect(await run('ls-files', 'views')).toContain(OFFERED_VIEWS)
  })
})

describe('Store.closedAt', () => {
  const DAY = 86_400_000
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const log = async (root: string, id: string, from: string, to: string, at: string) => {
    await mkdir(join(root, '.tracker'), { recursive: true })
    await appendFile(feedPath(root), `${JSON.stringify({ at, actor: you, id, kind: 'status', from, to })}\n`)
  }
  const openOne = (s: Store): Issue => s.all().find((i) => i.status === 'Todo' || i.status === 'Backlog' || i.status === 'In Progress')!
  /** A fixture issue moved to `status` through the engine, with its logged move replaced by what the test writes. */
  const closedFixture = async () => {
    const root = await miniCopy()
    const s = await Store.open(root)
    const id = openOne(s).id
    expect(s.closedAt(s.get(id)!)).toBeUndefined()
    await s.updateIssue(id, { status: 'Done' }, you)
    await rm(feedPath(root))
    return { root, id }
  }

  test('the logged time wins over a later comment', async () => {
    const { root, id } = await closedFixture()
    const at = ago(20 * DAY)
    await log(root, id, 'Todo', 'Done', at)
    const s = await Store.open(root)
    await s.addComment(id, 'later note', you)
    expect(s.closedAt(s.get(id)!)).toBe(at)
  })

  test('moving between closed statuses keeps the close time; reopening clears it; closing again is now', async () => {
    const { root, id } = await closedFixture()
    const first = ago(3 * DAY)
    await log(root, id, 'Todo', 'Canceled', first)
    await log(root, id, 'Canceled', 'Done', ago(DAY))
    const s = await Store.open(root)
    expect(s.closedAt(s.get(id)!)).toBe(first)
    await s.updateIssue(id, { status: 'Todo' }, you)
    expect(s.closedAt(s.get(id)!)).toBeUndefined()
    const reclosed = await s.updateIssue(id, { status: 'Done' }, you)
    expect(s.closedAt(reclosed)).toBe(reclosed.updated)
  })

  test('closing an imported issue again is not read from its old close date, even before the log has it', async () => {
    const { root, id } = await closedFixture()
    await log(root, id, 'Done', 'Todo', ago(DAY))
    const s = await Store.open(root)
    const issue = { ...s.get(id)!, status: 'Done', updated: ago(5), extra: { completed_at: '2026-01-02T03:04:05Z' } }
    expect(s.closedAt(issue)).toBe(issue.updated)
  })

  test('without a logged move: the imported close time, else updated', async () => {
    const { root, id } = await closedFixture()
    const s = await Store.open(root)
    const i = s.get(id)!
    expect(s.closedAt(i)).toBe(i.updated)
    expect(s.closedAt({ ...i, extra: { completed_at: '2026-01-02T03:04:05Z' } })).toBe('2026-01-02T03:04:05Z')
    expect(s.closedAt({ ...i, status: 'Canceled', extra: { canceled_at: '2026-01-03T03:04:05Z' } })).toBe('2026-01-03T03:04:05Z')
    expect(s.closedAt({ ...i, extra: { completed_at: 'not a date' } })).toBe(i.updated)
  })

  test('filterIssues applies the window with the logged close time', async () => {
    const { root, id } = await closedFixture()
    await log(root, id, 'Todo', 'Done', ago(DAY))
    expect(filterIssues(await Store.open(root), { closedWithinDays: 7 }).map((i) => i.id)).toContain(id)
    const old = await closedFixture()
    await log(old.root, old.id, 'Todo', 'Done', ago(9 * DAY))
    expect(filterIssues(await Store.open(old.root), { closedWithinDays: 7 }).map((i) => i.id)).not.toContain(old.id)
  })
})
