import type { z } from 'zod'
import type { Actor, Filter, Issue, Project, View } from '../model'
import { ancestors, filterIssues, home, progress, search, stalledOf, subtree, writerWorkspaces, type Tree } from '../engine/queries'
import type { Store } from '../engine/store'
import { issueCi } from '../engine/ci'
import { attemptsBrief, attemptsOf } from '../engine/attempts'
import { handoffOf } from '../engine/handoff'
import { workingStatus } from '../engine/stalled'
import { ciReasonOf } from '../engine/ci'
import { saveIssue, saveIssues } from './issueWrites'
import { taskAt, taskLines, toggleTask } from '../shared/tasks'
import {
  assertCanDelete, assertCanPlan, assertOwner, extractLinks, findProject, mergeLinks, mustProject, normId, noteExplanation,
  resolveLabel, resolveStatus, ToolError,
} from './rules'
import { type ToolArgs, type ToolName, toolSchemas } from './schemas'

export { ToolError } from './rules'

/** Who is calling. The MCP proxy fills workspace/branch/session/client for agents; the UI passes { actor: 'you' }. */
export interface ToolCtx { actor: Actor }

type Args<K extends ToolName> = ToolArgs<K>
type Handler = (s: Store, args: any, ctx: ToolCtx) => Promise<unknown> | unknown

const CLOSED = new Set(['completed', 'canceled', 'duplicate'])
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled'

// ---------- output shapes ----------

export const issueUrl = (s: Store, id: string) => `http://127.0.0.1:${s.port}/#/issue/${id}`
/** Opens the issue in the AI Task Tracking app (it registers the `aitt` URL scheme). */
export const issueAppUrl = (id: string) => `aitt://issue/${encodeURIComponent(id)}`

/** The issue model minus `path` (and the parser's hidden source), plus its UI and app urls. */
export function issueOut(s: Store, i: Issue): Record<string, unknown> {
  const { path: _path, ...rest } = i
  return { ...rest, url: issueUrl(s, i.id), appUrl: issueAppUrl(i.id) }
}

/** Compact shape for list_issues and search (no description or activity; get_issue has those). */
export function issueBrief(s: Store, i: Issue) {
  return {
    id: i.id, title: i.title, status: i.status, priority: i.priority, labels: i.labels, project: i.project,
    parent: i.parent, blockedBy: i.blockedBy, milestone: i.milestone, due: i.due, plan: i.plan, updated: i.updated,
    url: issueUrl(s, i.id), appUrl: issueAppUrl(i.id), childCount: s.children(i.id).length,
  }
}

const brief = (s: Store, i: Issue) => ({
  id: i.id, title: i.title, status: i.status, priority: i.priority, project: i.project, url: issueUrl(s, i.id), appUrl: issueAppUrl(i.id),
})

function mustIssue(s: Store, raw: string): Issue {
  const i = s.get(normId(raw))
  if (!i) throw new ToolError(`Issue ${raw} not found. Find ids with search({ query: "words from the title" }) or list_issues({}).`)
  return i
}

function isClosed(s: Store, i: Issue): boolean {
  const t = s.config.statuses.find((x) => x.name === i.status)?.type
  return !!t && CLOSED.has(t)
}

function projectOut(s: Store, p: Project) {
  const issues = s.all().filter((i) => i.project === p.slug)
  return {
    slug: p.slug, name: p.name, key: p.key, status: p.status, ...(p.color ? { color: p.color } : {}),
    openIssues: issues.filter((i) => !isClosed(s, i)).length, totalIssues: issues.length,
  }
}

function milestoneOut(s: Store, p: Project, m: Project['milestones'][number]) {
  const issues = s.all().filter((i) => i.project === p.slug && i.milestone === m.name)
  return {
    name: m.name, ...(m.description !== undefined ? { description: m.description } : {}),
    ...(m.target !== undefined ? { targetDate: m.target } : {}),
    progress: { done: issues.filter((i) => isClosed(s, i)).length, total: issues.length },
  }
}

const docId = (p: Project, slug: string) => `${p.slug}/${slug}`

/** whats_next lists at most this many of the caller's stalled issues (they also stay in their usual bucket, with a `stalled` reason). */
const STALLED_SHOWN = 5

const withAttempts = <T>(a: T | null) => (a ? { attempts: a } : {})

// ---------- cursor ----------

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url')
function decodeCursor(c: string): number {
  try {
    const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')).o
    if (Number.isInteger(o) && o >= 0) return o
  } catch {}
  throw new ToolError('Invalid cursor. Pass the nextCursor value from the previous list_issues result unchanged, or omit cursor to start over.')
}

/** ISO date/time, or an ISO-8601 duration relative to now ("-P7D", "P2W", "-PT12H"). */
function since(v: string): string {
  const m = /^-?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i.exec(v.trim())
  if (m && v.trim().length > 2) {
    const [, w, d, h, min] = m.map((x) => Number(x ?? 0))
    return new Date(Date.now() - ((((w! * 7 + d!) * 24 + h!) * 60 + min!) * 60_000)).toISOString()
  }
  if (Number.isNaN(Date.parse(v))) throw new ToolError(`updatedAt "${v}" is not a date or duration. Examples: updatedAt: "2026-10-01" or updatedAt: "-P7D" (last 7 days).`)
  return v
}

// ---------- handlers ----------

const handlers: Record<string, Handler> = {
  async save_issue(s, a: Args<'save_issue'>, { actor }) {
    return issueOut(s, await saveIssue(s, a, actor))
  },

  async save_issues(s, a: Args<'save_issues'>, { actor }) {
    const done = await saveIssues(s, a.issues, actor)
    return { issues: done.map((d) => ({ ...issueOut(s, d.issue), ...(d.ref ? { ref: d.ref } : {}) })) }
  },

  get_issue(s, a: Args<'get_issue'>, ctx: ToolCtx) {
    const i = mustIssue(s, a.id)
    const now = Date.now()
    const stalled = stalledOf(s, now)(i)
    const attempts = attemptsOf(s, i)
    // Opening In Progress work: where the last session stopped, first.
    const handoff = handoffOf(i, {
      working: workingStatus(s.config.statuses, s.config.needsYou.statuses), attempts, stalled,
      openBlockers: i.blockedBy.filter((b) => { const x = s.get(b); return !!x && !isClosed(s, x) }),
      ci: ciReasonOf(s, now)(i),
      // The proxy puts the agent's session in the actor: the session that worked last gets no handoff.
      ...(ctx.actor.actor === 'agent' && ctx.actor.session ? { caller: ctx.actor.session } : {}),
    })
    // Per PR link with a known CI status: ci { state, checks, failing (up to 3 check names) }.
    const ci = new Map(issueCi(s.ci, i).map((x) => [x.url, x.status]))
    const links = ci.size
      ? i.links.map((l) => {
        const c = ci.get(l.url)
        return c ? { ...l, ci: { state: c.state, checks: c.checks, failing: c.failing } } : l
      })
      : i.links
    return {
      ...(handoff ? { handoff } : {}),
      ...issueOut(s, i),
      links,
      children: s.children(i.id).map((c) => c.id),
      blocks: s.blocks(i.id),
      ancestors: ancestors(s, i.id).map((x) => x.id),
      progress: progress(s, i.id),
      ...(stalled ? { stalled } : {}),
      ...withAttempts(attemptsBrief(attempts)),
    }
  },

  list_issues(s, a: Args<'list_issues'>) {
    const f: Filter = {}
    if (a.state) f.status = [resolveStatus(s, a.state).name]
    if (a.project) f.project = [mustProject(s, a.project).slug]
    if (a.label) f.labels = [resolveLabel(s.labels, a.label) ?? a.label]
    if (a.parentId) f.parent = normId(a.parentId)
    if (a.query) f.query = a.query
    if (a.updatedAt) f.updatedAfter = since(a.updatedAt)
    if (a.includeArchived) f.includeDone = true
    const all = filterIssues(s, f).sort((x, y) => (x.updated < y.updated ? 1 : x.updated > y.updated ? -1 : 0))
    const offset = a.cursor ? decodeCursor(a.cursor) : 0
    const limit = a.limit ?? 50
    const page = all.slice(offset, offset + limit)
    return {
      issues: page.map((i) => issueBrief(s, i)),
      ...(offset + limit < all.length ? { nextCursor: encodeCursor(offset + limit) } : {}),
    }
  },

  async save_comment(s, a: Args<'save_comment'>, { actor }) {
    const issue = mustIssue(s, a.issueId)
    const entry = await s.addComment(issue.id, a.body, actor)
    noteExplanation(s, issue.id, actor.session)
    const found = extractLinks(a.body)
    if (found.length) {
      await s.updateIssue(issue.id, (cur) => {
        const links = mergeLinks(cur.links, found)
        return links.length !== cur.links.length ? { links } : null
      }, actor)
    }
    return { issueId: issue.id, ...entry, url: issueUrl(s, issue.id), appUrl: issueAppUrl(issue.id) }
  },

  list_comments(s, a: Args<'list_comments'>) {
    const i = mustIssue(s, a.issueId)
    return { issueId: i.id, comments: i.activity }
  },

  list_projects(s) {
    return { projects: [...s.projects.values()].sort((x, y) => x.name.localeCompare(y.name)).map((p) => projectOut(s, p)) }
  },

  get_project(s, a: Args<'get_project'>) {
    const p = mustProject(s, a.query)
    return {
      ...projectOut(s, p), description: p.description, repos: p.repos,
      workspaces: Object.entries(s.config.workspaces).filter(([, slug]) => slug === p.slug).map(([ws]) => ws),
      milestones: p.milestones.map((m) => milestoneOut(s, p, m)),
      documents: p.docs.map((d) => ({ id: docId(p, d.slug), title: d.title })),
    }
  },

  async save_project(s, a: Args<'save_project'>) {
    let slug: string | undefined
    let name = a.name
    if (a.id) {
      const cur = findProject(s, a.id)
      if (!cur) throw new ToolError(`Project "${a.id}" not found. Omit id to create it: save_project({ name: "${a.name ?? a.id}" }), or see list_projects.`)
      slug = cur.slug
      name ??= cur.name
    }
    if (!name) throw new ToolError('save_project needs name to create a project, or id to update one. Examples: save_project({ name: "Website" }), save_project({ id: "website", state: "Completed" })')
    const p = await s.upsertProject({
      name, ...(slug ? { slug } : {}),
      ...(a.description !== undefined ? { description: a.description } : {}), ...(a.state !== undefined ? { status: a.state } : {}),
    }, (cur) => {
      if (cur && a.name !== undefined) {
        const lower = a.name.toLowerCase()
        const clash = [...s.projects.values()].find((x) => x.slug !== cur.slug && x.name.toLowerCase() === lower)
        if (clash) throw new ToolError(`Another project is already named "${clash.name}" (id ${clash.slug}). Pick a different name; nothing was changed.`)
      }
      if (a.baseDescription !== undefined && cur && a.baseDescription !== cur.description) {
        throw new ToolError(`The project description changed since you started editing (someone saved a newer version of "${cur.name}"). Reload to see it, then re-apply your edit; your text was not saved.`)
      }
    })
    return { ...projectOut(s, p), description: p.description }
  },

  list_issue_statuses(s) {
    return { statuses: s.config.statuses.map((x) => ({ name: x.name, type: x.type, color: x.color })) }
  },

  list_issue_labels(s) {
    return { labels: s.labels.map((l) => ({ name: l.name, group: l.group, color: l.color })) }
  },

  async save_issue_label(s, a: Args<'save_issue_label'>) {
    const group = a.parent?.trim() || null
    const name = group && !a.name.startsWith(`${group}/`) ? `${group}/${a.name}` : a.name
    const existing = s.labels.find((l) => l.name.toLowerCase() === name.toLowerCase())
    const def = {
      name: existing?.name ?? name,
      group: group ?? existing?.group ?? (name.includes('/') ? name.slice(0, name.indexOf('/')) : null),
      color: a.color ?? existing?.color ?? '#95a2b3',
    }
    await s.upsertLabel(def)
    return def
  },

  list_milestones(s, a: Args<'list_milestones'>) {
    const p = mustProject(s, a.project)
    return { project: p.slug, milestones: p.milestones.map((m) => milestoneOut(s, p, m)) }
  },

  async save_milestone(s, a: Args<'save_milestone'>) {
    const p = mustProject(s, a.project)
    const next = await s.upsertMilestone(p.slug, {
      name: a.name.trim(),
      ...(a.description !== undefined ? { description: a.description } : {}),
      ...(a.targetDate !== undefined ? { target: a.targetDate } : {}),
    })
    const m = next.milestones.find((x) => x.name.toLowerCase() === a.name.trim().toLowerCase())!
    return { project: p.slug, ...milestoneOut(s, next, m) }
  },

  async save_document(s, a: Args<'save_document'>) {
    const p = mustProject(s, a.project)
    if (!a.id) {
      const { slug } = await s.createDocument(p.slug, slugify(a.title), { title: a.title, content: a.content })
      return { id: docId(p, slug), project: p.slug, title: a.title }
    }
    const raw = a.id.includes('/') ? a.id.slice(a.id.indexOf('/') + 1) : a.id
    if (a.id.includes('/') && a.id.slice(0, a.id.indexOf('/')) !== p.slug) {
      throw new ToolError(`Document ${a.id} belongs to another project. Pass project: "${a.id.slice(0, a.id.indexOf('/'))}", or omit id to create a new document in "${p.name}".`)
    }
    const slug = slugify(raw)
    await s.upsertDocument(p.slug, { slug, title: a.title, content: a.content }, (cur) => {
      if (a.baseContent !== undefined && cur && a.baseContent !== cur.content) {
        throw new ToolError(`The document changed since you started editing (someone saved a newer version of ${docId(p, slug)}). Reload to see it, then re-apply your edit; your text was not saved.`)
      }
    })
    return { id: docId(p, slug), project: p.slug, title: a.title }
  },

  get_document(s, a: Args<'get_document'>) {
    const q = a.id.trim()
    const hits: { p: Project; d: Project['docs'][number] }[] = []
    for (const p of s.projects.values()) {
      for (const d of p.docs) {
        if (docId(p, d.slug) === q || d.slug === q || d.title.toLowerCase() === q.toLowerCase()) hits.push({ p, d })
      }
    }
    if (hits.length !== 1) {
      const all = [...s.projects.values()].flatMap((p) => p.docs.map((d) => `${docId(p, d.slug)} ("${d.title}")`))
      const why = hits.length ? `"${q}" matches several documents` : `Document "${q}" not found`
      throw new ToolError(`${why}. Pass a full id like get_document({ id: "${all[0]?.split(' ')[0] ?? 'project/doc'}" }). Documents: ${all.join(', ') || '(none)'}.`)
    }
    const { p, d } = hits[0]!
    return { id: docId(p, d.slug), project: p.slug, title: d.title, content: d.content }
  },

  list_teams(s) {
    const byKey = new Map<string, string[]>()
    for (const p of s.projects.values()) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p.name])
    return {
      teams: [...byKey].sort(([x], [y]) => x.localeCompare(y)).map(([key, names]) => ({ id: key, key, name: key, projects: names.sort() })),
    }
  },

  search(s, a: Args<'search'>) {
    return { issues: search(s, a.query, a.limit ?? 20).map((i) => issueBrief(s, i)) }
  },

  whats_next(s, _a, { actor }) {
    // needsYou keeps its meaning (waiting on the user): stalled issues stay in their bucket, marked `stalled: <why>`.
    const h = home(s, Date.now(), { stalledInNeedsYou: false })
    const mark = (i: Issue) => {
      const why = h.stalled.get(i.id)
      const ci = h.ci.get(i.id)
      return { ...brief(s, i), ...(why ? { stalled: why } : {}), ...(ci ? { ci } : {}) }
    }
    // The caller's own stalled work: issues its workspace wrote to (touched_by, comments or logged writes).
    const ws = actor.workspace
    const mine = ws && ws !== 'external'
      ? [...h.inProgress, ...h.needsYou, ...h.readyNext.map((r) => r.issue)]
        .filter((i) => h.stalled.has(i.id) && (writerWorkspaces(i).includes(ws) || s.historyWorkspaces(i.id).has(ws)))
      : []
    return {
      ...(mine.length ? { stalled: mine.slice(0, STALLED_SHOWN).map((i) => ({ ...brief(s, i), why: h.stalled.get(i.id)! })) } : {}),
      needsYou: h.needsYou.map(mark),
      inProgress: h.inProgress.map(mark),
      readyNext: h.readyNext.map((r) => ({ ...mark(r.issue), unblocks: r.unblocks })),
      blocked: h.blocked.map((b) => ({ ...brief(s, b.issue), blockers: b.blockers })),
    }
  },

  get_tree(s, a: Args<'get_tree'>) {
    const root = mustIssue(s, a.id)
    const node = (t: Tree): Record<string, unknown> => ({
      ...brief(s, t.issue), blockedBy: t.issue.blockedBy, children: t.children.map(node),
      ...(t.children.length ? { progress: progress(s, t.issue.id) } : {}),
    })
    return { ...node(subtree(s, root.id)), progress: progress(s, root.id) }
  },

  async set_plan(s, a: Args<'set_plan'>, { actor }) {
    const i = mustIssue(s, a.id)
    assertCanPlan(actor, i.id, a.plan)
    return issueOut(s, await s.updateIssue(i.id, { plan: a.plan }, actor))
  },

  async toggle_task(s, a: Args<'toggle_task'>, { actor }) {
    const i = mustIssue(s, a.id)
    // Checked against the fresh file inside the issue's write queue: a stale view can't flip the wrong item.
    const out = await s.updateIssue(i.id, (cur) => {
      const t = taskAt(cur.description, a.index)
      if (!t) {
        const n = taskLines(cur.description).length
        throw new ToolError(n
          ? `${i.id} has no checklist item ${a.index} (it has ${n}; index counts from 0, code blocks skipped). Re-read it with get_issue({ id: "${i.id}" }) and pass that item's index and line.`
          : `${i.id} has no checklist ("- [ ]" lines) in its description. Add one with save_issue({ id: "${i.id}", description }), or tick nothing.`)
      }
      if (t.text.trim() !== a.line.trim()) {
        throw new ToolError(`The description changed since you loaded it: checklist item ${a.index} of ${i.id} no longer reads "${a.line.trim()}". Re-read it with get_issue({ id: "${i.id}" }) and retry with the current index and line.`)
      }
      return { description: toggleTask(cur.description, a.index) }
    }, actor)
    return issueOut(s, out)
  },

  async delete_issue(s, a: Args<'delete_issue'>, { actor }) {
    assertCanDelete(actor, normId(a.id))
    const i = mustIssue(s, a.id)
    await s.deleteIssue(i.id, actor)
    return { deleted: i.id }
  },

  async save_view(s, a: Args<'save_view'>, { actor }) {
    assertOwner(actor, 'Saving views')
    const slug = a.slug ?? slugify(a.name)
    // A new view never replaces another one; updating an existing view names it by slug.
    if (!a.slug && s.views.some((v) => v.slug === slug)) {
      throw new ToolError(`A view named '${a.name}' already exists — choose another name, or open it and use Save changes.`)
    }
    // Updating keeps keys this tool doesn't know (e.g. hand-added notes) and `favorite` unless it is given.
    const prev = s.views.find((v) => v.slug === slug) as (View & Record<string, unknown>) | undefined
    const view: View & { favorite?: boolean } = { ...prev, slug, name: a.name, filter: a.filter as View['filter'], display: a.display as View['display'] }
    if (a.favorite !== undefined) view.favorite = a.favorite
    if (view.favorite === false) delete view.favorite
    return s.saveView(view)
  },
}

// ---------- entry point ----------

function formatIssues(name: string, err: z.ZodError): string {
  const lines = err.issues.map((i) => `- ${i.path.length ? i.path.join('.') : '(arguments)'}: ${i.message}`)
  return `Invalid arguments for ${name}:\n${lines.join('\n')}\n${toolSchemas[name]!.description}`
}

/** Validate `args` against the tool's schema and run it. Throws ToolError with a message written for agents. */
export async function callTool(store: Store, name: string, args: unknown, ctx: ToolCtx): Promise<unknown> {
  const tool = toolSchemas[name]
  const handler = handlers[name]
  if (!tool || !handler) throw new ToolError(`Unknown tool "${name}". Available tools: ${Object.keys(toolSchemas).join(', ')}.`)
  const parsed = tool.input.safeParse(args ?? {})
  if (!parsed.success) throw new ToolError(formatIssues(name, parsed.error))
  try {
    return await handler(store, parsed.data, ctx)
  } catch (e) {
    if (e instanceof ToolError) throw e
    throw new ToolError(`${name} failed: ${e instanceof Error ? e.message : String(e)}`, undefined, { cause: e })
  }
}
