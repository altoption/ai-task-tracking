import { describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { attemptsBrief, attemptsOf } from '../../src/engine/attempts'
import { IssueHistory } from '../../src/engine/stalled'
import { feedPath } from '../../src/engine/eventlog'
import { Store } from '../../src/engine/store'
import { callTool } from '../../src/tools/handlers'
import { miniCopy } from './helpers'

const agent = (session: string, client = 'claude-code', branch = 'feat/x', workspace = 'web') =>
  ({ actor: 'agent' as const, session, client, branch, workspace })

describe('attempts (one per agent session)', () => {
  test('groups writes by session with tool, branch, times, writes and the status each left', async () => {
    const s = await Store.open(await miniCopy())
    await s.updateIssue('Q-2', { status: 'In Progress' }, agent('a'))
    await s.addComment('Q-2', 'started', agent('a'))
    await s.updateIssue('Q-2', { status: 'Waiting' }, agent('a', 'claude-code', 'feat/y'))
    await s.addComment('Q-2', 'picking it up', agent('b', 'codex', 'fix/z'))
    await s.updateIssue('Q-2', { status: 'In Progress' }, { actor: 'you' }) // the owner: not an attempt
    await s.updateIssue('Q-2', { labels: ['Bug'] }, agent('b', 'codex', 'fix/z'))
    const list = attemptsOf(s, s.get('Q-2')!)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ client: 'claude-code', branch: 'feat/y', workspace: 'web', leftStatus: 'Waiting' })
    expect(list[0]!.writes).toBeGreaterThanOrEqual(1) // same-second writes count once (times are in seconds)
    expect(list[1]).toMatchObject({ client: 'codex', branch: 'fix/z', leftStatus: 'In Progress' })
    expect(Date.parse(list[0]!.first)).toBeLessThanOrEqual(Date.parse(list[0]!.last))
    expect(attemptsBrief(list)).toEqual({ count: 2, tools: 2, last: { client: 'codex', branch: 'fix/z', at: list[1]!.last, leftStatus: 'In Progress' } })
  })

  test('history comes from the feed log at open; events at the same moment count as one write', async () => {
    const root = await miniCopy()
    const a = { actor: 'agent', session: 's1', client: 'cursor', branch: 'b1', workspace: 'w' }
    const lines = [
      { at: '2026-10-20T10:00:00Z', id: 'Q-3', kind: 'status', from: 'Todo', to: 'In Progress', actor: a },
      { at: '2026-10-20T10:00:00Z', id: 'Q-3', kind: 'comment', text: 'go', actor: a },
      { at: '2026-10-20T11:00:00Z', id: 'Q-3', kind: 'updated', text: 'labels', actor: a },
    ]
    await mkdir(join(root, '.tracker'), { recursive: true })
    await writeFile(feedPath(root), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const s = await Store.open(root)
    expect(attemptsOf(s, s.get('Q-3')!)).toEqual([{
      session: 's1', client: 'cursor', workspace: 'w', branch: 'b1', first: '2026-10-20T10:00:00.000Z', last: '2026-10-20T11:00:00.000Z', leftStatus: 'In Progress', writes: 2,
    }])
  })

  test('without logged history, touched_by is the one attempt; the owner alone is none', async () => {
    const s = await Store.open(await miniCopy())
    const i = { ...s.get('Q-4')!, touchedBy: agent('x', 'codex', 'main') }
    expect(attemptsOf(s, i)).toEqual([{ session: 'x', client: 'codex', workspace: 'web', branch: 'main', first: i.updated, last: i.updated, leftStatus: 'Backlog', writes: 1 }])
    expect(attemptsOf(s, { ...i, touchedBy: { actor: 'you' } })).toEqual([])
    expect(attemptsBrief([])).toBeNull()
  })

  test('get_issue carries attempts { count, tools, last } only when there are some', async () => {
    const s = await Store.open(await miniCopy())
    await s.addComment('Q-2', 'note', agent('a'))
    const r: any = await callTool(s, 'get_issue', { id: 'Q-2' }, { actor: agent('a') })
    expect(r.attempts).toEqual({ count: 1, tools: 1, last: { client: 'claude-code', branch: 'feat/x', at: expect.any(String), leftStatus: 'Todo' } })
    const plain: any = await callTool(s, 'get_issue', { id: 'Q-4' }, { actor: { actor: 'you' } })
    expect(plain.attempts).toBeUndefined()
  })
})

test('no status move logged: every attempt left the issue in its current status', async () => {
  const s = await Store.open(await miniCopy())
  await s.addComment('Q-3', 'one', agent('a'))
  await s.addComment('Q-3', 'two', agent('b', 'codex'))
  expect(attemptsOf(s, s.get('Q-3')!).map((a) => a.leftStatus)).toEqual(['Todo', 'Todo'])
})

test('past the cap, the least recently active session is dropped (not the first seen)', () => {
  const h = new IssueHistory()
  const add = (t: number, session: string) => h.add({ t, session }, 1e15, 'In Progress')
  add(1, 's0')
  for (let k = 1; k < IssueHistory.MAX_ATTEMPTS; k++) add(10 + k, `s${k}`)
  add(1000, 's0') // s0 came back: now the most recent
  add(1001, 'new')
  const ids = h.attempts().map((a) => a.session)
  expect(ids).toHaveLength(IssueHistory.MAX_ATTEMPTS)
  expect(ids).toContain('s0')
  expect(ids).not.toContain('s1')
  expect(ids.at(-1)).toBe('new')
})
