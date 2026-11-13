import { describe, expect, test } from 'bun:test'
import type { Actor } from '../../src/model'
import { Store } from '../../src/engine/store'
import { readConfig } from '../../src/store/metaFiles'
import { callTool, type ToolCtx } from '../../src/tools/handlers'
import { extractLinks, noteExplanation, openDescendants, parentOutcome } from '../../src/tools/rules'
import { miniCopy } from '../engine/helpers'

const agent = (session?: string, workspace = 'web-app'): ToolCtx => ({
  actor: { actor: 'agent', workspace, branch: 'main', ...(session ? { session } : {}) } as Actor,
})
const you: ToolCtx = { actor: { actor: 'you' } }

type Out = Record<string, any>
async function setup() {
  const root = await miniCopy()
  const s = await Store.open(root)
  const call = (name: string, args: unknown, c: ToolCtx = agent('s1')) => callTool(s, name, args, c) as Promise<Out>
  return { root, s, call }
}

describe('rule 1: project from workspace', () => {
  test('mapped workspace fills project', async () => {
    const { call } = await setup()
    const out = await call('save_issue', { title: 'Support thing', labels: ['Bug'] })
    expect(out.project).toBe('support')
    expect(out.id).toBe('Q-7')
  })

  test('unmapped workspace auto-creates project with key TC', async () => {
    const { root, s, call } = await setup()
    const out = await call('save_issue', { title: 'First', labels: ['Task'] }, agent('s1', 'task-clone'))
    expect(out.id).toBe('TC-1')
    expect(out.project).toBe('task-clone')
    const p = s.projects.get('task-clone')!
    expect(p.name).toBe('task-clone')
    expect(p.key).toBe('TC')
    expect((await readConfig(root)).workspaces['task-clone']).toBe('task-clone')
    const second = await call('save_issue', { title: 'Second', labels: ['Task'] }, agent('s1', 'task-clone'))
    expect(second.id).toBe('TC-2')
    expect(s.projects.size).toBe(3)
  })

  test('no project and no workspace explains how to fix', async () => {
    const { call } = await setup()
    await expect(call('save_issue', { title: 'x', labels: ['Bug'] }, you)).rejects.toThrow(/project: "Support"|list_projects/)
  })

  test('unknown project lists existing ones', async () => {
    const { call } = await setup()
    await expect(call('save_issue', { title: 'x', labels: ['Bug'], project: 'Nope' })).rejects.toThrow(/Acme App/)
  })
})

describe('rule 2: labels', () => {
  test('create with no labels is rejected with existing labels listed', async () => {
    const { call } = await setup()
    const err = await call('save_issue', { title: 'x', project: 'support' }).catch((e: Error) => e)
    expect((err as Error).message).toContain("Add at least one label, e.g. labels: ['Feature']. Existing labels: ")
    expect((err as Error).message).toContain('Scope/App')
    await expect(call('save_issue', { title: 'x', project: 'support', labels: [] })).rejects.toThrow(/at least one label/)
  })

  test('unknown labels are created', async () => {
    const { s, call } = await setup()
    const out = await call('save_issue', { title: 'x', project: 'support', labels: ['Perf'] })
    expect(out.labels).toEqual(['Perf'])
    expect(s.labels.find((l) => l.name === 'Perf')).toEqual(expect.objectContaining({ group: null }))
  })

  test('update may leave labels alone; addLabels creates unknown labels too', async () => {
    const { s, call } = await setup()
    await call('save_issue', { id: 'Q-2', title: 'only title' })
    const out = await call('save_issue', { id: 'Q-2', addLabels: ['Spike'] })
    expect(out.labels).toContain('Spike')
    expect(s.labels.some((l) => l.name === 'Spike')).toBe(true)
  })
})

describe('rule 3: explanation for Done/Canceled/Duplicate/Waiting', () => {
  test('Done without explanation is rejected; with comment arg accepted', async () => {
    const { s, call } = await setup()
    await expect(call('save_issue', { id: 'Q-4', state: 'Done' })).rejects.toThrow(/comment/)
    expect(s.get('Q-4')!.status).toBe('Backlog')
    const out = await call('save_issue', { id: 'Q-4', state: 'Done', comment: 'Shipped in PR #1414' })
    expect(out.status).toBe('Done')
    expect(s.get('Q-4')!.activity.at(-1)!.body).toBe('Shipped in PR #1414')
  })

  test('prior save_comment same session accepted', async () => {
    const { call } = await setup()
    await call('save_comment', { issueId: 'Q-4', body: 'Shipped' }, agent('s1'))
    const out = await call('save_issue', { id: 'Q-4', state: 'Canceled' }, agent('s1'))
    expect(out.status).toBe('Canceled')
  })

  test('prior comment from another session rejected', async () => {
    const { call } = await setup()
    await call('save_comment', { issueId: 'Q-4', body: 'Shipped' }, agent('s1'))
    await expect(call('save_issue', { id: 'Q-4', state: 'Done' }, agent('s2'))).rejects.toThrow(/comment/)
  })

  test('sessionless prior comment does not count', async () => {
    const { call } = await setup()
    await call('save_comment', { issueId: 'Q-4', body: 'Shipped' }, agent())
    await expect(call('save_issue', { id: 'Q-4', state: 'Done' }, agent())).rejects.toThrow(/comment/)
  })

  test('comment older than 10 minutes does not count', async () => {
    const { s, call } = await setup()
    noteExplanation(s, 'Q-4', 's1', Date.now() - 11 * 60_000)
    await expect(call('save_issue', { id: 'Q-4', state: 'Done' })).rejects.toThrow(/comment/)
    noteExplanation(s, 'Q-4', 's1', Date.now() - 9 * 60_000)
    expect((await call('save_issue', { id: 'Q-4', state: 'Done' })).status).toBe('Done')
  })

  test('Waiting needs it too; In Progress does not', async () => {
    const { call } = await setup()
    await expect(call('save_issue', { id: 'Q-4', state: 'waiting' })).rejects.toThrow(/comment/)
    expect((await call('save_issue', { id: 'Q-4', state: 'In Progress' })).status).toBe('In Progress')
  })

  test('comment in the same save_issues batch counts', async () => {
    const { s, call } = await setup()
    await call('save_issues', { issues: [{ id: 'Q-4', state: 'Done' }, { id: 'Q-4', comment: 'Shipped in abc123' }] })
    expect(s.get('Q-4')!.status).toBe('Done')
    await expect(call('save_issues', { issues: [{ id: 'Q-3', state: 'Done' }, { id: 'Q-4', comment: 'unrelated' }] })).rejects.toThrow(/Q-3/)
    expect(s.get('Q-3')!.status).toBe('Todo')
  })

  test('the owner is not asked for an explanation', async () => {
    const { call } = await setup()
    expect((await call('save_issue', { id: 'Q-4', state: 'Done' }, you)).status).toBe('Done')
  })
})

describe('rule 4: cycles and unknown ids', () => {
  test('parent cycle rejected', async () => {
    const { s, call } = await setup()
    const err = (await call('save_issue', { id: 'Q-1', parentId: 'Q-3' }).catch((e: Error) => e)) as Error
    expect(err.message).toContain('Q-1 → Q-3 → Q-2 → Q-1')
    expect(s.get('Q-1')!.parent).toBeNull()
    await expect(call('save_issue', { id: 'Q-1', parentId: 'Q-1' })).rejects.toThrow(/cycle/)
  })

  test('blockedBy cycle rejected', async () => {
    const { call } = await setup()
    // Q-4 is blocked by Q-3; making Q-3 blocked by Q-4 closes the loop.
    await expect(call('save_issue', { id: 'Q-3', blockedBy: ['Q-4'] })).rejects.toThrow('Q-3 → Q-4 → Q-3')
  })

  test('cycle through a batch ref rejected', async () => {
    const { s, call } = await setup()
    await expect(call('save_issues', {
      issues: [
        { ref: 'kid', title: 'Kid', project: 'support', labels: ['Task'], parentId: 'Q-1' },
        { id: 'Q-1', parentId: 'ref:kid' },
      ],
    })).rejects.toThrow(/cycle/)
    expect(s.all()).toHaveLength(6)
  })

  test('cycle through a ref on an update item rejected', async () => {
    const { s, call } = await setup()
    await expect(call('save_issues', {
      issues: [
        { ref: 'top', id: 'Q-1', title: 'Top' },
        { id: 'Q-3', blockedBy: ['Q-4'] }, // Q-4 blocked by Q-3 already: cycle
      ],
    })).rejects.toThrow('Q-3 → Q-4 → Q-3')
    await expect(call('save_issues', {
      issues: [
        { ref: 'top', id: 'Q-1', title: 'Top' },
        { id: 'Q-1', parentId: 'Q-3' },
        { ref: 'kid', title: 'Kid', project: 'support', labels: ['Task'], parentId: 'ref:top' },
      ],
    })).rejects.toThrow('Q-1 → Q-3 → Q-2 → Q-1')
    await expect(call('save_issues', {
      issues: [
        { ref: 'top', id: 'Q-3', title: 'Leaf' },
        { id: 'Q-1', parentId: 'ref:top' },
      ],
    })).rejects.toThrow('Q-1 → Q-3 → Q-2 → Q-1')
    expect(s.get('Q-1')!.parent).toBeNull()
    expect(s.get('Q-1')!.title).not.toBe('Top')
  })

  test('unknown ids are listed', async () => {
    const { call } = await setup()
    await expect(call('save_issue', { id: 'Q-2', blockedBy: ['Q-98', 'Q-99'] })).rejects.toThrow(/Q-98, Q-99/)
    await expect(call('save_issue', { id: 'Q-2', parentId: 'Q-77' })).rejects.toThrow(/Q-77/)
    await expect(call('save_issue', { id: 'Q-55', title: 'x' })).rejects.toThrow(/Q-55/)
  })
})

describe('concurrency', () => {
  test('concurrent addLabels on one issue keep both', async () => {
    const { s, call } = await setup()
    await Promise.all([
      call('save_issue', { id: 'Q-2', addLabels: ['RaceX'] }),
      call('save_issue', { id: 'Q-2', addLabels: ['RaceY'] }),
    ])
    expect(s.get('Q-2')!.labels).toEqual(expect.arrayContaining(['RaceX', 'RaceY', 'Task', 'Scope/App']))
  })

  test('concurrent link appends and related partner edits keep both', async () => {
    const { s, call } = await setup()
    await Promise.all([
      call('save_comment', { issueId: 'Q-2', body: 'https://github.com/o/r/pull/1' }),
      call('save_comment', { issueId: 'Q-2', body: 'https://github.com/o/r/pull/2' }),
      call('save_issue', { id: 'Q-3', relatedTo: ['Q-5'] }),
      call('save_issue', { id: 'Q-4', relatedTo: ['Q-5'] }),
    ])
    expect(s.get('Q-2')!.links.map((l) => l.title).sort()).toEqual(['PR #1', 'PR #2'])
    expect([...s.get('Q-5')!.related].sort()).toEqual(['Q-3', 'Q-4'])
  })

  test('concurrent opposite parent assignments: exactly one succeeds', async () => {
    const { s, call } = await setup()
    const r = await Promise.allSettled([
      call('save_issue', { id: 'Q-5', parentId: 'Q-6' }),
      call('save_issue', { id: 'Q-6', parentId: 'Q-5' }),
    ])
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    const rejected = r.find((x) => x.status === 'rejected') as PromiseRejectedResult
    expect(String(rejected.reason.message)).toContain('cycle')
    expect([s.get('Q-5')!.parent, s.get('Q-6')!.parent].filter(Boolean)).toHaveLength(1)
  })

  test('concurrent opposite blockedBy: exactly one succeeds', async () => {
    const { s, call } = await setup()
    const r = await Promise.allSettled([
      call('save_issue', { id: 'Q-5', blockedBy: ['Q-6'] }),
      call('save_issue', { id: 'Q-6', blockedBy: ['Q-5'] }),
    ])
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(s.get('Q-5')!.blockedBy.length + s.get('Q-6')!.blockedBy.length).toBe(1)
  })
})

describe('rule 5: owner-only actions', () => {
  test('agent delete rejected', async () => {
    const { s, call } = await setup()
    await expect(call('delete_issue', { id: 'Q-6' })).rejects.toThrow(/Canceled/)
    expect(s.get('Q-6')).toBeDefined()
  })

  test('set_plan: agents only now; owner anything', async () => {
    const { s, call } = await setup()
    await expect(call('set_plan', { id: 'Q-2', plan: 'later' })).rejects.toThrow(/now/)
    expect((await call('set_plan', { id: 'Q-2', plan: 'now' })).plan).toBe('now')
    expect((await call('set_plan', { id: 'Q-2', plan: 'later' }, you)).plan).toBe('later')
    expect(s.get('Q-2')!.plan).toBe('later')
  })

  test('agent save_view rejected', async () => {
    const { s, call } = await setup()
    const view = { name: 'Mine', filter: {}, display: { layout: 'list', groupBy: 'status', orderBy: 'priority', showSubIssues: false, properties: [] } }
    await expect(call('save_view', view)).rejects.toThrow(/owner/)
    expect(s.views.some((v) => v.slug === 'mine')).toBe(false)
  })

  test('moving to a started status sets plan now', async () => {
    const { call } = await setup()
    expect((await call('save_issue', { id: 'Q-3', state: 'In Progress' })).plan).toBe('now')
  })
})

describe('rule 6: GitHub links', () => {
  test('PR url becomes link', async () => {
    const { s, call } = await setup()
    await call('save_comment', { issueId: 'Q-2', body: 'Opened https://github.com/octo/web-app/pull/1414.' })
    expect(s.get('Q-2')!.links).toEqual([{ title: 'PR #1414', url: 'https://github.com/octo/web-app/pull/1414' }])
    await call('save_issue', { id: 'Q-2', description: 'See https://github.com/octo/web-app/pull/1414/files and https://github.com/o/r/commit/abcdef1234567 and https://github.com/o/r/tree/fix/login-redirect' })
    expect(s.get('Q-2')!.links.map((l) => l.title)).toEqual(['PR #1414', 'Commit abcdef1', 'Branch fix/login-redirect'])
  })

  test('extractLinks ignores non-GitHub urls and dedupes', () => {
    const links = extractLinks('x https://example.com/pull/1 https://github.com/a/b/pull/2 (https://github.com/a/b/pull/2)')
    expect(links).toEqual([{ title: 'PR #2', url: 'https://github.com/a/b/pull/2' }])
  })
})

describe('rule 7: touchedBy', () => {
  test('every write records the actor', async () => {
    const { s, call } = await setup()
    const a = agent('s9', 'acme-app').actor
    await call('save_issue', { id: 'Q-2', title: 'x' }, { actor: a })
    expect(s.get('Q-2')!.touchedBy).toEqual(a)
    await call('save_comment', { issueId: 'Q-3', body: 'hi' }, you)
    expect(s.get('Q-3')!.touchedBy).toEqual({ actor: 'you' })
  })
})

// Fixture: Q-1 (In Progress) > Q-2 (Todo) > Q-3 (Todo).
describe('rule 8: a parent and its sub-issues close together', () => {
  const cfg = {
    statuses: [
      { name: 'Todo', type: 'unstarted' as const, color: '' }, { name: 'Waiting', type: 'started' as const, color: '' },
      { name: 'Done', type: 'completed' as const, color: '' }, { name: 'Canceled', type: 'canceled' as const, color: '' },
      { name: 'Duplicate', type: 'duplicate' as const, color: '' },
    ],
    needsYou: { statuses: ['Waiting'], labels: ['Needs decision'] },
  }
  const parent = (over: Partial<{ status: string; labels: string[]; description: string }> = {}) => ({ status: 'Todo', labels: [], description: '', ...over })
  const kids = (...statuses: string[]) => statuses.map((status) => ({ status }))

  test('parentOutcome: done when any sub-issue is done, else canceled', () => {
    expect(parentOutcome(parent(), kids('Done', 'Canceled'), cfg)).toBe('completed')
    expect(parentOutcome(parent(), kids('Canceled', 'Duplicate'), cfg)).toBe('canceled')
  })

  test('parentOutcome: leaves a parent that is closed, childless, has an open sub-issue, waits on the owner or has open checklist items', () => {
    expect(parentOutcome(parent({ status: 'Canceled' }), kids('Done'), cfg)).toBeNull()
    expect(parentOutcome(parent(), [], cfg)).toBeNull()
    expect(parentOutcome(parent(), kids('Done', 'Todo'), cfg)).toBeNull()
    expect(parentOutcome(parent(), kids('Done', 'Unknown status'), cfg)).toBeNull()
    expect(parentOutcome(parent({ status: 'Waiting' }), kids('Done'), cfg)).toBeNull()
    expect(parentOutcome(parent({ labels: ['Bug', 'Needs decision'] }), kids('Done'), cfg)).toBeNull()
    expect(parentOutcome(parent({ description: '- [x] one\n- [ ] two' }), kids('Done'), cfg)).toBeNull()
    expect(parentOutcome(parent({ description: '- [x] one\n- [x] two' }), kids('Done'), cfg)).toBe('completed')
  })

  test('openDescendants: any depth, through closed steps, cycle-safe', () => {
    const tree: Record<string, { id: string; status: string }[]> = {
      A: [{ id: 'B', status: 'Done' }, { id: 'C', status: 'Todo' }], B: [{ id: 'D', status: 'Todo' }], D: [{ id: 'A', status: 'Todo' }],
    }
    expect(openDescendants('A', (k) => tree[k] ?? [], (st) => st !== 'Done')).toEqual(['C', 'D'])
  })

  test('canceling a parent cancels its open sub-issues at every depth, each with a comment', async () => {
    const { s, call } = await setup()
    await call('save_issue', { id: 'Q-3', state: 'In Progress' })
    const out = await call('save_issue', { id: 'Q-1', state: 'Canceled', comment: 'Dropped.' }, agent('s2'))
    expect(out.alsoChanged).toEqual([{ id: 'Q-2', status: 'Canceled' }, { id: 'Q-3', status: 'Canceled' }])
    expect(s.get('Q-2')!.activity.at(-1)!.body).toBe('Canceled with its parent Q-1 (was Todo).')
    expect(s.get('Q-3')!.activity.at(-1)!.body).toBe('Canceled with its parent Q-1 (was In Progress).')
    // the cascade is the agent's write, but not a session of work on those issues
    expect(s.get('Q-2')!.touchedBy).toEqual({ actor: 'agent', workspace: 'web-app', branch: 'main' })
    expect(s.history('Q-2').some((h) => h.session === 's2')).toBe(false)
    expect(s.history('Q-1').some((h) => h.session === 's2')).toBe(true)
  })

  test('marking a parent Duplicate cancels its sub-issues; closed ones are left alone', async () => {
    const { s, call } = await setup()
    await call('save_issues', { issues: [{ id: 'Q-3', state: 'Done', comment: 'Shipped.' }, { id: 'Q-2', state: 'In Progress' }] })
    const out = await call('save_issue', { id: 'Q-1', state: 'Duplicate' }, you)
    expect(out.alsoChanged).toEqual([{ id: 'Q-2', status: 'Canceled' }])
    expect(s.get('Q-3')!.status).toBe('Done')
  })

  test('a parent cannot be completed over open sub-issues, by an agent or the owner', async () => {
    const { s, call } = await setup()
    const err = await call('save_issue', { id: 'Q-1', state: 'Done', comment: 'Shipped.' }).catch((e: Error) => e)
    expect((err as Error).message).toContain('Q-1 has 2 open sub-issues: Q-2 (Todo), Q-3 (Todo).')
    expect((err as Error).message).toContain('save_issues({ issues: [{ id: "Q-2", state: "Done"')
    await expect(call('save_issue', { id: 'Q-1', state: 'Done' }, you)).rejects.toThrow(/open sub-issues/)
    await expect(call('save_issues', { issues: [{ id: 'Q-2', state: 'Done' }, { id: 'Q-1', state: 'Done' }] }, you)).rejects.toThrow(/Q-1 has 1 open sub-issue: Q-3 \(Todo\)/)
    expect(s.get('Q-1')!.status).toBe('In Progress')
    expect(s.get('Q-2')!.status).toBe('Todo')
  })

  test('a parent is completed when the same call closes its sub-issues, in any order', async () => {
    const { s, call } = await setup()
    const out = await call('save_issues', { issues: [{ id: 'Q-1', state: 'Done' }, { id: 'Q-2', state: 'Done' }, { id: 'Q-3', state: 'Canceled' }] }, you)
    expect(out.alsoChanged).toBeUndefined()
    expect(['Q-1', 'Q-2', 'Q-3'].map((id) => s.get(id)!.status)).toEqual(['Done', 'Done', 'Canceled'])
    expect(s.get('Q-1')!.activity.some((a) => a.body.includes('automatically'))).toBe(false)
  })

  test('closing the last open sub-issue closes the parent, and its parent in turn', async () => {
    const { s, call } = await setup()
    const out = await call('save_issue', { id: 'Q-3', state: 'Done', comment: 'Shipped.' })
    expect(out.alsoChanged).toEqual([{ id: 'Q-2', status: 'Done' }, { id: 'Q-1', status: 'Done' }])
    expect(s.get('Q-2')!.activity.at(-1)!.body).toBe('Its only sub-issue is closed; closed automatically.')
    expect(s.history('Q-2').some((h) => h.session)).toBe(false)
  })

  test('a parent whose sub-issues were all canceled is canceled', async () => {
    const { s, call } = await setup()
    await call('save_issue', { id: 'Q-3', state: 'Canceled' }, you)
    expect(['Q-1', 'Q-2'].map((id) => s.get(id)!.status)).toEqual(['Canceled', 'Canceled'])
  })

  test('a parent with other open sub-issues stays open until the last one closes', async () => {
    const { s, call } = await setup()
    const extra = await call('save_issue', { title: 'Second step', labels: ['Task'], parentId: 'Q-2', project: 'Acme App' })
    await call('save_issue', { id: 'Q-3', state: 'Done' }, you)
    expect(s.get('Q-2')!.status).toBe('Todo')
    const out = await call('save_issue', { id: extra.id, state: 'Canceled' }, you)
    expect(out.alsoChanged).toEqual([{ id: 'Q-2', status: 'Done' }, { id: 'Q-1', status: 'Done' }])
    expect(s.get('Q-2')!.activity.at(-1)!.body).toBe('All 2 sub-issues are closed; closed automatically.')
  })

  test('a parent waiting on the owner or with open checklist items is not closed', async () => {
    const { s, call } = await setup()
    await call('save_issue', { id: 'Q-2', state: 'Waiting' }, you)
    expect((await call('save_issue', { id: 'Q-3', state: 'Done' }, you)).alsoChanged).toBeUndefined()
    expect(s.get('Q-2')!.status).toBe('Waiting')

    const b = await setup()
    await b.call('save_issue', { id: 'Q-2', addLabels: ['Needs review'] }, you)
    await b.call('save_issue', { id: 'Q-3', state: 'Done' }, you)
    expect(b.s.get('Q-2')!.status).toBe('Todo')

    const c = await setup()
    await c.call('save_issue', { id: 'Q-2', description: '- [x] write it\n- [ ] ship it' }, you)
    await c.call('save_issue', { id: 'Q-3', state: 'Done' }, you)
    expect(c.s.get('Q-2')!.status).toBe('Todo')
  })

  test('deleting or moving away the last open sub-issue closes the parent', async () => {
    const { s, call } = await setup()
    const extra = await call('save_issue', { title: 'Second step', labels: ['Task'], parentId: 'Q-2', project: 'Acme App' })
    await call('save_issue', { id: 'Q-3', state: 'Done' }, you)
    const out = await call('delete_issue', { id: extra.id }, you)
    expect(out).toEqual({ deleted: extra.id, alsoChanged: [{ id: 'Q-2', status: 'Done' }, { id: 'Q-1', status: 'Done' }] })

    const b = await setup()
    const moved = await b.call('save_issue', { title: 'Second step', labels: ['Task'], parentId: 'Q-2', project: 'Acme App' })
    await b.call('save_issue', { id: 'Q-3', state: 'Done' }, you)
    const res = await b.call('save_issue', { id: moved.id, parentId: null }, you)
    expect(res.alsoChanged).toEqual([{ id: 'Q-2', status: 'Done' }, { id: 'Q-1', status: 'Done' }])
    expect(b.s.get(moved.id)!.status).toBe('Backlog')
  })

  test('a status the same call sets wins over the cascade', async () => {
    const { s, call } = await setup()
    await call('save_issues', { issues: [{ id: 'Q-1', state: 'Canceled' }, { id: 'Q-3', state: 'In Progress' }] }, you)
    expect(['Q-1', 'Q-2', 'Q-3'].map((id) => s.get(id)!.status)).toEqual(['Canceled', 'Canceled', 'In Progress'])
    expect(s.get('Q-3')!.activity.some((a) => a.body.includes('with its parent'))).toBe(false)
    // the parent a call moves itself is not closed under it
    const b = await setup()
    await b.call('save_issues', { issues: [{ id: 'Q-3', state: 'Done' }, { id: 'Q-2', state: 'In Progress' }] }, you)
    expect(b.s.get('Q-2')!.status).toBe('In Progress')
  })

  test('nothing reopens, and a sub-issue created closed closes nothing', async () => {
    const { s, call } = await setup()
    await call('save_issue', { id: 'Q-3', state: 'Done' }, you)
    await call('save_issue', { id: 'Q-3', state: 'In Progress' }, you)
    expect(['Q-1', 'Q-2'].map((id) => s.get(id)!.status)).toEqual(['Done', 'Done'])

    const b = await setup()
    const out = await b.call('save_issue', { title: 'Imported', labels: ['Task'], parentId: 'Q-4', project: 'Acme App', state: 'Done' }, you)
    expect(out.alsoChanged).toBeUndefined()
    expect(b.s.get('Q-4')!.status).toBe('Backlog')
  })
})
