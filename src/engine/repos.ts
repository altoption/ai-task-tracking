/**
 * Where each agent workspace's repo lives on this Mac, for the Changes panel's diffs (src/engine/diff.ts).
 *
 * Learned from agent calls: the MCP proxy sends the main worktree's folder next to (never inside) the actor, so the
 * path stays out of issue files, which sync to the backup remote. Kept in `.tracker/repos.json` (git-ignored,
 * machine-local). An entry is taken only for a git repo whose folder name is the workspace name, and is checked again
 * before each use, so a moved or replaced repo reads as unknown instead of diffing the wrong folder.
 */
import { statSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { atomicWrite } from '../store/atomic'
import { runGit } from './diff'

export interface RepoEntry { dir: string; commonDir: string }

export const reposPath = (root: string) => join(root, '.tracker', 'repos.json')

const isDir = (p: string) => { try { return statSync(p).isDirectory() } catch { return false } }

/** The repo's absolute common git dir and the workspace name it implies (as src/mcp/workspace.ts names it). */
async function probe(dir: string): Promise<{ commonDir: string; name: string } | undefined> {
  if (!isAbsolute(dir) || !isDir(dir)) return undefined
  const r = await runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: 2000, maxBytes: 4096 })
  const commonDir = r.ok ? r.out.trim() : ''
  if (!commonDir) return undefined
  return { commonDir, name: basename(basename(commonDir) === '.git' ? dirname(commonDir) : dir) }
}

export class RepoMap {
  // No prototype: workspace names come from agents (`__proto__` is just a name here).
  private entries: Record<string, RepoEntry> = Object.create(null) as Record<string, RepoEntry>
  private writing: Promise<void> = Promise.resolve()

  private constructor(private readonly root: string, private readonly log: (m: string) => void) {}

  static async open(root: string, log: (m: string) => void = (m) => console.error(m)): Promise<RepoMap> {
    const m = new RepoMap(root, log)
    try {
      const raw = JSON.parse(await readFile(reposPath(root), 'utf8')) as unknown
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          const e = v as Partial<RepoEntry> | null
          if (e && typeof e.dir === 'string' && typeof e.commonDir === 'string') m.entries[k] = { dir: e.dir, commonDir: e.commonDir }
        }
      }
    } catch { /* none yet, or unreadable: start empty */ }
    return m
  }

  /** Record `dir` for `workspace` when it is a git repo of that name. Cheap when already known. */
  async learn(workspace: string | undefined, dir: unknown): Promise<void> {
    if (!workspace || workspace === 'external' || typeof dir !== 'string') return
    if (this.entries[workspace]?.dir === dir) return // own keys only: the map has no prototype
    const p = await probe(dir)
    if (!p || p.name !== workspace) return
    this.entries[workspace] = { dir, commonDir: p.commonDir }
    const body = `${JSON.stringify(this.entries, null, 2)}\n`
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(reposPath(this.root)), { recursive: true })
      await atomicWrite(reposPath(this.root), body)
    }).catch((e) => {
      this.log(`[repos] could not write .tracker/repos.json: ${e instanceof Error ? e.message : String(e)}`)
    })
    await this.writing
  }

  /** The workspace's repo folder, if it is still the repo that was learned. */
  async lookup(workspace: string): Promise<string | undefined> {
    const e = this.entries[workspace]
    if (!e) return undefined
    const p = await probe(e.dir)
    return p && p.commonDir === e.commonDir && p.name === workspace ? e.dir : undefined
  }
}
