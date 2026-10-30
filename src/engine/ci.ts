/**
 * CI status on linked GitHub PRs (config.yml `ci:`). Two halves:
 *
 * - Pure: parse `gh pr view --json …` (state and statusCheckRollup, CheckRun and StatusContext), pick the worst
 *   status of an issue's PRs, and the Needs-you reason ("CI failing on PR #12").
 * - `CiRefresher`: the only place that runs `gh`, always in the background, never on a request path. Requests read
 *   its in-memory cache (`store.ci`, a `CiLookup`).
 *
 * Refresh policy: an open or draft PR is re-checked every `refreshMinutes` (2); a merged or closed PR whose checks
 * are settled is never re-checked. Only PRs linked from issues that aren't Done, Canceled or Duplicate, plus Done
 * issues updated in the last 7 days, are refreshed. A new PR link is checked within a second (debounced, batched).
 * At most `concurrency` (3) `gh` calls run at once and a pass takes at most `MAX_PER_PASS` PRs. Errors back off:
 * per PR (1 min doubling to 30 min; no access: 6 h), and for everything when gh is missing or signed out
 * (re-tried every 10 min, one call) or rate-limited (5 min doubling to 1 h). Each reason is logged once.
 * Results are cached in `.tracker/ci.json` (git-ignored), never in issue files, so a restart doesn't refetch.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { ChecksState, CiBadge, CiRules, CiStatus, Issue, PrState, StatusDef } from '../model'
import { atomicWrite } from '../store/atomic'
import { statusTypeOf } from '../shared/filter'
import type { ChangeEvent, Store } from './store'

export const DEFAULT_CI: CiRules = { enabled: true, refreshMinutes: 2 }

/** Config values: `enabled` a boolean, `refreshMinutes` a number ≥ 0.5 (a bad value counts as its default). */
export function normalizeCi(raw: unknown): CiRules {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const m = o.refreshMinutes
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_CI.enabled,
    refreshMinutes: typeof m === 'number' && Number.isFinite(m) && m >= 0.5 ? m : DEFAULT_CI.refreshMinutes,
  }
}

// ---------- parsing (pure) ----------

/**
 * GitHub names: an owner is letters, digits and single inner hyphens (no leading hyphen, ≤ 39); a repo is letters,
 * digits, `.`, `_` and `-` (≤ 100), not starting with `-`, and never `.`, `..` or containing `..`.
 */
const PR_URL = /^https:\/\/(?:[Gg][Ii][Tt][Hh][Uu][Bb])\.(?:[Cc][Oo][Mm])\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._][A-Za-z0-9._-]{0,99})\/pull\/(\d{1,9})\/?$/

/** A GitHub PR url's repo (`owner/name`) and number, or null for any other url. */
export function prOf(url: string): { repo: string; number: number } | null {
  const m = PR_URL.exec(url.trim())
  if (!m || m[2] === '.' || m[2]!.includes('..')) return null
  return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) }
}

const FAILED_RUN = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const FAILED_CONTEXT = new Set(['FAILURE', 'ERROR'])
const PENDING_CONTEXT = new Set(['PENDING', 'EXPECTED'])
/** At most this many failing check names are kept. */
export const FAILING_SHOWN = 3

/**
 * The checks of a PR from gh's `statusCheckRollup`: CheckRun (`status`, `conclusion`, `name`) and StatusContext
 * (`state`, `context`). Any failure → failing (with up to three names); else anything not finished → pending; else
 * passing; no checks → none. Neutral, skipped and stale runs count as passing.
 */
export function parseRollup(rollup: unknown): { checks: ChecksState; failing: string[] } {
  const items = Array.isArray(rollup) ? rollup : []
  const failing: string[] = []
  let pending = false, any = false
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const c = raw as Record<string, unknown>
    const isContext = c.__typename === 'StatusContext' || (c.__typename === undefined && 'context' in c)
    const name = String((isContext ? c.context : c.name) ?? '') || 'check'
    any = true
    if (isContext) {
      const state = String(c.state ?? '').toUpperCase()
      if (FAILED_CONTEXT.has(state)) failing.push(name)
      else if (PENDING_CONTEXT.has(state) || !state) pending = true
    } else {
      const status = String(c.status ?? '').toUpperCase()
      const conclusion = String(c.conclusion ?? '').toUpperCase()
      if (status && status !== 'COMPLETED') pending = true
      else if (FAILED_RUN.has(conclusion)) failing.push(name)
      else if (!conclusion) pending = true
    }
  }
  const names = [...new Set(failing)].slice(0, FAILING_SHOWN)
  if (failing.length) return { checks: 'failing', failing: names }
  return { checks: pending ? 'pending' : any ? 'passing' : 'none', failing: [] }
}

/** A PR's state from gh's `state` (OPEN, CLOSED, MERGED), `isDraft` and `mergedAt`. */
export function prState(o: Record<string, unknown>): PrState {
  const state = String(o.state ?? '').toUpperCase()
  if (state === 'MERGED' || (typeof o.mergedAt === 'string' && o.mergedAt)) return 'merged'
  if (state === 'CLOSED') return 'closed'
  return o.isDraft === true ? 'draft' : 'open'
}

/** `gh pr view --json state,isDraft,mergedAt,statusCheckRollup,number,url` output → a CiStatus (null if it isn't one). */
export function parsePr(json: string, checkedAt: string): CiStatus | null {
  let o: unknown
  try { o = JSON.parse(json) } catch { return null }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const r = o as Record<string, unknown>
  if (typeof r.state !== 'string' || typeof r.number !== 'number') return null
  const mergedAt = typeof r.mergedAt === 'string' && r.mergedAt ? { mergedAt: r.mergedAt } : {}
  return { pr: r.number, state: prState(r), ...parseRollup(r.statusCheckRollup), checkedAt, ...mergedAt }
}

/** A merged PR whose checks fail or still run is re-checked this often… */
export const MERGED_TTL_MS = 30 * 60_000
/** …for this long after the merge, then never again. */
export const MERGED_WATCH_MS = 24 * 3_600_000

/**
 * Never re-checked: a PR closed without merging, a merged one whose checks are settled (passing or none), and a
 * merged one more than 24 h after its merge (failing or pending by then: it stays that way).
 */
export function isFinal(s: CiStatus, now: number): boolean {
  if (s.state === 'closed') return true
  if (s.state !== 'merged') return false
  if (s.checks === 'passing' || s.checks === 'none') return true
  const merged = Date.parse(s.mergedAt ?? '') || Date.parse(s.checkedAt) || 0
  return now >= merged + MERGED_WATCH_MS
}

const STATES: ReadonlySet<string> = new Set(['open', 'draft', 'merged', 'closed'])
const CHECKS: ReadonlySet<string> = new Set(['passing', 'failing', 'pending', 'none'])

/** A CiStatus read from the cache file, checked field by field (null if anything is off). */
export function validStatus(v: unknown): CiStatus | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.pr !== 'number' || !Number.isInteger(o.pr) || o.pr <= 0) return null
  if (typeof o.state !== 'string' || !STATES.has(o.state) || typeof o.checks !== 'string' || !CHECKS.has(o.checks)) return null
  if (!Array.isArray(o.failing) || !o.failing.every((x) => typeof x === 'string')) return null
  if (typeof o.checkedAt !== 'string' || Number.isNaN(Date.parse(o.checkedAt))) return null
  if (o.mergedAt !== undefined && typeof o.mergedAt !== 'string') return null
  return {
    pr: o.pr, state: o.state as PrState, checks: o.checks as ChecksState, failing: (o.failing as string[]).slice(0, FAILING_SHOWN),
    checkedAt: o.checkedAt, ...(typeof o.mergedAt === 'string' ? { mergedAt: o.mergedAt } : {}),
  }
}

const CHECK_RANK: Record<ChecksState, number> = { failing: 3, pending: 2, passing: 1, none: 0 }
const STATE_RANK: Record<PrState, number> = { open: 3, draft: 2, merged: 1, closed: 0 }

/** The status a row shows for several PRs: worst checks first, then the most open PR. */
export function worstCi(list: readonly CiStatus[]): CiStatus | null {
  let best: CiStatus | null = null
  for (const s of list) {
    if (!best || CHECK_RANK[s.checks] > CHECK_RANK[best.checks]
      || (CHECK_RANK[s.checks] === CHECK_RANK[best.checks] && STATE_RANK[s.state] > STATE_RANK[best.state])) best = s
  }
  return best
}

export const badgeOf = (s: CiStatus): CiBadge => ({ pr: s.pr, state: s.state, checks: s.checks })

// ---------- what requests read ----------

/** The refresher's cache as requests see it: nothing at all while CI status is off. */
export interface CiLookup {
  /** CI status is on: config.yml `ci.enabled` and the app's "Show CI status" setting. */
  enabled(): boolean
  /** The cached status of a PR url (undefined when off, unknown or not accessible). */
  get(url: string): CiStatus | undefined
  /** Why a PR url has no status ("no access with gh"), when that is known; shown on its issue only. */
  problem(url: string): string | undefined
}

/** Done issues stay in scope (refreshed and in Needs you) this long after they reached Done. */
export const DONE_WINDOW_MS = 7 * 86_400_000

/** What the CI Needs-you test reads: the lookup, the statuses, and when an issue reached Done (the store). */
export interface CiCtx {
  ci: CiLookup | null | undefined
  config: { statuses: StatusDef[] }
  /** When the issue last moved into a completed status (ms), from the feed log; undefined when not logged. */
  doneAt(id: string): number | undefined
}

/** When `i` reached Done: logged, else its last update (a fresh clone has no log). */
export const doneTime = (c: Pick<CiCtx, 'doneAt'>, i: Pick<Issue, 'id' | 'updated'>) => c.doneAt(i.id) ?? (Date.parse(i.updated) || 0)

/** The issue's PR links with a known status, in link order. */
export function issueCi(ci: CiLookup | null | undefined, i: Pick<Issue, 'links'>): { url: string; status: CiStatus }[] {
  if (!ci?.enabled() || !i.links.length) return []
  const out: { url: string; status: CiStatus }[] = []
  for (const l of i.links) {
    if (!prOf(l.url)) continue
    const status = ci.get(l.url)
    if (status) out.push({ url: l.url, status })
  }
  return out
}

/** The row badge: the worst status over the issue's PRs. */
export function ciBadge(ci: CiLookup | null | undefined, i: Pick<Issue, 'links'>): CiBadge | undefined {
  const w = worstCi(issueCi(ci, i).map((x) => x.status))
  return w ? badgeOf(w) : undefined
}

/**
 * The Needs-you test for CI at `now`: "CI failing on PR #12" (the first failing PR; "+1 more" for others) for an
 * issue in a started status (In Progress), or that reached Done within the last 7 days, whose open or draft PR's
 * checks fail. A merged or closed PR never counts (merged is final for Needs you; its badge still shows the
 * failure). Null otherwise, and always null while CI status is off.
 */
export function ciReasonOf(c: CiCtx, now: number): (i: Issue) => string | null {
  const ci = c.ci
  if (!ci?.enabled()) return () => null
  const typeOf = statusTypeOf(c.config.statuses)
  return (i) => {
    if (!i.links.length) return null
    const t = typeOf(i.status)
    if (t !== 'started' && !(t === 'completed' && now - doneTime(c, i) <= DONE_WINDOW_MS)) return null
    const failing = issueCi(ci, i).filter((x) => x.status.checks === 'failing' && (x.status.state === 'open' || x.status.state === 'draft'))
    if (!failing.length) return null
    return `CI failing on PR #${failing[0]!.status.pr}${failing.length > 1 ? ` +${failing.length - 1} more` : ''}`
  }
}

// ---------- running gh ----------

export interface GhResult { code: number; stdout: string; stderr: string }
/**
 * Runs `gh` with these arguments (an argv array, no shell); `signal` kills it. Tests inject a fake; the default
 * spawns the real one.
 */
export type GhRunner = (args: string[], opts?: { signal?: AbortSignal }) => Promise<GhResult>

const GH_TIMEOUT_MS = 20_000
/** Where `gh` lives when it isn't on PATH (a login item gets launchd's PATH): Homebrew on Apple Silicon and Intel, then ~/.local/bin. */
export const GH_FALLBACKS = (home: string) => ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', join(home, '.local', 'bin', 'gh')]

/** The `gh` to run: the first on PATH (absolute entries only), else the first fallback that exists; null: none. */
export function resolveGh(o: { path: string | undefined; home: string; exists: (p: string) => boolean }): string | null {
  const onPath = (o.path ?? '').split(':').filter((d) => d && isAbsolute(d)).map((d) => join(d, 'gh'))
  return [...onPath, ...GH_FALLBACKS(o.home)].find((p) => o.exists(p)) ?? null
}

/** A runner for the `gh` that `bin()` names (found once, then kept; looked for again while missing, so a `gh`
 * installed after the engine started is picked up); no `gh` is exit code 127. */
export function makeGhRunner(bin: () => string | null): GhRunner {
  let resolved: string | null = null
  return async (args, opts = {}) => {
    if (!resolved) resolved = bin()
    if (!resolved) return { code: 127, stdout: '', stderr: 'gh: command not found' }
    return spawnGh(resolved, args, opts.signal)
  }
}

/** The real `gh`, found on PATH or in Homebrew's or ~/.local's bin folder. */
export const ghRunner: GhRunner = makeGhRunner(() => resolveGh({ path: process.env.PATH, home: homedir(), exists: existsSync }))

/** Spawn `gh`: argv array (no shell), no prompts, killed after 20 s or on `signal`. */
async function spawnGh(bin: string, args: string[], signal?: AbortSignal): Promise<GhResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    if (signal?.aborted) return { code: 143, stdout: '', stderr: 'gh stopped' }
    const p = Bun.spawn([bin, ...args], {
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: 'cat' },
    })
    onAbort = () => p.kill()
    signal?.addEventListener('abort', onAbort)
    const timedOut = new Promise<'timeout'>((r) => { timer = setTimeout(() => { p.kill(); r('timeout') }, GH_TIMEOUT_MS) })
    const done = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    done.catch(() => {})
    const res = await Promise.race([done, timedOut])
    if (res === 'timeout') return { code: 124, stdout: '', stderr: `gh timed out after ${GH_TIMEOUT_MS} ms` }
    return { code: res[2], stdout: res[0], stderr: res[1] }
  } catch (e) {
    // Bun.spawn throws when the executable isn't on PATH.
    return { code: 127, stdout: '', stderr: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

export type GhProblem = 'missing' | 'auth' | 'rate' | 'access' | 'other'

/** Why a gh call failed: not installed, not signed in, rate-limited, no access to the repo/PR, or anything else. */
export function classifyGh(r: GhResult): GhProblem {
  const e = `${r.stderr}\n${r.stdout}`
  if (r.code === 127 || /ENOENT|command not found|executable not found/i.test(e)) return 'missing'
  if (/gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i.test(e)) return 'auth'
  if (/rate limit|HTTP 429/i.test(e)) return 'rate'
  if (/could not resolve to a|HTTP 404|not found|resource not accessible|HTTP 403/i.test(e)) return 'access'
  return 'other'
}

// ---------- the refresher ----------

const MIN = 60_000
const RETRY_MIN = MIN
const RETRY_MAX = 30 * MIN
const NO_ACCESS_RETRY = 6 * 60 * MIN
const OFF_RETRY = 10 * MIN
const RATE_MIN = 5 * MIN
const RATE_MAX = 60 * MIN
/** PRs checked per pass at most; the rest wait for the next tick. */
export const MAX_PER_PASS = 30
const CACHE_VERSION = 1

/** One PR in the cache. `nextAt` null: final (never re-checked). `error`: the last call failed (`access`: no access). */
interface Entry { status?: CiStatus; nextAt: number | null; fails?: number; error?: GhProblem }

export const ciCachePath = (root: string) => join(root, '.tracker', 'ci.json')

const PROBLEMS: ReadonlySet<string> = new Set(['missing', 'auth', 'rate', 'access', 'other'])

/** A cache entry read from disk, checked field by field (null if anything is off). */
function validEntry(v: unknown): Entry | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const status = o.status === undefined ? undefined : validStatus(o.status)
  if (status === null) return null
  if (!(o.nextAt === null || (typeof o.nextAt === 'number' && Number.isFinite(o.nextAt)))) return null
  if (o.fails !== undefined && !(typeof o.fails === 'number' && Number.isInteger(o.fails) && o.fails >= 0)) return null
  if (o.error !== undefined && !(typeof o.error === 'string' && PROBLEMS.has(o.error))) return null
  return {
    ...(status ? { status } : {}), nextAt: o.nextAt as number | null,
    ...(o.fails !== undefined ? { fails: o.fails as number } : {}), ...(o.error !== undefined ? { error: o.error as GhProblem } : {}),
  }
}

export interface CiHealth {
  /** CI status is on (config.yml and the app's setting). */
  enabled: boolean
  /** The app's "Show CI status" setting as the engine last heard it (true until the app says otherwise). */
  setting: boolean
  /** One line when CI status is off or can't be fetched: "CI status off: gh not signed in". */
  reason?: string
}

export interface CiOpts {
  run?: GhRunner
  now?: () => number
  /** `gh` calls at once (2–3). */
  concurrency?: number
  /** How often the background pass runs (default 15 s). 0: no timer (tests call `pass()`). */
  tickMs?: number
  /** Nothing is checked before this delay after start (timer or new links), so the app can post its setting first (default 5 s). */
  startDelayMs?: number
  /** A new PR link is checked after this quiet time (default 1 s); several links in a burst share one pass. */
  debounceMs?: number
  /** Cache writes are batched this long (default 1 s). */
  saveDelayMs?: number
  log?: (msg: string) => void
}

export class CiRefresher implements CiLookup {
  private cache = new Map<string, Entry>()
  private inflight = new Set<string>()
  /** Everything is paused: gh missing or signed out, or rate-limited. */
  private off: { problem: GhProblem; until: number; reason: string } | null = null
  private rateFails = 0
  private setting = true
  private logged = new Set<string>()
  private running: Promise<void> | null = null
  private timers: { tick?: ReturnType<typeof setInterval>; start?: ReturnType<typeof setTimeout>; kick?: ReturnType<typeof setTimeout>; save?: ReturnType<typeof setTimeout> } = {}
  private dirty = false
  private stopped = false
  /** Aborted by stop(): kills gh calls in flight. */
  private abort = new AbortController()
  /** No check before this time (the start delay). */
  private readonly readyAt: number
  private unsubscribe = () => {}
  /** gh calls made (tests). */
  calls = 0

  private readonly run: GhRunner
  private readonly now: () => number
  private readonly concurrency: number
  private readonly log: (msg: string) => void

  private constructor(private readonly store: Store, private readonly opts: CiOpts) {
    this.run = opts.run ?? ghRunner
    this.now = opts.now ?? Date.now
    this.concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 3))
    this.log = opts.log ?? ((m) => console.error(m))
    this.readyAt = this.now() + (opts.startDelayMs ?? 5_000)
  }

  /** Load the cache, attach to the store (`store.ci`) and start the background pass. */
  static async start(store: Store, opts: CiOpts = {}): Promise<CiRefresher> {
    const r = new CiRefresher(store, opts)
    await r.load()
    store.ci = r
    r.unsubscribe = store.on((e) => r.onChange(e))
    const tick = opts.tickMs ?? 15_000
    if (tick > 0) {
      r.timers.start = setTimeout(() => {
        void r.pass()
        r.timers.tick = setInterval(() => void r.pass(), tick)
      }, opts.startDelayMs ?? 5_000)
    }
    return r
  }

  // ----- CiLookup -----

  enabled(): boolean { return this.store.config.ci.enabled && this.setting }
  get(url: string): CiStatus | undefined {
    if (!this.enabled()) return undefined
    const e = this.cache.get(url)
    return e?.error === 'access' ? undefined : e?.status
  }
  problem(url: string): string | undefined {
    if (!this.enabled()) return undefined
    return this.cache.get(url)?.error === 'access' ? 'no access with gh' : undefined
  }

  // ----- control -----

  /** The app's "Show CI status" setting. Off: nothing is fetched or shown. Rows update through a `ci` event. */
  setSetting(on: boolean): void {
    if (on === this.setting) return
    const before = this.badges()
    this.setting = on
    this.emitDiff(before)
    if (on) this.kick(0)
  }

  health(): CiHealth {
    const h: CiHealth = { enabled: this.enabled(), setting: this.setting }
    if (!this.store.config.ci.enabled) return { ...h, reason: 'CI status off in config.yml (ci.enabled)' }
    if (!this.setting) return { ...h, reason: 'CI status off in Settings' }
    // gh missing, signed out or rate-limited stops everything; a link gh can't read is reported on its issue only.
    if (this.off) return { ...h, reason: this.off.reason }
    return h
  }

  /** Stop the timers and write the cache (a gh call still running is not waited for; its result is dropped). */
  async stop(): Promise<void> {
    this.unsubscribe()
    clearTimeout(this.timers.start)
    clearInterval(this.timers.tick)
    clearTimeout(this.timers.kick)
    clearTimeout(this.timers.save)
    if (this.store.ci === this) this.store.ci = null
    this.stopped = true
    this.abort.abort()
    if (this.dirty) await this.save()
  }

  /** Check due PRs soon (debounced; never before the start delay): several new links in a burst share one pass. */
  kick(delay = this.opts.debounceMs ?? 1_000): void {
    clearTimeout(this.timers.kick)
    this.timers.kick = setTimeout(() => void this.pass(), Math.max(delay, this.readyAt - this.now()))
  }

  // ----- the pass -----

  /** PR urls to check now, in scope order (started work first), at most MAX_PER_PASS. */
  due(): string[] {
    const now = this.now()
    const typeOf = statusTypeOf(this.store.config.statuses)
    const store = this.store
    const seen = new Set<string>()
    const first: string[] = [], rest: string[] = []
    for (const i of this.store.all()) {
      if (!i.links.length) continue
      const t = typeOf(i.status)
      if (t === 'canceled' || t === 'duplicate') continue
      if (t === 'completed' && now - doneTime(store, i) > DONE_WINDOW_MS) continue
      for (const l of i.links) {
        if (!prOf(l.url) || seen.has(l.url)) continue
        seen.add(l.url)
        const e = this.cache.get(l.url)
        if (this.inflight.has(l.url) || (e && (e.nextAt === null || e.nextAt > now))) continue
        if (e?.status && isFinal(e.status, now)) { e.nextAt = null; continue } // merged more than 24 h ago
        ;(t === 'started' ? first : rest).push(l.url)
      }
    }
    return [...first, ...rest].slice(0, MAX_PER_PASS)
  }

  /** One background pass: check the due PRs, `concurrency` at a time. Resolves when done (one pass at a time). */
  pass(): Promise<void> {
    if (this.running) return this.running
    this.running = this.doPass().finally(() => { this.running = null })
    return this.running
  }

  private async doPass(): Promise<void> {
    if (this.stopped || !this.enabled()) return
    const now = this.now()
    if (this.off && this.off.until > now) return
    const queue = this.due()
    if (!queue.length) return
    // Coming back: after gh was missing or signed out, `gh auth status` first; after a rate limit, one PR check.
    if (this.off) {
      const ok = this.off.problem === 'rate' ? await this.check(queue.shift()!) : await this.probe()
      if (!ok) return
    }
    const worker = async () => {
      while (queue.length && !this.off && this.enabled()) await this.check(queue.shift()!)
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker))
  }

  /** `gh auth status`: true (and the pause is over) when gh is there and signed in. */
  private async probe(): Promise<boolean> {
    this.calls++
    const r = await this.run(['auth', 'status', '--hostname', 'github.com'], { signal: this.abort.signal })
    if (this.stopped) return false
    if (r.code === 0) { this.off = null; return true }
    const problem = classifyGh(r)
    this.pause(problem === 'missing' ? 'missing' : 'auth', this.now(), true)
    return false
  }

  /** Pause everything: gh missing, signed out, or rate-limited. `again`: a failed probe re-arms the pause. */
  private pause(problem: 'missing' | 'auth' | 'rate', now: number, again = false): void {
    // Calls already running when gh went away fail the same way: the first one sets the pause.
    if (!again && this.off && this.off.until > now) return
    const reason = problem === 'missing' ? 'CI status off: gh not installed'
      : problem === 'auth' ? 'CI status off: gh not signed in' : 'CI status paused: GitHub rate limit'
    const wait = problem === 'rate' ? Math.min(RATE_MIN * 2 ** this.rateFails++, RATE_MAX) : OFF_RETRY
    this.off = { problem, until: now + wait, reason }
    this.once(reason)
  }

  /** Check one PR; false when gh as a whole is unavailable (the pass stops). */
  private async check(url: string): Promise<boolean> {
    this.inflight.add(url)
    const before = this.badges()
    try {
      this.calls++
      const r = await this.run(['pr', 'view', url, '--json', 'state,isDraft,mergedAt,statusCheckRollup,number,url'], { signal: this.abort.signal })
      if (this.stopped) return false
      const now = this.now()
      const prev = this.cache.get(url)
      const status = r.code === 0 ? parsePr(r.stdout, new Date(now).toISOString()) : null
      if (status) {
        this.off = null
        this.rateFails = 0
        const ttl = status.state === 'merged' ? MERGED_TTL_MS : this.store.config.ci.refreshMinutes * MIN
        this.cache.set(url, { status, nextAt: isFinal(status, now) ? null : now + ttl })
        this.changed()
        this.emitDiff(before)
        return true
      }
      const problem: GhProblem = r.code === 0 ? 'other' : classifyGh(r)
      if (problem === 'missing' || problem === 'auth' || problem === 'rate') {
        this.pause(problem, now)
        return false
      }
      // gh answered (no access, or a passing failure): gh itself is there and signed in.
      if (problem === 'access' && this.off?.problem !== 'rate') this.off = null
      const fails = (prev?.fails ?? 0) + 1
      const wait = problem === 'access' ? NO_ACCESS_RETRY : Math.min(RETRY_MIN * 2 ** (fails - 1), RETRY_MAX)
      // A transient failure keeps the last known status; no access drops it (nothing is shown).
      this.cache.set(url, { ...(problem !== 'access' && prev?.status ? { status: prev.status } : {}), nextAt: now + wait, fails, error: problem })
      this.once(problem === 'access'
        ? `CI status: no access to ${prOf(url)?.repo ?? url} with gh`
        : `CI status: gh pr view failed (${(r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 200) || `exit ${r.code}`})`)
      this.changed()
      this.emitDiff(before)
      return true
    } finally {
      this.inflight.delete(url)
    }
  }

  private once(msg: string): void {
    if (this.logged.has(msg)) return
    this.logged.add(msg)
    this.log(`[ci] ${msg}`)
  }

  // ----- live updates -----

  /** Issue id → badge for every issue with a PR link (the state `emitDiff` compares). */
  private badges(): Map<string, CiBadge | undefined> {
    const m = new Map<string, CiBadge | undefined>()
    for (const i of this.store.all()) if (i.links.some((l) => prOf(l.url))) m.set(i.id, ciBadge(this, i))
    return m
  }

  /** Tell clients which rows' badges changed (a `ci` event; null = no badge). */
  private emitDiff(before: Map<string, CiBadge | undefined>): void {
    const after = this.badges()
    const changes: Record<string, CiBadge | null> = {}
    for (const [id, b] of after) {
      const a = before.get(id)
      if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changes[id] = b ?? null
    }
    if (Object.keys(changes).length) this.store.emitCi(changes)
  }

  private onChange(e: ChangeEvent): void {
    if (e.kind === 'meta') {
      // ci.enabled may have changed in config.yml.
      if (this.enabled()) this.kick()
      return
    }
    if (e.kind !== 'issue' || !this.enabled()) return
    const had = new Set(e.prev?.links.map((l) => l.url) ?? [])
    if (e.issue.links.some((l) => prOf(l.url) && !had.has(l.url) && !this.cache.get(l.url)?.status)) this.kick()
  }

  // ----- the cache file -----

  private async load(): Promise<void> {
    const text = await readFile(ciCachePath(this.store.root), 'utf8').catch(() => '')
    if (!text) return
    try {
      const o = JSON.parse(text) as { v?: number; prs?: Record<string, unknown> }
      if (o.v !== CACHE_VERSION || !o.prs || typeof o.prs !== 'object') return
      for (const [url, raw] of Object.entries(o.prs)) {
        const e = prOf(url) ? validEntry(raw) : null
        if (e) this.cache.set(url, e) // a malformed entry is dropped (and checked again)
      }
    } catch {
      this.log('[ci] ignoring an unreadable .tracker/ci.json')
    }
  }

  private changed(): void {
    this.dirty = true
    if (this.timers.save) return
    this.timers.save = setTimeout(() => { this.timers.save = undefined; void this.save() }, this.opts.saveDelayMs ?? 1_000)
  }

  /** Write the cache now; PRs no issue links any more are dropped. */
  async save(): Promise<void> {
    this.dirty = false
    const linked = new Set<string>()
    for (const i of this.store.all()) for (const l of i.links) linked.add(l.url)
    const prs: Record<string, Entry> = {}
    for (const [url, e] of this.cache) if (linked.has(url)) prs[url] = e
    const path = ciCachePath(this.store.root)
    try {
      await mkdir(dirname(path), { recursive: true })
      await atomicWrite(path, JSON.stringify({ v: CACHE_VERSION, prs }))
    } catch (e) {
      this.once(`could not write .tracker/ci.json: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
