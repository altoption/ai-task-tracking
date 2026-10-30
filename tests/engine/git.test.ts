import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Priority } from '../../src/model'
import { redact, startGit } from '../../src/engine/git'
import { Store, EXTERNAL } from '../../src/engine/store'
import { miniCopy } from './helpers'

// Isolate from the user's git config.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

const agent = { actor: 'agent' as const, workspace: 'shop' }
let root: string
let store: Store
let extra: string[]
let handle: { flush(): Promise<void>; stop(): void } | undefined

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  await p.exited
  return out.trim()
}
const bump = (p: Priority): Priority => ((p + 1) % 5) as Priority
const count = async () => Number(await git(root, 'rev-list', '--count', 'HEAD'))
async function until(pred: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await pred()) return; await Bun.sleep(20) }
  throw new Error('timeout')
}

beforeEach(async () => {
  root = await miniCopy()
  store = await Store.open(root)
  extra = []
})
afterEach(async () => {
  await handle?.flush()
  handle?.stop()
  handle = undefined
  await Bun.sleep(50)
  await rm(root, { recursive: true, force: true })
  for (const d of extra) await rm(d, { recursive: true, force: true })
})

describe('git auto-commit', () => {
  test('batches writes into one commit', async () => {
    const g = startGit(store, { commitDelayMs: 50, pushDelayMs: 100 }); handle = g
    await g.flush() // initial import commit
    const before = await count()
    const ids = store.all().slice(0, 3).map((i) => i.id)
    for (const id of ids) await store.updateIssue(id, { priority: bump(store.get(id)!.priority) }, agent)
    await until(async () => (await count()) > before)
    await Bun.sleep(150)
    expect(await count()).toBe(before + 1)
    const msg = await git(root, 'log', '-1', '--format=%B')
    expect(msg.startsWith('agent(shop): ')).toBe(true)
    for (const id of ids) expect(msg).toContain(id)
    expect(g.status().lastCommit).toBeTruthy()
  })

  test('message summarises status, comment and creation; external prefix', async () => {
    const g = startGit(store, { commitDelayMs: 50, pushDelayMs: 100 }); handle = g
    await g.flush()
    const id = store.all()[0]!.id
    await store.addComment(id, 'hello', agent)
    const issue = await store.createIssue({ title: 'brand new', project: store.all()[0]!.project }, agent)
    await g.flush()
    const msg = await git(root, 'log', '-1', '--format=%s')
    expect(msg).toContain(`comment on ${id}`)
    expect(msg).toContain(`new ${issue.id}`)
  })

  test('caps at 5 changes with +N more', async () => {
    const g = startGit(store, { commitDelayMs: 50, pushDelayMs: 100 }); handle = g
    await g.flush()
    const project = store.all()[0]!.project
    for (let n = 0; n < 7; n++) await store.createIssue({ title: `t${n}`, project }, { actor: 'you' })
    await g.flush()
    const msg = await git(root, 'log', '-1', '--format=%s')
    expect(msg.startsWith('you: ')).toBe(true)
    expect(msg).toContain('+2 more')
  })

  test('pushes to bare remote', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'tracker-bare-')); extra.push(bare)
    await git(bare, 'init', '--bare', '-b', 'main')
    const g = startGit(store, { commitDelayMs: 50, pushDelayMs: 100 }); handle = g
    await g.flush()
    await git(root, 'remote', 'add', 'origin', bare)
    await store.updateIssue(store.all()[0]!.id, { priority: bump(store.all()[0]!.priority) }, agent)
    await until(async () => (await git(root, 'ls-remote', 'origin', 'HEAD')).length > 0)
    expect(await git(root, 'ls-remote', 'origin', 'HEAD')).toContain(await git(root, 'rev-parse', 'HEAD'))
    expect(g.status().lastPush).toBeTruthy()
    expect(g.status().pushError).toBeUndefined()
  })

  test('push failure records error and does not throw', async () => {
    const g = startGit(store, { commitDelayMs: 50, pushDelayMs: 100 }); handle = g
    await g.flush()
    await git(root, 'remote', 'add', 'origin', join(tmpdir(), 'tracker-does-not-exist-xyz'))
    await store.updateIssue(store.all()[0]!.id, { priority: bump(store.all()[0]!.priority) }, agent)
    await until(async () => !!g.status().pushError)
    expect(g.status().pushError).toBeTruthy()
    await g.flush() // must not throw
  })

  test('external edits commit as external:', async () => {
    const g = startGit(store, { commitDelayMs: 50, pushDelayMs: 100 }); handle = g
    await g.flush()
    const issue = store.all()[0]!
    await store.updateIssue(issue.id, { priority: bump(issue.priority) }, EXTERNAL)
    await g.flush()
    expect(await git(root, 'log', '-1', '--format=%s')).toStartWith('external: ')
  })

  test('failed commit is retried with the original summary and exposes commitError', async () => {
    const g = startGit(store, { commitDelayMs: 50, pushDelayMs: 100 }); handle = g
    await g.flush()
    const hook = join(root, '.git', 'hooks', 'pre-commit')
    const marker = join(root, '.git', 'hook-ran')
    await writeFile(hook, `#!/bin/sh\nif [ ! -f "${marker}" ]; then touch "${marker}"; echo hook says no >&2; exit 1; fi\n`)
    await chmod(hook, 0o755)
    const before = await count()
    const id = store.all()[0]!.id
    await store.addComment(id, 'hi', agent)
    await until(async () => !!g.status().commitError)
    expect(g.status().commitError).toContain('hook says no')
    await until(async () => (await count()) > before) // hook passes second time; re-armed timer retries
    expect(await git(root, 'log', '-1', '--format=%s')).toContain(`comment on ${id}`)
    expect(g.status().commitError).toBeUndefined()
    await unlink(hook)
  })

  test('push error redacts credentials', async () => {
    const g = startGit(store, { commitDelayMs: 50, pushDelayMs: 100 }); handle = g
    await g.flush()
    await git(root, 'remote', 'add', 'origin', 'https://user:secret@127.0.0.1:9/x.git')
    await store.updateIssue(store.all()[0]!.id, { priority: bump(store.all()[0]!.priority) }, agent)
    await until(async () => !!g.status().pushError)
    expect(g.status().pushError).not.toContain('secret')
    expect(redact('fatal: unable to access \'https://u:tok@h/x.git/\': boom\nmore')).toBe("fatal: unable to access 'https://***@h/x.git/': boom")
  })

  test('hung git command is killed by the timeout', async () => {
    const g = startGit(store, { commitDelayMs: 50, pushDelayMs: 100, gitTimeoutMs: 300 }); handle = g
    await g.flush()
    // A pre-commit hook that hangs; the commit must fail with a timeout instead of wedging the chain.
    const hook = join(root, '.git', 'hooks', 'pre-commit')
    await writeFile(hook, '#!/bin/sh\nsleep 5\n')
    await chmod(hook, 0o755)
    await store.addComment(store.all()[0]!.id, 'x', agent)
    await until(async () => !!g.status().commitError, 4000)
    expect(g.status().commitError).toContain('timed out')
    await unlink(hook)
  })

  test('stop() unsubscribes and clears timers', async () => {
    const g = startGit(store, { commitDelayMs: 50, pushDelayMs: 100 }); handle = g
    await g.flush()
    const before = await count()
    g.stop()
    await store.addComment(store.all()[0]!.id, 'x', agent)
    await Bun.sleep(200)
    expect(await count()).toBe(before)
  })
})

describe('files outside issues and meta', () => {
  test('a file event commits as external: edited <path>', async () => {
    const g = startGit(store, { commitDelayMs: 50, pushDelayMs: 60_000 }); handle = g
    await g.flush()
    const before = await count()
    await writeFile(join(root, 'AGENTS.md'), '# rules, edited by hand\n')
    ;(store as any).emit({ kind: 'file', path: 'AGENTS.md' })
    expect(g.status().pending).toBe(true)
    await until(async () => (await count()) > before)
    expect(await git(root, 'log', '-1', '--format=%s')).toBe('external: edited AGENTS.md')
    expect(await git(root, 'status', '--porcelain')).toBe('')
  })
})

describe('fix round 1', () => {
  test('a deleted file commits as external: deleted <path>', async () => {
    const g = startGit(store, { commitDelayMs: 50, pushDelayMs: 60_000 }); handle = g
    await writeFile(join(root, 'notes.md'), 'x\n')
    await g.flush()
    const before = await count()
    await unlink(join(root, 'notes.md'))
    ;(store as any).emit({ kind: 'file', path: 'notes.md', deleted: true })
    await until(async () => (await count()) > before)
    expect(await git(root, 'log', '-1', '--format=%s')).toBe('external: deleted notes.md')
  })

  test('refresh() sees a hand-made commit (ahead) and a dirty tree (pending) without a store event', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'tracker-bare-')); extra.push(bare)
    await git(bare, 'init', '--bare', '-b', 'main')
    const g = startGit(store, { commitDelayMs: 60_000, pushDelayMs: 60_000 }); handle = g
    await g.flush()
    await git(root, 'remote', 'add', 'origin', bare)
    await g.sync()
    expect(g.status().ahead).toBe(0)
    await writeFile(join(root, 'hand.md'), 'by hand\n')
    await git(root, 'add', '-A')
    await git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'by hand')
    await writeFile(join(root, 'dirty.md'), 'not committed\n')
    expect(g.status().ahead).toBe(0) // cached
    const st = await g.refresh()
    expect(st).toMatchObject({ ahead: 1, pending: true, remote: true })
    expect(g.status()).toMatchObject({ ahead: 1, pending: true })
    await g.sync()
    expect(g.status()).toMatchObject({ ahead: 0, pending: false })
  })
})

describe('final fix: startup git maintenance', () => {
  const tmpName = '.Q-1.md.0123456789ab.tmp'
  test('adds the temp-file pattern to .gitignore once, keeping existing lines', async () => {
    await writeFile(join(root, '.gitignore'), '.tracker/\n/projects/x/big.mp4')
    const g = startGit(store, { commitDelayMs: 50, pushDelayMs: 60_000 }); handle = g
    await g.flush()
    const gi = await Bun.file(join(root, '.gitignore')).text()
    expect(gi).toBe('.tracker/\n/projects/x/big.mp4\n.*.tmp\n\\#*#\n~$*\n')
    g.stop(); handle = undefined
    const g2 = startGit(store, { commitDelayMs: 50, pushDelayMs: 60_000 }); handle = g2
    await g2.flush()
    expect(await Bun.file(join(root, '.gitignore')).text()).toBe(gi)
    expect(await git(root, 'status', '--porcelain')).toBe('')
    expect(await git(root, 'check-ignore', 'projects/support/issues/' + tmpName)).toBe('projects/support/issues/' + tmpName)
  })

  test('creates .gitignore with the pattern when missing', async () => {
    const g = startGit(store, { commitDelayMs: 50, pushDelayMs: 60_000 }); handle = g
    await g.flush()
    expect(await Bun.file(join(root, '.gitignore')).text()).toBe('.*.tmp\n\\#*#\n~$*\n')
  })

  test('untracks temp files that were committed earlier', async () => {
    await git(root, 'init', '-b', 'main')
    const p = join(root, 'projects', 'support', 'issues', tmpName)
    await writeFile(p, 'partial')
    await git(root, 'add', '-A')
    await git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'crash leftovers')
    expect(await git(root, 'ls-files', 'projects/support/issues')).toContain(tmpName)
    const g = startGit(store, { commitDelayMs: 50, pushDelayMs: 60_000 }); handle = g
    await g.flush()
    expect(await git(root, 'ls-files')).not.toContain('.tmp')
    expect(await git(root, 'status', '--porcelain')).toBe('')
    expect(await git(root, 'log', '-1', '--format=%s')).toContain('untrack')
  })

  test('commits a dirty working tree found at startup', async () => {
    const g = startGit(store, { commitDelayMs: 50, pushDelayMs: 60_000 }); handle = g
    await g.flush()
    g.stop(); handle = undefined
    const before = await count()
    await writeFile(join(root, 'notes.md'), 'written while the engine was down\n')
    const g2 = startGit(store, { commitDelayMs: 50, pushDelayMs: 60_000 }); handle = g2
    await until(async () => (await count()) > before)
    expect(await git(root, 'log', '-1', '--format=%s')).toBe('external: recovered uncommitted changes')
    expect(await git(root, 'status', '--porcelain')).toBe('')
  })
})

describe('sync and backup status', () => {
  const slow = { commitDelayMs: 60_000, pushDelayMs: 60_000 }
  const bareRemote = async () => {
    const bare = await mkdtemp(join(tmpdir(), 'tracker-bare-')); extra.push(bare)
    await git(bare, 'init', '--bare', '-b', 'main')
    return bare
  }

  test('status reports pending writes and no remote', async () => {
    const g = startGit(store, slow); handle = g
    await g.flush()
    expect(g.status()).toMatchObject({ pending: false, ahead: 0, remote: false })
    await store.updateIssue(store.all()[0]!.id, { priority: bump(store.all()[0]!.priority) }, agent)
    expect(g.status().pending).toBe(true)
    await g.flush()
    expect(g.status().pending).toBe(false)
  })

  test('sync commits now (no remote): committed, not pushed, ok', async () => {
    const g = startGit(store, slow); handle = g
    await g.flush()
    const before = await count()
    await store.addComment(store.all()[0]!.id, 'now please', agent)
    const r = await g.sync()
    expect(r).toEqual({ ok: true, committed: true, pushed: false })
    expect(await count()).toBe(before + 1)
    expect(g.status().pending).toBe(false)
    expect(await g.sync()).toEqual({ ok: true, committed: false, pushed: false })
  })

  test('sync commits a dirty tree that no store event announced', async () => {
    const g = startGit(store, slow); handle = g
    await g.flush()
    await writeFile(join(root, 'notes.md'), 'hand-written\n')
    const r = await g.sync()
    expect(r.committed).toBe(true)
    expect(await git(root, 'status', '--porcelain')).toBe('')
  })

  test('ahead counts commits not on origin; sync pushes and resets it', async () => {
    const bare = await bareRemote()
    const g = startGit(store, slow); handle = g
    await g.flush()
    await git(root, 'remote', 'add', 'origin', bare)
    await store.addComment(store.all()[0]!.id, 'one', agent)
    expect((await g.sync({ push: false })).committed).toBe(true)
    // Never pushed: every commit is ahead.
    expect(g.status()).toMatchObject({ remote: true, ahead: await count(), pending: false })
    const r = await g.sync()
    expect(r).toEqual({ ok: true, committed: false, pushed: true })
    expect(g.status().ahead).toBe(0)
    expect(g.status().lastPush).toBeTruthy()
    await store.addComment(store.all()[0]!.id, 'two', agent)
    await g.sync({ push: false })
    expect(g.status().ahead).toBe(1)
  })

  test('sync reports a push failure (redacted) after committing', async () => {
    const g = startGit(store, slow); handle = g
    await g.flush()
    await git(root, 'remote', 'add', 'origin', 'https://user:secret@127.0.0.1:9/x.git')
    await store.addComment(store.all()[0]!.id, 'x', agent)
    const r = await g.sync()
    expect(r.ok).toBe(false)
    expect(r.committed).toBe(true)
    expect(r.pushed).toBe(false)
    expect(r.pushError).toBeTruthy()
    expect(r.pushError).not.toContain('secret')
  })

  test('sync reports a commit failure and keeps the change pending', async () => {
    const g = startGit(store, slow); handle = g
    await g.flush()
    const hook = join(root, '.git', 'hooks', 'pre-commit')
    await writeFile(hook, '#!/bin/sh\necho hook says no >&2\nexit 1\n')
    await chmod(hook, 0o755)
    await store.addComment(store.all()[0]!.id, 'x', agent)
    const r = await g.sync()
    expect(r).toMatchObject({ ok: false, committed: false, pushed: false })
    expect(r.commitError).toContain('hook says no')
    expect(g.status().pending).toBe(true)
    await unlink(hook)
    expect((await g.sync()).committed).toBe(true)
  })

  test('lastPush survives a restart (read from the tracking ref)', async () => {
    const bare = await bareRemote()
    const g = startGit(store, slow); handle = g
    await g.flush()
    await git(root, 'remote', 'add', 'origin', bare)
    await g.sync()
    g.stop(); handle = undefined
    const g2 = startGit(store, slow); handle = g2
    await g2.flush()
    expect(g2.status().lastPush).toBeTruthy()
    expect(g2.status()).toMatchObject({ remote: true, ahead: 0, pending: false })
  })
})
