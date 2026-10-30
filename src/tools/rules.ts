import type { Actor, LabelDef, Link, Project, StatusDef } from '../model'
import type { Store } from '../engine/store'

/**
 * Agent rules for the tool layer (spec §7.4). Pure helpers plus the in-memory "recent comment"
 * memory for rule 3. Every error message says what is wrong, how to fix it, and shows a valid call.
 */

/** An error whose message is written for the calling agent. `data` carries structured details. */
export class ToolError extends Error {
  constructor(message: string, readonly data?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ToolError'
  }
}

export const normId = (id: string) => id.trim().toUpperCase()
const lc = (s: string) => s.trim().toLowerCase()
const list = (xs: string[]) => xs.join(', ')

// ---------- rule 1: project resolution ----------

/** Project by slug or name (case-insensitive). */
export function findProject(s: Store, q: string): Project | undefined {
  const k = lc(q)
  return s.projects.get(q) ?? [...s.projects.values()].find((p) => p.slug === k || lc(p.name) === k)
}

export function mustProject(s: Store, q: string): Project {
  const p = findProject(s, q)
  if (!p) {
    const names = [...s.projects.values()].map((x) => `"${x.name}"`).sort()
    throw new ToolError(`Unknown project "${q}". Existing projects: ${list(names)}. Use one of them, or create it first: save_project({ name: "${q}" }).`)
  }
  return p
}

/**
 * Where a new issue goes when `project` is omitted: the project mapped to the actor's workspace,
 * or `{ auto }` meaning "create a project named after the workspace and map it".
 */
export function projectForCreate(s: Store, actor: Actor): { slug: string } | { auto: string } {
  const ws = actor.workspace
  if (ws) {
    const mapped = s.config.workspaces[ws]
    if (mapped && s.projects.has(mapped)) return { slug: mapped }
    return { auto: ws }
  }
  const names = [...s.projects.values()].map((p) => p.name).sort()
  throw new ToolError(`New issues need a project. Pass project, e.g. save_issue({ title: "Fix login", project: "${names[0] ?? 'Support'}", labels: ["Bug"] }). Projects: ${list(names)} (see list_projects).`)
}

// ---------- rule 2: labels ----------

/**
 * Resolve a label name: exact full name (case-insensitive), else a bare name matching exactly one
 * grouped label's suffix ("Docs" -> "Scope/Docs"). null when unknown.
 */
export function resolveLabel(labels: LabelDef[], name: string): string | null {
  const k = lc(name)
  const exact = labels.find((l) => lc(l.name) === k)
  if (exact) return exact.name
  const bare = labels.filter((l) => l.group && lc(l.name.slice(l.group.length + 1)) === k)
  if (bare.length === 1) return bare[0]!.name
  if (bare.length > 1) {
    throw new ToolError(`Label "${name}" is ambiguous: ${list(bare.map((l) => l.name))}. Pass the full name, e.g. labels: ["${bare[0]!.name}"].`)
  }
  return null
}

export function noLabelsError(s: Store): ToolError {
  return new ToolError(`Add at least one label, e.g. labels: ['Feature']. Existing labels: ${list(s.labels.map((l) => l.name))}.`)
}

/** A label definition for a name that doesn't exist yet ('A/B' gets group 'A', as labels.yml would read it). */
export function newLabel(name: string): LabelDef {
  const slash = name.indexOf('/')
  return { name, group: slash > 0 ? name.slice(0, slash) : null, color: '#95a2b3' }
}

// ---------- statuses ----------

export function resolveStatus(s: Store, name: string): StatusDef {
  const st = s.config.statuses.find((x) => lc(x.name) === lc(name))
  if (!st) {
    throw new ToolError(`Unknown state "${name}". Valid states: ${list(s.config.statuses.map((x) => x.name))}. Example: save_issue({ id: "ENG-27", state: "In Progress" })`)
  }
  return st
}

export function statusType(s: Store, name: string): StatusDef['type'] | undefined {
  return s.config.statuses.find((x) => x.name === name)?.type
}

// ---------- rule 3: explanation for closing / waiting ----------

export const EXPLAIN_WINDOW_MS = 10 * 60_000
const recent = new WeakMap<Store, Map<string, number>>()

/** Remember that `session` commented on `issueId` at `at` (ms). Sessionless comments are not remembered. */
export function noteExplanation(s: Store, issueId: string, session: string | undefined, at = Date.now()): void {
  if (!session) return
  let m = recent.get(s)
  if (!m) recent.set(s, (m = new Map()))
  m.set(`${issueId}|${session}`, at)
  if (m.size > 5000) for (const [k, t] of m) if (Date.now() - t > EXPLAIN_WINDOW_MS) m.delete(k)
}

export function hasRecentExplanation(s: Store, issueId: string, session: string | undefined, now = Date.now()): boolean {
  if (!session) return false
  const t = recent.get(s)?.get(`${issueId}|${session}`)
  return t !== undefined && now - t <= EXPLAIN_WINDOW_MS
}

/** Completed, canceled and duplicate statuses, and Waiting, need an explanation. */
export function needsExplanation(st: StatusDef): boolean {
  return st.type === 'completed' || st.type === 'canceled' || st.type === 'duplicate' || lc(st.name) === 'waiting'
}

export function explanationError(id: string | undefined, state: string): ToolError {
  const what = lc(state) === 'waiting' ? 'what it is waiting on' : 'what shipped and where (PR/commit), or why'
  const subject = id ? `Moving ${id} to ${state}` : `Creating an issue in ${state}`
  const example = id ? `save_issue({ id: "${id}", state: "${state}", comment: "Shipped in PR #1414" })` : `save_issue({ title: "…", labels: ["Task"], state: "${state}", comment: "Shipped in PR #1414" })`
  return new ToolError(`${subject} needs an explanation. Pass comment saying ${what}, e.g. ${example}.`)
}

// ---------- rule 4: cycles ----------

/**
 * If `self`'s parent became `parent`, would the parent chain loop? Returns the cycle as
 * [self, parent, ..., self] (each points to its parent), or null.
 */
export function parentCycle(self: string, parent: string, parentOf: (k: string) => string | null): string[] | null {
  const path = [self]
  const seen = new Set<string>()
  for (let cur: string | null = parent; cur !== null && !seen.has(cur); cur = parentOf(cur)) {
    path.push(cur)
    if (cur === self) return path
    seen.add(cur)
  }
  return null
}

/**
 * If `self` became blocked by `blocker`, would blocked_by loop? Returns [self, blocker, ..., self]
 * (each is blocked by the next), or null. Depth-first, cycle-safe.
 */
export function blockCycle(self: string, blocker: string, blockersOf: (k: string) => string[]): string[] | null {
  if (blocker === self) return [self, self]
  const seen = new Set<string>()
  const dfs = (k: string, path: string[]): string[] | null => {
    if (k === self) return path
    if (seen.has(k)) return null
    seen.add(k)
    for (const b of blockersOf(k)) {
      const found = dfs(b, [...path, b])
      if (found) return found
    }
    return null
  }
  return dfs(blocker, [self, blocker])
}

export function cycleError(kind: 'parent' | 'blockedBy', self: string, cycle: string[]): ToolError {
  const chain = cycle.join(' → ')
  if (kind === 'parent') {
    return new ToolError(`Setting parentId of ${self} to ${cycle[1]} would create a cycle: ${chain} (each arrow points to a parent). Pick a parent outside ${self}'s subtree, or clear it: save_issue({ id: "${self}", parentId: null }).`)
  }
  return new ToolError(`Making ${self} blocked by ${cycle[1]} would create a cycle: ${chain} (each is blocked by the next). Remove one link, e.g. save_issue({ id: "${self}", blockedBy: [] }).`)
}

export function unknownIdsError(ids: string[], field: string): ToolError {
  return new ToolError(`Unknown issue ids in ${field}: ${list(ids)}. Check them with get_issue({ id }) or search({ query }); in save_issues use "ref:<ref>" for items created in the same call.`)
}

// ---------- rule 5: owner-only actions ----------

export function assertCanDelete(actor: Actor, id: string): void {
  if (actor.actor !== 'you') {
    throw new ToolError(`Agents cannot delete issues. Cancel it instead: save_issue({ id: "${id}", state: "Canceled", comment: "Why it is no longer needed" }).`)
  }
}

export function assertOwner(actor: Actor, what: string): void {
  if (actor.actor !== 'you') throw new ToolError(`${what} is for the owner only (from the AI Task Tracking app); agents cannot do it. Use list_issues or search to read issues instead.`)
}

export function assertCanPlan(actor: Actor, id: string, plan: string | null): void {
  if (actor.actor !== 'you' && plan !== 'now') {
    throw new ToolError(`Only the owner moves issues between Next and Later. Agents may only set now, e.g. set_plan({ id: "${id}", plan: "now" }).`)
  }
}

// ---------- rule 6: GitHub links ----------

const GH = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull\/(\d+)|commit\/([0-9a-f]{7,40})|tree\/([^\s)\]>"'`]+))/gi

/** GitHub PR / commit / branch URLs in `text`, normalized and deduplicated, in order of appearance. */
export function extractLinks(text: string | undefined): Link[] {
  if (!text) return []
  const out: Link[] = []
  for (const m of text.matchAll(GH)) {
    const [, owner, repo, , pr, sha, branchRaw] = m
    const base = `https://github.com/${owner}/${repo}`
    let link: Link
    if (pr) link = { title: `PR #${pr}`, url: `${base}/pull/${pr}` }
    else if (sha) link = { title: `Commit ${sha.slice(0, 7)}`, url: `${base}/commit/${sha}` }
    else {
      const branch = branchRaw!.replace(/[.,;:!?]+$/, '')
      link = { title: `Branch ${branch}`, url: `${base}/tree/${branch}` }
    }
    if (!out.some((l) => l.url === link.url)) out.push(link)
  }
  return out
}

/** `existing` plus `add`, skipping urls already present. */
export function mergeLinks(existing: Link[], add: Link[]): Link[] {
  const out = [...existing]
  for (const l of add) if (!out.some((x) => x.url === l.url)) out.push(l)
  return out
}
