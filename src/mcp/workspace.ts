import { statSync } from 'node:fs'
import { basename, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aittEnv } from '../shared/env'

function git(cwd: string, ...args: string[]): string | undefined {
  try {
    const r = Bun.spawnSync(['git', ...args], { cwd, timeout: 2000, stdout: 'pipe', stderr: 'ignore' })
    if (r.exitCode !== 0) return undefined
    return r.stdout.toString().trim() || undefined
  } catch {
    return undefined
  }
}

/** The workspace per folder (it never changes); the branch is not cached, since a session can switch branches. */
const cache = new Map<string, { workspace: string; inGit: boolean }>()

/**
 * Workspace = main worktree's folder name (a linked worktree maps to its main repo), else the cwd's basename.
 * The branch is read on every call.
 */
export function resolveWorkspace(cwd: string): { workspace: string; branch?: string } {
  let hit = cache.get(cwd)
  if (!hit) {
    const top = git(cwd, 'rev-parse', '--show-toplevel')
    // Main worktree = parent of a `.git` common dir; a submodule's common dir is .git/modules/x, so use its toplevel.
    const common = top ? git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir') : undefined
    hit = top
      ? { workspace: basename(common && basename(common) === '.git' ? dirname(common) : top), inGit: true }
      : { workspace: basename(cwd), inGit: false }
    cache.set(cwd, hit)
  }
  const branch = hit.inGit ? git(cwd, 'branch', '--show-current') : undefined
  return branch ? { workspace: hit.workspace, branch } : { workspace: hit.workspace }
}

/** System places an MCP client may start us in that are not anyone's project. */
const NOT_PROJECT = /^\/(Applications|System|Library|usr|bin|sbin|opt)(\/|$)|\.app(\/|$)/

/** False for `/`, the home folder or its ancestors, app bundles and system folders: a cwd that says nothing about the work. */
export function isProjectDir(cwd: string, userHome: string): boolean {
  if (cwd === '/' || cwd === userHome || userHome.startsWith(`${cwd}/`)) return false
  return !NOT_PROJECT.test(cwd)
}

const isDir = (p: string) => { try { return statSync(p).isDirectory() } catch { return false } }

/**
 * A workspace name from outside (env, a client's root): its last path segment, without control characters.
 * `.` and `..` name no folder, so they give '' (no workspace) like an empty name.
 */
export const cleanName = (s: string) => {
  const name = basename(s.replace(/[\u0000-\u001f\u007f]/g, '').trim()).trim()
  return name === '.' || name === '..' ? '' : name
}

/**
 * The session's workspace. A project cwd wins (command-line tools start servers in the project).
 * Otherwise (desktop apps start them in `/` or $HOME): the client's first file:// MCP root that names a folder,
 * else AITT_WORKSPACE (a folder path or a workspace name), else the cwd as before (`/` gives '').
 */
export async function resolveSessionWorkspace(opts: {
  cwd: string; userHome: string; env: Record<string, string | undefined>; listRoots?: () => Promise<string[]>
}): Promise<{ workspace: string; branch?: string; via: 'cwd' | 'roots' | 'env'; dir?: string }> {
  const { cwd, userHome, env } = opts
  // `dir` is the folder the workspace came from: the caller re-reads its branch on each write.
  if (isProjectDir(cwd, userHome)) return { ...resolveWorkspace(cwd), via: 'cwd', dir: cwd }
  const uris = await (opts.listRoots?.() ?? Promise.resolve([])).catch(() => [] as string[])
  for (const uri of uris.filter((u) => u.startsWith('file://'))) {
    let r: { workspace: string; branch?: string }
    let dir: string
    try { dir = fileURLToPath(uri); r = resolveWorkspace(dir) } catch { continue } // malformed URI
    const workspace = cleanName(r.workspace)
    if (workspace) return { ...r, workspace, via: 'roots', dir }
  }
  const named = aittEnv('WORKSPACE', env)?.trim()
  if (named) {
    if (isAbsolute(named) && isDir(named)) {
      const r = resolveWorkspace(named)
      return { ...r, workspace: cleanName(r.workspace), via: 'env', dir: named }
    }
    return { workspace: cleanName(named), via: 'env' }
  }
  return { ...resolveWorkspace(cwd), via: 'cwd', dir: cwd }
}

/** A process: its parent, its executable path (`ps -o comm`, spaces intact) and, for script runners, its arguments. */
export interface ProcInfo { ppid: number; exe: string; args?: string }

const RUNNER = /(^|\/)(node|bun|deno)$/

function psField(pid: number, field: string): string | undefined {
  try {
    const r = Bun.spawnSync(['/bin/ps', '-o', field, '-p', String(pid)], { timeout: 2000, stdout: 'pipe', stderr: 'ignore' })
    return r.exitCode === 0 ? r.stdout.toString().trim() : undefined
  } catch {
    return undefined
  }
}

function psInfo(pid: number): ProcInfo | undefined {
  const m = psField(pid, 'ppid=,comm=')?.match(/^(\d+)\s+(.*)$/)
  if (!m) return undefined
  const exe = m[2] ?? ''
  // A second call only for node/bun/deno, whose script (in the arguments) says which tool it is.
  return RUNNER.test(exe) ? { ppid: Number(m[1]), exe, args: psField(pid, 'args=') ?? '' } : { ppid: Number(m[1]), exe }
}

/** Desktop apps: any process inside the bundle (main app or a helper) counts. */
const APP_CLIENTS: [RegExp, string][] = [
  [/\/Cursor\.app\//, 'cursor'],
  [/\/(Visual Studio Code( - Insiders)?|VSCodium)\.app\//, 'vscode'],
  [/\/Windsurf\.app\//, 'windsurf'],
  [/\/Claude\.app\//, 'claude-desktop'],
]
/** CLIs: [executable name, script inside a node/bun/deno command line]. */
const CLI_CLIENTS: [RegExp, RegExp, string][] = [
  [/(^|\/)claude$/, /@anthropic-ai\/claude-code\/|\/claude(\.js)?(\s|$)/, 'claude-code'],
  [/(^|\/)codex(-[\w-]+)?$/, /@openai\/codex\/|\/codex(\.js)?(\s|$)/, 'codex'],
  [/(^|\/)gemini$/, /@google\/gemini-cli\/|\/gemini(\.js)?(\s|$)/, 'gemini'],
]

/** The agent tool a process belongs to, from its executable path (and a runner's arguments), or undefined. */
export function clientOf(exe: string, args?: string): string | undefined {
  for (const [re, name] of APP_CLIENTS) if (re.test(exe)) return name
  const runner = RUNNER.test(exe)
  for (const [bin, script, name] of CLI_CLIENTS) if (bin.test(exe) || (runner && args && script.test(args))) return name
  return undefined
}

/**
 * Walk up from `ppid` to the nearest known agent tool. Its pid is the session id (rule 3 remembers a session's
 * recent comment); an unknown chain gives neither, and closing moves then need a `comment` argument.
 */
export function findClient(ppid: number, ps: (pid: number) => ProcInfo | undefined = psInfo): { client?: string; session?: string } {
  for (let cur = ppid, hops = 0; cur > 1 && hops < 20; hops++) {
    const info = ps(cur)
    if (!info) return {}
    const client = clientOf(info.exe, info.args)
    if (client) return { client, session: String(cur) }
    cur = info.ppid
  }
  return {}
}
