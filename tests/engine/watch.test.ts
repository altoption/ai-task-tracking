import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Store, type ChangeEvent } from '../../src/engine/store'
import { watchFolder } from '../../src/engine/watch'
import { issuePath, miniCopy } from './helpers'

const you = { actor: 'you' as const }
let root: string
let store: Store
let watcher: { close(): void }
let events: ChangeEvent[]
let waiters: Array<{ pred: (e: ChangeEvent) => boolean; resolve: (e: ChangeEvent) => void }>

beforeEach(async () => {
  root = await miniCopy()
  store = await Store.open(root)
  events = []
  waiters = []
  store.on((e) => {
    events.push(e)
    for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e) }
  })
  watcher = watchFolder(store)
  // FSEvents may replay the fixture copy that just happened; let that settle, then start clean.
  await Bun.sleep(200)
  events.length = 0
})
afterEach(async () => {
  watcher.close()
  await Bun.sleep(100) // let in-flight reloads/feed appends finish before the temp dir goes
  await rm(root, { recursive: true, force: true })
})

/** Resolve with the next matching event (or reject on timeout). */
function waitFor(pred: (e: ChangeEvent) => boolean, ms = 1000): Promise<ChangeEvent> {
  const past = events.find(pred)
  if (past) return Promise.resolve(past)
  return new Promise((resolve, reject) => {
    const w = { pred, resolve: (e: ChangeEvent) => { clearTimeout(t); resolve(e) } }
    const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timed out waiting for event')) }, ms)
    waiters.push(w)
  })
}
const issueEvent = (id: string) => (e: ChangeEvent) => e.kind === 'issue' && e.issue.id === id

describe('watchFolder', () => {
  test('external edit emits issue event within 300 ms', async () => {
    const p = issuePath(root, 'acme-app', 'Q-2')
    const text = await readFile(p, 'utf8')
    const t0 = Date.now()
    const next = text.replace(/^title: .*$/m, 'title: Edited outside')
    expect(next).not.toBe(text)
    await writeFile(p, next)
    const e = await waitFor(issueEvent('Q-2'), 300)
    expect(Date.now() - t0).toBeLessThan(300)
    expect(e.kind === 'issue' && e.issue.title).toBe('Edited outside')
    expect(store.get('Q-2')!.title).toBe('Edited outside')
  })

  test('own write does not emit a second event', async () => {
    await store.updateIssue('Q-2', { title: 'Engine title' }, you)
    await Bun.sleep(250) // longer than debounce + fs.watch latency
    const issueEvents = events.filter(issueEvent('Q-2'))
    expect(issueEvents).toHaveLength(1)
  })

  test('deleted file emits removed', async () => {
    await rm(issuePath(root, 'acme-app', 'Q-3'))
    const e = await waitFor((e) => e.kind === 'removed' && e.id === 'Q-3')
    expect(e.kind).toBe('removed')
    expect(store.get('Q-3')).toBeUndefined()
  })

  test('broken YAML keeps last good issue and emits error', async () => {
    const p = issuePath(root, 'acme-app', 'Q-2')
    const good = await readFile(p, 'utf8')
    const oldTitle = store.get('Q-2')!.title
    const broken = good.replace(/^title: .*$/m, 'title: "unterminated\nstatus: [oops')
    await writeFile(p, broken)
    await waitFor((e) => e.kind === 'error' && e.path === p)
    expect(store.get('Q-2')!.title).toBe(oldTitle)
    expect(store.errors.has(p)).toBe(true)
    expect(await readFile(p, 'utf8')).toBe(broken) // never overwritten
  })

  test('fixing the YAML clears the error', async () => {
    const p = issuePath(root, 'acme-app', 'Q-2')
    const good = await readFile(p, 'utf8')
    await writeFile(p, good.replace(/^title: .*$/m, 'title: "unterminated\nstatus: [oops'))
    await waitFor((e) => e.kind === 'error' && e.path === p)
    events.length = 0
    await writeFile(p, good.replace(/^title: .*$/m, 'title: Fixed title'))
    await waitFor(issueEvent('Q-2'))
    expect(store.errors.has(p)).toBe(false)
    expect(store.get('Q-2')!.title).toBe('Fixed title')
  })

  test('hand-editing config.yml emits meta within 300 ms', async () => {
    const p = join(root, 'config.yml')
    const text = await readFile(p, 'utf8')
    await writeFile(p, text.replace('port: 7477', 'port: 7480'))
    await waitFor((e) => e.kind === 'meta', 300)
    expect(store.config.port).toBe(7480)
  })

  test('issue moved across project folders: removed from old path, indexed at new', async () => {
    const from = issuePath(root, 'acme-app', 'Q-4')
    const to = issuePath(root, 'support', 'Q-4')
    await mkdir(dirname(to), { recursive: true })
    await rename(from, to)
    await waitFor((e) => e.kind === 'issue' && e.issue.id === 'Q-4' && e.issue.path === to)
    expect(store.get('Q-4')!.path).toBe(to)
  })

  test('ignores .git and editor temp files', async () => {
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, '.git', 'x.md'), 'x')
    await writeFile(join(root, 'projects', 'support', 'issues', '.Q-9.md.swp'), 'x')
    await writeFile(join(root, 'projects', 'support', 'issues', 'Q-9.md~'), 'x')
    await Bun.sleep(200)
    expect(events).toHaveLength(0)
  })

  test('other files in the data folder (AGENTS.md, attachments) emit a file event; deletes too', async () => {
    await writeFile(join(root, 'AGENTS.md'), '# hand edited\n')
    expect(await waitFor((e) => e.kind === 'file' && e.path === 'AGENTS.md')).toEqual({ kind: 'file', path: 'AGENTS.md' })
    await mkdir(join(root, 'projects', 'support', 'files'), { recursive: true })
    await writeFile(join(root, 'projects', 'support', 'files', 'shot.png'), 'PNG')
    await waitFor((e) => e.kind === 'file' && e.path === 'projects/support/files/shot.png')
    events.length = 0
    await rm(join(root, 'AGENTS.md'))
    expect(await waitFor((e) => e.kind === 'file' && e.path === 'AGENTS.md')).toEqual({ kind: 'file', path: 'AGENTS.md', deleted: true })
  })

  test('ignores emacs autosaves (#x#) and Office lock files (~$x)', async () => {
    await writeFile(join(root, '#notes.md#'), 'x')
    await writeFile(join(root, '~$report.docx'), 'x')
    await Bun.sleep(200)
    expect(events).toHaveLength(0)
  })

  test('close stops delivering events', async () => {
    watcher.close()
    const p = issuePath(root, 'acme-app', 'Q-2')
    await writeFile(p, (await readFile(p, 'utf8')).replace(/^title: .*$/m, 'title: After close'))
    await Bun.sleep(200)
    expect(events).toHaveLength(0)
  })
})
