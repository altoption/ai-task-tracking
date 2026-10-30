import { describe, expect, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Actor } from '../../src/model'
import { Store } from '../../src/engine/store'
import { callTool, ToolError, type ToolCtx } from '../../src/tools/handlers'
import { toolSchemas } from '../../src/tools/schemas'
import { miniCopy } from '../engine/helpers'

const agent: Actor = { actor: 'agent', workspace: 'web-app', branch: 'main', session: 's1' }
const ctx: ToolCtx = { actor: agent }
const youCtx: ToolCtx = { actor: { actor: 'you' } }

type Out = Record<string, any>
async function setup() {
  const root = await miniCopy()
  const s = await Store.open(root)
  const call = (name: string, args: unknown = {}, c: ToolCtx = ctx) => callTool(s, name, args, c) as Promise<Out>
  return { root, s, call }
}

describe('tool schemas', () => {
  test('every tool has a description and a plain z.object input', () => {
    for (const name of [
      'save_issue', 'get_issue', 'list_issues', 'save_comment', 'list_comments', 'list_projects', 'get_project',
      'save_project', 'list_issue_statuses', 'list_issue_labels', 'save_issue_label', 'list_milestones',
      'save_milestone', 'save_document', 'get_document', 'list_teams', 'save_issues', 'search', 'whats_next',
      'get_tree', 'delete_issue', 'save_view', 'set_plan', 'toggle_task',
    ]) {
      const t = toolSchemas[name]
      expect(t, name).toBeDefined()
      expect(t!.description.length).toBeGreaterThan(10)
      expect(typeof t!.input.shape).toBe('object')
    }
  })

  test('unknown tool and bad args give agent-readable ToolErrors', async () => {
    const { call } = await setup()
    await expect(call('nope')).rejects.toBeInstanceOf(ToolError)
    await expect(call('nope')).rejects.toThrow(/save_issue/)
    await expect(call('get_issue', {})).rejects.toThrow(/id/)
    await expect(call('save_issue', { id: 'Q-1', priority: 9 })).rejects.toThrow(/priority/)
  })
})

describe('issue tools', () => {
  test('save_issue creates with team/state/assignee-shaped args', async () => {
    const { s, call } = await setup()
    const out = await call('save_issue', {
      title: 'Fan table import', team: 'Acme', project: 'Acme App', state: 'Todo', priority: 2,
      assignee: 'me', labels: ['Feature'], parentId: 'Q-1',
    })
    expect(out.id).toBe('Q-7')
    expect(out.status).toBe('Todo')
    expect(out.labels).toEqual(['Feature'])
    expect(out.parent).toBe('Q-1')
    expect(out.priority).toBe(2)
    expect(out.project).toBe('acme-app')
    expect(out.url).toBe('http://127.0.0.1:7477/#/issue/Q-7')
    expect(out.appUrl).toBe('aitt://issue/Q-7')
    expect(out.path).toBeUndefined()
    expect(s.get('Q-7')?.touchedBy).toEqual(agent)
  })

  test('url uses AITT_PORT over config.port', async () => {
    const root = await miniCopy()
    const prev = process.env.AITT_PORT
    process.env.AITT_PORT = '9123'
    try {
      const s = await Store.open(root)
      expect(s.port).toBe(9123)
      const out = (await callTool(s, 'get_issue', { id: 'Q-1' }, ctx)) as Out
      expect(out.url).toBe('http://127.0.0.1:9123/#/issue/Q-1')
      const s2 = await Store.open(root, { port: 8001 })
      expect(s2.port).toBe(8001)
    } finally {
      if (prev === undefined) delete process.env.AITT_PORT
      else process.env.AITT_PORT = prev
    }
  })

  test('save_issue updates by id with patch semantics', async () => {
    const { s, call } = await setup()
    const before = s.get('Q-2')!
    const out = await call('save_issue', { id: 'q-2', title: 'Renamed', priority: 1, dueDate: '2026-12-24' })
    expect(out.title).toBe('Renamed')
    expect(out.priority).toBe(1)
    expect(out.due).toBe('2026-12-24')
    expect(out.status).toBe(before.status)
    expect(out.labels).toEqual(before.labels)
    expect(out.parent).toBe('Q-1')
    expect(out.description).toBe(before.description)
  })

  test('save_issue moves project and clears parent with null', async () => {
    const { s, call } = await setup()
    const out = await call('save_issue', { id: 'Q-3', project: 'support', parentId: null })
    expect(out.project).toBe('support')
    expect(out.parent).toBeNull()
    expect(s.children('Q-2')).toEqual([])
  })

  test('addLabels/removeLabels', async () => {
    const { call } = await setup()
    const out = await call('save_issue', { id: 'Q-2', addLabels: ['Bug', 'Task'], removeLabels: ['Scope/App'] })
    expect(out.labels).toEqual(['Task', 'Bug'])
    const replaced = await call('save_issue', { id: 'Q-2', labels: ['Improvement'] })
    expect(replaced.labels).toEqual(['Improvement'])
  })

  test('relatedTo is symmetric', async () => {
    const { s, call } = await setup()
    await call('save_issue', { id: 'Q-2', relatedTo: ['Q-5', 'Q-6'] })
    expect(s.get('Q-2')!.related).toEqual(['Q-5', 'Q-6'])
    expect(s.get('Q-5')!.related).toEqual(['Q-2'])
    expect(s.get('Q-6')!.related).toEqual(['Q-2'])
    await call('save_issue', { id: 'Q-2', relatedTo: ['Q-5'] })
    expect(s.get('Q-6')!.related).toEqual([])
    expect(s.get('Q-5')!.related).toEqual(['Q-2'])
  })

  test('delta args add/remove blockers, related (both sides) and links inside the queue', async () => {
    const { s, call } = await setup()
    await call('save_issue', { id: 'Q-2', blockedBy: ['Q-4'], relatedTo: ['Q-5'], links: [{ url: 'https://a.example/1', title: 'one' }, { url: 'https://a.example/2' }] })
    const out = await call('save_issue', { id: 'Q-2', addBlockedBy: ['Q-3'], removeBlockedBy: ['Q-4'], addRelatedTo: ['Q-6'], removeRelatedTo: ['Q-5'], removeLinks: ['https://a.example/1'] })
    expect(out.blockedBy).toEqual(['Q-3'])
    expect(out.related).toEqual(['Q-6'])
    expect(out.links.map((l: any) => l.url)).toEqual(['https://a.example/2'])
    expect(s.get('Q-6')!.related).toEqual(['Q-2'])
    expect(s.get('Q-5')!.related).toEqual([])
  })

  test('concurrent delta edits of blockers both land', async () => {
    const { s, call } = await setup()
    await Promise.all([call('save_issue', { id: 'Q-2', addBlockedBy: ['Q-4'] }), call('save_issue', { id: 'Q-2', addBlockedBy: ['Q-5'] })])
    expect([...s.get('Q-2')!.blockedBy].sort()).toEqual(['Q-4', 'Q-5'])
  })

  test('removing a blocker that no longer exists is allowed; adding an unknown one is not; addBlockedBy checks cycles', async () => {
    const { call } = await setup()
    await expect(call('save_issue', { id: 'Q-2', addBlockedBy: ['Q-999'] })).rejects.toThrow(/Q-999/)
    await call('save_issue', { id: 'Q-2', removeBlockedBy: ['Q-999'] })
    await call('save_issue', { id: 'Q-2', addBlockedBy: ['Q-4'] })
    await expect(call('save_issue', { id: 'Q-4', addBlockedBy: ['Q-2'] })).rejects.toThrow(/cycle/)
  })

  test('baseDescription refuses a description edit started from older text', async () => {
    const { s, call } = await setup()
    const base = s.get('Q-2')!.description
    await call('save_issue', { id: 'Q-2', description: 'someone else', baseDescription: base })
    await expect(call('save_issue', { id: 'Q-2', description: 'mine', baseDescription: base })).rejects.toThrow(/description changed since you started editing/)
    expect(s.get('Q-2')!.description).toBe('someone else')
  })

  test('toggle_task flips the n-th task when the line still matches, else refuses', async () => {
    const { s, call } = await setup()
    const md = ['intro', '```', '- [ ] code', '```', '- [ ] one', '- [ ] two'].join('\n')
    await call('save_issue', { id: 'Q-2', description: md }, youCtx)
    await call('toggle_task', { id: 'Q-2', index: 1, line: '- [ ] two' }, youCtx)
    expect(s.get('Q-2')!.description).toBe(md.replace('- [ ] two', '- [x] two'))
    // a second click from the same stale view must not undo the first
    await expect(call('toggle_task', { id: 'Q-2', index: 1, line: '- [ ] two' }, youCtx)).rejects.toThrow(/description changed since you loaded it/)
    // no item at that index: say so (not "stale"), with how many there are
    await expect(call('toggle_task', { id: 'Q-2', index: 5, line: '- [ ] x' }, youCtx)).rejects.toThrow(/Q-2 has no checklist item 5 \(it has \d+; index counts from 0/)
    await expect(call('toggle_task', { id: 'Q-2', index: 5, line: '- [ ] x' }, youCtx)).rejects.not.toThrow(/changed since you loaded it/)
    expect(s.get('Q-2')!.description).toBe(md.replace('- [ ] two', '- [x] two'))
  })

  test('concurrent toggles of different tasks both land', async () => {
    const { s, call } = await setup()
    await call('save_issue', { id: 'Q-2', description: '- [ ] a\n- [ ] b' }, youCtx)
    await Promise.all([call('toggle_task', { id: 'Q-2', index: 0, line: '- [ ] a' }, youCtx), call('toggle_task', { id: 'Q-2', index: 1, line: '- [ ] b' })])
    expect(s.get('Q-2')!.description).toBe('- [x] a\n- [x] b')
  })

  test('blockedBy and milestone resolve; unknown milestone explains', async () => {
    const { s, call } = await setup()
    const out = await call('save_issue', { id: 'Q-2', blockedBy: ['Q-4'], milestone: 'beta' })
    expect(out.blockedBy).toEqual(['Q-4'])
    expect(out.milestone).toBe('Beta')
    expect(s.blocks('Q-4')).toEqual(['Q-2'])
    await expect(call('save_issue', { id: 'Q-2', milestone: 'Gamma' })).rejects.toThrow(/MVP.*Beta|save_milestone/)
  })

  test('unknown state lists valid statuses', async () => {
    const { call } = await setup()
    await expect(call('save_issue', { id: 'Q-2', state: 'Doing' })).rejects.toThrow(/In Progress/)
  })

  test('valid-values errors name the bad value, list the valid ones and show a fix', async () => {
    const { call, s } = await setup()
    const state = call('save_issue', { id: 'Q-2', state: 'Doing' })
    await expect(state).rejects.toThrow(/^Unknown state "Doing"\. Valid states: Backlog, Todo, In Progress, Waiting, Done, Canceled, Duplicate\. Example: save_issue\(/)
    const names = [...s.projects.values()].map((p) => p.name).sort()
    const project = call('save_issue', { title: 'x', labels: ['Bug'], project: 'Nope' })
    await expect(project).rejects.toThrow(`Unknown project "Nope". Existing projects: ${names.map((n) => `"${n}"`).join(', ')}. Use one of them, or create it first: save_project({ name: "Nope" }).`)
    await expect(call('list_issues', { project: 'Nope' })).rejects.toThrow(/^Unknown project "Nope"\. Existing projects: /)
    // labels: unknown names are created, so the only label error is an ambiguous bare name
    await call('save_issue_label', { name: 'Web', parent: 'Scope' }, youCtx)
    await call('save_issue_label', { name: 'Web', parent: 'Area' }, youCtx)
    const label = call('save_issue', { title: 'x', labels: ['Web'] })
    await expect(label).rejects.toThrow(/^Label "Web" is ambiguous: (Scope\/Web, Area\/Web|Area\/Web, Scope\/Web)\. Pass the full name, e\.g\. labels: \["(Scope|Area)\/Web"\]\./)
  })

  test('list_issues filters by state and project, paginates with cursor', async () => {
    const { call } = await setup()
    const open = await call('list_issues', {})
    expect(open.issues.map((i: Out) => i.id).sort()).toEqual(['Q-1', 'Q-2', 'Q-3', 'Q-4', 'Q-5'])
    const todo = await call('list_issues', { state: 'todo', project: 'Acme App' })
    expect(todo.issues.map((i: Out) => i.id).sort()).toEqual(['Q-2', 'Q-3'])
    const done = await call('list_issues', { state: 'Done' })
    expect(done.issues.map((i: Out) => i.id)).toEqual(['Q-6'])
    const all = await call('list_issues', { includeArchived: true })
    expect(all.issues).toHaveLength(6)
    const byLabel = await call('list_issues', { label: 'Prod' })
    expect(byLabel.issues.map((i: Out) => i.id)).toEqual(['Q-5'])
    const kids = await call('list_issues', { parentId: 'Q-1' })
    expect(kids.issues.map((i: Out) => i.id)).toEqual(['Q-2'])

    const p1 = await call('list_issues', { limit: 2 })
    expect(p1.issues).toHaveLength(2)
    expect(typeof p1.nextCursor).toBe('string')
    const p2 = await call('list_issues', { limit: 2, cursor: p1.nextCursor })
    const p3 = await call('list_issues', { limit: 2, cursor: p2.nextCursor })
    expect(p3.nextCursor).toBeUndefined()
    const seen = [...p1.issues, ...p2.issues, ...p3.issues].map((i: Out) => i.id)
    expect(seen.sort()).toEqual(['Q-1', 'Q-2', 'Q-3', 'Q-4', 'Q-5'])
  })

  test('list_issues and search return the brief shape', async () => {
    const { call } = await setup()
    await call('save_comment', { issueId: 'Q-1', body: 'brief shape check' })
    const keys = ['id', 'title', 'status', 'priority', 'labels', 'project', 'parent', 'blockedBy', 'milestone', 'due', 'plan', 'updated', 'url', 'appUrl', 'childCount'].sort()
    const listed = (await call('list_issues', {})).issues.find((i: Out) => i.id === 'Q-1')
    expect(Object.keys(listed).sort()).toEqual(keys)
    expect(listed.childCount).toBe(1)
    const hit = (await call('search', { query: 'brief shape' })).issues[0]
    expect(Object.keys(hit).sort()).toEqual(keys)
    const full = await call('get_issue', { id: 'Q-1' })
    expect(full.description).toBeDefined()
    expect(full.activity).toHaveLength(1)
  })

  test('list_issues orders by updated desc and filters updatedAt', async () => {
    const { call } = await setup()
    await call('save_issue', { id: 'Q-3', title: 'Touched now' })
    const out = await call('list_issues', {})
    expect(out.issues[0].id).toBe('Q-3')
    const recent = await call('list_issues', { updatedAt: '2026-10-20T00:00:00Z' })
    expect(recent.issues.map((i: Out) => i.id)).toEqual(['Q-3'])
    const q = await call('list_issues', { query: 'Touched' })
    expect(q.issues.map((i: Out) => i.id)).toEqual(['Q-3'])
  })

  test('save_issues creates epic + children via ref', async () => {
    const { s, call } = await setup()
    const out = await call('save_issues', {
      issues: [
        { ref: 'epic', title: 'Epic: importer', project: 'support', labels: ['Feature'] },
        { ref: 'a', title: 'Step A', parentId: 'ref:epic', labels: ['Task'] },
        { title: 'Step B', parentId: 'ref:epic', blockedBy: ['ref:a'], labels: ['Task'] },
      ],
    })
    expect(out.issues.map((i: Out) => i.id)).toEqual(['Q-7', 'Q-8', 'Q-9'])
    expect(out.issues.map((i: Out) => i.ref ?? null)).toEqual(['epic', 'a', null])
    expect(s.children('Q-7').map((i) => i.id)).toEqual(['Q-8', 'Q-9'])
    expect(s.get('Q-9')!.blockedBy).toEqual(['Q-8'])
  })

  test('save_issues validates every item before writing any', async () => {
    const { s, call } = await setup()
    const n = s.all().length
    await expect(call('save_issues', {
      issues: [
        { ref: 'epic', title: 'Epic', project: 'support', labels: ['Feature'] },
        { title: 'Child', parentId: 'ref:nope', labels: ['Task'] },
      ],
    })).rejects.toThrow(/ref:nope/)
    expect(s.all().length).toBe(n)
  })

  test('save_issues reports saved items when a write fails mid-batch', async () => {
    const { s, call } = await setup()
    const real = s.createIssue.bind(s)
    let n = 0
    s.createIssue = (async (...a: Parameters<typeof real>) => {
      if (++n === 2) throw new Error('disk full')
      return real(...a)
    }) as typeof s.createIssue
    const err = (await call('save_issues', {
      issues: [
        { ref: 'epic', title: 'Epic', project: 'support', labels: ['Feature'] },
        { title: 'Child', parentId: 'ref:epic', labels: ['Task'] },
      ],
    }).catch((e: unknown) => e)) as ToolError
    expect(err).toBeInstanceOf(ToolError)
    expect(err.message).toContain('disk full')
    expect(err.message).toContain('Q-7 (ref "epic")')
    expect(err.data).toEqual({ saved: [{ id: 'Q-7', ref: 'epic' }], failedIndex: 1 })
    expect(s.get('Q-7')).toBeDefined()
  })

  test('get_issue includes children, blocks, ancestors', async () => {
    const { call } = await setup()
    const out = await call('get_issue', { id: 'Q-3' })
    expect(out.id).toBe('Q-3')
    expect(out.children).toEqual([])
    expect(out.blocks).toEqual(['Q-4'])
    expect(out.ancestors).toEqual(['Q-2', 'Q-1'])
    const root = await call('get_issue', { id: 'Q-1' })
    expect(root.children).toEqual(['Q-2'])
    await expect(call('get_issue', { id: 'Q-99' })).rejects.toThrow(/Q-99/)
  })

  test('get_tree returns nested subtree with blockers', async () => {
    const { call } = await setup()
    const out = await call('get_tree', { id: 'Q-1' })
    expect(out.id).toBe('Q-1')
    expect(out.children[0].id).toBe('Q-2')
    expect(out.children[0].children[0].id).toBe('Q-3')
    expect(out.appUrl).toBe('aitt://issue/Q-1')
    expect(out.progress).toEqual({ done: 0, total: 2 })
  })

  test('whats_next returns home buckets', async () => {
    const { call } = await setup()
    const out = await call('whats_next', {})
    expect(out.needsYou.map((i: Out) => i.id)).toEqual(['Q-5'])
    expect(out.needsYou[0].appUrl).toBe('aitt://issue/Q-5')
    expect(out.inProgress.map((i: Out) => i.id)).toEqual(['Q-1'])
    expect(out.blocked).toEqual([expect.objectContaining({ id: 'Q-4', blockers: ['Q-3'] })])
    const q3 = out.readyNext.find((i: Out) => i.id === 'Q-3')
    expect(q3).toEqual(expect.objectContaining({ title: expect.any(String), unblocks: 1 }))
  })

  test('whats_next: a short stalled list (with why) of the stalled issues the caller\'s workspace touched', async () => {
    const { s, call } = await setup()
    expect((await call('whats_next')).stalled).toBeUndefined() // the fixture turns idle off
    s.config.stalled = { idleHours: 24, windowDays: 7, reopens: 2, sessions: 3 } // Q-1 has been In Progress since 2026-10-01
    // Q-1 was last written by the owner: no workspace touched it, so no agent gets it in its list.
    expect((await call('whats_next')).stalled).toBeUndefined()
    await s.updateIssue('Q-1', { labels: ['Feature'] }, agent) // web-app touches it...
    s.config.stalled.idleHours = 1e-9 // ...and has been idle for more than 3.6 µs by the time we ask
    await Bun.sleep(5)
    const out = await call('whats_next')
    expect(out.stalled).toEqual([expect.objectContaining({ id: 'Q-1', title: expect.any(String), status: 'In Progress', why: 'idle 0 h in In Progress' })])
    // needsYou keeps its meaning (waiting on the user); the stalled issue stays in inProgress, marked.
    expect(out.needsYou.map((i: Out) => i.id)).toEqual(['Q-5'])
    expect(out.inProgress).toEqual([expect.objectContaining({ id: 'Q-1', stalled: 'idle 0 h in In Progress' })])
    expect(out.needsYou[0]).not.toHaveProperty('stalled')
    const other = await call('whats_next', {}, { actor: { ...agent, workspace: 'other-app' } })
    expect(other.stalled).toBeUndefined()
    expect((await call('whats_next', {}, youCtx)).stalled).toBeUndefined()
  })

  test('whats_next lists at most 5 stalled issues', async () => {
    const { s, call } = await setup()
    for (let n = 0; n < 7; n++) await s.createIssue({ title: `T${n}`, project: 'support', status: 'In Progress' }, agent)
    s.config.stalled = { idleHours: 1e-9, windowDays: 7, reopens: 2, sessions: 3 }
    await Bun.sleep(5)
    const out = await call('whats_next')
    expect(out.stalled).toHaveLength(5)
    expect(out.inProgress.filter((i: Out) => i.stalled).length).toBeGreaterThanOrEqual(7)
    expect(out.needsYou.map((i: Out) => i.id)).toEqual(['Q-5'])
  })

  test('get_issue carries stalled: <reason> only when it applies', async () => {
    const { s, call } = await setup()
    expect(await call('get_issue', { id: 'Q-1' })).not.toHaveProperty('stalled')
    s.config.stalled = { idleHours: 24, windowDays: 7, reopens: 2, sessions: 3 }
    expect((await call('get_issue', { id: 'Q-1' })).stalled).toMatch(/^idle \d+ d in In Progress$/)
    expect(await call('get_issue', { id: 'Q-6' })).not.toHaveProperty('stalled') // Done
  })

  test('save_comment, list_comments, search finds comment text', async () => {
    const { call } = await setup()
    const c = await call('save_comment', { issueId: 'Q-4', body: 'Waiting on the zebracorn vendor' })
    expect(c.body).toBe('Waiting on the zebracorn vendor')
    expect(c.issueId).toBe('Q-4')
    const list = await call('list_comments', { issueId: 'Q-4' })
    expect(list.comments.at(-1).body).toBe('Waiting on the zebracorn vendor')
    expect(list.comments.at(-1).workspace).toBe('web-app')
    const hits = await call('search', { query: 'zebracorn' })
    expect(hits.issues.map((i: Out) => i.id)).toEqual(['Q-4'])
  })

  test('bare label resolves to group label', async () => {
    const { s, call } = await setup()
    const out = await call('save_issue', { title: 'x', project: 'support', labels: ['Bug', 'app'] })
    expect(out.labels).toEqual(['Bug', 'Scope/App'])
    expect(s.labels.filter((l) => l.name.toLowerCase().endsWith('/app'))).toHaveLength(1)
  })

  test('delete_issue works for you', async () => {
    const { s, call } = await setup()
    await call('delete_issue', { id: 'Q-6' }, youCtx)
    expect(s.get('Q-6')).toBeUndefined()
  })
})

describe('project and meta tools', () => {
  test('list_projects, get_project, list_teams, statuses, labels', async () => {
    const { call } = await setup()
    const projects = await call('list_projects', {})
    expect(projects.projects.map((p: Out) => p.name).sort()).toEqual(['Acme App', 'Support'])
    const p = await call('get_project', { query: 'acme app' })
    expect(p.slug).toBe('acme-app')
    expect(p.milestones.map((m: Out) => m.name)).toEqual(['MVP', 'Beta'])
    expect(p.documents).toEqual([{ id: 'acme-app/architecture', title: 'Architecture notes' }])
    const teams = await call('list_teams', {})
    expect(teams.teams).toEqual([{ id: 'Q', key: 'Q', name: 'Q', projects: ['Acme App', 'Support'] }])
    const st = await call('list_issue_statuses', {})
    expect(st.statuses.map((x: Out) => x.name)).toContain('Waiting')
    const lb = await call('list_issue_labels', {})
    expect(lb.labels.find((l: Out) => l.name === 'Scope/App').group).toBe('Scope')
  })

  test('save_project creates and updates', async () => {
    const { s, call } = await setup()
    const p = await call('save_project', { name: 'Tracker App', description: 'Local tracker', state: 'Planned' })
    expect(p.slug).toBe('tracker-app')
    expect(p.key).toBe('TA')
    expect(p.status).toBe('Planned')
    const u = await call('save_project', { id: 'tracker-app', name: 'Tracker', description: 'Renamed' })
    expect(u.name).toBe('Tracker')
    expect(u.key).toBe('TA')
    expect(s.projects.get('tracker-app')!.description).toBe('Renamed')
    const c = await call('save_project', { id: 'tracker-app', state: 'Completed' })
    expect(c.name).toBe('Tracker')
    expect(c.status).toBe('Completed')
    await expect(call('save_project', { description: 'no name' })).rejects.toThrow(/name/)
  })

  test('save_project baseDescription refuses an edit started from older text', async () => {
    const { s, call } = await setup()
    await call('save_project', { name: 'Tracker App', description: 'v1' })
    await call('save_project', { id: 'tracker-app', description: 'agent edit', baseDescription: 'v1' })
    await expect(call('save_project', { id: 'tracker-app', description: 'mine', baseDescription: 'v1' })).rejects.toThrow(/description changed since you started editing/)
    expect(s.projects.get('tracker-app')!.description).toBe('agent edit')
    await call('save_project', { id: 'tracker-app', description: 'mine', baseDescription: 'agent edit' })
    expect(s.projects.get('tracker-app')!.description).toBe('mine')
  })

  test('save_document baseContent refuses an edit started from older text', async () => {
    const { s, call } = await setup()
    await call('save_document', { project: 'support', title: 'Runbook', content: 'v1' })
    await call('save_document', { id: 'support/runbook', project: 'support', title: 'Runbook', content: 'agent edit', baseContent: 'v1' })
    await expect(call('save_document', { id: 'support/runbook', project: 'support', title: 'Runbook', content: 'mine', baseContent: 'v1' })).rejects.toThrow(/document changed since you started editing/)
    expect(s.projects.get('support')!.docs.find((d) => d.slug === 'runbook')!.content).toBe('agent edit')
    // concurrent: exactly one of two same-base saves wins
    const r = await Promise.allSettled([1, 2].map((n) => call('save_document', { id: 'support/runbook', project: 'support', title: 'Runbook', content: `w${n}`, baseContent: 'agent edit' })))
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
  })

  test('baseDescription / baseContent compare against the file on disk, not the index', async () => {
    const { root, s, call } = await setup()
    const pf = join(root, 'projects/support/project.md')
    const before = await readFile(pf, 'utf8')
    const base = s.projects.get('support')!.description
    await writeFile(pf, before.replace(/\n---\n([\s\S]*)$/, (_m, body) => `\n---\n${body.trimEnd()}\nHAND EDIT\n`)) // watcher not running in tests
    expect(s.projects.get('support')!.description).toBe(base)
    await expect(call('save_project', { id: 'support', description: 'mine', baseDescription: base })).rejects.toThrow(/description changed/)
    // without a base: written on top of the fresh file, unrelated front-matter keys survive
    await writeFile(pf, (await readFile(pf, 'utf8')).replace('\n---\n', '\nhand_key: keep-me\n---\n'))
    await call('save_project', { id: 'support', state: 'Paused' })
    expect(await readFile(pf, 'utf8')).toContain('hand_key: keep-me')
    expect(await readFile(pf, 'utf8')).toContain('HAND EDIT')

    await call('save_document', { project: 'support', title: 'Runbook', content: 'v1' })
    const df = join(root, 'projects/support/docs/runbook.md')
    await writeFile(df, (await readFile(df, 'utf8')).replace('v1', 'disk edit'))
    await expect(call('save_document', { id: 'support/runbook', project: 'support', title: 'Runbook', content: 'mine', baseContent: 'v1' })).rejects.toThrow(/document changed/)
    expect(await readFile(df, 'utf8')).toContain('disk edit')
  })

  test('concurrent document creates with the same title make two documents', async () => {
    const { s, call } = await setup()
    const [a, b] = await Promise.all([1, 2].map((n) => call('save_document', { project: 'support', title: 'Notes', content: `c${n}` })))
    expect(a!.id).not.toBe(b!.id)
    const docs = s.projects.get('support')!.docs.filter((d) => d.title === 'Notes')
    expect(docs.map((d) => d.content).sort()).toEqual(['c1', 'c2'])
  })

  test('save_issue_label with parent creates group label', async () => {
    const { s, call } = await setup()
    const l = await call('save_issue_label', { name: 'Docs', parent: 'Scope', color: '#123456' })
    expect(l).toEqual({ name: 'Scope/Docs', group: 'Scope', color: '#123456' })
    expect(s.labels.find((x) => x.name === 'Scope/Docs')).toBeDefined()
  })

  test('milestones: list and save', async () => {
    const { root, s, call } = await setup()
    const ms = await call('list_milestones', { project: 'Acme App' })
    expect(ms.milestones[0]).toEqual(expect.objectContaining({ name: 'MVP', targetDate: '2026-12-01', progress: { done: 0, total: 1 } }))
    await call('save_milestone', { project: 'acme-app', name: 'GA', targetDate: '2027-06-01', description: 'General availability' })
    expect(s.projects.get('acme-app')!.milestones.map((m) => m.name)).toEqual(['MVP', 'Beta', 'GA'])
    await call('save_milestone', { project: 'acme-app', name: 'mvp', targetDate: '2026-12-15' })
    expect(s.projects.get('acme-app')!.milestones[0]).toEqual(expect.objectContaining({ name: 'MVP', target: '2026-12-15', description: 'First usable release' }))
    const text = await readFile(join(root, 'projects/acme-app/project.md'), 'utf8')
    expect(text).toContain('GA')
  })

  test('documents: save and get', async () => {
    const { root, call } = await setup()
    const d = await call('save_document', { project: 'support', title: 'Runbook', content: '# Runbook\nSteps.' })
    expect(d.id).toBe('support/runbook')
    const g = await call('get_document', { id: 'support/runbook' })
    expect(g).toEqual(expect.objectContaining({ title: 'Runbook', content: '# Runbook\nSteps.', project: 'support' }))
    await call('save_document', { id: 'support/runbook', project: 'support', title: 'Runbook v2', content: 'New' })
    const g2 = await call('get_document', { id: 'support/runbook' })
    expect(g2.title).toBe('Runbook v2')
    expect(await readFile(join(root, 'projects/support/docs/runbook.md'), 'utf8')).toContain('New')
    const arch = await call('get_document', { id: 'architecture' })
    expect(arch.title).toBe('Architecture notes')
  })

  test('save_view writes a view (UI)', async () => {
    const { root, s, call } = await setup()
    const v = await call('save_view', {
      name: 'Open bugs', filter: { labels: ['Bug'] },
      display: { layout: 'list', groupBy: 'status', orderBy: 'priority', showSubIssues: true, properties: ['id', 'status'] },
    }, youCtx)
    expect(v.slug).toBe('open-bugs')
    expect(s.views.find((x) => x.slug === 'open-bugs')?.filter).toEqual({ labels: ['Bug'] })
    expect(await readFile(join(root, 'views/open-bugs.yml'), 'utf8')).toContain('Open bugs')
  })

  test('save_view without slug refuses a name whose slug is taken; with slug it updates', async () => {
    const { root, call } = await setup()
    const display = { layout: 'list', groupBy: 'status', orderBy: 'priority', showSubIssues: true, properties: ['id'] }
    await call('save_view', { name: 'Acme App', favorite: true, filter: { labels: ['Bug'] }, display }, youCtx)
    const yml = join(root, 'views/acme-app.yml')
    const before = await readFile(yml, 'utf8')
    await expect(call('save_view', { name: 'Acme app', filter: {}, display }, youCtx))
      .rejects.toThrow("A view named 'Acme app' already exists — choose another name, or open it and use Save changes.")
    expect(await readFile(yml, 'utf8')).toBe(before)
    const v = await call('save_view', { slug: 'acme-app', name: 'Acme App', filter: {}, display }, youCtx)
    expect(v.slug).toBe('acme-app')
    expect(await readFile(yml, 'utf8')).not.toContain('Bug')
  })

  test('save_view keeps favorite, unknown keys and the file when updating by slug; new filter/display fields survive', async () => {
    const { root, s, call } = await setup()
    const display = { layout: 'board', groupBy: 'status', rowsBy: 'parent', orderBy: 'priority', showSubIssues: true, properties: ['id'] }
    await call('save_view', { name: 'Mine', favorite: true, filter: {}, display }, youCtx)
    const yml = join(root, 'views/mine.yml')
    await writeFile(yml, (await readFile(yml, 'utf8')) + 'note: keep me\n')
    await s.reloadFile(yml)
    const v = await call('save_view', {
      slug: 'mine', name: 'Mine renamed',
      filter: { milestone: ['M1'], blocking: true, hasLinks: true, hasRelated: false, createdAfter: '2026-10-01' },
      display: { ...display, showEmptyColumns: true, showEmptyRows: false, completed: 'week' },
    }, youCtx)
    expect(v.slug).toBe('mine')
    const text = await readFile(yml, 'utf8')
    expect(text).toContain('favorite: true')
    expect(text).toContain('note: keep me')
    expect(text).toContain('Mine renamed')
    expect(text).toContain('blocking: true')
    expect(text).toContain('completed: week')
    expect(text).toContain('showEmptyColumns: true')
    expect(s.views.filter((x) => x.slug.startsWith('mine'))).toHaveLength(1)
    // favorite can be turned off explicitly
    await call('save_view', { slug: 'mine', name: 'Mine renamed', favorite: false, filter: {}, display }, youCtx)
    expect(await readFile(yml, 'utf8')).not.toContain('favorite: true')
  })
})

describe('final fix: save_project rename collision', () => {
  test('renaming to a name another project uses is a ToolError and changes nothing', async () => {
    const { s, call } = await setup()
    await call('save_project', { name: 'Tracker App' })
    const other = [...s.projects.values()].find((p) => p.slug !== 'tracker-app')!
    const err = await call('save_project', { id: 'tracker-app', name: other.name.toUpperCase() }).catch((e) => e)
    expect(err).toBeInstanceOf(ToolError)
    expect(String(err.message)).toContain(other.name)
    expect(s.projects.get('tracker-app')!.name).toBe('Tracker App')
    // renaming to its own name (any case) is fine
    const ok = await call('save_project', { id: 'tracker-app', name: 'TRACKER app' })
    expect(ok.name).toBe('TRACKER app')
  })
})
