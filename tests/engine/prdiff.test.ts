import { describe, expect, test } from 'bun:test'
import type { GhResult } from '../../src/engine/ci'
import { changesFor } from '../../src/engine/changes'
import { FRESH_MS, PrDiffs, RETRY_MS, filesOfPatch } from '../../src/engine/prdiff'
import type { Issue } from '../../src/model'

const URL = 'https://github.com/acme/shop/pull/12'
const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,3 @@', ' keep', '-old', '+new', '+more',
  'diff --git a/old.txt b/new.txt', 'similarity index 100%', 'rename from old.txt', 'rename to new.txt',
  'diff --git a/logo.png b/logo.png', 'new file mode 100644', 'Binary files /dev/null and b/logo.png differ', '',
].join('\n')
const VIEW = (head: string, state = 'OPEN') => JSON.stringify({
  headRefOid: head, headRefName: 'feat/table', baseRefName: 'main', state,
  commits: [{ oid: 'c1', messageHeadline: 'First', authors: [{ name: 'A' }], committedDate: '2026-11-06T10:00:00Z' }, { oid: 'c2', messageHeadline: 'Second', authors: [{ login: 'b' }], committedDate: '2026-11-06T11:00:00Z' }],
})

function fakeGh(script: (args: string[]) => GhResult) {
  const calls: string[][] = []
  return { calls, run: async (args: string[]) => { calls.push(args); return script(args) } }
}
const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' })

test('filesOfPatch counts lines per file, renames and binaries', () => {
  const files = filesOfPatch(PATCH)
  expect(files.map(({ patch: _p, ...f }) => f)).toEqual([
    { path: 'src/a.ts', added: 2, removed: 1, binary: false },
    { path: 'new.txt', oldPath: 'old.txt', added: 0, removed: 0, binary: false },
    { path: 'logo.png', added: 0, removed: 0, binary: true },
  ])
})

describe('PrDiffs', () => {
  test('pending first, gh in the background, then the diff; a same head skips the diff call', async () => {
    let head = 'h1'
    const gh = fakeGh((a) => (a[1] === 'view' ? ok(VIEW(head)) : ok(PATCH)))
    let now = 1_000_000
    const p = new PrDiffs(gh.run, () => now)
    expect(p.get('https://example.com/x')).toBeNull()
    expect(p.get(URL)).toMatchObject({ state: 'pending', pr: 12, repo: 'acme/shop' })
    await p.idle()
    const d = p.get(URL)!
    expect(d).toMatchObject({ state: 'ok', branch: 'feat/table', base: 'main', head: 'h1', prState: 'OPEN' })
    expect(d.commits!.map((c) => c.subject)).toEqual(['Second', 'First'])
    expect(d.files!.length).toBe(3)
    expect(gh.calls.map((c) => c[1])).toEqual(['view', 'diff'])
    expect(gh.calls[0]).toContain('acme/shop')

    now += FRESH_MS + 1
    p.get(URL); await p.idle()
    expect(gh.calls.map((c) => c[1])).toEqual(['view', 'diff', 'view'])
    head = 'h2'
    now += FRESH_MS + 1
    p.get(URL); await p.idle()
    expect(gh.calls.map((c) => c[1])).toEqual(['view', 'diff', 'view', 'view', 'diff'])
    expect(p.get(URL)!.head).toBe('h2')
  })

  test('a merged PR is not re-checked; failures carry a reason and retry after a minute', async () => {
    const merged = fakeGh((a) => (a[1] === 'view' ? ok(VIEW('h', 'MERGED')) : ok(PATCH)))
    let now = 0
    const m = new PrDiffs(merged.run, () => now)
    m.get(URL); await m.idle()
    now += 10 * FRESH_MS
    m.get(URL); await m.idle()
    expect(merged.calls.length).toBe(2)

    const signedOut = fakeGh(() => ({ code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }))
    const s = new PrDiffs(signedOut.run, () => now)
    s.get(URL); await s.idle()
    expect(s.get(URL)).toMatchObject({ state: 'error', error: 'gh is not signed in' })
    expect(signedOut.calls.length).toBe(1)
    now += RETRY_MS + 1
    s.get(URL); await s.idle()
    expect(signedOut.calls.length).toBe(2)
  })
})

describe('changesFor falls back to the PR', () => {
  const issue = (links: string[]): Issue => ({
    id: 'Q-1', title: 't', status: 'Waiting', priority: 0, labels: [], project: 'p', description: '', activity: [
      { at: '2026-11-06T10:00:00Z', actor: 'agent', workspace: 'shop', branch: 'feat/table', body: 'ready' },
    ], links: links.map((url) => ({ url })),
  } as unknown as Issue)
  const store = { attempts: () => [], statusMoved: () => false }
  const noRepos = { lookup: async () => undefined }

  test('repo not on this Mac + a linked PR: the PR, labelled as GitHub, with the local reason', async () => {
    const prs = { get: (u: string) => (u === URL ? { state: 'ok' as const, url: u, pr: 12, repo: 'acme/shop', branch: 'feat/table', files: [] } : null) }
    const c = await changesFor(store as any, noRepos, issue(['https://example.com', URL]), undefined, prs)
    expect(c).toMatchObject({ state: 'ok', source: 'github', pr: 12, url: URL, local: 'repo-unknown', branches: ['feat/table'] })
    expect(c).not.toHaveProperty('repo')
  })
  test('no PR link, or a branch asked for by name: the local answer', async () => {
    const prs = { get: () => { throw new Error('not called') } }
    expect((await changesFor(store as any, noRepos, issue([]), undefined, prs)).state).toBe('repo-unknown')
    expect((await changesFor(store as any, noRepos, issue([URL]), 'feat/table', prs)).source).toBe('local')
  })
})
