import type { Actor, Issue, Link } from '../model'
import type { IssuePatch, Store } from '../engine/store'
import type { BatchItemArgs } from './schemas'
import {
  blockCycle, cycleError, explanationError, extractLinks, findProject, hasRecentExplanation, mergeLinks, mustProject,
  needsExplanation, newLabel, noLabelsError, normId, noteExplanation, parentCycle, projectForCreate, resolveLabel,
  resolveStatus, statusType, ToolError, unknownIdsError,
} from './rules'

/**
 * save_issue / save_issues. Two phases: `prepare` validates an item and resolves every name and
 * reference without writing; `apply` performs the writes. A batch prepares every item first
 * (all-or-nothing validation), then applies them in order.
 */

/** Validated item. Graph fields hold keys: an existing id, or "ref:<ref>" for an item of this batch. */
interface Prepared {
  index: number
  ref?: string
  key: string // existing id, "ref:<ref>", or "#<index>" for an unnamed new item
  id?: string // set for updates
  args: BatchItemArgs
  project?: { slug: string } | { auto: string } // create target, or move target on update
  status?: string
  milestone?: string | null
  parent?: string | null
  blockedBy?: string[]
  related?: string[]
  labels?: string[]
  addLabels: string[]
  removeLabels: string[]
  // deltas, applied inside the issue's write queue on the fresh file
  addBlockedBy: string[]
  removeBlockedBy: string[]
  addRelated: string[]
  removeRelated: string[]
  removeLinks: string[]
}

interface Overlay { parent: Map<string, string | null>; blockedBy: Map<string, string[]> }

const isRef = (k: string) => k.startsWith('ref:')

class Batch {
  readonly overlay: Overlay = { parent: new Map(), blockedBy: new Map() }
  readonly refs = new Map<string, string>() // ref -> graph key (the id for an update item)
  constructor(readonly s: Store, readonly actor: Actor, readonly commented: Set<string>) {}

  parentOf = (k: string): string | null => (this.overlay.parent.has(k) ? this.overlay.parent.get(k)! : this.s.get(k)?.parent ?? null)
  blockersOf = (k: string): string[] => this.overlay.blockedBy.get(k) ?? this.s.get(k)?.blockedBy ?? []

  /** Resolve an id or "ref:<ref>" to a graph key; null when unknown. */
  key(raw: string): string | null {
    const t = raw.trim()
    if (/^ref:/i.test(t)) return this.refs.get(t.slice(4)) ?? null
    const id = normId(t)
    return this.s.get(id) ? id : null
  }
}

/** Keys of batch items that carry a comment (rule 3: "a comment in the same batch"). */
function commentedKeys(items: BatchItemArgs[]): Set<string> {
  const out = new Set<string>()
  items.forEach((a, i) => {
    if (!a.comment?.trim()) return
    if (a.id) out.add(normId(a.id))
    else out.add(a.ref ? `ref:${a.ref}` : `#${i}`)
  })
  return out
}

function prepare(b: Batch, args: BatchItemArgs, index: number): Prepared {
  const { s, actor } = b
  const id = args.id ? normId(args.id) : undefined
  const cur = id ? s.get(id) : undefined
  if (id && !cur) throw unknownIdsError([id], 'id')
  if (args.ref && b.refs.has(args.ref)) throw new ToolError(`ref "${args.ref}" is used twice; give each item its own ref.`)
  const key = id ?? (args.ref ? `ref:${args.ref}` : `#${index}`)
  const p: Prepared = {
    index, key, args, addLabels: [], removeLabels: [], addBlockedBy: [], removeBlockedBy: [], addRelated: [], removeRelated: [], removeLinks: [], ...(args.ref ? { ref: args.ref } : {}), ...(id ? { id } : {}) }

  // project (rule 1) and milestone
  if (args.project !== undefined) p.project = { slug: mustProject(s, args.project).slug }
  else if (!cur) {
    if (!args.title?.trim()) throw new ToolError('To create an issue pass title (and labels); to update one pass id. Example: save_issue({ title: "Fix login timeout", labels: ["Bug"] })')
    p.project = projectForCreate(s, actor)
  }
  if (args.milestone !== undefined && args.milestone !== null) {
    const slug = p.project && 'slug' in p.project ? p.project.slug : p.project ? undefined : cur!.project
    const proj = slug ? s.projects.get(slug) : undefined
    const m = proj?.milestones.find((x) => x.name.toLowerCase() === args.milestone!.trim().toLowerCase())
    if (!m) {
      const names = proj?.milestones.map((x) => x.name) ?? []
      const pname = proj?.name ?? (p.project && 'auto' in p.project ? p.project.auto : '?')
      throw new ToolError(`Unknown milestone "${args.milestone}" in project "${pname}". Milestones: ${names.join(', ') || '(none)'}. Create it first: save_milestone({ project: "${pname}", name: "${args.milestone}" }).`)
    }
    p.milestone = m.name
  } else if (args.milestone === null) p.milestone = null

  // labels (rule 2)
  const resolve = (names: string[]) => names.map((n) => resolveLabel(s.labels, n) ?? n.trim())
  if (args.labels) p.labels = resolve(args.labels)
  if (args.addLabels) p.addLabels = resolve(args.addLabels)
  if (args.removeLabels) p.removeLabels = resolve(args.removeLabels)
  if (!cur) {
    const final = [...(p.labels ?? []), ...p.addLabels].filter((l) => !p.removeLabels.includes(l))
    if (!final.length) throw noLabelsError(s)
  }

  // status (rule 3)
  if (args.state !== undefined) {
    const st = resolveStatus(s, args.state)
    p.status = st.name
    const changed = !cur || cur.status !== st.name
    if (changed && actor.actor !== 'you' && needsExplanation(st)) {
      const ok = !!args.comment?.trim() || b.commented.has(key) || (!!id && hasRecentExplanation(s, id, actor.session))
      if (!ok) throw explanationError(id, st.name)
    }
  }

  // references (rule 4)
  const unknown: string[] = []
  if (args.parentId !== undefined) {
    if (args.parentId === null) p.parent = null
    else {
      const k = b.key(args.parentId)
      if (k === null) unknown.push(args.parentId)
      else p.parent = k
    }
  }
  if (args.blockedBy) {
    const ks: string[] = []
    for (const raw of args.blockedBy) {
      const k = b.key(raw)
      if (k === null) unknown.push(raw)
      else if (!ks.includes(k)) ks.push(k)
    }
    p.blockedBy = ks
  }
  if (args.relatedTo) {
    const ks: string[] = []
    for (const raw of args.relatedTo) {
      const k = b.key(raw)
      if (k === null || isRef(k)) unknown.push(raw)
      else if (k !== id && !ks.includes(k)) ks.push(k)
    }
    p.related = ks
  }
  for (const raw of args.addBlockedBy ?? []) {
    const k = b.key(raw)
    if (k === null) unknown.push(raw)
    else if (!p.addBlockedBy.includes(k)) p.addBlockedBy.push(k)
  }
  for (const raw of args.addRelatedTo ?? []) {
    const k = b.key(raw)
    if (k === null || isRef(k)) unknown.push(raw)
    else if (k !== id && !p.addRelated.includes(k)) p.addRelated.push(k)
  }
  // Removing needs no lookup: a blocker or related id may no longer exist.
  p.removeBlockedBy = (args.removeBlockedBy ?? []).map(normId)
  p.removeRelated = (args.removeRelatedTo ?? []).map(normId)
  p.removeLinks = (args.removeLinks ?? []).map((u) => u.trim())
  if (unknown.length) throw unknownIdsError(unknown, 'parentId/blockedBy/relatedTo')
  if (p.parent) {
    const cyc = parentCycle(key, p.parent, b.parentOf)
    if (cyc) throw cycleError('parent', key, cyc)
  }
  for (const bk of [...(p.blockedBy ?? []), ...p.addBlockedBy]) {
    const cyc = blockCycle(key, bk, b.blockersOf)
    if (cyc) throw cycleError('blockedBy', key, cyc)
  }
  return p
}

const hasBlockedDelta = (p: Prepared) => p.addBlockedBy.length > 0 || p.removeBlockedBy.length > 0
const hasRelatedDelta = (p: Prepared) => p.addRelated.length > 0 || p.removeRelated.length > 0
const uniq = (xs: string[]) => [...new Set(xs)]

/** The final list: `base` (a replacement, or the current list) plus `add`, minus `remove`. */
const applyDelta = (base: string[], add: string[], remove: string[]) => uniq([...base, ...add]).filter((x) => !remove.includes(x))

/** Record a prepared item's graph changes so later items in the batch see them. */
function commit(b: Batch, p: Prepared): void {
  if (p.ref) b.refs.set(p.ref, p.key)
  if (p.parent !== undefined) b.overlay.parent.set(p.key, p.parent)
  else if (!p.id) b.overlay.parent.set(p.key, null)
  if (p.blockedBy || hasBlockedDelta(p)) b.overlay.blockedBy.set(p.key, applyDelta(p.blockedBy ?? (p.id ? b.blockersOf(p.key) : []), p.addBlockedBy, p.removeBlockedBy))
  else if (!p.id) b.overlay.blockedBy.set(p.key, [])
}

async function apply(s: Store, p: Prepared, actor: Actor, refIds: Map<string, string>): Promise<Issue> {
  const a = p.args
  const real = (k: string) => (isRef(k) ? refIds.get(k)! : k)

  // unknown labels are created (rule 2)
  for (const l of [...(p.labels ?? []), ...p.addLabels]) {
    if (!s.labels.some((x) => x.name === l)) await s.upsertLabel(newLabel(l))
  }
  // auto-create the workspace's project (rule 1)
  let slug: string | undefined
  if (p.project && 'auto' in p.project) {
    const ws = p.project.auto
    const proj = findProject(s, ws) ?? (await s.upsertProject({ name: ws }))
    await s.mapWorkspace(ws, proj.slug)
    slug = proj.slug
  } else if (p.project) slug = p.project.slug

  const textLinks = [...extractLinks(a.description), ...extractLinks(a.comment)]
  const argLinks: Link[] = (a.links ?? []).map((l) => ({ title: l.title ?? l.url, url: l.url }))
  const parent = p.parent === undefined ? undefined : p.parent === null ? null : real(p.parent)
  const blockedBy = p.blockedBy?.map(real)
  const addBlockedBy = p.addBlockedBy.map(real)
  const blockedTouched = !!blockedBy || hasBlockedDelta(p)
  const relatedTouched = !!p.related || hasRelatedDelta(p)
  const startedNow = (st: string | undefined) => st !== undefined && statusType(s, st) === 'started'

  let issue: Issue
  let oldRelated: string[] = []
  let newRelated: string[] = []
  if (!p.id) {
    const createBlocked = blockedTouched ? applyDelta(blockedBy ?? [], addBlockedBy, p.removeBlockedBy) : undefined
    newRelated = applyDelta(p.related ?? [], p.addRelated, p.removeRelated)
    const labels = [...new Set([...(p.labels ?? []), ...p.addLabels])].filter((l) => !p.removeLabels.includes(l))
    issue = await s.createIssue({
      title: a.title!.trim(), project: slug!, labels,
      ...(p.status !== undefined ? { status: p.status } : {}),
      ...(a.priority !== undefined ? { priority: a.priority as Issue['priority'] } : {}),
      ...(parent !== undefined ? { parent } : {}),
      ...(createBlocked ? { blockedBy: createBlocked } : {}),
      ...(relatedTouched ? { related: newRelated } : {}),
      ...(p.milestone !== undefined ? { milestone: p.milestone } : {}),
      ...(a.dueDate !== undefined ? { due: a.dueDate } : {}),
      ...(a.description !== undefined ? { description: a.description } : {}),
      ...(startedNow(p.status) ? { plan: 'now' as const } : {}),
      links: mergeLinks(argLinks, textLinks).filter((l) => !p.removeLinks.includes(l.url)),
    }, actor)
  } else {
    const id = p.id
    // Computed inside the issue's write queue on the fresh file, so concurrent edits aren't lost.
    const build = (cur: Issue): IssuePatch | null => {
      oldRelated = cur.related
      newRelated = cur.related
      const patch: IssuePatch = {}
      if (a.title !== undefined) patch.title = a.title
      if (a.baseDescription !== undefined && a.baseDescription !== cur.description) {
        throw new ToolError(`The description changed since you started editing (someone saved a newer version of ${id}). Reload to see it, then re-apply your edit; your text was not saved.`)
      }
      if (a.description !== undefined) patch.description = a.description
      if (p.status !== undefined && p.status !== cur.status) {
        patch.status = p.status
        const wasStarted = statusType(s, cur.status) === 'started'
        if (startedNow(p.status) && !wasStarted && cur.plan !== 'now') patch.plan = 'now'
      }
      if (a.priority !== undefined) patch.priority = a.priority as Issue['priority']
      if (slug !== undefined && slug !== cur.project) patch.project = slug
      if (p.milestone !== undefined) patch.milestone = p.milestone
      if (a.dueDate !== undefined) patch.due = a.dueDate
      if (parent !== undefined) {
        const cyc = parent === null ? null : parentCycle(id, parent, (k) => s.get(k)?.parent ?? null)
        if (cyc) throw cycleError('parent', id, cyc)
        patch.parent = parent
      }
      if (blockedTouched) {
        const next = applyDelta(blockedBy ?? cur.blockedBy, addBlockedBy, p.removeBlockedBy)
        for (const bk of next) {
          if (cur.blockedBy.includes(bk) && !blockedBy) continue // unchanged, already acyclic
          const cyc = blockCycle(id, bk, (k) => s.get(k)?.blockedBy ?? [])
          if (cyc) throw cycleError('blockedBy', id, cyc)
        }
        patch.blockedBy = next
      }
      if (relatedTouched) {
        newRelated = applyDelta(p.related ?? cur.related, p.addRelated, p.removeRelated).filter((r) => r !== id)
        patch.related = newRelated
      }
      if (p.labels || p.addLabels.length || p.removeLabels.length) {
        const base = p.labels ?? cur.labels
        patch.labels = [...new Set([...base, ...p.addLabels])].filter((l) => !p.removeLabels.includes(l))
      }
      const links = mergeLinks(mergeLinks(cur.links, argLinks), textLinks).filter((l) => !p.removeLinks.includes(l.url))
      if (JSON.stringify(links) !== JSON.stringify(cur.links)) patch.links = links
      return Object.keys(patch).length ? patch : null
    }
    // parent/blocked_by changes hold the graph lock across cycle check + write (rule 4 under concurrency)
    issue = parent !== undefined || blockedTouched
      ? await s.withGraphLock(() => s.updateIssue(id, build, actor))
      : await s.updateIssue(id, build, actor)
  }

  // relatedTo is stored on both sides
  if (relatedTouched) {
    const added = newRelated.filter((r) => !oldRelated.includes(r))
    const removed = oldRelated.filter((r) => !newRelated.includes(r))
    const self = issue.id
    for (const r of added) {
      if (s.get(r)) await s.updateIssue(r, (o) => (o.related.includes(self) ? null : { related: [...o.related, self] }), actor)
    }
    for (const r of removed) {
      if (s.get(r)) await s.updateIssue(r, (o) => (o.related.includes(self) ? { related: o.related.filter((x) => x !== self) } : null), actor)
    }
  }
  if (a.comment?.trim()) {
    await s.addComment(issue.id, a.comment, actor)
    noteExplanation(s, issue.id, actor.session)
  }
  return s.get(issue.id) ?? issue
}

export async function saveIssue(s: Store, args: BatchItemArgs, actor: Actor): Promise<Issue> {
  const b = new Batch(s, actor, commentedKeys([args]))
  return apply(s, prepare(b, args, 0), actor, new Map())
}

/** Validate every item (resolving refs) before writing any; then write in order. */
export async function saveIssues(s: Store, items: BatchItemArgs[], actor: Actor): Promise<{ issue: Issue; ref?: string }[]> {
  const b = new Batch(s, actor, commentedKeys(items))
  const prepared: Prepared[] = []
  const errors: string[] = []
  items.forEach((a, i) => {
    try {
      const p = prepare(b, a, i)
      commit(b, p)
      prepared.push(p)
    } catch (e) {
      if (!(e instanceof ToolError)) throw e
      if (a.ref) b.refs.set(a.ref, a.id ? normId(a.id) : `ref:${a.ref}`) // let later items' refs resolve so each error is about its own item
      errors.push(`item ${i}${a.ref ? ` (ref "${a.ref}")` : a.id ? ` (${normId(a.id)})` : ''}: ${e.message}`)
    }
  })
  if (errors.length) throw new ToolError(`Nothing was saved; fix these items and resend the whole batch:\n${errors.join('\n')}`)

  const refIds = new Map<string, string>()
  const done: { issue: Issue; ref?: string }[] = []
  for (const p of prepared) {
    try {
      const issue = await apply(s, p, actor, refIds)
      if (p.ref) refIds.set(`ref:${p.ref}`, issue.id)
      done.push({ issue, ...(p.ref ? { ref: p.ref } : {}) })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const saved = done.map((d) => (d.ref ? `${d.issue.id} (ref "${d.ref}")` : d.issue.id))
      throw new ToolError(
        `save_issues stopped at item ${p.index}: ${msg}. Already saved: ${saved.join(', ') || 'none'}. ` +
        'Resend only the remaining items, replacing "ref:" references to saved items with their ids.',
        { saved: done.map((d) => ({ id: d.issue.id, ...(d.ref ? { ref: d.ref } : {}) })), failedIndex: p.index },
        { cause: e },
      )
    }
  }
  return done
}
