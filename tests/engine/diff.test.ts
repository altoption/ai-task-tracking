import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseOf, branchDiff, parseNumstat, plausibleBranch, runGit, splitPatch } from '../../src/engine/diff'

// Isolate from the user's git config.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  if ((await p.exited) !== 0) throw new Error(`git ${args.join(' ')}: ${await new Response(p.stderr).text()}`)
  return out.trim()
}

let scratch: string
let repo: string

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'aitt-diff-'))
  repo = join(scratch, 'shop')
  await git(scratch, 'init', '-q', '-b', 'main', repo)
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  await writeFile(join(repo, 'old-name.txt'), 'keep me\n'.repeat(20))
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'base')
  await git(repo, 'switch', '-q', '-c', 'feat/table')
  await writeFile(join(repo, 'a.txt'), 'one\n2\nthree\nfour\n')
  await git(repo, 'mv', 'old-name.txt', 'new-name.txt')
  await writeFile(join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0, 3]))
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'Feature table')
  // main moves on after the branch left it: those changes must not show.
  await git(repo, 'switch', '-q', 'main')
  await writeFile(join(repo, 'main-only.txt'), 'later\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'later on main')
  await git(repo, 'branch', 'same-as-main')
})
afterAll(async () => { await rm(scratch, { recursive: true, force: true }) })

describe('pure parts', () => {
  test('parseNumstat reads counts, binaries and renames', () => {
    expect(parseNumstat('3\t1\ta.txt\0-\t-\tlogo.png\x000\t0\t\0old.txt\0new.txt\0')).toEqual([
      { path: 'a.txt', added: 3, removed: 1, binary: false },
      { path: 'logo.png', added: 0, removed: 0, binary: true },
      { path: 'new.txt', oldPath: 'old.txt', added: 0, removed: 0, binary: false },
    ])
  })
  test('splitPatch cuts at each file header', () => {
    expect(splitPatch('diff --git a/x b/x\n+1\ndiff --git a/y b/y\n-2\n')).toEqual(['diff --git a/x b/x\n+1\n', 'diff --git a/y b/y\n-2\n'])
    expect(splitPatch('')).toEqual([])
  })
  test('plausibleBranch refuses option-like and odd names', () => {
    for (const b of ['feat/x', 'jolt-8-verify', 'a.b_c']) expect(plausibleBranch(b)).toBe(true)
    for (const b of ['', '-p', '--output=/tmp/x', 'a b', 'a..b~1', 'x:y', 'a\nb']) expect(plausibleBranch(b)).toBe(false)
  })
})

describe('branchDiff', () => {
  test('diffs the branch from where it left main, not against main today', async () => {
    const d = await branchDiff(repo, 'feat/table')
    expect(d.state).toBe('ok')
    expect(d.base).toBe('main')
    expect(d.commits!.map((c) => c.subject)).toEqual(['Feature table'])
    const byPath = Object.fromEntries(d.files!.map((f) => [f.path, f]))
    expect(Object.keys(byPath).sort()).toEqual(['a.txt', 'logo.png', 'new-name.txt'])
    expect(byPath['a.txt']).toMatchObject({ added: 2, removed: 1, binary: false })
    expect(byPath['a.txt']!.patch).toContain('+four')
    expect(byPath['logo.png']!.binary).toBe(true)
    expect(byPath['new-name.txt']!.oldPath).toBe('old-name.txt')
    expect(d.truncated).toBeUndefined()
  })
  test('states: same, branch-gone, bad name, no base', async () => {
    expect((await branchDiff(repo, 'same-as-main')).state).toBe('same')
    expect((await branchDiff(repo, 'nope')).state).toBe('branch-gone')
    expect((await branchDiff(repo, '--output=/tmp/x')).state).toBe('error')
    const lone = join(scratch, 'lone')
    await git(scratch, 'init', '-q', '-b', 'trunk', lone)
    await writeFile(join(lone, 'f'), 'x')
    await git(lone, 'add', '.')
    await git(lone, 'commit', '-q', '-m', 'x')
    await git(lone, 'branch', 'feat/y')
    expect(await baseOf(lone)).toBeUndefined()
    expect((await branchDiff(lone, 'feat/y')).state).toBe('no-base')
  })
  test('a big patch is cut off and flagged', async () => {
    const r = await runGit(repo, ['log', '-p', 'feat/table'], { maxBytes: 64 })
    expect(r.ok).toBe(true)
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.out)).toBeLessThanOrEqual(64)
  })
  test('a hanging git is stopped by the timeout', async () => {
    const slow = await runGit(repo, ['-c', 'alias.slow=!sleep 5', 'slow'], { timeoutMs: 200 })
    expect(slow.ok).toBe(false)
    expect(slow.err).toContain('timed out')
  })
})

describe('a repo whose config tries to run programs', () => {
  test('diff, log, merge-base and rev-parse run none of them', async () => {
    const evil = join(scratch, 'evil')
    await git(scratch, 'init', '-q', '-b', 'main', evil)
    await writeFile(join(evil, 'f.txt'), 'a\n')
    await writeFile(join(evil, '.gitattributes'), '*.txt diff=boom\n')
    await git(evil, 'add', '.')
    await git(evil, 'commit', '-q', '-m', 'base')
    await git(evil, 'switch', '-q', '-c', 'feat/z')
    await writeFile(join(evil, 'f.txt'), 'b\n')
    await git(evil, 'commit', '-q', '-am', 'change')
    // Make the branch head look signed, so a signature check would call gpg.program.
    const body = await git(evil, 'cat-file', 'commit', 'HEAD')
    const signed = body.replace(/^(committer .*)$/m, '$1\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQ==\n -----END PGP SIGNATURE-----')
    const obj = join(scratch, 'signed-commit')
    await writeFile(obj, `${signed}\n`)
    await git(evil, 'update-ref', 'refs/heads/feat/z', await git(evil, 'hash-object', '-t', 'commit', '-w', obj))
    const marker = join(scratch, 'pwned')
    const script = join(scratch, 'boom.sh')
    await writeFile(script, `#!/bin/sh\ntouch "${marker}"\n`)
    await chmod(script, 0o755)
    const hooks = join(scratch, 'hooks')
    await Bun.write(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch "${marker}"\n`)
    for (const [k, v] of [
      ['core.fsmonitor', script], ['core.hooksPath', hooks], ['core.pager', script], ['diff.external', script],
      ['diff.boom.textconv', script], ['diff.boom.command', script], ['log.showSignature', 'true'], ['gpg.program', script],
      ['pager.diff', script], ['pager.log', script], ['core.sshCommand', script],
    ]) await git(evil, 'config', k!, v!)
    // Sanity: the planted config does fire for a plain git call.
    const fired = async (args: string[]) => {
      await Bun.spawn(['git', ...args], { cwd: evil, stdout: 'ignore', stderr: 'ignore' }).exited
      const hit = existsSync(marker)
      await rm(marker, { force: true })
      return hit
    }
    expect(await fired(['diff', 'main', 'feat/z'])).toBe(true)
    expect(await fired(['log', '-1', 'feat/z'])).toBe(true)

    const d = await branchDiff(evil, 'feat/z')
    expect(d.state).toBe('ok')
    expect(d.files![0]!.patch).toContain('+b')
    expect(d.commits!.map((c) => c.subject)).toEqual(['change'])
    expect(existsSync(marker)).toBe(false)
  })
})
