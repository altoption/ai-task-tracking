/** Pure helpers behind the Changes panel (tested without a DOM): the file outline, patch lines with their numbers, totals across sub-issues. */
import type { Changes } from '../src/engine/changes'
import type { DiffFile } from '../src/engine/diff'

export type FileKind = 'added' | 'deleted' | 'renamed' | 'modified'

/** What happened to the file, from its patch header (`new file mode` / `deleted file mode`) or its old path. */
export function fileKind(f: Pick<DiffFile, 'oldPath' | 'patch'>): FileKind {
  const head = f.patch ? f.patch.slice(0, Math.max(0, f.patch.indexOf('\n@@'))) || f.patch.slice(0, 400) : ''
  if (/^new file mode /m.test(head)) return 'added'
  if (/^deleted file mode /m.test(head)) return 'deleted'
  return f.oldPath ? 'renamed' : 'modified'
}

export interface OutlineFile { file: DiffFile; name: string; index: number; kind: FileKind }
export interface OutlineDir { dir: string; files: OutlineFile[] }

/** The files grouped by folder, folders in the order they first appear (git's path order); `index` is the file's place in `files`. */
export function fileOutline(files: readonly DiffFile[]): OutlineDir[] {
  const dirs = new Map<string, OutlineDir>()
  files.forEach((file, index) => {
    const cut = file.path.lastIndexOf('/')
    const dir = cut < 0 ? '' : file.path.slice(0, cut)
    let d = dirs.get(dir)
    if (!d) dirs.set(dir, d = { dir, files: [] })
    d.files.push({ file, name: file.path.slice(cut + 1), index, kind: fileKind(file) })
  })
  return [...dirs.values()]
}

export interface PatchLine {
  kind: 'hunk' | 'add' | 'del' | 'ctx' | 'note'
  text: string
  /** Line numbers in the old and the new file (none on the side a line isn't in). */
  old?: number
  new?: number
}

/** A file's patch as lines with their old/new numbers, from the first hunk on (the header lines repeat the file name). */
export function patchLines(patch: string): PatchLine[] {
  const lines = patch.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const start = lines.findIndex((l) => l.startsWith('@@'))
  if (start < 0) return []
  const out: PatchLine[] = []
  let o = 0, n = 0
  for (const l of lines.slice(start)) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(l)
    if (h) { o = Number(h[1]); n = Number(h[2]); out.push({ kind: 'hunk', text: h[3] ?? '' }) }
    else if (l.startsWith('+')) out.push({ kind: 'add', text: l.slice(1), new: n++ })
    else if (l.startsWith('-')) out.push({ kind: 'del', text: l.slice(1), old: o++ })
    else if (l.startsWith('\\')) out.push({ kind: 'note', text: l.slice(2) })
    else out.push({ kind: 'ctx', text: l.slice(1), old: o++, new: n++ })
  }
  return out
}

/** What a diff is of: the PR, or the repo and branch. Undefined when there is no branch to name (nothing recorded yet). */
export function branchKey(c: Pick<Changes, 'source' | 'url' | 'pr' | 'repo' | 'branch'>): string | undefined {
  if (c.source === 'github') return `pr:${c.url ?? c.pr}`
  return c.branch ? `${c.repo ?? ''}\0${c.branch}` : undefined
}

export interface Totals { files: number; added: number; removed: number }

export const changeTotals = (c: Pick<Changes, 'files'>): Totals => {
  const files = c.files ?? []
  return { files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) }
}

/**
 * Totals across several issues' changes (an epic and its sub-issues), each branch counted once: two steps written
 * on one branch show the same diff, and a file changed on two branches counts on each.
 */
export function rollupTotals(list: readonly Changes[]): Totals & { branches: number } {
  const seen = new Set<string>()
  const t = { files: 0, added: 0, removed: 0, branches: 0 }
  for (const c of list) {
    if (!c.files?.length) continue
    const key = branchKey(c) ?? ''
    if (seen.has(key)) continue
    seen.add(key)
    const one = changeTotals(c)
    t.files += one.files; t.added += one.added; t.removed += one.removed; t.branches++
  }
  return t
}

/** Up to five blocks showing a file's added/removed split (GitHub's diffstat), scaled to the largest change in the list. */
export function statBlocks(added: number, removed: number, max: number): { add: number; del: number } {
  const total = added + removed
  if (!total) return { add: 0, del: 0 }
  const blocks = Math.max(added && removed ? 2 : 1, Math.round((5 * total) / Math.max(max, total)))
  // Each side that changed gets at least one block; the rest follow the split.
  const add = added ? Math.min(removed ? blocks - 1 : blocks, Math.max(1, Math.round((blocks * added) / total))) : 0
  return { add, del: blocks - add }
}
