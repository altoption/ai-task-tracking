/**
 * Attempts: an issue's agent work grouped by session (one attempt per agent session), from the per-issue history the
 * store keeps for the stalled rules (`IssueHistory`, read from the feed log at open) plus `touched_by`. No I/O.
 *
 * The history starts when this Mac's feed log (`.tracker/events.jsonl`) does: on a fresh clone, or for work from
 * before it, the only attempt known is the last writer in `touched_by`.
 */
import type { Issue } from '../model'
import type { Store } from './store'

/** One attempt as clients see it. Times are ISO; `writes` counts changes (one save is one write). */
export interface AttemptOut {
  /** The agent session (absent for the touched_by stand-in when it has none). */
  session?: string
  client?: string; workspace?: string; branch?: string
  first: string; last: string; leftStatus?: string; writes: number
}

const iso = (ms: number) => new Date(ms).toISOString()

/** The issue's attempts, oldest first by their last write. */
export function attemptsOf(s: Pick<Store, 'attempts' | 'statusMoved'>, i: Issue): AttemptOut[] {
  const list = s.attempts(i.id)
  if (!list.length) {
    // No logged history: the last agent that wrote (touched_by) is one attempt.
    const t = i.touchedBy
    if (t?.actor !== 'agent') return []
    return [{
      ...(t.session ? { session: t.session } : {}), ...(t.client ? { client: t.client } : {}), ...(t.workspace ? { workspace: t.workspace } : {}), ...(t.branch ? { branch: t.branch } : {}),
      first: i.updated, last: i.updated, leftStatus: i.status, writes: 1,
    }]
  }
  // No move logged at all: every attempt left the issue in the status it has now.
  const moved = s.statusMoved(i.id)
  return list.map((a, k) => {
    // Else the latest attempt's status, when no move was logged before it: the issue's status now.
    const left = a.leftStatus ?? (!moved || k === list.length - 1 ? i.status : undefined)
    return {
      session: a.session, ...(a.client ? { client: a.client } : {}), ...(a.workspace ? { workspace: a.workspace } : {}), ...(a.branch ? { branch: a.branch } : {}),
      first: iso(a.first), last: iso(a.last), ...(left ? { leftStatus: left } : {}), writes: a.writes,
    }
  })
}

/** Distinct agent tools across attempts (unknown tools count as one). */
export const toolCount = (list: AttemptOut[]) => new Set(list.map((a) => a.client ?? '?')).size

/** get_issue's small form: `{ count, tools, last: { client, branch, at, leftStatus } }`, or null with no attempts. */
export function attemptsBrief(list: AttemptOut[]) {
  const last = list.at(-1)
  if (!last) return null
  return {
    count: list.length, tools: toolCount(list),
    last: {
      ...(last.client ? { client: last.client } : {}), ...(last.branch ? { branch: last.branch } : {}),
      at: last.last, ...(last.leftStatus ? { leftStatus: last.leftStatus } : {}),
    },
  }
}
