import { describe, expect, test } from 'bun:test'
import { handoffOf } from '../../src/engine/handoff'
import type { AttemptOut } from '../../src/engine/attempts'
import { Store } from '../../src/engine/store'
import { callTool } from '../../src/tools/handlers'
import { shapeResult } from '../../src/mcp/surface'
import type { Issue } from '../../src/model'
import { miniCopy } from './helpers'

const agent = (session: string, client = 'claude-code', branch = 'feat/x', workspace = 'web') =>
  ({ actor: 'agent' as const, session, client, branch, workspace })
const base = (over: Partial<Issue> = {}): Issue => ({
  id: 'Q-9', title: 'T', status: 'In Progress', priority: 0, labels: [], parent: null, blockedBy: [], related: [], milestone: null,
  due: null, plan: null, links: [], created: '', updated: '', extra: {}, description: '', activity: [], project: 'p', path: '', ...over,
})
const attempt = (over: Partial<AttemptOut>): AttemptOut =>
  ({ session: 's2', client: 'claude-code', workspace: 'web', branch: 'feat/x', first: '2026-10-29T10:00:00.000Z', last: '2026-10-29T11:00:00.000Z', writes: 2, ...over })
const opts = { working: 'In Progress', attempts: [] as AttemptOut[], openBlockers: [] as string[] }

describe('handoff', () => {
  test('only for In Progress, only when something in it helps, never for the session that worked last', () => {
    expect(handoffOf(base({ status: 'Todo', description: '- [ ] a' }), opts)).toBeNull()
    expect(handoffOf(base(), opts)).toBeNull()
    expect(handoffOf(base(), { ...opts, attempts: [attempt({})] })).toBeNull() // who alone isn't enough
    const i = base({ description: '- [ ] a' })
    expect(handoffOf(i, { ...opts, attempts: [attempt({})], caller: 's2' })).toBeNull() // its own work
    expect(handoffOf(i, { ...opts, attempts: [attempt({})], caller: 's3' })).not.toBeNull()
  })

  test('last, note (the last session\'s own comment, < 200 chars), open (count + 3 titles), blockers, reasons', () => {
    const long = 'Done: the parser. '.repeat(20)
    const i = base({
      description: ['- [x] one', '- [ ] two', '* [ ] three', '1. [ ] four', '- [ ] five ' + 'x'.repeat(100), '```', '- [ ] code', '```'].join('\n'),
      activity: [
        { at: '2026-10-29T09:00:00Z', actor: 'agent', workspace: 'web', branch: 'feat/x', body: 'an older session, same branch' },
        { at: '2026-10-29T10:30:00Z', actor: 'agent', workspace: 'other', branch: 'main', body: 'someone else' },
        { at: '2026-10-29T10:45:00Z', actor: 'agent', workspace: 'web', branch: 'feat/x', body: long },
        { at: '2026-10-29T11:30:00Z', actor: 'you', body: 'owner note' },
      ],
    })
    const h = handoffOf(i, { ...opts, openBlockers: ['Q-2'], stalled: 'idle 31 h in In Progress', ci: 'CI failing on PR #12', attempts: [attempt({})] })!
    expect(Object.keys(h)).toEqual(['last', 'note', 'open', 'blockers', 'stalled', 'ci'])
    expect(h.last).toEqual({ client: 'claude-code', branch: 'feat/x', at: '2026-10-29T11:00:00.000Z' })
    expect(h.note!.length).toBeLessThan(200)
    expect(h.note!.startsWith('Done: the parser.')).toBe(true)
    expect(h.note!.endsWith('…')).toBe(true)
    expect(h.open).toEqual({ count: 4, items: ['two', 'three', 'four'] })
    expect(h.blockers).toEqual(['Q-2'])
  })

  test('no note when the last session commented nothing (an older session\'s comment on the same branch is not its own)', () => {
    const i = base({
      description: '- [ ] a',
      activity: [{ at: '2026-10-29T09:00:00Z', actor: 'agent', workspace: 'web', branch: 'feat/x', body: 'older session' }],
    })
    expect(handoffOf(i, { ...opts, attempts: [attempt({})] })).toEqual({
      last: { client: 'claude-code', branch: 'feat/x', at: '2026-10-29T11:00:00.000Z' }, open: { count: 1, items: ['a'] },
    })
  })

  test('get_issue leads with the handoff for another session, and leaves it out for the one that worked last', async () => {
    const s = await Store.open(await miniCopy())
    await s.updateIssue('Q-2', { status: 'In Progress', description: 'Plan:\n- [x] read\n- [ ] write\n', blockedBy: ['Q-3'] }, agent('a'))
    await s.addComment('Q-2', 'Done: read the code. Next: write. Blocking: nothing.', agent('a'))
    const r: any = await callTool(s, 'get_issue', { id: 'Q-2' }, { actor: agent('b', 'codex') })
    expect(Object.keys(r)[0]).toBe('handoff')
    expect(Object.keys(shapeResult('get_issue', r) as object)[0]).toBe('handoff') // still first for the agent
    expect(r.handoff).toEqual({
      last: { client: 'claude-code', branch: 'feat/x', at: expect.any(String) },
      note: 'Done: read the code. Next: write. Blocking: nothing.', open: { count: 1, items: ['write'] }, blockers: ['Q-3'],
    })
    expect(((await callTool(s, 'get_issue', { id: 'Q-2' }, { actor: agent('a') })) as any).handoff).toBeUndefined()
    await s.updateIssue('Q-2', { status: 'Todo' }, agent('a'))
    expect(((await callTool(s, 'get_issue', { id: 'Q-2' }, { actor: agent('b') })) as any).handoff).toBeUndefined()
  })
})
