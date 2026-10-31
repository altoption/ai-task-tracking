/**
 * Live client: one in-memory copy of the engine's snapshot, kept current by the SSE stream.
 *
 * - `applyEvent` / `fromSnapshot` are pure (tested without a DOM).
 * - `startLive()` connects: EventSource → on open fetch `/api/snapshot` (+ `/api/feed`), replaying
 *   events that arrived meanwhile; reconnects with backoff and re-snapshots on every reconnect.
 * - `useTracker()` reads the store through `useSyncExternalStore`.
 */
import { useSyncExternalStore } from 'react'
import type { Actor, CiBadge, CiStatus, Config, IssueSummary, LabelDef, Project, View } from '../src/model'
import type { FeedEvent } from '../src/engine/eventlog'
import type { AttemptOut } from '../src/engine/attempts'
import type { ThemeOut } from '../src/engine/themes'
import type { HealthInfo } from './settingsModel'

export type { FeedEvent }
/** `favorite: true` in a view's yml (unknown keys pass through the engine's view loader). */
export type ViewDef = View & { favorite?: boolean }
export interface FileError { path: string; message: string }
/** The theme list and the chosen id (`theme` in config.yml); src/server/http.ts `themesOut`. */
export interface ThemesInfo { selected: string; effective?: string; list: ThemeOut[] }

/** Wire form of the engine's ChangeEvent (src/server/http.ts `wireEvent`). */
export type WireEvent =
  | { kind: 'issue'; issue: IssueSummary; prev?: IssueSummary; actor: Actor; comment?: unknown }
  | { kind: 'removed'; id: string; actor: Actor }
  | { kind: 'meta' }
  | { kind: 'error'; path: string; message: string }
  | { kind: 'feed'; event: FeedEvent }
  | { kind: 'ci'; changes: Record<string, CiBadge | null> }
  /** An issue in a hidden project changed (src/server/http.ts `wireEvent`): no summary, only which one and where. */
  | { kind: 'hidden'; id: string; project: string; parent?: string; prevProject?: string; prevParent?: string; rel?: string[] }

/**
 * What the engine left out of the snapshot because its project is hidden (`hiddenProjects` in config.yml): the hidden
 * projects that exist, by name, and their issue ids. Only for direct links (a breadcrumb's name, "in a hidden
 * project" on a link); filters, groups, lists and counts never read it.
 */
export interface HiddenInfo { projects: { slug: string; name: string }[]; issues: ReadonlySet<string> }

export interface Snapshot {
  issues: IssueSummary[]; config: Config | null; labels: LabelDef[]; projects: Project[]; views: ViewDef[]; errors: FileError[]
  themes?: ThemesInfo
  hidden?: { projects: { slug: string; name: string }[]; issues: string[] }
}

export interface TrackerState {
  issues: Map<string, IssueSummary>
  config: Config | null
  labels: LabelDef[]
  projects: Project[]
  views: ViewDef[]
  errors: FileError[]
  /** Null until a snapshot (from an engine that has themes) arrives. */
  themes: ThemesInfo | null
  hidden: HiddenInfo
  /**
   * Per key, how many `hidden` events touched it: the issue id, `p:<project>`, `c:<parent>` (also the project and parent
   * it left) and the ids it newly blocks or relates to. Kept across snapshot reloads. A page showing a hidden
   * issue, its parent, a relation or a hidden project refetches when one of its keys moves (hiddenRevOf), and only then.
   */
  hiddenRevs: ReadonlyMap<string, number>
  /** Newest first. */
  feed: FeedEvent[]
  /** A snapshot has been applied. */
  ready: boolean
  /** Something changed that events don't carry (config/labels/projects/views, cleared file errors): refetch the snapshot. */
  needsSnapshot: boolean
  /** The SSE stream is open. */
  connected: boolean
}

export const FEED_LIMIT = 200

export function emptyState(): TrackerState {
  return {
    issues: new Map(), config: null, labels: [], projects: [], views: [], errors: [], themes: null, hidden: NO_HIDDEN, hiddenRevs: new Map(),
    feed: [], ready: false, needsSnapshot: false, connected: false,
  }
}

const NO_HIDDEN: HiddenInfo = { projects: [], issues: new Set() }

export function fromSnapshot(s: Snapshot, feed: FeedEvent[] = []): TrackerState {
  return {
    issues: new Map(s.issues.map((i) => [i.id, i])),
    config: s.config, labels: s.labels, projects: s.projects, views: s.views, errors: s.errors, themes: s.themes ?? null,
    hidden: s.hidden ? { projects: s.hidden.projects, issues: new Set(s.hidden.issues) } : NO_HIDDEN, hiddenRevs: new Map(),
    feed: feed.slice(0, FEED_LIMIT), ready: true, needsSnapshot: false, connected: false,
  }
}

const isExternal = (a: Actor) => a.workspace === 'external'
const sameFeed = (a: FeedEvent, b: FeedEvent) =>
  a.at === b.at && a.id === b.id && a.kind === b.kind && a.from === b.from && a.to === b.to && a.text === b.text

/**
 * Pure: the state after a snapshot reload. `hiddenRevs` carry over: they only ever go up, so an event replayed after
 * the reload still moves a hidden page's signature.
 */
export function reloaded(state: TrackerState, s: Snapshot, feed: FeedEvent[] = []): TrackerState {
  return { ...fromSnapshot(s, feed), hiddenRevs: state.hiddenRevs, connected: state.connected }
}

/** Pure: the state after one SSE event. Returns the same object when nothing changed. */
export function applyEvent(state: TrackerState, e: WireEvent): TrackerState {
  if (!state.ready) return state
  switch (e.kind) {
    case 'issue': {
      const issues = new Map(state.issues)
      issues.set(e.issue.id, e.issue)
      // A watcher reload of a previously broken file clears its error but events don't say which path: refetch.
      const needsSnapshot = state.needsSnapshot || (state.errors.length > 0 && isExternal(e.actor))
      return { ...state, issues, needsSnapshot, hidden: withoutHidden(state.hidden, e.issue.id) }
    }
    case 'hidden': {
      // Moved into a hidden project (or changed there): the UI drops it and remembers the id for links to it.
      const known = state.hidden.issues.has(e.id)
      const issues = state.issues.has(e.id) ? new Map(state.issues) : state.issues
      if (issues !== state.issues) issues.delete(e.id)
      const hidden = known ? state.hidden : { ...state.hidden, issues: new Set([...state.hidden.issues, e.id]) }
      const hiddenRevs = new Map(state.hiddenRevs)
      const keys = [
        e.id, `p:${e.project}`, ...(e.parent ? [`c:${e.parent}`] : []), ...(e.prevProject ? [`p:${e.prevProject}`] : []),
        ...(e.prevParent ? [`c:${e.prevParent}`] : []), ...(e.rel ?? []),
      ]
      for (const k of keys) hiddenRevs.set(k, (hiddenRevs.get(k) ?? 0) + 1)
      return { ...state, issues, hidden, hiddenRevs }
    }
    case 'removed': {
      const needsSnapshot = state.needsSnapshot || (state.errors.length > 0 && isExternal(e.actor))
      const hidden = withoutHidden(state.hidden, e.id)
      if (!state.issues.has(e.id)) return needsSnapshot === state.needsSnapshot && hidden === state.hidden ? state : { ...state, needsSnapshot, hidden }
      const issues = new Map(state.issues)
      issues.delete(e.id)
      return { ...state, issues, needsSnapshot, hidden }
    }
    case 'meta':
      return state.needsSnapshot ? state : { ...state, needsSnapshot: true }
    case 'error': {
      const errors = state.errors.filter((x) => x.path !== e.path)
      const at = state.errors.findIndex((x) => x.path === e.path)
      errors.splice(at < 0 ? errors.length : at, 0, { path: e.path, message: e.message })
      return { ...state, errors }
    }
    case 'ci': {
      // New CI badges for some rows (null: no badge any more, e.g. CI status turned off).
      let issues: Map<string, IssueSummary> | null = null
      for (const [id, ci] of Object.entries(e.changes)) {
        const cur = (issues ?? state.issues).get(id)
        if (!cur) continue
        issues ??= new Map(state.issues)
        const { ci: _old, ...rest } = cur
        issues.set(id, ci ? { ...rest, ci } : rest)
      }
      return issues ? { ...state, issues } : state
    }
    case 'feed': {
      // Events replayed after a snapshot may already be in the fetched feed.
      if (state.feed.slice(0, 20).some((f) => sameFeed(f, e.event))) return state
      return { ...state, feed: [e.event, ...state.feed].slice(0, FEED_LIMIT) }
    }
    default:
      return state
  }
}

function withoutHidden(h: HiddenInfo, id: string): HiddenInfo {
  if (!h.issues.has(id)) return h
  const issues = new Set(h.issues)
  issues.delete(id)
  return { ...h, issues }
}

/** Pure: a signature of the `hidden` events that touched these keys (see `hiddenRevs`); changes only when one did. */
export function hiddenRevOf(state: Pick<TrackerState, 'hiddenRevs'>, keys: Iterable<string>): string {
  let out = ''
  for (const k of keys) { const n = state.hiddenRevs.get(k); if (n) out += `${k}:${n},` }
  return out
}

/** Pure: is this project slug hidden (`hiddenProjects` in config.yml)? */
export function isHiddenProject(state: Pick<TrackerState, 'config'>, slug: string): boolean {
  return !!state.config?.hiddenProjects?.includes(slug)
}

/** Pure: a project's name for a link, hidden or not (the slug when unknown). */
export function projectName(state: Pick<TrackerState, 'projects' | 'hidden'>, slug: string): string {
  return state.projects.find((p) => p.slug === slug)?.name ?? state.hidden.projects.find((p) => p.slug === slug)?.name ?? slug
}

/** The `_none` folder holds issues without a project; it is not listed as a project. */
export const NO_PROJECT = '_none'
/** Pure: projects to list in the sidebar, switcher and pickers — real projects, by name. */
export function listedProjects(projects: Project[]): Project[] {
  return projects.filter((p) => p.slug !== NO_PROJECT).sort((a, b) => a.name.localeCompare(b.name))
}

// ---------- workspace / project scope (sidebar switcher) ----------

export type Scope = { kind: 'all' } | { kind: 'workspace'; name: string } | { kind: 'project'; slug: string }

/** Pure: does the issue belong to the scope? A workspace covers its mapped project plus every issue it ever wrote to (owner edits never remove an issue from a scope). */
export function inScope(i: Pick<IssueSummary, 'project' | 'workspaces'>, scope: Scope, config: Pick<Config, 'workspaces'> | null): boolean {
  if (scope.kind === 'all') return true
  if (scope.kind === 'project') return i.project === scope.slug
  const mapped = config?.workspaces[scope.name]
  return (mapped !== undefined && i.project === mapped) || i.workspaces.includes(scope.name)
}

const SCOPE_KEY = 'tracker.scope'
function readScope(): Scope {
  try {
    const raw = globalThis.localStorage?.getItem(SCOPE_KEY)
    const s = raw ? (JSON.parse(raw) as Scope) : null
    if (s && (s.kind === 'all' || (s.kind === 'workspace' && typeof s.name === 'string') || (s.kind === 'project' && typeof s.slug === 'string'))) return s
  } catch { /* storage blocked or bad JSON */ }
  return { kind: 'all' }
}
let scope: Scope = readScope()
const scopeSubs = new Set<() => void>()
export function setScope(next: Scope): void {
  scope = next
  try { globalThis.localStorage?.setItem(SCOPE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
  scopeSubs.forEach((f) => f())
}
export function useScope(): Scope {
  return useSyncExternalStore((f) => { scopeSubs.add(f); return () => { scopeSubs.delete(f) } }, () => scope)
}

// ---------- the live store ----------

let state: TrackerState = emptyState()
const subs = new Set<() => void>()
let notifyQueued = false

function set(next: TrackerState) {
  if (next === state) return
  state = next
  if (notifyQueued) return
  notifyQueued = true
  queueMicrotask(() => { notifyQueued = false; subs.forEach((f) => f()) }) // coalesce bursts of events into one render
}

export function getState(): TrackerState { return state }
export function subscribe(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}
export function useTracker(): TrackerState {
  return useSyncExternalStore(subscribe, getState)
}

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(path)
  const body = (await r.json().catch(() => ({}))) as T & { error?: string }
  if (!r.ok) throw new Error(body.error ?? `${path} failed (${r.status})`)
  return body
}

/** Call an engine tool as the owner (actor `you`). Throws with the engine's message on failure. */
export async function callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch(`/api/tool/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Tracker': '1' },
    body: JSON.stringify({ args }),
  })
  const body = (await r.json().catch(() => ({}))) as T & { error?: string }
  if (!r.ok) throw new Error(body.error ?? `${name} failed (${r.status})`)
  return body
}

/** Choose the UI theme (POST /api/theme, the owner's). Every open UI follows through the `meta` event. */
export async function setTheme(id: string): Promise<void> {
  const r = await ownerPost('/api/theme', { theme: id })
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `setting the theme failed (${r.status})`)
}

/** Hide or unhide a project folder in the UIs (POST /api/hidden-projects, the owner's). Every open UI follows through `meta`. */
export async function setProjectHidden(slug: string, hidden: boolean): Promise<void> {
  const r = await ownerPost('/api/hidden-projects', { project: slug, hidden })
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `${hidden ? 'hiding' : 'unhiding'} the project failed (${r.status})`)
}

/** No reply at all is the engine being away: browsers word that as "Failed to fetch" or "Load failed". */
const ownerPost = (path: string, body: unknown): Promise<Response> => fetch(path, {
  method: 'POST', headers: { 'content-type': 'application/json', 'X-Tracker': '1' }, body: JSON.stringify(body),
}).catch(() => { throw new Error('The engine isn\'t answering') })

/** `/api/health`, for the Settings page's status strip. */
export function getHealth(): Promise<HealthInfo> {
  return getJSON<HealthInfo>('/api/health')
}

/** `/api/projects/:slug`: one project by its link, hidden or not, with its issues. */
export interface ProjectDetail { project: Project; hidden: boolean; issues: IssueSummary[] }
export function getProject(slug: string): Promise<ProjectDetail> {
  return getJSON<ProjectDetail>(`/api/projects/${encodeURIComponent(slug)}`)
}

export interface ActivityEntry { at: string; actor: string; workspace?: string; branch?: string; body: string }
/** `/api/issues/:id`: the full issue plus children, ancestors (nearest first) and the issues it blocks. */
/** A hidden issue linked from a visible one's page (a child or an ancestor): only its id. */
export interface HiddenStub { id: string; hidden: true }
export const isStub = (x: IssueSummary | HiddenStub): x is HiddenStub => 'hidden' in x && x.hidden === true
export type IssueDetail = Omit<IssueSummary, 'childCount' | 'progress'> & {
  description: string; activity: ActivityEntry[]; extra: Record<string, unknown>; url: string
  /** A visible issue's hidden children and ancestors are stubs; a hidden issue (opened by its link) gets them all. */
  children: (IssueSummary | HiddenStub)[]; ancestors: (IssueSummary | HiddenStub)[]
  /** PR url → its CI status, when CI status is on and known (src/engine/ci.ts). */
  ci?: Record<string, CiStatus>
  /** PR url → why it has no CI status ("no access with gh"). */
  ciProblems?: Record<string, string>
  /** One per agent session that worked on it, oldest first (src/engine/attempts.ts). */
  attempts?: AttemptOut[]
}
export function getIssue(id: string): Promise<IssueDetail> {
  return getJSON<IssueDetail>(`/api/issues/${encodeURIComponent(id)}`)
}
/** Field-change history of one issue, newest first. */
export function getIssueFeed(id: string, limit = 500): Promise<FeedEvent[]> {
  return getJSON<FeedEvent[]>(`/api/feed?id=${encodeURIComponent(id)}&limit=${limit}`)
}
export function searchIssues(q: string): Promise<IssueSummary[]> {
  return getJSON<IssueSummary[]>(`/api/search?q=${encodeURIComponent(q)}`)
}

let started = false
let queue: WireEvent[] | null = null // events that arrive while a snapshot is in flight
let snapshotting = false
let snapshotAgain = false
let backoff = 500
let snapshotTimer: ReturnType<typeof setTimeout> | undefined

async function loadSnapshot(): Promise<void> {
  if (snapshotting) { snapshotAgain = true; return }
  snapshotting = true
  queue = []
  try {
    const [snap, feed] = await Promise.all([getJSON<Snapshot>('/api/snapshot'), getJSON<FeedEvent[]>(`/api/feed?limit=${FEED_LIMIT}`)])
    let next = reloaded(state, snap, feed)
    for (const e of queue) next = applyEvent(next, e)
    queue = null
    set(next)
    snapshotting = false
    if (snapshotAgain || next.needsSnapshot) { snapshotAgain = false; scheduleSnapshot() }
  } catch {
    // Keep showing the last good state; try again shortly (the SSE reconnect also re-snapshots).
    const pending = queue ?? []
    queue = null
    snapshotting = false
    for (const e of pending) set(applyEvent(state, e))
    snapshotTimer = setTimeout(() => void loadSnapshot(), backoff)
  }
}

function scheduleSnapshot(delay = 50) {
  if (snapshotTimer) clearTimeout(snapshotTimer)
  snapshotTimer = setTimeout(() => { snapshotTimer = undefined; void loadSnapshot() }, delay)
}

function connect() {
  const es = new EventSource('/api/events')
  es.onopen = () => {
    backoff = 500
    set({ ...state, connected: true })
    void loadSnapshot() // first connect and every reconnect: events may have been missed
  }
  es.onmessage = (m: MessageEvent<string>) => {
    let e: WireEvent
    try { e = JSON.parse(m.data) as WireEvent } catch { return }
    if (queue) { queue.push(e); return }
    set(applyEvent(state, e))
    if (state.needsSnapshot) scheduleSnapshot()
  }
  es.onerror = () => {
    es.close()
    set({ ...state, connected: false })
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 10_000)
  }
}

/** Start the live connection once (browser only). */
export function startLive(): void {
  if (started) return
  started = true
  connect()
}
