import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepoMap, reposPath } from '../../src/engine/repos'
import { repoDirOf } from '../../src/mcp/workspace'

process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text())
}

let scratch: string
let home: string
let repo: string
const quiet = () => {}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'aitt-repos-'))
  home = join(scratch, 'home')
  await mkdir(home)
  repo = join(scratch, 'shop')
  await git(scratch, 'init', '-q', '-b', 'main', repo)
  await writeFile(join(repo, 'f'), 'x')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'x')
})
afterAll(async () => { await rm(scratch, { recursive: true, force: true }) })

describe('repoDirOf (proxy side)', () => {
  test('a subfolder and a linked worktree both give the main worktree folder', async () => {
    await mkdir(join(repo, 'sub'), { recursive: true })
    expect(repoDirOf(join(repo, 'sub'))).toBe(await realpath(repo))
    const wt = join(scratch, 'shop-wt')
    await git(repo, 'worktree', 'add', '-q', '-b', 'feat/wt', wt)
    expect(repoDirOf(wt)).toBe(await realpath(repo))
  })
  test('outside git: none', async () => {
    const plain = join(scratch, 'plain')
    await mkdir(plain)
    expect(repoDirOf(plain)).toBeUndefined()
  })
})

const realpath = async (p: string) => (await import('node:fs/promises')).realpath(p)

describe('RepoMap', () => {
  test('learns a repo whose folder name is the workspace, persists it, and finds it after a restart', async () => {
    const m = await RepoMap.open(home, quiet)
    await m.learn('shop', repo)
    expect(await m.lookup('shop')).toBe(repo)
    const saved = JSON.parse(await readFile(reposPath(home), 'utf8'))
    expect(saved.shop.dir).toBe(repo)
    expect(await (await RepoMap.open(home, quiet)).lookup('shop')).toBe(repo)
  })
  test('ignores a name mismatch, a relative path, a non-repo folder and non-strings', async () => {
    const m = await RepoMap.open(join(scratch, 'h2'), quiet)
    const plain = join(scratch, 'notrepo')
    await mkdir(plain)
    await m.learn('other', repo)
    await m.learn('shop', 'shop')
    await m.learn('notrepo', plain)
    await m.learn('shop', 42)
    await m.learn('__proto__', repo)
    for (const w of ['other', 'shop', 'notrepo', '__proto__', 'constructor']) expect(await m.lookup(w)).toBeUndefined()
  })
  test('a moved repo reads as unknown', async () => {
    const dir = join(scratch, 'moving')
    await git(scratch, 'init', '-q', dir)
    const m = await RepoMap.open(join(scratch, 'h3'), quiet)
    await m.learn('moving', dir)
    expect(await m.lookup('moving')).toBe(dir)
    await rename(dir, join(scratch, 'moved'))
    expect(await m.lookup('moving')).toBeUndefined()
    // A plain folder now at the old path is not a repo.
    await mkdir(dir)
    expect(await m.lookup('moving')).toBeUndefined()
  })
})
