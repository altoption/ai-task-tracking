import { describe, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Actor } from '../../src/model'
import { ancestors, filterIssues, home, needsYouCount, needsYouList, needsYouRequest, progress, REQUEST_MAX, search, stalledOf, subtree, unblocks } from '../../src/engine/queries'
import { feedPath } from '../../src/engine/eventlog'
import { DEFAULT_STALLED } from '../../src/engine/stalled'
import { Store } from '../../src/engine/store'
import { issuePath, miniCopy } from './helpers'

const agent: Actor = { actor: 'agent', workspace: 'web-app', branch: 'main' }
const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

async function edit(root: string, project: string, id: string, from: string, to: string) {
  const p = issuePath(root, project, id)
  const t = await readFile(p, 'utf8')
  if (!t.includes(from)) throw new Error(`fixture ${id} lacks ${from}`)
  await writeFile(p, t.replace(from, to))
}

describe('queries', () => {
  test('home buckets', async () => {
    const s = await Store.open(await miniCopy())
    const h = home(s)
    expect(ids(h.needsYou)).toEqual(['Q-5'])
    expect(ids(h.inProgress)).toEqual(['Q-1'])
    expect(h.readyNext.map((r) => [r.issue.id, r.unblocks])).toEqual([['Q-3', 1], ['Q-2', 0]])
    expect(h.blocked.map((b) => [b.issue.id, b.blockers])).toEqual([['Q-4', ['Q-3']]])
  })

  test('home: label rules, Blocked label, closed blockers', async () => {
    const root = await miniCopy()
    await edit(root, 'acme-app', 'Q-2', 'labels: [Task, Scope/App]', 'labels: [Task, Needs decision]')
    await edit(root, 'acme-app', 'Q-1', 'labels: [Feature, Scope/App]', 'labels: [Feature, Blocked]')
    await edit(root, 'acme-app', 'Q-3', 'status: Todo', 'status: Done')
    const h = home(await Store.open(root))
    expect(ids(h.needsYou).sort()).toEqual(['Q-2', 'Q-5'])
    expect(ids(h.inProgress)).toEqual([])
    expect(h.blocked.map((b) => [b.issue.id, b.blockers])).toEqual([['Q-1', []]])
    expect(h.readyNext.map((r) => r.issue.id)).toEqual(['Q-4'])
  })

  test('needsYouList: home order, why = Needs-you status first, else the first Needs-you label; capped', async () => {
    const root = await miniCopy()
    await edit(root, 'acme-app', 'Q-2', 'labels: [Task, Scope/App]', 'labels: [Task, Needs decision, Needs review]')
    const s = await Store.open(root)
    const list = needsYouList(s)
    expect(list.map((x) => x.issue.id)).toEqual(ids(home(s).needsYou))
    const q5 = s.get('Q-5')!
    expect(list.find((x) => x.issue.id === 'Q-2')!.why).toBe('Needs decision')
    expect(list.find((x) => x.issue.id === 'Q-5')!.why).toBe(q5.status)
    expect(needsYouList(s, 1).length).toBe(1)
  })

  test('readyNext ordered by priority then unblocks', async () => {
    const root = await miniCopy()
    const s = await Store.open(root)
    const a = await s.createIssue({ title: 'A', project: 'support', status: 'Todo', priority: 3 }, agent) // Q-7, unblocks 0
    const b = await s.createIssue({ title: 'B', project: 'support', status: 'Todo', priority: 0 }, agent) // Q-8, none -> last
    const c = await s.createIssue({ title: 'C', project: 'support', status: 'Backlog', priority: 4 }, agent) // Q-9
    await s.updateIssue('Q-4', { blockedBy: ['Q-3', 'Q-2'] }, agent) // Q-2 now unblocks 1
    expect(home(s).readyNext.map((r) => [r.issue.id, r.unblocks])).toEqual([
      ['Q-3', 1], ['Q-2', 1], [a.id, 0], [c.id, 0], [b.id, 0],
    ])
    // equal priority (3): higher unblocks first -> A (2) before Q-2 (1)
    await s.createIssue({ title: 'D', project: 'support', status: 'Backlog', blockedBy: [a.id] }, agent)
    await s.createIssue({ title: 'E', project: 'support', status: 'Backlog', blockedBy: [a.id] }, agent)
    expect(home(s).readyNext.map((r) => [r.issue.id, r.unblocks])).toEqual([
      ['Q-3', 1], [a.id, 2], ['Q-2', 1], [c.id, 0], [b.id, 0],
    ])
  })

  test('unblocks is transitive and counts open only', async () => {
    const root = await miniCopy()
    const s = await Store.open(root)
    await s.createIssue({ title: 'after 4', project: 'support', blockedBy: ['Q-4'] }, agent)
    expect(unblocks(s, 'Q-3')).toBe(2)
    await s.updateIssue('Q-4', { status: 'Canceled' }, agent)
    expect(unblocks(s, 'Q-3')).toBe(1)
  })

  test('subtree depth 3', async () => {
    const s = await Store.open(await miniCopy())
    const t = subtree(s, 'Q-1')
    expect(t.issue.id).toBe('Q-1')
    expect(t.children.map((c) => c.issue.id)).toEqual(['Q-2'])
    expect(t.children[0]!.children.map((c) => c.issue.id)).toEqual(['Q-3'])
    expect(t.children[0]!.children[0]!.children).toEqual([])
    expect(ids(ancestors(s, 'Q-3'))).toEqual(['Q-2', 'Q-1'])
  })

  test('progress counts descendants done', async () => {
    const s = await Store.open(await miniCopy())
    expect(progress(s, 'Q-1')).toEqual({ done: 0, total: 2 })
    await s.updateIssue('Q-3', { status: 'Done' }, agent)
    expect(progress(s, 'Q-1')).toEqual({ done: 1, total: 2 })
    expect(progress(s, 'Q-3')).toEqual({ done: 0, total: 0 })
  })

  test('parent cycle does not hang', async () => {
    const root = await miniCopy()
    await edit(root, 'acme-app', 'Q-1', 'parent: null', 'parent: Q-3') // Q-1 -> Q-2 -> Q-3 -> Q-1
    await edit(root, 'support', 'Q-5', 'parent: null', 'parent: Q-6')
    await edit(root, 'support', 'Q-6', 'parent: null', 'parent: Q-5') // A<->B
    await edit(root, 'acme-app', 'Q-3', 'blocked_by: []', 'blocked_by: [Q-4]') // blocker cycle Q-3<->Q-4
    const s = await Store.open(root)
    const t0 = performance.now()
    const t = subtree(s, 'Q-1')
    expect(t.children[0]!.children[0]!.issue.id).toBe('Q-3')
    expect(t.children[0]!.children[0]!.children).toEqual([]) // Q-1 not revisited
    expect(subtree(s, 'Q-5').children.map((c) => c.issue.id)).toEqual(['Q-6'])
    expect(ids(ancestors(s, 'Q-3'))).toEqual(['Q-2', 'Q-1'])
    expect(ids(ancestors(s, 'Q-5'))).toEqual(['Q-6'])
    expect(progress(s, 'Q-1')).toEqual({ done: 0, total: 2 })
    expect(progress(s, 'Q-5')).toEqual({ done: 1, total: 1 })
    expect(unblocks(s, 'Q-3')).toBe(1)
    expect(unblocks(s, 'Q-4')).toBe(1)
    home(s)
    expect(performance.now() - t0).toBeLessThan(50)
  })

  test('dangling parent/blocker ids', async () => {
    const root = await miniCopy()
    await edit(root, 'acme-app', 'Q-2', 'parent: Q-1', 'parent: Q-999')
    await edit(root, 'acme-app', 'Q-4', 'blocked_by: [Q-3]', 'blocked_by: [Q-998]')
    const s = await Store.open(root)
    expect(ids(ancestors(s, 'Q-3'))).toEqual(['Q-2'])
    expect(subtree(s, 'Q-2').children.map((c) => c.issue.id)).toEqual(['Q-3'])
    expect(unblocks(s, 'Q-998')).toBe(1)
    const h = home(s)
    expect(h.blocked).toEqual([])
    expect(h.readyNext.map((r) => r.issue.id)).toContain('Q-4')
    expect(() => subtree(s, 'Q-404')).toThrow(/Q-404/)
  })

  test('filterIssues by labels and workspace', async () => {
    const root = await miniCopy()
    const s = await Store.open(root)
    expect(ids(filterIssues(s, { labels: ['Scope/Support'] }))).toEqual(['Q-5'])
    expect(ids(filterIssues(s, { labels: ['Scope/Support'], includeDone: true })).sort()).toEqual(['Q-5', 'Q-6'])
    expect(ids(filterIssues(s, { status: ['Done'] }))).toEqual(['Q-6'])
    await s.updateIssue('Q-3', { priority: 2 }, agent)
    await s.addComment('Q-4', 'seen from cdp', { actor: 'agent', workspace: 'cdp' })
    expect(ids(filterIssues(s, { workspace: ['web-app'] }))).toEqual(['Q-3'])
    expect(ids(filterIssues(s, { workspace: ['cdp'] }))).toEqual(['Q-4'])
    expect(ids(filterIssues(s, { project: ['support'] }))).toEqual(['Q-5'])
    expect(ids(filterIssues(s, { parent: null })).sort()).toEqual(['Q-1', 'Q-4', 'Q-5'])
    expect(ids(filterIssues(s, { parent: 'Q-1' }))).toEqual(['Q-2'])
    expect(ids(filterIssues(s, { priority: [2] })).sort()).toEqual(['Q-1', 'Q-3', 'Q-5'])
    expect(ids(filterIssues(s, { blocked: true }))).toEqual(['Q-4'])
    expect(ids(filterIssues(s, { query: 'fan curve' }))).toEqual(['Q-3'])
    expect(ids(filterIssues(s, { updatedAfter: '2026-10-20T00:00:00Z' })).sort()).toEqual(['Q-3', 'Q-4'])
  })

  test('search ranks title hit above activity hit', async () => {
    const root = await miniCopy()
    const s = await Store.open(root)
    await s.addComment('Q-5', 'customer asked for a quote today', agent) // activity hit, most recently updated
    await s.updateIssue('Q-6', { description: 'Typo was on the quote page.' }, agent) // description hit
    const r = ids(search(s, 'quote'))
    expect(r.slice(0, 2).sort()).toEqual(['Q-1', 'Q-4']) // title hits
    expect(r.slice(2)).toEqual(['Q-6', 'Q-5'])
    expect(ids(search(s, 'QUOTE', 1))).toHaveLength(1)
    expect(ids(search(s, 'fan tab'))).toEqual(['Q-3']) // all terms, last is a prefix
    expect(ids(search(s, 'q-4'))[0]).toBe('Q-4') // exact id first
    expect(search(s, '   ')).toEqual([])
    // index follows changes
    await s.updateIssue('Q-3', { title: 'Parse blower tables' }, agent)
    expect(ids(search(s, 'fan'))).toEqual([])
    expect(ids(search(s, 'blower'))).toEqual(['Q-3'])
  })

  test('needsYouRequest: the newest comment on one line, and when it moved into its Needs-you status', async () => {
    const s = await Store.open(await miniCopy())
    await s.updateIssue('Q-2', { status: 'In Progress' }, agent)
    const before = Date.now()
    await s.updateIssue('Q-2', { status: 'Waiting' }, agent)
    await s.addComment('Q-2', 'Older note', agent)
    await s.addComment('Q-2', '## Needs\n\n**Your** Apple `app-specific` password\n> to notarize', agent)
    const r = needsYouRequest(s, s.get('Q-2')!)
    expect(r.request).toBe('Needs Your Apple app-specific password to notarize')
    expect(Date.parse(r.waitingSince!)).toBeGreaterThanOrEqual(before - 1000)
    // Long notes are shortened; a label-only item has no waitingSince; no comments, no request.
    await s.addComment('Q-2', 'x'.repeat(500), agent)
    expect(needsYouRequest(s, s.get('Q-2')!).request).toBe(`${'x'.repeat(REQUEST_MAX - 1)}…`)
    await s.updateIssue('Q-3', { labels: ['Needs review'] }, agent)
    expect(needsYouRequest(s, s.get('Q-3')!).waitingSince).toBeUndefined()
    const bare = await s.createIssue({ title: 'Bare', project: 'support', status: 'Waiting' }, agent)
    expect(needsYouRequest(s, bare).request).toBeUndefined()
  })
})

describe('needsYouRequest: whose comment, and how long it has waited', () => {
  const NOW = Date.now(), H = 3_600_000
  const iso = (hAgo: number) => new Date(NOW - hAgo * H).toISOString()
  const you: Actor = { actor: 'you' }
  /** Q-5 in the fixture is Waiting. */
  const withFeed = async (lines: object[]) => {
    const root = await miniCopy()
    await mkdir(dirname(feedPath(root)), { recursive: true })
    await writeFile(feedPath(root), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return Store.open(root)
  }
  const move = (hAgo: number, from: string, to: string) => ({ at: iso(hAgo), actor: agent, id: 'Q-5', kind: 'status', from, to })

  test('an owner reply is not the request; the agent comment before it is', async () => {
    const s = await Store.open(await miniCopy())
    await s.addComment('Q-5', 'Which provider?', agent)
    await s.addComment('Q-5', 'Let me think about it', you)
    expect(needsYouRequest(s, s.get('Q-5')!).request).toBe('Which provider?')
  })

  test('only owner comments: no request', async () => {
    const s = await Store.open(await miniCopy())
    const i = await s.createIssue({ title: 'Mine', project: 'support', status: 'Waiting' }, you)
    await s.addComment(i.id, 'A note to myself', you)
    expect(needsYouRequest(s, s.get(i.id)!).request).toBeUndefined()
  })

  test('no request for an item not in Needs you by status or label (stalled-only, CI-only)', async () => {
    const s = await Store.open(await miniCopy())
    await s.addComment('Q-1', 'A status note', agent) // Q-1: In Progress, no Needs-you label
    expect(needsYouRequest(s, s.get('Q-1')!).request).toBeUndefined()
    await s.updateIssue('Q-1', { labels: ['Needs decision'] }, agent)
    expect(needsYouRequest(s, s.get('Q-1')!).request).toBe('A status note')
  })

  test('a 10-day wait survives the window: a newer agent write does not reset it', async () => {
    const s = await withFeed([move(240, 'Todo', 'Waiting'), { at: iso(1), actor: { ...agent, session: 's1' }, id: 'Q-5', kind: 'comment', text: 'still here' }])
    expect(needsYouRequest(s, s.get('Q-5')!).waitingSince).toBe(iso(240))
  })

  test('re-entry into Waiting counts from the last entry, not the first', async () => {
    const s = await withFeed([move(20, 'Todo', 'Waiting'), move(10, 'Waiting', 'In Progress'), move(1, 'In Progress', 'Waiting')])
    expect(needsYouRequest(s, s.get('Q-5')!).waitingSince).toBe(iso(1))
  })

  test('the newest logged move went elsewhere (the file was edited since): no waitingSince, not a stale move', async () => {
    const s = await withFeed([move(20, 'Todo', 'Waiting'), move(10, 'Waiting', 'In Progress')])
    expect(needsYouRequest(s, s.get('Q-5')!).waitingSince).toBeUndefined()
  })

  test('never moved: it has waited since it was created', async () => {
    const s = await Store.open(await miniCopy())
    const i = await s.createIssue({ title: 'Born waiting', project: 'support', status: 'Waiting' }, agent)
    expect(needsYouRequest(s, i).waitingSince).toBe(i.created)
  })

  test('cleanup: links, emphasis and list marks go; identifiers and arithmetic stay', async () => {
    const s = await Store.open(await miniCopy())
    const of = async (body: string) => { await s.addComment('Q-5', body, agent); return needsYouRequest(s, s.get('Q-5')!).request }
    expect(await of('See [the PR](https://example.com/1) and ![shot](a.png)')).toBe('See the PR and shot')
    expect(await of('Rename `__init__` and __init__ and snake_case_name')).toBe('Rename __init__ and __init__ and snake_case_name')
    expect(await of('This is *really* **important**')).toBe('This is really important')
    expect(await of('2 * 3 * 4 and a*b*c')).toBe('2 * 3 * 4 and a*b*c')
    expect(await of('* first\n- second')).toBe('first second')
  })
})

describe('stalled (config.stalled)', () => {
  const H = 3_600_000
  /**
   * The fixture turns idle off (its dates are fixed); these tests use the defaults. Q-1 is In Progress since
   * 2026-10-01 and is an epic: its newest change, counting its child Q-2 and grandchild Q-3, is 2026-10-03T10:00Z.
   */
  async function open(root?: string) {
    const s = await Store.open(root ?? await miniCopy())
    s.config.stalled = { ...DEFAULT_STALLED }
    return s
  }
  const at = (iso: string) => Date.parse(iso)

  test('idle In Progress goes to Needs you with its reason, computed in the same pass as the other buckets', async () => {
    const s = await open()
    const now = at('2026-10-04T17:00:00Z') // Q-1's newest change (its grandchild Q-3) was 31 h before
    const h = home(s, now)
    expect(ids(h.needsYou)).toEqual(['Q-1', 'Q-5'])
    expect(ids(h.inProgress)).toEqual([])
    expect([...h.stalled]).toEqual([['Q-1', 'idle 31 h in In Progress']])
    expect(needsYouCount(s, now)).toEqual({ count: 2, stalledOnly: ['Q-1'], stalledAll: ['Q-1'] })
    const list = needsYouList(s, 50, now)
    expect(list.find((x) => x.issue.id === 'Q-1')).toMatchObject({ why: 'stalled', stalled: 'idle 31 h in In Progress' })
    expect(list.find((x) => x.issue.id === 'Q-5')).toEqual({ issue: s.get('Q-5')!, why: 'Waiting' })
    // A day minus a millisecond after the last change it is not idle yet.
    expect(home(s, at('2026-10-04T10:00:00Z') - 1).stalled.size).toBe(0)
  })

  test('a stalled issue that already needs you keeps its status as why, and stalled as well', async () => {
    const s = await open()
    await s.updateIssue('Q-1', { labels: ['Needs review'] }, { actor: 'you' })
    const now = Date.parse(s.get('Q-1')!.updated) + 25 * H
    expect(needsYouList(s, 50, now).find((x) => x.issue.id === 'Q-1')).toMatchObject({ why: 'Needs review', stalled: 'idle 25 h in In Progress' })
    expect(needsYouCount(s, now)).toEqual({ count: 2, stalledOnly: [], stalledAll: ['Q-1'] })
  })

  test('any edit or comment, by anyone, resets idle; Done is never stalled; idleHours 0 is off', async () => {
    const s = await open()
    expect(stalledOf(s)(s.get('Q-1')!)).toMatch(/^idle \d+ d in In Progress$/)
    await s.addComment('Q-1', 'still on it', agent)
    expect(stalledOf(s)(s.get('Q-1')!)).toBeNull()
    expect(stalledOf(s, Date.now() + 24 * H)(s.get('Q-1')!)).toBe('idle 24 h in In Progress')
    await s.updateIssue('Q-1', { status: 'Done' }, agent)
    expect(stalledOf(s, Date.now() + 99 * 24 * H)(s.get('Q-1')!)).toBeNull()
    s.config.stalled.idleHours = 0
    await s.updateIssue('Q-1', { status: 'In Progress' }, agent)
    expect(stalledOf(s, Date.now() + 99 * 24 * H)(s.get('Q-1')!)).toBeNull()
  })

  test('churning from writes: reopens and agent sessions are remembered as they happen; Waiting round trips are not reopens', async () => {
    const s = await open()
    const by = (session: string): Actor => ({ ...agent, session })
    await s.updateIssue('Q-3', { status: 'In Progress' }, by('a')) // first start
    await s.updateIssue('Q-3', { status: 'Waiting' }, by('a'))
    await s.updateIssue('Q-3', { status: 'In Progress' }, by('b')) // back from asking the owner: not a reopen
    await s.updateIssue('Q-3', { status: 'Todo' }, { actor: 'you' })
    await s.updateIssue('Q-3', { status: 'In Progress' }, by('c')) // reopen 1
    expect(stalledOf(s)(s.get('Q-3')!)).toBeNull()
    await s.updateIssue('Q-3', { status: 'Done' }, by('d'))
    expect(stalledOf(s)(s.get('Q-3')!)).toBeNull() // Done is never stalled
    await s.updateIssue('Q-3', { status: 'In Progress' }, by('e')) // reopen 2: churn comes back at once
    expect(stalledOf(s)(s.get('Q-3')!)).toBe('reopened 2× in 7 days by 1 session')
    expect(s.history('Q-3').map((e) => e.to ?? '·')).toEqual(['In Progress', 'Waiting', 'In Progress', 'Todo', 'In Progress', 'Done', 'In Progress'])
    // ... and outside the window they no longer count.
    expect(stalledOf(s, Date.now() + 8 * 24 * H)(s.get('Q-3')!)).toMatch(/^idle /)
  })

  test('Blocked wins: an issue with an open blocker is never stalled and stays in Blocked', async () => {
    const s = await open()
    await s.updateIssue('Q-4', { status: 'In Progress' }, agent) // Q-4 is blocked by Q-3 (Todo)
    const later = Date.now() + 2 * 24 * H
    expect(stalledOf(s, later)(s.get('Q-4')!)).toBeNull()
    const h = home(s, later)
    expect(h.blocked.map((b) => b.issue.id)).toContain('Q-4')
    expect(h.stalled.has('Q-4')).toBe(false)
    await s.updateIssue('Q-3', { status: 'Done' }, agent) // unblocked: now it can idle
    expect(stalledOf(s, later)(s.get('Q-4')!)).toMatch(/^idle /)
  })

  test('history maps are pruned when an issue is removed', async () => {
    const s = await open()
    await s.updateIssue('Q-2', { status: 'In Progress' }, { ...agent, session: 'x' })
    expect(s.history('Q-2').length).toBeGreaterThan(0)
    await s.deleteIssue('Q-2', { actor: 'you' })
    expect(s.history('Q-2')).toEqual([])
    expect(s.hasHistory('Q-2')).toBe(false)
  })

  test('an epic is not idle while its descendants change (ATT-37)', async () => {
    const s = await open()
    const epic = () => s.get('Q-1')!
    // Q-1 changed 2026-10-01, Q-2 (child) 10-02, Q-3 (grandchild) 10-03: idle counts from the grandchild.
    expect(stalledOf(s, at('2026-10-03T10:00:00Z') + 24 * H - 1)(epic())).toBeNull()
    expect(stalledOf(s, at('2026-10-03T10:00:00Z') + 25 * H)(epic())).toBe('idle 25 h in In Progress')
    // Work on a grandchild today resets the epic's idle time.
    await s.addComment('Q-3', 'progress', agent)
    expect(stalledOf(s)(epic())).toBeNull()
    expect(stalledOf(s, Date.now() + 24 * H)(epic())).toBe('idle 24 h in In Progress')
    // A leaf is unaffected: its own last change counts.
    await s.updateIssue('Q-3', { status: 'In Progress' }, agent)
    expect(stalledOf(s, Date.now() + 24 * H)(s.get('Q-3')!)).toBe('idle 24 h in In Progress')
  })

  test('an epic whose open children all need the owner or are blocked is waiting on them, not idle (ATT-37)', async () => {
    const s = await open()
    const later = (h: number) => Date.now() + h * H
    // Q-1's only child Q-2 (open, Todo) is neither: the epic idles from its newest descendant change.
    await s.addComment('Q-2', 'note', agent)
    expect(stalledOf(s, later(30))(s.get('Q-1')!)).toBe('idle 30 h in In Progress')
    await s.updateIssue('Q-2', { status: 'Waiting' }, agent) // asks the owner
    expect(stalledOf(s, later(99))(s.get('Q-1')!)).toBeNull()
    await s.updateIssue('Q-2', { status: 'Todo', labels: ['Blocked'] }, agent) // blocked
    expect(stalledOf(s, later(99))(s.get('Q-1')!)).toBeNull()
    await s.updateIssue('Q-2', { labels: ['Needs decision'] }, agent) // a Needs-you label counts as asking too
    expect(stalledOf(s, later(99))(s.get('Q-1')!)).toBeNull()
    // A closed child isn't waited on: with Q-2 Done the epic has no open children, so it idles again, counting from
    // Q-2's last change (moving it to Done).
    await s.updateIssue('Q-2', { status: 'Done', labels: [] }, agent)
    expect(stalledOf(s, later(30))(s.get('Q-1')!)).toBe('idle 30 h in In Progress')
  })

  test('waiting goes through nested epics; every open child must wait; an open blocker counts as blocked (ATT-37)', async () => {
    const s = await open()
    const later = (h: number) => Date.now() + h * H
    // Q-1 > Q-2 > Q-3. Q-2 in progress, its only open child Q-3 waiting on the owner: both epics are waiting.
    await s.updateIssue('Q-2', { status: 'In Progress' }, agent)
    await s.updateIssue('Q-3', { status: 'Waiting' }, agent)
    expect(stalledOf(s, later(99))(s.get('Q-2')!)).toBeNull()
    expect(stalledOf(s, later(99))(s.get('Q-1')!)).toBeNull()
    // A second open child of Q-1 that isn't waiting: Q-1 is no longer waiting, so it idles (Q-2 still waits).
    await s.updateIssue('Q-4', { parent: 'Q-1', blockedBy: [] }, agent) // the fixture has it blocked by Q-3
    expect(stalledOf(s, later(30))(s.get('Q-1')!)).toBe('idle 30 h in In Progress')
    expect(stalledOf(s, later(99))(s.get('Q-2')!)).toBeNull()
    // Blocked by an open issue (no label) counts as blocked: Q-1 waits again.
    await s.updateIssue('Q-4', { blockedBy: ['Q-5'] }, agent)
    expect(stalledOf(s, later(99))(s.get('Q-1')!)).toBeNull()
  })

  test('a parent cycle in hand-edited files ends the walk (ATT-37)', async () => {
    const root = await miniCopy()
    await edit(root, 'acme-app', 'Q-1', 'parent: null', 'parent: Q-3') // Q-1 > Q-2 > Q-3 > Q-1
    const s = await open(root)
    const now = at('2026-10-04T17:00:00Z')
    expect(stalledOf(s, now)(s.get('Q-1')!)).toBe('idle 31 h in In Progress')
  })

  test('needsYouList can leave out stalled-only issues before the cut (the menu with the stalled setting off)', async () => {
    const s = await open()
    const now = at('2026-10-04T17:00:00Z')
    expect(needsYouList(s, 1, now).map((x) => x.issue.id)).toEqual(['Q-1'])
    expect(needsYouList(s, 1, now, { stalled: false }).map((x) => x.issue.id)).toEqual(['Q-5'])
  })

  test('history comes from the feed log at open: status moves, agent sessions, hand edits as last change', async () => {
    const root = await miniCopy()
    const now = Date.now()
    const iso = (ago: number) => new Date(now - ago).toISOString()
    const ev = (ago: number, kind: string, extra: object = {}) => JSON.stringify({ at: iso(ago), id: 'Q-2', kind, actor: { actor: 'agent', workspace: 'w', session: `s${ago}` }, ...extra })
    await mkdir(dirname(feedPath(root)), { recursive: true })
    await writeFile(feedPath(root), [
      ev(5 * H, 'comment'), ev(4 * H, 'updated'), ev(3 * H, 'comment'), ev(2 * H, 'comment'),
      'not json', JSON.stringify({ at: iso(H), id: 'Q-4', kind: 'updated', actor: { actor: 'you', workspace: 'external' } }), '',
    ].join('\n'))
    const s = await open(root)
    expect(s.history('Q-2')).toHaveLength(4)
    expect(stalledOf(s)(s.get('Q-2')!)).toBe('4 sessions in 7 days without Done')
    expect(s.history('Q-4')).toEqual([]) // the owner's hand edit is no session and no status move...
    expect(s.lastChange(s.get('Q-4')!)).toBe(Date.parse(iso(H))) // ...but it is the newest change
  })
})
