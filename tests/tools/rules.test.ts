import { describe, expect, test } from 'bun:test'
import type { Actor } from '../../src/model'
import { Store } from '../../src/engine/store'
import { readConfig } from '../../src/store/metaFiles'
import { callTool, type ToolCtx } from '../../src/tools/handlers'
import { extractLinks, noteExplanation } from '../../src/tools/rules'
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
    await expect(call('save_issue', { id: 'Q-2', state: 'Done' })).rejects.toThrow(/comment/)
    expect(s.get('Q-2')!.status).toBe('Todo')
    const out = await call('save_issue', { id: 'Q-2', state: 'Done', comment: 'Shipped in PR #1414' })
    expect(out.status).toBe('Done')
    expect(s.get('Q-2')!.activity.at(-1)!.body).toBe('Shipped in PR #1414')
  })

  test('prior save_comment same session accepted', async () => {
    const { call } = await setup()
    await call('save_comment', { issueId: 'Q-2', body: 'Shipped' }, agent('s1'))
    const out = await call('save_issue', { id: 'Q-2', state: 'Canceled' }, agent('s1'))
    expect(out.status).toBe('Canceled')
  })

  test('prior comment from another session rejected', async () => {
    const { call } = await setup()
    await call('save_comment', { issueId: 'Q-2', body: 'Shipped' }, agent('s1'))
    await expect(call('save_issue', { id: 'Q-2', state: 'Done' }, agent('s2'))).rejects.toThrow(/comment/)
  })

  test('sessionless prior comment does not count', async () => {
    const { call } = await setup()
    await call('save_comment', { issueId: 'Q-2', body: 'Shipped' }, agent())
    await expect(call('save_issue', { id: 'Q-2', state: 'Done' }, agent())).rejects.toThrow(/comment/)
  })

  test('comment older than 10 minutes does not count', async () => {
    const { s, call } = await setup()
    noteExplanation(s, 'Q-2', 's1', Date.now() - 11 * 60_000)
    await expect(call('save_issue', { id: 'Q-2', state: 'Done' })).rejects.toThrow(/comment/)
    noteExplanation(s, 'Q-2', 's1', Date.now() - 9 * 60_000)
    expect((await call('save_issue', { id: 'Q-2', state: 'Done' })).status).toBe('Done')
  })

  test('Waiting needs it too; In Progress does not', async () => {
    const { call } = await setup()
    await expect(call('save_issue', { id: 'Q-2', state: 'waiting' })).rejects.toThrow(/comment/)
    expect((await call('save_issue', { id: 'Q-2', state: 'In Progress' })).status).toBe('In Progress')
  })

  test('comment in the same save_issues batch counts', async () => {
    const { s, call } = await setup()
    await call('save_issues', { issues: [{ id: 'Q-2', state: 'Done' }, { id: 'Q-2', comment: 'Shipped in abc123' }] })
    expect(s.get('Q-2')!.status).toBe('Done')
    await expect(call('save_issues', { issues: [{ id: 'Q-3', state: 'Done' }, { id: 'Q-4', comment: 'unrelated' }] })).rejects.toThrow(/Q-3/)
    expect(s.get('Q-3')!.status).toBe('Todo')
  })

  test('the owner is not asked for an explanation', async () => {
    const { call } = await setup()
    expect((await call('save_issue', { id: 'Q-2', state: 'Done' }, you)).status).toBe('Done')
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
