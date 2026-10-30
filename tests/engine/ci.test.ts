import { describe, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CiStatus } from '../../src/model'
import {
  ciBadge, ciCachePath, CiRefresher, ciReasonOf, classifyGh, normalizeCi, parsePr, parseRollup, prOf, resolveGh, makeGhRunner, worstCi, type GhRunner,
} from '../../src/engine/ci'
import { home, needsYouCount, needsYouList } from '../../src/engine/queries'
import { Store } from '../../src/engine/store'
import { miniCopy } from './helpers'

const ME = { actor: 'you' as const }
const PR = (n: number, repo = 'acme/web') => `https://github.com/${repo}/pull/${n}`

const run = (name: string, status: string, conclusion: string | null) => ({ __typename: 'CheckRun', name, status, conclusion })
const ctx = (context: string, state: string) => ({ __typename: 'StatusContext', context, state })
const prJson = (n: number, o: { state?: string; isDraft?: boolean; mergedAt?: string | null; checks?: unknown[] } = {}) => JSON.stringify({
  number: n, url: PR(n), state: o.state ?? 'OPEN', isDraft: o.isDraft ?? false, mergedAt: o.mergedAt ?? null, statusCheckRollup: o.checks ?? [],
})

/** A fake gh: answers per PR number from `answers` (a function of the call count), recording every call. */
function fakeGh(answer: (n: number, k: number) => { code: number; stdout?: string; stderr?: string }) {
  const calls: string[][] = []
  const runner: GhRunner = async (args) => {
    calls.push(args)
    const n = Number(/pull\/(\d+)/.exec(args[2] ?? '')?.[1])
    const r = answer(n, calls.length)
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  return { runner, calls }
}

async function setup(links: Record<string, string[]> = { 'Q-1': [PR(12)] }) {
  const root = await miniCopy()
  const s = await Store.open(root)
  for (const [id, urls] of Object.entries(links)) await s.updateIssue(id, { links: urls.map((url) => ({ title: url, url })) }, ME)
  return { root, s }
}

let clock = Date.parse('2026-10-29T12:00:00Z')
const now = () => clock

async function refresher(s: Store, runner: GhRunner, log: string[] = []) {
  return CiRefresher.start(s, { run: runner, now, tickMs: 0, startDelayMs: 0, debounceMs: 5, saveDelayMs: 5, log: (m) => log.push(m) })
}

describe('parsing gh pr view', () => {
  test('CheckRun conclusions: failure, timed out, cancelled fail; neutral and skipped pass; unfinished is pending', () => {
    expect(parseRollup([run('build', 'COMPLETED', 'SUCCESS'), run('lint', 'COMPLETED', 'NEUTRAL'), run('e2e', 'COMPLETED', 'SKIPPED')]))
      .toEqual({ checks: 'passing', failing: [] })
    expect(parseRollup([run('build', 'COMPLETED', 'SUCCESS'), run('test', 'IN_PROGRESS', null)])).toEqual({ checks: 'pending', failing: [] })
    expect(parseRollup([run('test', 'QUEUED', '')])).toEqual({ checks: 'pending', failing: [] })
    expect(parseRollup([run('a', 'COMPLETED', 'FAILURE'), run('b', 'COMPLETED', 'TIMED_OUT'), run('c', 'COMPLETED', 'CANCELLED'),
      run('d', 'COMPLETED', 'ACTION_REQUIRED'), run('e', 'IN_PROGRESS', null)])).toEqual({ checks: 'failing', failing: ['a', 'b', 'c'] })
  })

  test('StatusContext states: failure and error fail, pending and expected wait, success passes', () => {
    expect(parseRollup([ctx('ci/circle', 'SUCCESS')])).toEqual({ checks: 'passing', failing: [] })
    expect(parseRollup([ctx('ci/circle', 'PENDING'), ctx('deploy', 'EXPECTED')])).toEqual({ checks: 'pending', failing: [] })
    expect(parseRollup([ctx('ci/circle', 'ERROR'), run('build', 'COMPLETED', 'SUCCESS'), ctx('lint', 'FAILURE')]))
      .toEqual({ checks: 'failing', failing: ['ci/circle', 'lint'] })
  })

  test('no checks is none; duplicate names count once', () => {
    expect(parseRollup([])).toEqual({ checks: 'none', failing: [] })
    expect(parseRollup(null)).toEqual({ checks: 'none', failing: [] })
    expect(parseRollup([run('t', 'COMPLETED', 'FAILURE'), run('t', 'COMPLETED', 'FAILURE')]).failing).toEqual(['t'])
  })

  test('PR state: open, draft, merged, closed; junk is null', () => {
    const at = '2026-10-29T12:00:00Z'
    expect(parsePr(prJson(1), at)).toEqual({ pr: 1, state: 'open', checks: 'none', failing: [], checkedAt: at })
    expect(parsePr(prJson(1, { isDraft: true }), at)?.state).toBe('draft')
    expect(parsePr(prJson(1, { state: 'MERGED', mergedAt: at }), at)?.state).toBe('merged')
    expect(parsePr(prJson(1, { state: 'CLOSED' }), at)?.state).toBe('closed')
    expect(parsePr('not json', at)).toBeNull()
    expect(parsePr('{"message":"x"}', at)).toBeNull()
  })

  test('the real shape gh returns (PR #1 of this repo, merged, two green CheckRuns)', () => {
    const real = '{"isDraft":false,"mergedAt":"2026-10-29T12:13:24Z","number":1,"state":"MERGED","statusCheckRollup":[{"__typename":"CheckRun","completedAt":"2026-10-29T10:44:30Z","conclusion":"SUCCESS","name":"check","startedAt":"2026-10-29T10:43:25Z","status":"COMPLETED","workflowName":"CI"},{"__typename":"CheckRun","conclusion":"SUCCESS","name":"check-app","status":"COMPLETED","workflowName":"CI"}],"url":"https://github.com/altoption/ai-task-tracking/pull/1"}'
    expect(parsePr(real, 'x')).toEqual({ pr: 1, state: 'merged', checks: 'passing', failing: [], checkedAt: 'x', mergedAt: '2026-10-29T12:13:24Z' })
  })

  test('PR urls only; worst status first; config defaults', () => {
    expect(prOf(PR(7))).toEqual({ repo: 'acme/web', number: 7 })
    expect(prOf('https://github.com/acme/web/commit/abc1234')).toBeNull()
    const s = (checks: CiStatus['checks'], state: CiStatus['state'] = 'open', pr = 1): CiStatus => ({ pr, state, checks, failing: [], checkedAt: '' })
    expect(worstCi([s('passing', 'open', 1), s('failing', 'merged', 2), s('pending', 'open', 3)])?.pr).toBe(2)
    expect(worstCi([s('passing', 'merged', 1), s('passing', 'open', 2)])?.pr).toBe(2)
    expect(worstCi([])).toBeNull()
    expect(normalizeCi(undefined)).toEqual({ enabled: true, refreshMinutes: 2 })
    expect(normalizeCi({ enabled: false, refreshMinutes: 'x' })).toEqual({ enabled: false, refreshMinutes: 2 })
    expect(normalizeCi({ refreshMinutes: 10 })).toEqual({ enabled: true, refreshMinutes: 10 })
  })

  test('gh failures: missing, signed out, rate limit, no access, other', () => {
    expect(classifyGh({ code: 127, stdout: '', stderr: 'Executable not found in $PATH: "gh"' })).toBe('missing')
    expect(classifyGh({ code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' })).toBe('auth')
    expect(classifyGh({ code: 1, stdout: '', stderr: 'GraphQL: API rate limit exceeded for user ID 1.' })).toBe('rate')
    expect(classifyGh({ code: 1, stdout: '', stderr: "GraphQL: Could not resolve to a Repository with the name 'a/b'. (repository)" })).toBe('access')
    expect(classifyGh({ code: 1, stdout: '', stderr: 'dial tcp: i/o timeout' })).toBe('other')
  })
})

describe('the refresher', () => {
  test('fetches with an argv array, caches, and only re-checks an open PR after its TTL', async () => {
    clock = Date.parse('2026-10-29T12:00:00Z')
    const { s } = await setup()
    const gh = fakeGh((n) => ({ code: 0, stdout: prJson(n, { checks: [run('test', 'COMPLETED', 'FAILURE')] }) }))
    const ci = await refresher(s, gh.runner)
    await ci.pass()
    expect(gh.calls).toEqual([['pr', 'view', PR(12), '--json', 'state,isDraft,mergedAt,statusCheckRollup,number,url']])
    expect(ci.get(PR(12))).toMatchObject({ pr: 12, state: 'open', checks: 'failing', failing: ['test'] })
    await ci.pass()
    clock += 60_000
    await ci.pass()
    expect(gh.calls).toHaveLength(1) // within the 2 min TTL
    clock += 61_000
    await ci.pass()
    expect(gh.calls).toHaveLength(2)
    await ci.stop()
  })

  test('merged PRs with settled checks are never refetched; merged with pending checks are (slowly)', async () => {
    clock = Date.parse('2026-10-29T12:00:00Z')
    const { s } = await setup({ 'Q-1': [PR(1), PR(2)] })
    const gh = fakeGh((n) => ({ code: 0, stdout: prJson(n, { state: 'MERGED', mergedAt: '2026-10-29T11:00:00Z',
      checks: [run('t', n === 1 ? 'COMPLETED' : 'IN_PROGRESS', n === 1 ? 'SUCCESS' : null)] }) }))
    const ci = await refresher(s, gh.runner)
    await ci.pass()
    clock += 31 * 60_000
    await ci.pass()
    clock += 24 * 3_600_000
    await ci.pass()
    expect(gh.calls.map((c) => c[2])).toEqual([PR(1), PR(2), PR(2)])
    await ci.stop()
  })

  test('only issues in scope: not Canceled/Duplicate, Done only if updated in the last 7 days', async () => {
    clock = Date.now()
    const { s } = await setup({ 'Q-1': [PR(1)], 'Q-6': [PR(6)] }) // Q-6 is Done, updated just now by the link edit
    const gh = fakeGh((n) => ({ code: 0, stdout: prJson(n) }))
    const ci = await refresher(s, gh.runner)
    expect(ci.due()).toEqual([PR(1), PR(6)]) // started work first
    clock += 8 * 86_400_000
    expect(ci.due()).toEqual([PR(1)])
    await s.updateIssue('Q-1', { status: 'Canceled' }, ME)
    expect(ci.due()).toEqual([])
    await ci.stop()
  })

  test('backs off per PR on errors (1, 2, 4 min…), keeps the last status, and logs once', async () => {
    clock = Date.parse('2026-10-29T12:00:00Z')
    const { s } = await setup()
    let fail = false
    const gh = fakeGh((n) => (fail ? { code: 1, stderr: 'dial tcp: i/o timeout' } : { code: 0, stdout: prJson(n) }))
    const log: string[] = []
    const ci = await refresher(s, gh.runner, log)
    await ci.pass()
    fail = true
    const step = async (ms: number) => { clock += ms; await ci.pass(); return gh.calls.length }
    expect(await step(121_000)).toBe(2) // TTL over: fails
    expect(await step(59_000)).toBe(2) // 1 min back-off
    expect(await step(2_000)).toBe(3)
    expect(await step(119_000)).toBe(3) // 2 min
    expect(await step(2_000)).toBe(4)
    expect(ci.get(PR(12))?.state).toBe('open') // last known status kept
    expect(log).toEqual(['[ci] CI status: gh pr view failed (dial tcp: i/o timeout)'])
    await ci.stop()
  })

  test('rate limit pauses everything with growing waits and says so in health', async () => {
    clock = Date.parse('2026-10-29T12:00:00Z')
    const { s } = await setup({ 'Q-1': [PR(1), PR(2), PR(3)] })
    const gh = fakeGh(() => ({ code: 1, stderr: 'API rate limit exceeded' }))
    const ci = await refresher(s, gh.runner)
    await ci.pass()
    expect(gh.calls.length).toBeLessThanOrEqual(3) // workers stop once paused
    const n = gh.calls.length
    clock += 4 * 60_000
    await ci.pass()
    expect(gh.calls.length).toBe(n)
    expect(ci.health().reason).toBe('CI status paused: GitHub rate limit')
    clock += 2 * 60_000
    await ci.pass()
    expect(gh.calls.length).toBe(n + 1) // one probe after 5 min
    await ci.stop()
  })

  test('without gh (missing or signed out): no status, a one-line health reason, one log line, one probe per 10 min', async () => {
    for (const [answer, reason] of [
      [{ code: 127, stderr: 'Executable not found in $PATH: "gh"' }, 'CI status off: gh not installed'],
      [{ code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }, 'CI status off: gh not signed in'],
    ] as const) {
      clock = Date.parse('2026-10-29T12:00:00Z')
      const { s } = await setup({ 'Q-1': [PR(1), PR(2)], 'Q-2': [PR(3)] })
      const gh = fakeGh(() => answer)
      const log: string[] = []
      const ci = await refresher(s, gh.runner, log)
      await ci.pass()
      await ci.pass()
      clock += 9 * 60_000
      await ci.pass()
      expect(ci.health()).toEqual({ enabled: true, setting: true, reason })
      expect(ci.get(PR(1))).toBeUndefined()
      expect(ciBadge(ci, s.get('Q-1')!)).toBeUndefined()
      expect(needsYouCount(s).count).toBe(needsYouCount(s).count)
      const before = gh.calls.length
      expect(before).toBeLessThanOrEqual(3)
      clock += 2 * 60_000
      await ci.pass()
      expect(gh.calls.length).toBe(before + 1) // a single probe
      expect(log).toEqual([`[ci] ${reason}`])
      await ci.stop()
    }
  })

  test('no access to a repo: nothing shown for it, a health reason naming the repo, re-tried after hours', async () => {
    clock = Date.parse('2026-10-29T12:00:00Z')
    const { s } = await setup({ 'Q-1': [PR(1, 'secret/repo'), PR(2)] })
    const gh = fakeGh((n) => (n === 1 ? { code: 1, stderr: "GraphQL: Could not resolve to a Repository with the name 'secret/repo'." } : { code: 0, stdout: prJson(n) }))
    const ci = await refresher(s, gh.runner)
    await ci.pass()
    expect(ci.get(PR(1, 'secret/repo'))).toBeUndefined()
    expect(ci.get(PR(2))?.state).toBe('open')
    // One bad link doesn't turn CI status off: the problem is reported on that link only.
    expect(ci.health()).toEqual({ enabled: true, setting: true })
    expect(ci.problem(PR(1, 'secret/repo'))).toBe('no access with gh')
    expect(ci.problem(PR(2))).toBeUndefined()
    clock += 3 * 3_600_000
    await ci.pass()
    expect(gh.calls.filter((c) => c[2] === PR(1, 'secret/repo'))).toHaveLength(1)
    await ci.stop()
  })

  test('a new PR link is checked right away (debounced): several links in a burst share one pass', async () => {
    clock = Date.now()
    const { s } = await setup({})
    const gh = fakeGh((n) => ({ code: 0, stdout: prJson(n) }))
    const ci = await refresher(s, gh.runner)
    await s.updateIssue('Q-1', { links: [{ title: 'PR #4', url: PR(4) }] }, ME)
    await s.updateIssue('Q-2', { links: [{ title: 'PR #5', url: PR(5) }] }, ME)
    await Bun.sleep(40)
    await ci.pass()
    expect(gh.calls.map((c) => c[2]).sort()).toEqual([PR(4), PR(5)])
    await ci.stop()
  })

  test('the cache survives a restart: fresh entries are not refetched, results never go into issue files', async () => {
    clock = Date.parse('2026-10-29T12:00:00Z')
    const { root, s } = await setup({ 'Q-1': [PR(12)] })
    const gh = fakeGh((n) => ({ code: 0, stdout: prJson(n, { checks: [run('t', 'COMPLETED', 'SUCCESS')] }) }))
    const ci = await refresher(s, gh.runner)
    await ci.pass()
    await ci.stop()
    const issueText = await readFile(s.get('Q-1')!.path, 'utf8')
    expect(issueText).not.toContain('passing')
    expect(JSON.parse(await readFile(ciCachePath(root), 'utf8')).prs[PR(12)].status.checks).toBe('passing')

    const s2 = await Store.open(root)
    const gh2 = fakeGh((n) => ({ code: 0, stdout: prJson(n) }))
    const ci2 = await refresher(s2, gh2.runner)
    expect(ci2.get(PR(12))?.checks).toBe('passing')
    await ci2.pass()
    expect(gh2.calls).toHaveLength(0)
    await ci2.stop()
    // A corrupt cache is ignored, not fatal.
    await writeFile(ciCachePath(root), '{nope')
    const log: string[] = []
    const ci3 = await refresher(await Store.open(root), gh2.runner, log)
    expect(log).toEqual(['[ci] ignoring an unreadable .tracker/ci.json'])
    await ci3.stop()
  })

  test('off (config.yml or the app setting): nothing fetched, nothing shown; turning it back on fetches', async () => {
    clock = Date.parse('2026-10-29T12:00:00Z')
    const { s } = await setup()
    const gh = fakeGh((n) => ({ code: 0, stdout: prJson(n, { checks: [run('t', 'COMPLETED', 'FAILURE')] }) }))
    const ci = await refresher(s, gh.runner)
    const events: unknown[] = []
    s.on((e) => { if (e.kind === 'ci') events.push(e.changes) })
    await ci.pass()
    expect(events).toEqual([{ 'Q-1': { pr: 12, state: 'open', checks: 'failing' } }])
    ci.setSetting(false)
    expect(events.at(-1)).toEqual({ 'Q-1': null })
    expect(ci.get(PR(12))).toBeUndefined()
    expect(home(s).ci.size).toBe(0)
    expect(ci.health()).toEqual({ enabled: false, setting: false, reason: 'CI status off in Settings' })
    clock += 3_600_000
    await ci.pass()
    expect(gh.calls).toHaveLength(1)
    ci.setSetting(true)
    expect(events.at(-1)).toEqual({ 'Q-1': { pr: 12, state: 'open', checks: 'failing' } })
    s.config.ci = { enabled: false, refreshMinutes: 2 }
    expect(ci.health().reason).toBe('CI status off in config.yml (ci.enabled)')
    await ci.pass()
    expect(gh.calls).toHaveLength(1)
    await ci.stop()
  })
})

describe('Needs you', () => {
  test('failing checks on In Progress and recent Done issues need you, with the reason', async () => {
    clock = Date.now()
    const { s } = await setup({ 'Q-1': [PR(12)], 'Q-6': [PR(6), PR(7)], 'Q-2': [PR(8)] }) // In Progress, Done, Todo
    const gh = fakeGh((n) => ({ code: 0, stdout: prJson(n, { checks: [run('t', 'COMPLETED', 'FAILURE')] }) }))
    const ci = await CiRefresher.start(s, { run: gh.runner, tickMs: 0, saveDelayMs: 5, log: () => {} })
    const before = needsYouCount(s).count
    await ci.pass()
    const h = home(s)
    expect(h.ci.get('Q-1')).toBe('CI failing on PR #12')
    expect(h.ci.get('Q-6')).toBe('CI failing on PR #6 +1 more')
    expect(h.ci.has('Q-2')).toBe(false) // Todo: not started
    expect(h.needsYou.map((i) => i.id)).toEqual(expect.arrayContaining(['Q-1', 'Q-6']))
    expect(needsYouCount(s).count).toBe(before + 2)
    const rows = needsYouList(s)
    expect(rows.find((r) => r.issue.id === 'Q-1')).toMatchObject({ why: 'CI failing on PR #12', ci: 'CI failing on PR #12' })
    // whats_next keeps them in their bucket, only marked.
    const plain = home(s, Date.now(), { stalledInNeedsYou: false })
    expect(plain.needsYou.map((i) => i.id)).not.toContain('Q-1')
    expect(plain.inProgress.map((i) => i.id)).toContain('Q-1')
    // A closed (not merged) PR's failing checks don't count.
    const lookup = (state: 'closed' | 'merged') => ({ enabled: () => true, problem: () => undefined, get: () => ({ pr: 1, state, checks: 'failing' as const, failing: [], checkedAt: '' }) })
    // A PR closed without merging, or merged: its failing checks don't put the issue in Needs you.
    for (const st of ['closed', 'merged'] as const) {
      expect(ciReasonOf({ ci: lookup(st), config: s.config, doneAt: () => undefined }, Date.now())(s.get('Q-1')!)).toBeNull()
    }
    await ci.stop()
  })
})


describe('review fixes', () => {
  test('gh is resolved from PATH first, then Homebrew (Apple Silicon, Intel), then ~/.local/bin', () => {
    const have = (...paths: string[]) => (p: string) => paths.includes(p)
    const home = '/home/x'
    expect(resolveGh({ path: '/usr/bin:/custom/bin', home, exists: have('/custom/bin/gh', '/opt/homebrew/bin/gh') })).toBe('/custom/bin/gh')
    // A login item's PATH: /usr/bin:/bin:/usr/sbin:/sbin.
    const login = '/usr/bin:/bin:/usr/sbin:/sbin'
    expect(resolveGh({ path: login, home, exists: have('/opt/homebrew/bin/gh', '/usr/local/bin/gh') })).toBe('/opt/homebrew/bin/gh')
    expect(resolveGh({ path: login, home, exists: have('/usr/local/bin/gh', '/home/x/.local/bin/gh') })).toBe('/usr/local/bin/gh')
    expect(resolveGh({ path: login, home, exists: have('/home/x/.local/bin/gh') })).toBe('/home/x/.local/bin/gh')
    expect(resolveGh({ path: undefined, home, exists: have() })).toBeNull()
    expect(resolveGh({ path: ':relative:', home, exists: have('relative/gh') })).toBeNull() // only absolute PATH entries
  })

  test('a gh installed after the engine started is found on the next call; a found gh is kept', async () => {
    let found: string | null = null, looks = 0
    const run = makeGhRunner(() => { looks++; return found })
    expect((await run(['--version'])).code).toBe(127)
    found = '/usr/bin/true'
    expect((await run(['--version'])).code).toBe(0)
    expect((await run(['--version'])).code).toBe(0)
    expect(looks).toBe(2)
  })

  test('PR urls follow GitHub name rules', () => {
    expect(prOf('https://github.com/acme-co/web.site_2/pull/3')).toEqual({ repo: 'acme-co/web.site_2', number: 3 })
    expect(prOf('https://github.com/acme/.github/pull/3')).not.toBeNull()
    expect(prOf('https://GitHub.com/acme/web/pull/4')).toEqual({ repo: 'acme/web', number: 4 }) // hosts are case-insensitive
    expect(prOf('https://github.com.evil.com/acme/web/pull/4')).toBeNull()
    for (const bad of ['https://github.com/-acme/web/pull/1', 'https://github.com/acme/../pull/1', 'https://github.com/acme/./pull/1',
      'https://github.com/acme/a..b/pull/1', 'https://github.com/acme/-web/pull/1', 'https://github.com/ac_me/web/pull/1']) {
      expect(prOf(bad)).toBeNull()
    }
  })

  test('merged with failing or pending checks: re-checked every 30 min until 24 h after the merge, then never', async () => {
    clock = Date.parse('2026-10-29T12:00:00Z')
    const mergedAt = new Date(clock - 3_600_000).toISOString()
    const { s } = await setup({ 'Q-1': [PR(1), PR(2)] })
    const gh = fakeGh((n) => ({ code: 0, stdout: prJson(n, { state: 'MERGED', mergedAt,
      checks: [n === 1 ? run('t', 'COMPLETED', 'FAILURE') : run('t', 'IN_PROGRESS', null)] }) }))
    const ci = await refresher(s, gh.runner)
    await ci.pass()
    expect(ci.get(PR(1))).toMatchObject({ state: 'merged', checks: 'failing', mergedAt })
    const at = async (ms: number) => { clock += ms; await ci.pass(); return gh.calls.length }
    expect(await at(29 * 60_000)).toBe(2)
    expect(await at(2 * 60_000)).toBe(4)
    clock = Date.parse(mergedAt) + 24 * 3_600_000 - 60_000
    expect(await at(0)).toBe(6) // the last check inside the 24 h
    expect(await at(31 * 60_000)).toBe(6) // past 24 h after the merge: never again
    expect(await at(24 * 3_600_000)).toBe(6)
    // Still shown as a badge (failing), never as a Needs-you reason.
    expect(ciBadge(ci, s.get('Q-1')!)).toEqual({ pr: 1, state: 'merged', checks: 'failing' })
    expect(home(s, clock).ci.size).toBe(0)
    await ci.stop()
  })

  test('the 7 days for Done issues count from when the issue reached Done, not its last update', async () => {
    clock = Date.now()
    const { s } = await setup({ 'Q-2': [PR(5)], 'Q-3': [PR(6)] })
    await s.updateIssue('Q-2', { status: 'Done' }, ME) // Done now
    const gh = fakeGh((n) => ({ code: 0, stdout: prJson(n, { checks: [run('t', 'COMPLETED', 'FAILURE')] }) }))
    const ci = await refresher(s, gh.runner)
    expect(s.doneAt('Q-2')).toBeGreaterThan(0)
    expect(ci.due()).toContain(PR(5))
    clock += 8 * 86_400_000
    await s.addComment('Q-2', 'a late note', ME) // updated now, Done 8 days ago
    expect(ci.due()).not.toContain(PR(5))
    expect(ciReasonOf(s, clock)(s.get('Q-2')!)).toBeNull()
    await ci.stop()
  })

  test('malformed cache entries are dropped on load', async () => {
    const { root, s } = await setup({ 'Q-1': [PR(1), PR(2), PR(3), PR(4), PR(5)] })
    const ok = { status: { pr: 1, state: 'open', checks: 'passing', failing: [], checkedAt: '2026-10-29T12:00:00Z' }, nextAt: Date.parse('2099-01-01') }
    await mkdir(join(root, '.tracker'), { recursive: true })
    await writeFile(ciCachePath(root), JSON.stringify({ v: 1, prs: {
      [PR(1)]: ok,
      [PR(2)]: { status: { ...ok.status, pr: 2, state: 'weird' }, nextAt: 1 },
      [PR(3)]: { status: { ...ok.status, pr: 3, failing: 'lint' }, nextAt: 1 },
      [PR(4)]: { nextAt: 'soon' },
      [PR(5)]: 'nope',
      'https://example.com/x': ok,
    } }))
    const gh = fakeGh((n) => ({ code: 0, stdout: prJson(n) }))
    const ci = await refresher(s, gh.runner)
    expect(ci.get(PR(1))?.checks).toBe('passing')
    for (const n of [2, 3, 4, 5]) expect(ci.get(PR(n))).toBeUndefined()
    expect(ci.due().sort()).toEqual([PR(2), PR(3), PR(4), PR(5)].sort())
    await ci.stop()
  })

  test('after gh was missing or signed out, a successful `gh auth status` probe resumes', async () => {
    clock = Date.parse('2026-10-29T12:00:00Z')
    const { s } = await setup({ 'Q-1': [PR(1, 'secret/repo')] })
    let signedIn = false
    const calls: string[][] = []
    const runner: GhRunner = async (args) => {
      calls.push(args)
      if (!signedIn) return { code: 4, stdout: '', stderr: 'please run:  gh auth login' }
      if (args[0] === 'auth') return { code: 0, stdout: '', stderr: 'Logged in to github.com' }
      return { code: 1, stdout: '', stderr: "Could not resolve to a Repository with the name 'secret/repo'." }
    }
    const ci = await refresher(s, runner)
    await ci.pass()
    expect(ci.health().reason).toBe('CI status off: gh not signed in')
    signedIn = true
    clock += 11 * 60_000
    await ci.pass()
    expect(calls.map((c) => c[0])).toEqual(['pr', 'auth', 'pr'])
    expect(calls[1]).toEqual(['auth', 'status', '--hostname', 'github.com'])
    expect(ci.health()).toEqual({ enabled: true, setting: true }) // resumed, though that PR has no access
    await ci.stop()
  })

  test('new links wait for the start delay, so the app can post its setting first', async () => {
    clock = Date.now()
    const { s } = await setup({})
    const gh = fakeGh((n) => ({ code: 0, stdout: prJson(n) }))
    const ci = await CiRefresher.start(s, { run: gh.runner, tickMs: 0, startDelayMs: 150, debounceMs: 5, saveDelayMs: 5, log: () => {} })
    await s.updateIssue('Q-1', { links: [{ title: 'PR #4', url: PR(4) }] }, ME)
    await Bun.sleep(60)
    expect(gh.calls).toHaveLength(0)
    ci.setSetting(false) // the app's setting arrives in time: nothing is fetched
    await Bun.sleep(150)
    expect(gh.calls).toHaveLength(0)
    await ci.stop()
  })

  test('stop() kills a gh call in flight and drops its result', async () => {
    const { s } = await setup()
    let signal: AbortSignal | undefined
    const runner: GhRunner = (_args, opts) => new Promise((resolve) => {
      signal = opts?.signal
      signal?.addEventListener('abort', () => resolve({ code: 143, stdout: '', stderr: 'killed' }))
    })
    const ci = await refresher(s, runner)
    const p = ci.pass()
    await Bun.sleep(5)
    await ci.stop()
    await p
    expect(signal?.aborted).toBe(true)
    expect(ci.get(PR(12))).toBeUndefined()
  })
})
