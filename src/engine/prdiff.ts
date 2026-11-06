/**
 * The Changes panel's fallback when the agent's repo isn't on this Mac (or its branch is gone): the diff of a GitHub
 * PR linked from the issue, through `gh` (the CI refresher's runner, src/engine/ci.ts).
 *
 * `gh` never runs on a request: `get` answers from memory and starts a fetch in the background when there is nothing
 * fresh, returning `pending`; the panel asks again. An open PR is re-checked after FRESH_MS (only `gh pr view`; the
 * diff is fetched again only when the PR's head moved). Failures are kept for RETRY_MS with gh's reason.
 */
import { classifyGh, ghRunner, prOf, type GhProblem, type GhRunner } from './ci'
import { DIFF_MAX_BYTES, splitPatch, type DiffCommit, type DiffFile } from './diff'

export const FRESH_MS = 2 * 60_000
export const RETRY_MS = 60_000
const MAX_RUNNING = 2

export interface PrDiff {
  state: 'ok' | 'pending' | 'error'
  url: string
  pr: number
  repo: string
  branch?: string
  base?: string
  head?: string
  prState?: string
  commits?: DiffCommit[]
  files?: DiffFile[]
  truncated?: boolean
  error?: string
}

interface Entry { at: number; value: PrDiff }

/** Per-file counts from a unified patch (what `gh pr diff` prints). */
export function filesOfPatch(patch: string): DiffFile[] {
  return splitPatch(patch).map((section) => {
    const lines = section.split('\n')
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(lines[0] ?? '')
    let path = m?.[2] ?? ''
    let oldPath: string | undefined
    let added = 0, removed = 0, binary = false, inHunk = false
    for (const l of lines.slice(1)) {
      if (!inHunk) {
        if (l.startsWith('rename from ')) oldPath = l.slice(12)
        else if (l.startsWith('rename to ')) path = l.slice(10)
        else if (l.startsWith('+++ b/')) path = l.slice(6)
        else if (l.startsWith('Binary files ') || l === 'GIT binary patch') binary = true
        else if (l.startsWith('@@')) inHunk = true
        continue
      }
      if (l.startsWith('+')) added++
      else if (l.startsWith('-')) removed++
    }
    return { path, ...(oldPath && oldPath !== path ? { oldPath } : {}), added, removed, binary, patch: section }
  })
}

const reasonOf = (p: GhProblem, err: string) =>
  p === 'missing' ? 'gh is not installed' : p === 'auth' ? 'gh is not signed in' : p === 'rate' ? 'GitHub rate limit; try again soon'
    : p === 'access' ? "gh can't read this PR (signed in as an account without access?)" : err.split('\n')[0]!.slice(0, 200) || 'gh failed'

export class PrDiffs {
  private cache = new Map<string, Entry>()
  private running = new Set<string>()

  constructor(private readonly run: GhRunner = ghRunner, private readonly now: () => number = Date.now) {}

  /** The PR's diff as known now; starts a background fetch when missing or stale. */
  get(url: string): PrDiff | null {
    const pr = prOf(url)
    if (!pr) return null
    const hit = this.cache.get(url)
    const age = hit ? this.now() - hit.at : Infinity
    const stale = !hit || (hit.value.state === 'error' ? age > RETRY_MS : hit.value.prState === 'OPEN' && age > FRESH_MS)
    if (stale && !this.running.has(url) && this.running.size < MAX_RUNNING) void this.fetch(url, pr)
    return hit?.value ?? { state: 'pending', url, pr: pr.number, repo: pr.repo }
  }

  /** Resolves when the background fetches have settled (tests). */
  async idle(): Promise<void> { while (this.running.size) await Bun.sleep(5) }

  private async fetch(url: string, pr: { repo: string; number: number }): Promise<void> {
    this.running.add(url)
    const base = { url, pr: pr.number, repo: pr.repo }
    try {
      const view = await this.run(['pr', 'view', String(pr.number), '--repo', pr.repo, '--json', 'headRefOid,headRefName,baseRefName,state,commits'])
      if (view.code !== 0) { this.put(url, { ...base, state: 'error', error: reasonOf(classifyGh(view), view.stderr) }); return }
      const v = JSON.parse(view.stdout) as { headRefOid?: string; headRefName?: string; baseRefName?: string; state?: string; commits?: { oid?: string; messageHeadline?: string; authors?: { name?: string; login?: string }[]; committedDate?: string }[] }
      const prev = this.cache.get(url)?.value
      const meta = { ...base, branch: v.headRefName, base: v.baseRefName, head: v.headRefOid, prState: v.state }
      if (prev?.state === 'ok' && prev.head === v.headRefOid) { this.put(url, { ...prev, ...meta }); return }
      const diff = await this.run(['pr', 'diff', String(pr.number), '--repo', pr.repo, '--color', 'never'])
      if (diff.code !== 0) { this.put(url, { ...meta, state: 'error', error: reasonOf(classifyGh(diff), diff.stderr) }); return }
      const truncated = Buffer.byteLength(diff.stdout) > DIFF_MAX_BYTES
      const patch = truncated ? Buffer.from(diff.stdout).subarray(0, DIFF_MAX_BYTES).toString('utf8') : diff.stdout
      const files = filesOfPatch(patch)
      if (truncated && files.length) delete files[files.length - 1]!.patch
      const commits = (v.commits ?? []).slice(-50).reverse().map((c) => ({
        sha: c.oid ?? '', subject: c.messageHeadline ?? '', author: c.authors?.[0]?.name || c.authors?.[0]?.login || '', at: c.committedDate ?? '',
      }))
      this.put(url, { ...meta, state: 'ok', commits, files, ...(truncated ? { truncated } : {}) })
    } catch (e) {
      this.put(url, { ...base, state: 'error', error: e instanceof Error ? e.message : String(e) })
    } finally {
      this.running.delete(url)
    }
  }

  private put(url: string, value: PrDiff) { this.cache.set(url, { at: this.now(), value }) }
}
