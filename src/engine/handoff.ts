/**
 * The handoff an agent sees first when it opens an In Progress issue (get_issue): where the last session stopped.
 * Small and not repeating the rest of get_issue: who worked last, that session's own latest note, how much of the
 * checklist is open (3 titles), open blockers, and the stalled and CI reasons. Built from memory only; null when it
 * isn't In Progress, when nothing in it helps, or when the caller is the session that worked on it last.
 */
import type { Issue } from '../model'
import { taskLines } from '../shared/tasks'
import type { AttemptOut } from './attempts'

/** The note is shorter than this. */
export const HANDOFF_NOTE_MAX = 200
/** Unticked checklist titles listed at most (the count says how many there are). */
export const HANDOFF_OPEN_SHOWN = 3
const TITLE_MAX = 60

export interface Handoff {
  /** The session that worked on it last: tool, branch and its last write. */
  last?: { client?: string; branch?: string; at: string }
  /** That session's own latest comment, shortened ("…"). */
  note?: string
  /** Unticked checklist items: how many, and the first three titles. */
  open?: { count: number; items: string[] }
  /** Open blockers' ids. */
  blockers?: string[]
  stalled?: string
  ci?: string
}

/** `- [ ] ` and friends at the start of a task line. */
const TASK_MARK = /^(?:\s*>)*\s*(?:[-*+]|\d{1,9}[.)])\s+\[[ xX]\]\s*/

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one
}

export function handoffOf(
  i: Issue,
  o: {
    working: string | null; attempts: AttemptOut[]; openBlockers: string[]; stalled?: string | null; ci?: string | null
    /** The calling agent's session: no handoff to the session that worked on it last. */
    caller?: string
  },
): Handoff | null {
  if (!o.working || i.status !== o.working) return null
  const last = o.attempts.at(-1)
  if (last?.session && o.caller && last.session === o.caller) return null
  // The last session's own comment: an agent comment from its repo and branch, written while it worked.
  const from = Date.parse(last?.first ?? '') - 1_000, to = Date.parse(last?.last ?? '') + 1_000
  const note = last
    ? i.activity.filter((a) => a.actor === 'agent' && a.workspace === last.workspace && (a.branch ?? '') === (last.branch ?? '')
      && Date.parse(a.at) >= from && Date.parse(a.at) <= to).at(-1)
    : undefined
  const open = taskLines(i.description).filter((t) => !t.checked)
  const h: Handoff = {
    ...(note ? { note: clip(note.body, HANDOFF_NOTE_MAX - 1) } : {}),
    ...(open.length ? { open: { count: open.length, items: open.slice(0, HANDOFF_OPEN_SHOWN).map((t) => clip(t.text.replace(TASK_MARK, ''), TITLE_MAX)) } } : {}),
    ...(o.openBlockers.length ? { blockers: o.openBlockers } : {}),
    ...(o.stalled ? { stalled: o.stalled } : {}),
    ...(o.ci ? { ci: o.ci } : {}),
  }
  if (!Object.keys(h).length) return null
  return {
    ...(last ? { last: { ...(last.client ? { client: last.client } : {}), ...(last.branch ? { branch: last.branch } : {}), at: last.last } } : {}),
    ...h,
  }
}
