/**
 * The Changes panel's answer for one issue: which agent branch to show, and its diff (src/engine/diff.ts).
 *
 * Branches come only from the issue itself: the branch each agent comment was written on (activity entries) and each
 * attempt's branch (src/engine/attempts.ts). A request may pick one of those by name and nothing else. The default is
 * the most recent one that isn't the repo's base branch (after a merge, agents often write from main).
 */
import type { Issue } from '../model'
import { attemptsOf } from './attempts'
import { prOf } from './ci'
import { baseOf, branchDiff, type BranchDiff } from './diff'
import type { PrDiff } from './prdiff'
import type { Store } from './store'

export interface Repos { lookup(workspace: string): Promise<string | undefined> }
export interface PrSource { get(url: string): PrDiff | null }
export interface Candidate { workspace: string; branch: string; at: string }

export type ChangesState = BranchDiff['state'] | 'no-branch' | 'repo-unknown' | 'unknown-branch' | 'pending'
export interface Changes extends Omit<BranchDiff, 'state' | 'branch'> {
  state: ChangesState
  source: 'local' | 'github'
  branch?: string
  /** source github: the PR shown, its url and state (OPEN, MERGED, CLOSED); `local` is why the local diff wasn't used. */
  pr?: number
  url?: string
  prState?: string
  local?: ChangesState
  workspace?: string
  /** The repo folder diffed (this Mac only; never stored in issue files). */
  repo?: string
  /** Every branch this issue recorded, newest first: the panel lists the others. */
  branches: string[]
}

/** Agent branches the issue recorded, newest first, one per workspace+branch. */
export function candidates(s: Pick<Store, 'attempts' | 'statusMoved'>, i: Issue): Candidate[] {
  const seen = new Map<string, Candidate>()
  const add = (workspace: string | undefined, branch: string | undefined, at: string) => {
    if (!workspace || !branch || workspace === 'external') return
    const k = `${workspace}\0${branch}`
    const cur = seen.get(k)
    if (!cur || cur.at < at) seen.set(k, { workspace, branch, at })
  }
  for (const e of i.activity) if (e.actor === 'agent') add(e.workspace, e.branch, e.at)
  for (const a of attemptsOf(s, i)) add(a.workspace, a.branch, a.last)
  return [...seen.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

const shortBase = (b: string) => b.replace(/^origin\//, '')

/** The local diff; when it can't be had (no repo here, branch gone, no branch) and no branch was asked for, the newest linked GitHub PR's. */
export async function changesFor(s: Pick<Store, 'attempts' | 'statusMoved'>, repos: Repos, i: Issue, want?: string, prs?: PrSource): Promise<Changes> {
  const local = await localChanges(s, repos, i, want)
  if (want !== undefined || !prs || !['repo-unknown', 'branch-gone', 'no-branch'].includes(local.state)) return local
  const url = [...i.links].reverse().map((l) => l.url).find((u) => prOf(u))
  const pr = url ? prs.get(url) : null
  if (!pr) return local
  const { state, repo: _repo, ...rest } = pr
  return { ...rest, state, source: 'github', local: local.state, branches: local.branches }
}

async function localChanges(s: Pick<Store, 'attempts' | 'statusMoved'>, repos: Repos, i: Issue, want?: string): Promise<Changes> {
  const list = candidates(s, i)
  const branches = [...new Set(list.map((c) => c.branch))]
  if (want !== undefined && !branches.includes(want)) return { state: 'unknown-branch', source: 'local', branches }
  const pool = want !== undefined ? list.filter((c) => c.branch === want) : list
  let unknownRepo: Candidate | undefined
  for (const c of pool) {
    const dir = await repos.lookup(c.workspace)
    if (!dir) { unknownRepo ??= c; continue }
    // The default skips the base branch itself; a branch asked for by name is shown whatever it is.
    if (want === undefined) {
      const base = await baseOf(dir)
      if (base && shortBase(base) === c.branch) continue
    }
    const d = await branchDiff(dir, c.branch)
    return { ...d, source: 'local', workspace: c.workspace, repo: dir, branches }
  }
  if (unknownRepo) return { state: 'repo-unknown', source: 'local', branch: unknownRepo.branch, workspace: unknownRepo.workspace, branches }
  return { state: 'no-branch', source: 'local', branches }
}
