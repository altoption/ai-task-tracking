/**
 * Stalled-work rules (config.yml `stalled:`). Pure and deterministic: an issue, its recent history and the clock in,
 * a short reason (or null) out. No I/O; the store keeps each issue's history in memory (`IssueHistory`).
 *
 * - Idle: the issue is in the working status (In Progress) and nothing changed on it (any edit or comment, by
 *   anyone) for `idleHours` or more. 0 turns it off. For an epic the caller passes its newest change among its
 *   descendants, or `now` while its open children all wait on the owner (`stalledOf` in queries.ts).
 * - Churning: in the last `windowDays`, the issue was reopened (back into In Progress from Done, Canceled, Duplicate,
 *   Todo or Backlog, after having been in it) at least `reopens` times, or more than `sessions` distinct agent
 *   sessions worked on it since it was last Done. A round trip through Waiting or another Needs-you status is asking
 *   the owner, never a reopen. 0 turns that half off; `windowDays: 0` turns churning off. Backlog issues (parked)
 *   are never churning.
 * Closed issues (Done, Canceled, Duplicate) are never stalled. Blocked issues are left out by the caller
 * (`stalledOf` in queries.ts): Blocked wins.
 */
import type { StalledRules, StatusDef } from '../model'
import { CLOSED_TYPES, statusTypeOf, type StatusType } from '../shared/filter'

/** One remembered change: a status move (`to` set), or another write by an agent session. Times in ms. */
export interface HistoryEntry { t: number; from?: string; to?: string; session?: string; workspace?: string; client?: string; branch?: string }

/**
 * One agent session's work on an issue (an "attempt"): its tool, repo and branch (as of its latest write), first and
 * last write times (ms), the status the issue was in after its last write (when known), and its writes (changes
 * logged at the same moment count once).
 */
export interface Attempt {
  session: string; client?: string; workspace?: string; branch?: string
  first: number; last: number; leftStatus?: string; writes: number
}

export const DEFAULT_STALLED: StalledRules = { idleHours: 24, windowDays: 7, reopens: 2, sessions: 3 }

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Status types a move back into In Progress counts as a reopen from (not started ones like Waiting). */
const REOPEN_FROM: ReadonlySet<StatusType> = new Set(['completed', 'canceled', 'duplicate', 'unstarted', 'backlog'])

/** The status idle work sits in: "In Progress" if it exists, else the first `started` status that isn't a Needs-you one. */
export function workingStatus(statuses: StatusDef[], needsYouStatuses: string[]): string | null {
  if (statuses.some((s) => s.name === 'In Progress')) return 'In Progress'
  return statuses.find((s) => s.type === 'started' && !needsYouStatuses.includes(s.name))?.name ?? null
}

/** "31 h" under three days, then "4 d". */
const span = (ms: number) => (ms < 3 * DAY ? `${Math.floor(ms / HOUR)} h` : `${Math.floor(ms / DAY)} d`)

/** Number of the window, singular or plural: "1 day", "7 days". */
const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`

export interface StalledCtx {
  rules: StalledRules
  /** The working status (`workingStatus`). */
  working: string | null
  /** Status name → type, built once per pass. */
  typeOf: (name: string) => StatusType
  /** Needs-you statuses: moves out of them are never reopens. */
  needsYou: ReadonlySet<string>
  now: number
}

/** The context for one pass over many issues (the status map is built here, not per issue). */
export function stalledCtx(o: { rules: StalledRules; statuses: StatusDef[]; needsYouStatuses: string[]; now: number }): StalledCtx {
  return {
    rules: o.rules, now: o.now, typeOf: statusTypeOf(o.statuses), needsYou: new Set(o.needsYouStatuses),
    working: workingStatus(o.statuses, o.needsYouStatuses),
  }
}

/**
 * Why the issue is stalled, or null. `lastChange` is the newest edit/comment time (ms); `history` is oldest first.
 * Reasons: "idle 31 h in In Progress", "reopened 3× in 7 days by 4 sessions", "5 sessions in 7 days without Done";
 * both rules matching join with "; ".
 */
export function stalledReason(
  issue: { status: string }, lastChange: number, history: readonly HistoryEntry[], ctx: StalledCtx,
): string | null {
  const { rules, working, now, typeOf } = ctx
  const type = typeOf(issue.status)
  if (CLOSED_TYPES.has(type)) return null
  const out: string[] = []

  if (rules.idleHours > 0 && working && issue.status === working && Number.isFinite(lastChange)) {
    const idle = now - lastChange
    if (idle >= rules.idleHours * HOUR) out.push(`idle ${span(idle)} in ${working}`)
  }

  if (rules.windowDays > 0 && type !== 'backlog' && history.length && (rules.reopens > 0 || rules.sessions > 0)) {
    const since = now - rules.windowDays * DAY
    let wasWorking = false
    let reopens = 0
    let sessions = new Set<string>()
    let doneBy: string | undefined // the session that moved it to Done; its other writes (the Done comment) don't count
    for (const h of history) {
      const inWindow = h.t >= since && h.t <= now
      if (h.to !== undefined) {
        const from = h.from ?? ''
        const reopen = h.to === working && from !== working && wasWorking && !ctx.needsYou.has(from) && REOPEN_FROM.has(typeOf(from))
        if (reopen && inWindow) reopens++
        if (from === working || h.to === working) wasWorking = true
        // Reaching Done starts the session count over: only sessions after it worked on it "without Done".
        if (typeOf(h.to) === 'completed') { sessions = new Set(); doneBy = h.session; continue }
      } else if (h.session === doneBy) continue
      if (inWindow && h.session) sessions.add(h.session)
    }
    const reopened = rules.reopens > 0 && reopens >= rules.reopens
    const crowded = rules.sessions > 0 && sessions.size > rules.sessions
    const by = sessions.size ? ` by ${sessions.size} session${sessions.size === 1 ? '' : 's'}` : ''
    if (reopened) out.push(`reopened ${reopens}× in ${days(rules.windowDays)}${by}`)
    else if (crowded) out.push(`${sessions.size} sessions in ${days(rules.windowDays)} without Done`)
  }
  return out.length ? out.join('; ') : null
}

/**
 * What the store remembers about one issue for the churning rules: its status moves, and each agent session's latest
 * other write (one entry per session, so a busy session can't push the moves out). Both are pruned to the window as
 * entries arrive. A pruned move that touched In Progress leaves one anchor move (In Progress → In Progress) at its
 * time, so a later reopen still knows the issue had been in progress. `MAX_MOVES` is only a safety net.
 */
export class IssueHistory {
  static readonly MAX_MOVES = 1000
  private moves: HistoryEntry[] = []
  private anchor: HistoryEntry | null = null
  /** The newest move that fell out of the window, so `lastMove` outlives pruning. */
  private pruned: HistoryEntry | null = null
  private sessions = new Map<string, HistoryEntry>()
  /** Agent workspaces that wrote to the issue (within the window when they were seen). */
  readonly workspaces = new Set<string>()
  private cache: HistoryEntry[] | null = null
  /** Every agent session's attempt (never pruned by the window; the oldest go past MAX_ATTEMPTS), oldest first. */
  private tries = new Map<string, Attempt>()
  /** The status after the newest logged move (any actor). */
  private status: string | undefined
  static readonly MAX_ATTEMPTS = 50

  /** Add one change (entries arrive oldest first); prune what fell out of `windowMs` before it. */
  add(e: HistoryEntry, windowMs: number, working: string | null): void {
    this.cache = null
    if (e.to !== undefined) this.status = e.to
    if (e.session) this.attempt(e)
    if (e.workspace) this.workspaces.add(e.workspace)
    if (e.to !== undefined) this.moves.push(e)
    else if (e.session) this.sessions.set(e.session, e)
    const cutoff = e.t - windowMs
    let drop = 0
    while (drop < this.moves.length && (this.moves[drop]!.t < cutoff || this.moves.length - drop > IssueHistory.MAX_MOVES)) drop++
    for (const m of this.moves.slice(0, drop)) {
      this.pruned = m
      if (working && (m.from === working || m.to === working)) this.anchor = { t: m.t, from: working, to: working }
    }
    if (drop) this.moves.splice(0, drop)
    for (const [k, v] of this.sessions) if (v.t < cutoff) this.sessions.delete(k)
  }

  private attempt(e: HistoryEntry): void {
    const id = e.session!
    let a = this.tries.get(id)
    if (!a) {
      a = { session: id, first: e.t, last: e.t, writes: 0 }
      this.tries.set(id, a)
      if (this.tries.size > IssueHistory.MAX_ATTEMPTS) {
        // Over the cap: forget the least recently active session (never the one just added).
        let oldest: Attempt | undefined
        for (const x of this.tries.values()) if (x !== a && (!oldest || x.last < oldest.last)) oldest = x
        if (oldest) this.tries.delete(oldest.session)
      }
    }
    // One write is logged as several events at the same time (a status move and its comment): it counts once.
    if (!(e.t === a.last && a.writes)) a.writes++
    a.last = Math.max(a.last, e.t)
    if (e.client) a.client = e.client
    if (e.workspace) a.workspace = e.workspace
    if (e.branch) a.branch = e.branch
    a.leftStatus = this.status
  }

  /** The newest status move logged, however old. */
  get lastMove(): HistoryEntry | null { return this.moves.at(-1) ?? this.pruned }

  /** Whether any status move was logged (without one, the issue is still in the status it was created in). */
  get moved(): boolean { return this.status !== undefined }

  /** Agent sessions that wrote to the issue, oldest first by their last write. */
  attempts(): Attempt[] { return [...this.tries.values()].sort((x, y) => x.last - y.last) }

  /** Moves and latest session writes, oldest first (cached until the next `add`). */
  entries(): HistoryEntry[] {
    if (!this.cache) {
      this.cache = [...(this.anchor ? [this.anchor] : []), ...this.moves, ...this.sessions.values()].sort((a, b) => a.t - b.t)
    }
    return this.cache
  }
}

/** Config values as numbers ≥ 0 (a bad value counts as its default, never as "off"). */
export function normalizeStalled(raw: unknown): StalledRules {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const num = (k: keyof StalledRules) => {
    const v = o[k]
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_STALLED[k]
  }
  return { idleHours: num('idleHours'), windowDays: num('windowDays'), reopens: num('reopens'), sessions: num('sessions') }
}
