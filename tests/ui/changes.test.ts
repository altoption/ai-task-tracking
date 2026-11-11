import { describe, expect, test } from 'bun:test'
import type { Changes } from '../../src/engine/changes'
import type { DiffFile } from '../../src/engine/diff'
import { branchRows } from '../../ui/views/ChangesPanel'
import { changeTotals, fileKind, fileOutline, patchLines, rollupTotals, statBlocks } from '../../ui/changes'

const f = (path: string, added = 1, removed = 0, extra: Partial<DiffFile> = {}): DiffFile => ({ path, added, removed, binary: false, ...extra })

describe('fileKind', () => {
  test('added and deleted come from the patch header, renamed from the old path', () => {
    expect(fileKind(f('a.ts', 1, 0, { patch: 'diff --git a/a.ts b/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+x\n' }))).toBe('added')
    expect(fileKind(f('a.ts', 0, 1, { patch: 'diff --git a/a.ts b/a.ts\ndeleted file mode 100644\n@@ -1 +0,0 @@\n-x\n' }))).toBe('deleted')
    expect(fileKind(f('b.ts', 0, 0, { oldPath: 'a.ts' }))).toBe('renamed')
    expect(fileKind(f('a.ts', 1, 1, { patch: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-x\n+new file mode\n' }))).toBe('modified')
  })
})

describe('fileOutline', () => {
  test('groups by folder in first-seen order and keeps each file\'s index', () => {
    const o = fileOutline([f('src/plans.ts'), f('src/pricing/Table.tsx'), f('README.md'), f('src/z.ts')])
    expect(o.map((d) => [d.dir, d.files.map((x) => `${x.index}:${x.name}`)])).toEqual([
      ['src', ['0:plans.ts', '3:z.ts']], ['src/pricing', ['1:Table.tsx']], ['', ['2:README.md']],
    ])
  })
})

describe('patchLines', () => {
  test('numbers each side from the hunk header and skips the file header', () => {
    const p = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -3,3 +3,4 @@ function x() {\n keep\n-old\n+new\n+more\n last\n\\ No newline at end of file\n'
    expect(patchLines(p).map((l) => [l.kind, l.old, l.new, l.text])).toEqual([
      ['hunk', undefined, undefined, 'function x() {'],
      ['ctx', 3, 3, 'keep'], ['del', 4, undefined, 'old'], ['add', undefined, 4, 'new'], ['add', undefined, 5, 'more'], ['ctx', 5, 6, 'last'],
      ['note', undefined, undefined, 'No newline at end of file'],
    ])
    expect(patchLines('Binary files differ\n')).toEqual([])
  })
})

describe('totals', () => {
  const c = (branch: string, files: DiffFile[], extra: Partial<Changes> = {}): Changes => ({ state: 'ok', source: 'local', branch, repo: '/r', branches: [branch], files, ...extra })
  test('changeTotals sums a diff', () => {
    expect(changeTotals(c('a', [f('x', 3, 2), f('y', 14, 0)]))).toEqual({ files: 2, added: 17, removed: 2 })
  })
  test('rollupTotals counts a branch shared by two sub-issues once, and skips issues without files', () => {
    const shared = [f('x', 3, 2)]
    expect(rollupTotals([c('a', shared), c('a', shared), c('b', [f('y', 5, 0)]), { state: 'no-branch', source: 'local', branches: [] }]))
      .toEqual({ files: 2, added: 8, removed: 2, branches: 2 })
  })
  test('branchRows: one row per branch naming every issue on it; an issue with no branch stays its own row', () => {
    const shared = [f('x', 3, 2)]
    const sc = (id: string, changes: Changes | null, own = false) => ({ issue: { id, title: id, status: 'Todo' }, own, changes })
    const rows = branchRows([sc('Q-1', c('a', shared), true), sc('Q-2', c('a', shared)), sc('Q-3', c('b', [f('y')])), sc('Q-4', { state: 'no-branch', source: 'local', branches: [] }), sc('Q-5', null)])
    expect(rows.map((r) => [r.changes?.branch, r.scopes.map((x) => x.issue.id)])).toEqual([['a', ['Q-1', 'Q-2']], ['b', ['Q-3']], [undefined, ['Q-4']], [undefined, ['Q-5']]])
  })
  test('statBlocks: at most five blocks, both sides shown when both changed', () => {
    expect(statBlocks(14, 0, 14)).toEqual({ add: 5, del: 0 })
    expect(statBlocks(3, 2, 14)).toEqual({ add: 1, del: 1 })
    expect(statBlocks(0, 0, 14)).toEqual({ add: 0, del: 0 })
    const b = statBlocks(1, 40, 41)
    expect(b.add).toBe(1); expect(b.add + b.del).toBeLessThanOrEqual(5)
  })
})
