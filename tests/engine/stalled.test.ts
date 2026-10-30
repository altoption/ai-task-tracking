import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_STALLED, IssueHistory, normalizeStalled, stalledCtx, stalledReason, workingStatus, type HistoryEntry,
} from '../../src/engine/stalled'
import { DEFAULT_STATUSES } from '../../src/store/metaFiles'
import type { StalledRules } from '../../src/model'

const H = 3_600_000
const D = 24 * H
const NOW = Date.parse('2026-10-29T12:00:00Z')
const ctx = (rules: Partial<StalledRules> = {}) => stalledCtx({
  rules: { ...DEFAULT_STALLED, ...rules }, statuses: DEFAULT_STATUSES, needsYouStatuses: ['Waiting', 'In Review'], now: NOW,
})
const ip = { status: 'In Progress' }
const fresh = NOW - H // changed an hour ago: never idle
/** A status move `ago` ms before NOW. */
const mv = (ago: number, from: string, to: string, session?: string): HistoryEntry => ({ t: NOW - ago, from, to, ...(session ? { session } : {}) })
/** A non-status write by an agent session. */
const touch = (ago: number, session: string): HistoryEntry => ({ t: NOW - ago, session })

describe('idle', () => {
  test('In Progress with no change for idleHours or more; reason in hours', () => {
    expect(stalledReason(ip, NOW - 24 * H, [], ctx())).toBe('idle 24 h in In Progress') // exactly at the threshold
    expect(stalledReason(ip, NOW - 24 * H + 1, [], ctx())).toBeNull() // 1 ms short
    expect(stalledReason(ip, NOW - 31 * H - 5, [], ctx())).toBe('idle 31 h in In Progress')
  })
  test('days from three days on', () => {
    expect(stalledReason(ip, NOW - 71 * H, [], ctx())).toBe('idle 71 h in In Progress')
    expect(stalledReason(ip, NOW - 4 * D - H, [], ctx())).toBe('idle 4 d in In Progress')
  })
  test('idleHours 0 turns it off', () => {
    expect(stalledReason(ip, NOW - 100 * D, [], ctx({ idleHours: 0 }))).toBeNull()
  })
  test('only the working status idles (Waiting and Todo do not)', () => {
    for (const status of ['Waiting', 'Todo', 'Backlog']) expect(stalledReason({ status }, NOW - 100 * D, [], ctx())).toBeNull()
  })
  test('custom threshold; an unparseable last change never counts as idle', () => {
    expect(stalledReason(ip, NOW - 2 * H, [], ctx({ idleHours: 2 }))).toBe('idle 2 h in In Progress')
    expect(stalledReason(ip, NaN, [], ctx())).toBeNull()
  })
})

describe('churning: reopens', () => {
  // Started, done, reopened, done again, reopened again: two reopens.
  const back = [mv(6 * D, 'Todo', 'In Progress'), mv(5 * D, 'In Progress', 'Done'), mv(4 * D, 'Done', 'In Progress'),
    mv(3 * D, 'In Progress', 'Done'), mv(2 * D, 'Done', 'In Progress')]
  test('Done → In Progress twice is churn; the first start is not a reopen', () => {
    expect(stalledReason(ip, fresh, back, ctx())).toBe('reopened 2× in 7 days')
    expect(stalledReason(ip, fresh, back.slice(0, 3), ctx())).toBeNull() // one reopen
    expect(stalledReason(ip, fresh, back, ctx({ reopens: 3 }))).toBeNull()
  })
  test('Waiting round trips (asking the owner) are never reopens', () => {
    const asks = [mv(6 * D, 'Todo', 'In Progress'), mv(5 * D, 'In Progress', 'Waiting'), mv(4 * D, 'Waiting', 'In Progress'),
      mv(3 * D, 'In Progress', 'Waiting'), mv(2 * D, 'Waiting', 'In Progress')]
    expect(stalledReason(ip, fresh, asks, ctx())).toBeNull()
    // Any Needs-you status is an "ask", even a custom started one.
    const review = [mv(6 * D, 'Todo', 'In Progress'), mv(5 * D, 'In Progress', 'In Review'), mv(4 * D, 'In Review', 'In Progress'),
      mv(3 * D, 'In Progress', 'In Review'), mv(2 * D, 'In Review', 'In Progress')]
    expect(stalledReason(ip, fresh, review, ctx())).toBeNull()
  })
  test('from Done, Canceled, Duplicate, Todo or Backlog counts once it has been In Progress', () => {
    const h = [mv(6 * D, 'Backlog', 'In Progress'), mv(5 * D, 'In Progress', 'Canceled'), mv(4 * D, 'Canceled', 'In Progress'),
      mv(3.5 * D, 'In Progress', 'Duplicate'), mv(3 * D, 'Duplicate', 'In Progress'),
      mv(2.5 * D, 'In Progress', 'Todo'), mv(2 * D, 'Todo', 'In Progress'), mv(1.5 * D, 'In Progress', 'Backlog'), mv(D, 'Backlog', 'In Progress')]
    expect(stalledReason(ip, fresh, h, ctx())).toBe('reopened 4× in 7 days')
  })
  test('created In Progress: its first move out marks it as having been there', () => {
    const h = [mv(3 * D, 'In Progress', 'Done'), mv(2 * D, 'Done', 'In Progress'), mv(D, 'In Progress', 'Todo'), mv(H, 'Todo', 'In Progress')]
    expect(stalledReason(ip, fresh, h, ctx())).toBe('reopened 2× in 7 days')
  })
  test('window boundaries: a move exactly windowDays ago counts, 1 ms earlier does not; earlier moves still mark "been there"', () => {
    const edge = (extra: number) => [mv(30 * D, 'Todo', 'In Progress'), mv(20 * D, 'In Progress', 'Done'),
      { t: NOW - 7 * D - extra, from: 'Done', to: 'In Progress' }, mv(D, 'In Progress', 'Todo'), mv(H, 'Todo', 'In Progress')]
    expect(stalledReason(ip, fresh, edge(0), ctx())).toBe('reopened 2× in 7 days')
    expect(stalledReason(ip, fresh, edge(1), ctx())).toBeNull()
    expect(stalledReason(ip, fresh, edge(0), ctx({ windowDays: 1 }))).toBeNull() // only one reopen in the last day
  })
  test('windowDays 0 or reopens 0 turns it off', () => {
    expect(stalledReason(ip, fresh, back, ctx({ windowDays: 0 }))).toBeNull()
    expect(stalledReason(ip, fresh, back, ctx({ reopens: 0 }))).toBeNull()
  })
  test('the reason names the sessions that worked on it since it was last Done', () => {
    const h = [mv(6 * D, 'Todo', 'In Progress', 's0'), mv(5 * D, 'In Progress', 'Done', 's1'), mv(4 * D, 'Done', 'In Progress', 's2'),
      mv(3 * D, 'In Progress', 'Todo', 's3'), mv(2 * D, 'Todo', 'In Progress', 's4')]
    expect(stalledReason(ip, fresh, h, ctx())).toBe('reopened 2× in 7 days by 3 sessions') // s2, s3, s4
    expect(stalledReason(ip, fresh, [mv(3 * D, 'Todo', 'In Progress'), mv(2 * D, 'In Progress', 'Todo', 'a'), mv(D, 'Todo', 'In Progress', 'a'),
      mv(H, 'In Progress', 'Todo'), mv(H / 2, 'Todo', 'In Progress')], ctx())).toBe('reopened 2× in 7 days by 1 session')
  })
})

describe('IssueHistory (what the store keeps per issue)', () => {
  const W = 7 * D
  const fill = (entries: HistoryEntry[]) => { const h = new IssueHistory(); for (const e of entries) h.add(e, W, 'In Progress'); return h }
  test('regression: 199 agent writes between the moves do not push the start out (the old 200-entry cap hid churn)', () => {
    const e: HistoryEntry[] = [mv(6 * D, 'Todo', 'In Progress', 'a'), mv(5 * D, 'In Progress', 'Waiting', 'a')]
    for (let k = 0; k < 199; k++) e.push({ t: NOW - 5 * D + 1000 + k, session: 'a' })
    e.push(mv(4.5 * D, 'Waiting', 'Todo', 'a'), mv(4 * D, 'Todo', 'In Progress', 'a'), mv(3 * D, 'In Progress', 'Done', 'a'), mv(2 * D, 'Done', 'In Progress', 'a'))
    expect(stalledReason(ip, fresh, e, ctx())).toBe('reopened 2× in 7 days by 1 session')
    expect(stalledReason(ip, fresh, fill(e).entries(), ctx())).toBe('reopened 2× in 7 days by 1 session')
    expect(stalledReason(ip, fresh, e.slice(-200), ctx())).toBeNull() // what the old cap saw
  })
  test('keeps one entry per session (its latest write), in time order with the moves', () => {
    const h = fill([touch(3 * H, 'a'), mv(2 * H, 'Todo', 'In Progress', 'b'), touch(H, 'a')])
    expect(h.entries()).toEqual([mv(2 * H, 'Todo', 'In Progress', 'b'), touch(H, 'a')])
  })
  test('prunes by the window; a pruned In Progress move leaves an anchor, so a later reopen still counts', () => {
    const h = fill([mv(30 * D, 'Todo', 'In Progress', 'old'), mv(29 * D, 'In Progress', 'Done'), touch(28 * D, 'old2'),
      mv(2 * D, 'Done', 'In Progress'), mv(D, 'In Progress', 'Done'), mv(H, 'Done', 'In Progress')])
    const e = h.entries()
    expect(e.some((x) => x.session === 'old' || x.session === 'old2')).toBe(false)
    expect(e[0]).toEqual({ t: NOW - 29 * D, from: 'In Progress', to: 'In Progress' }) // the anchor: "it was In Progress before"
    expect(e).toHaveLength(4)
    expect(stalledReason(ip, fresh, e, ctx())).toBe('reopened 2× in 7 days')
  })
  test('a hard cap on moves as a safety net', () => {
    const h = new IssueHistory()
    for (let k = 0; k < IssueHistory.MAX_MOVES + 50; k++) h.add({ t: NOW - 1000 + k / 10, from: 'Todo', to: 'Backlog' }, W, 'In Progress')
    expect(h.entries().length).toBeLessThanOrEqual(IssueHistory.MAX_MOVES + 1)
  })
  test('remembers agent workspaces', () => {
    expect([...fill([{ t: NOW, session: 's', workspace: 'web' }]).workspaces]).toEqual(['web'])
  })
})

describe('churning: sessions', () => {
  const sessions = (n: number, ago = D) => Array.from({ length: n }, (_, k) => touch(ago - k * 1000, `s${k}`))
  test('more than `sessions` distinct agent sessions in the window without Done', () => {
    expect(stalledReason(ip, fresh, sessions(4), ctx())).toBe('4 sessions in 7 days without Done')
    expect(stalledReason(ip, fresh, sessions(3), ctx())).toBeNull() // exactly at the threshold is not "more than"
    expect(stalledReason(ip, fresh, [...sessions(3), touch(H, 's0')], ctx())).toBeNull() // the same session twice counts once
  })
  test('the session that moved it to Done (and its Done comment) does not count, unless it moves it again', () => {
    const base = [mv(3 * D, 'Todo', 'In Progress', 'x'), mv(2 * D, 'In Progress', 'Done', 'a'), touch(2 * D - 1000, 'a')]
    const others = [touch(D, 'b'), touch(D - 1, 'c'), touch(D - 2, 'd')]
    expect(stalledReason(ip, fresh, [...base, ...others], ctx())).toBeNull() // b, c, d: 3 is not more than 3
    expect(stalledReason(ip, fresh, [...base, ...others, mv(H, 'Done', 'In Progress', 'a')], ctx({ reopens: 0 })))
      .toBe('4 sessions in 7 days without Done') // a reopened it: it counts again
  })
  test('reaching Done starts the count over', () => {
    expect(stalledReason(ip, fresh, [...sessions(3, 2 * D), mv(D, 'In Progress', 'Done'), mv(H, 'Done', 'In Progress', 'x')], ctx())).toBeNull()
  })
  test('sessions outside the window do not count; sessions 0 turns it off', () => {
    expect(stalledReason(ip, fresh, sessions(4, 8 * D), ctx())).toBeNull()
    expect(stalledReason(ip, fresh, sessions(9), ctx({ sessions: 0 }))).toBeNull()
  })
  test('applies to any open status but Backlog (parked)', () => {
    expect(stalledReason({ status: 'Waiting' }, fresh, sessions(4), ctx())).toBe('4 sessions in 7 days without Done')
    expect(stalledReason({ status: 'Todo' }, fresh, sessions(4), ctx())).toBe('4 sessions in 7 days without Done')
    expect(stalledReason({ status: 'Backlog' }, fresh, sessions(4), ctx())).toBeNull()
  })
})

describe('both, and closed issues', () => {
  test('idle and churning join with "; "', () => {
    const h = [mv(6 * D, 'Todo', 'In Progress'), mv(5 * D, 'In Progress', 'Todo', 'a'), mv(4 * D, 'Todo', 'In Progress', 'b'),
      mv(3.5 * D, 'In Progress', 'Todo', 'c'), mv(3 * D, 'Todo', 'In Progress', 'd'), touch(2.5 * D, 'e')]
    expect(stalledReason(ip, NOW - 2.5 * D, h, ctx())).toBe('idle 60 h in In Progress; reopened 2× in 7 days by 5 sessions')
  })
  test('Done, Canceled and Duplicate are never stalled', () => {
    const h = Array.from({ length: 9 }, (_, k) => touch(H + k, `s${k}`))
    for (const status of ['Done', 'Canceled', 'Duplicate']) expect(stalledReason({ status }, NOW - 100 * D, h, ctx())).toBeNull()
  })
})

describe('config', () => {
  test('working status: In Progress, else the first started status that is not a Needs-you one', () => {
    expect(workingStatus(DEFAULT_STATUSES, ['Waiting'])).toBe('In Progress')
    const custom = [{ name: 'Waiting', type: 'started' as const, color: '' }, { name: 'Doing', type: 'started' as const, color: '' }]
    expect(workingStatus(custom, ['Waiting'])).toBe('Doing')
    expect(workingStatus([{ name: 'Open', type: 'unstarted', color: '' }], [])).toBeNull()
  })
  test('normalize: missing or bad values take the default; 0 stays 0', () => {
    expect(normalizeStalled(undefined)).toEqual(DEFAULT_STALLED)
    expect(normalizeStalled({ idleHours: 0, windowDays: 'x', reopens: -1, sessions: 5 })).toEqual({ idleHours: 0, windowDays: 7, reopens: 2, sessions: 5 })
    expect(DEFAULT_STALLED).toEqual({ idleHours: 24, windowDays: 7, reopens: 2, sessions: 3 })
  })
})
