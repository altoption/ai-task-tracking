import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cleanName, clientOf, findClient, isProjectDir, resolveSessionWorkspace, resolveWorkspace } from '../../src/mcp/workspace'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'tracker-ws-')))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
}

describe('resolveWorkspace', () => {
  test('plain folder -> basename', () => {
    const d = join(base, 'plain-dir'); mkdirSync(d)
    expect(resolveWorkspace(d)).toEqual({ workspace: 'plain-dir' })
  })
  test('git repo -> repo name and branch', () => {
    const d = join(base, 'my-repo'); mkdirSync(d)
    git(d, 'init', '-q', '-b', 'feat/x'); git(d, 'commit', '-q', '--allow-empty', '-m', 'init')
    mkdirSync(join(d, 'sub'))
    expect(resolveWorkspace(join(d, 'sub'))).toEqual({ workspace: 'my-repo', branch: 'feat/x' })
  })
  test('the branch is read fresh on each call (a session can switch branches)', () => {
    const d = join(base, 'switching'); mkdirSync(d)
    git(d, 'init', '-q', '-b', 'main'); git(d, 'commit', '-q', '--allow-empty', '-m', 'init')
    expect(resolveWorkspace(d).branch).toBe('main')
    git(d, 'switch', '-q', '-c', 'feat/later')
    expect(resolveWorkspace(d)).toEqual({ workspace: 'switching', branch: 'feat/later' })
  })
  test('linked worktree -> main repo name', () => {
    const d = join(base, 'main-repo'); mkdirSync(d)
    git(d, 'init', '-q', '-b', 'main'); git(d, 'commit', '-q', '--allow-empty', '-m', 'init')
    const wt = join(base, 'main-repo-wt')
    git(d, 'worktree', 'add', '-q', '-b', 'side', wt)
    expect(resolveWorkspace(wt)).toEqual({ workspace: 'main-repo', branch: 'side' })
  })
})

describe('submodule', () => {
  test('submodule -> its own name, not the superproject', () => {
    const sub = join(base, 'sub-origin'); mkdirSync(sub)
    git(sub, 'init', '-q', '-b', 'main'); git(sub, 'commit', '-q', '--allow-empty', '-m', 'init')
    const sup = join(base, 'super'); mkdirSync(sup)
    git(sup, 'init', '-q', '-b', 'main'); git(sup, 'commit', '-q', '--allow-empty', '-m', 'init')
    git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor-lib')
    expect(resolveWorkspace(join(sup, 'vendor-lib')).workspace).toBe('vendor-lib')
  })
})

describe('findClient (injected ps)', () => {
  const table: Record<number, { ppid: number; exe: string; args?: string }> = {
    // Claude Code (native binary) in a zsh in VS Code's terminal: the nearest known client wins.
    50: { ppid: 40, exe: '/home/u/Applications/AI Task Tracking.app/Contents/Resources/aitt' },
    40: { ppid: 30, exe: '/usr/local/bin/claude' }, 30: { ppid: 20, exe: '-zsh' },
    20: { ppid: 1, exe: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron' },
    // Cursor's extension host
    61: { ppid: 60, exe: '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)' },
    60: { ppid: 1, exe: '/Applications/Cursor.app/Contents/MacOS/Cursor' },
    // Codex (npm launcher → native binary), Gemini CLI (node script), Windsurf, Claude Desktop
    71: { ppid: 70, exe: '/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex' },
    70: { ppid: 1, exe: '/opt/homebrew/bin/node', args: 'node /opt/homebrew/bin/codex' },
    81: { ppid: 1, exe: 'node', args: 'node /opt/homebrew/bin/gemini' },
    82: { ppid: 1, exe: '/usr/local/bin/node', args: 'node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume' },
    91: { ppid: 1, exe: '/Applications/Windsurf.app/Contents/Frameworks/Windsurf Helper (Plugin).app/Contents/MacOS/Windsurf Helper (Plugin)' },
    92: { ppid: 1, exe: '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper' },
    93: { ppid: 1, exe: '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)' },
    // CLIs installed under a folder with spaces: the executable path comes whole from ps -o comm
    94: { ppid: 1, exe: '/home/u/My Tools/bin/codex' },
    95: { ppid: 1, exe: '/home/u/Agent Tools/node', args: '/home/u/Agent Tools/node /home/u/Agent Tools/gemini' },
    99: { ppid: 98, exe: '/opt/homebrew/bin/bun', args: 'bun src/cli.ts mcp' }, 98: { ppid: 1, exe: '/sbin/launchd' },
  }
  const ps = (pid: number) => table[pid]
  test('walks up to the nearest known client; its pid is the session', () => {
    expect(findClient(50, ps)).toEqual({ client: 'claude-code', session: '40' })
  })
  test.each([
    [61, 'cursor', '61'], [71, 'codex', '71'], [81, 'gemini', '81'], [82, 'claude-code', '82'],
    [91, 'windsurf', '91'], [92, 'claude-desktop', '92'], [93, 'vscode', '93'], [20, 'vscode', '20'],
    [94, 'codex', '94'], [95, 'gemini', '95'],
  ])('pid %d -> %s', (pid, client, session) => expect(findClient(pid as number, ps)).toEqual({ client: client as string, session: session as string }))
  test('unknown parent chain -> no client, no session', () => expect(findClient(99, ps)).toEqual({}))
  test('ps failing -> no client', () => expect(findClient(12345, ps)).toEqual({}))
  test('our own app bundle is not mistaken for Claude Desktop', () => expect(clientOf(table[50]!.exe)).toBeUndefined())
  test('the real ps finds this process\'s executable', () => {
    // Not asserting a client (depends on who runs the tests); just that the live walk doesn't throw.
    expect(typeof findClient(process.ppid)).toBe('object')
  })
})

describe('isProjectDir', () => {
  const home = '/home/u'
  test.each([
    ['/', false], [home, false], ['/home', false], ['/Applications/Cursor.app/Contents/Resources', false],
    ['/home/u/Applications/AI Task Tracking.app', false], ['/System/Library', false],
    ['/home/u/code/web', true], ['/tmp/x', true],
  ])('%s -> %p', (cwd, want) => expect(isProjectDir(cwd as string, home)).toBe(want as boolean))
})

describe('resolveSessionWorkspace', () => {
  const fakeHome = join(base, 'home'); mkdirSync(fakeHome)
  const repo = join(base, 'roots-repo'); mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'dev'); git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  const roots = (...uris: string[]) => async () => uris
  test('cwd inside a project -> the cwd (roots are not asked)', async () => {
    let asked = false
    const r = await resolveSessionWorkspace({ cwd: repo, userHome: fakeHome, env: {}, listRoots: async () => { asked = true; return [] } })
    expect(r).toEqual({ workspace: 'roots-repo', branch: 'dev', via: 'cwd', dir: repo })
    expect(asked).toBe(false)
  })
  test('cwd is $HOME -> the first file:// root', async () => {
    const r = await resolveSessionWorkspace({ cwd: fakeHome, userHome: fakeHome, env: { AITT_WORKSPACE: 'ignored' }, listRoots: roots('https://example.com/x', pathToFileURL(repo).href, 'file:///other') })
    expect(r).toEqual({ workspace: 'roots-repo', branch: 'dev', via: 'roots', dir: repo })
  })
  test('no roots (or the client fails) -> AITT_WORKSPACE as a name', async () => {
    const fail = async (): Promise<string[]> => { throw new Error('Method not found') }
    expect(await resolveSessionWorkspace({ cwd: '/', userHome: fakeHome, env: { AITT_WORKSPACE: 'website' }, listRoots: fail }))
      .toEqual({ workspace: 'website', via: 'env' })
  })
  test('AITT_WORKSPACE as a folder path resolves like a cwd', async () => {
    expect(await resolveSessionWorkspace({ cwd: '/', userHome: fakeHome, env: { AITT_WORKSPACE: repo }, listRoots: roots() }))
      .toEqual({ workspace: 'roots-repo', branch: 'dev', via: 'env', dir: repo })
  })
  test('nothing else -> the cwd basename, as before', async () => {
    expect(await resolveSessionWorkspace({ cwd: fakeHome, userHome: fakeHome, env: {} })).toEqual({ workspace: 'home', via: 'cwd', dir: fakeHome })
  })
})

describe('resolveSessionWorkspace: fallbacks behave as before', () => {
  const fakeHome = join(base, 'home2'); mkdirSync(fakeHome)
  test('cwd "/" (Claude Desktop) with no roots and no env -> "" as before, never "/"', async () => {
    expect(resolveWorkspace('/').workspace).toBe('')
    expect((await resolveSessionWorkspace({ cwd: '/', userHome: fakeHome, env: {} })).workspace).toBe('')
  })
  test('a file:/// root names nothing: falls through to env, else ""', async () => {
    const roots = async () => ['file:///']
    expect((await resolveSessionWorkspace({ cwd: '/', userHome: fakeHome, env: {}, listRoots: roots })).workspace).toBe('')
    expect(await resolveSessionWorkspace({ cwd: '/', userHome: fakeHome, env: { AITT_WORKSPACE: 'web' }, listRoots: roots }))
      .toEqual({ workspace: 'web', via: 'env' })
  })
  test('AITT_WORKSPACE and roots names are sanitized: basename, no control characters or newlines; empty -> ""', async () => {
    const r = (v: string) => resolveSessionWorkspace({ cwd: '/', userHome: fakeHome, env: { AITT_WORKSPACE: v } })
    expect((await r('team/web\napp')).workspace).toBe('webapp')
    expect((await r('evil\u0007\u001b[31m')).workspace).toBe('evil[31m')
    expect((await r('\n\t')).workspace).toBe('')
    const odd = join(base, 'odd\nname'); mkdirSync(odd)
    const viaRoot = await resolveSessionWorkspace({ cwd: '/', userHome: fakeHome, env: {}, listRoots: async () => [pathToFileURL(odd).href] })
    expect(viaRoot).toEqual({ workspace: 'oddname', via: 'roots', dir: odd })
  })
  test('cleanName: "." and ".." (alone or as the last segment) name nothing', () => {
    for (const v of ['.', '..', ' .. ', 'a/..', 'a/.', '../', './', '.\u0007.']) expect(cleanName(v)).toBe('')
    expect(cleanName('...')).toBe('...')
    expect(cleanName('.hidden')).toBe('.hidden')
  })
  test('AITT_WORKSPACE=".." falls back to "" rather than naming a workspace ".."', async () => {
    const r = await resolveSessionWorkspace({ cwd: '/', userHome: fakeHome, env: { AITT_WORKSPACE: '..' } })
    expect(r.workspace).toBe('')
  })
})
