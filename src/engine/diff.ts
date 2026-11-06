/**
 * Branch diffs for the issue page's Changes panel: what an agent's branch changes against the repo's base branch.
 *
 * Every git call goes through `runGit`, which switches off everything in a repo's config that can start another
 * program (fsmonitor, hooks, external diff and textconv drivers, commit signature checks, pagers, lazy fetches of
 * missing objects). Only refs are compared, never the working tree, so clean/smudge filters never run. The caller
 * passes a repo folder the engine learned itself (src/engine/repos.ts) and a branch the issue recorded; nothing here
 * takes a path or a ref from a request.
 */

/** Config that, set in a repo, would make the commands below run something. Command-line `-c` outranks repo config. */
const SAFE_CONFIG = [
  'core.fsmonitor=', 'core.hooksPath=/dev/null', 'core.pager=cat', 'core.sshCommand=false', 'core.quotePath=false',
  'diff.external=', 'log.showSignature=false', 'gpg.program=false', 'protocol.allow=never', 'color.ui=false',
].flatMap((c) => ['-c', c])

/** Variables passed through to git; anything else (GIT_DIR, GIT_WORK_TREE, GIT_EXTERNAL_DIFF, …) is dropped. */
const PASS_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']

export const DIFF_TIMEOUT_MS = 5000
/** The patch is cut off after this many bytes (`truncated` is set). */
export const DIFF_MAX_BYTES = 2 * 1024 * 1024
export const MAX_COMMITS = 50

export interface GitRun { ok: boolean; out: string; err: string; truncated: boolean }

/** Run `git <args>` in `dir` with the safe config, a timeout and an output cap. Never throws. */
export async function runGit(dir: string, args: string[], opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<GitRun> {
  const timeoutMs = opts.timeoutMs ?? DIFF_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? DIFF_MAX_BYTES
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_ASKPASS: 'false' }
  for (const k of PASS_ENV) { const v = process.env[k]; if (v !== undefined) env[k] = v }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const p = Bun.spawn(['git', '--no-pager', ...SAFE_CONFIG, ...args], { cwd: dir, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const read = async () => {
      const chunks: Uint8Array[] = []
      let size = 0
      let truncated = false
      const reader = p.stdout.getReader()
      for (;;) {
        const { done, value: c } = await reader.read()
        if (done) break
        if (size + c.length > maxBytes) { chunks.push(c.subarray(0, maxBytes - size)); truncated = true; p.kill(); void reader.cancel(); break }
        chunks.push(c); size += c.length
      }
      const err = await new Response(p.stderr).text().catch(() => '')
      await p.exited
      return { out: Buffer.concat(chunks).toString('utf8'), err, truncated }
    }
    const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => { p.kill(); resolve('timeout') }, timeoutMs) })
    const done = read()
    done.catch(() => {})
    const res = await Promise.race([done, timedOut])
    if (res === 'timeout') return { ok: false, out: '', err: `git ${args[0]} timed out after ${timeoutMs} ms`, truncated: false }
    return { ok: res.truncated || p.exitCode === 0, out: res.out, err: res.err.trim(), truncated: res.truncated }
  } catch (e) {
    return { ok: false, out: '', err: e instanceof Error ? e.message : String(e), truncated: false }
  } finally {
    clearTimeout(timer)
  }
}

export interface DiffFile { path: string; oldPath?: string; added: number; removed: number; binary: boolean; patch?: string }
export interface DiffCommit { sha: string; subject: string; author: string; at: string }
export type DiffState = 'ok' | 'same' | 'branch-gone' | 'no-base' | 'error'
export interface BranchDiff {
  state: DiffState
  branch: string
  base?: string
  head?: string
  mergeBase?: string
  commits?: DiffCommit[]
  files?: DiffFile[]
  /** The patch was cut off at DIFF_MAX_BYTES; files after the cut have no `patch`. */
  truncated?: boolean
  error?: string
}

/** A branch name git would accept, that can't be read as an option. Checked again by git (`check-ref-format`). */
export const plausibleBranch = (b: string) => b.length > 0 && b.length <= 255 && !b.startsWith('-') && !/[\0-\x20\x7f~^:?*[\\]/.test(b)

/** The repo's base branch: origin's default branch, else `main`, else `master`. */
export async function baseOf(dir: string): Promise<string | undefined> {
  const origin = await runGit(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (origin.ok && origin.out.trim()) return origin.out.trim()
  for (const b of ['main', 'master']) {
    if ((await runGit(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${b}^{commit}`])).ok) return b
  }
  return undefined
}

/** `git diff --numstat -z -M` → files. Renames come as `a\tr\t\0old\0new\0`. */
export function parseNumstat(raw: string): DiffFile[] {
  const parts = raw.split('\0')
  const files: DiffFile[] = []
  for (let k = 0; k < parts.length; k++) {
    const head = parts[k]!
    if (!head) continue
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head)
    if (!m) continue
    const binary = m[1] === '-' && m[2] === '-'
    const f: DiffFile = { path: m[3]!, added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]), binary }
    if (m[3] === '') { f.oldPath = parts[++k] ?? ''; f.path = parts[++k] ?? '' }
    files.push(f)
  }
  return files
}

/** Split a unified patch into its per-file sections (each starts with `diff --git `). */
export function splitPatch(patch: string): string[] {
  if (!patch) return []
  return patch.split(/^(?=diff --git )/m).filter((s) => s.startsWith('diff --git '))
}

const cache = new Map<string, BranchDiff>()
const CACHE_MAX = 20

/** What `branch` changes against the repo's base, from the point where it left the base. */
export async function branchDiff(dir: string, branch: string): Promise<BranchDiff> {
  if (!plausibleBranch(branch) || !(await runGit(dir, ['check-ref-format', '--branch', branch])).ok) {
    return { state: 'error', branch, error: 'not a branch name' }
  }
  const head = await runGit(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}^{commit}`])
  if (!head.ok) return { state: 'branch-gone', branch }
  const base = await baseOf(dir)
  if (!base) return { state: 'no-base', branch, head: head.out.trim() }
  const baseRef = base.includes('/') ? `refs/remotes/${base}` : `refs/heads/${base}`
  const mb = await runGit(dir, ['merge-base', '--end-of-options', baseRef, `refs/heads/${branch}`])
  if (!mb.ok) return { state: 'no-base', branch, base, head: head.out.trim() }
  const out: BranchDiff = { state: 'ok', branch, base, head: head.out.trim(), mergeBase: mb.out.trim() }
  if (out.head === out.mergeBase) return { ...out, state: 'same', commits: [], files: [] }

  const key = `${dir}\0${out.mergeBase}\0${out.head}`
  const hit = cache.get(key)
  if (hit) return { ...hit, base }

  const range = [out.mergeBase!, out.head!]
  const diffArgs = ['--no-ext-diff', '--no-textconv', '--no-color', '-M']
  const [log, stat, patch] = await Promise.all([
    runGit(dir, ['log', '--no-show-signature', `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%s%x1f%an%x1f%aI', '--end-of-options', `${range[0]}..${range[1]}`, '--']),
    runGit(dir, ['diff', ...diffArgs, '--numstat', '-z', '--end-of-options', ...range, '--']),
    runGit(dir, ['diff', ...diffArgs, '--end-of-options', ...range, '--']),
  ])
  const failed = [log, stat, patch].find((r) => !r.ok)
  if (failed) return { ...out, state: 'error', error: failed.err || 'git failed' }
  out.commits = log.out.split('\n').filter(Boolean).map((l) => {
    const [sha = '', subject = '', author = '', at = ''] = l.split('\x1f')
    return { sha, subject, author, at }
  })
  const files = parseNumstat(stat.out)
  const sections = splitPatch(patch.out)
  // Same arguments, same order: the k-th section is the k-th file. A cut-off patch leaves later files without one.
  files.forEach((f, k) => { const s = sections[k]; if (s && (!patch.truncated || k < sections.length - 1)) f.patch = s })
  out.files = files
  if (patch.truncated) out.truncated = true
  cache.set(key, out)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  return out
}
