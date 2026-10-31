import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { ActivityEntry, Actor, CiBadge, Config, Issue, LabelDef, Link, Milestone, PlanSlot, Priority, Project, View } from '../model'
import { atomicCreate, atomicWrite, removeStaleTemps } from '../store/atomic'
import { parseIssue, readBackMismatch, serializeIssue } from '../store/issueFile'
import {
  createView, defaultConfig, defaultViews, deriveKey, readConfig, readLabels, readOfferedViews, readProject, readViews, SETUP_LOCK,
  writeConfig, writeLabels, writeOfferedViews, writeProject, writeView,
} from '../store/metaFiles'
import { CLOSED_TYPES } from '../shared/filter'
import { appendEvent, feedPath, type FeedEvent } from './eventlog'
import { IssueHistory, workingStatus, type Attempt, type HistoryEntry } from './stalled'
import { SearchIndex } from './searchIndex'
import type { CiLookup } from './ci'
import { allThemes, parseThemeFile, type Theme } from './themes'
import { aittEnv } from '../shared/env'

/** The folder of issues without a project. */
export const NO_PROJECT = '_none'

export type ChangeEvent =
  | { kind: 'issue'; issue: Issue; prev?: Issue; actor: Actor; comment?: ActivityEntry }
  | { kind: 'removed'; id: string; actor: Actor }
  | { kind: 'meta'; note?: string } // config/labels/projects/views changed; `note`: what to call it in the git commit
  | { kind: 'error'; path: string; message: string } // file couldn't be parsed
  | { kind: 'feed'; event: FeedEvent } // appended to the feed log (R3)
  | { kind: 'file'; path: string; deleted?: true } // any other file in the folder changed (AGENTS.md, attachments); `path` is root-relative
  | { kind: 'ci'; changes: Record<string, CiBadge | null> } // CI badges of these issues changed (null: none); src/engine/ci.ts

export interface IssueInput {
  title: string; project: string; status?: string; priority?: Priority; labels?: string[]; parent?: string | null
  blockedBy?: string[]; related?: string[]; milestone?: string | null; due?: string | null; plan?: PlanSlot
  links?: Link[]; description?: string; extra?: Record<string, unknown>
}
export type IssuePatch = Partial<IssueInput>
/** Computes a patch from the issue as freshly read inside its write queue; null = nothing to write. */
export type IssuePatchFn = (cur: Issue) => IssuePatch | null

/** Actor recorded for changes the engine didn't make (hand edits, git pull, other tools). */
export const EXTERNAL: Actor = { actor: 'you', workspace: 'external' }

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const hash = (s: string) => Bun.hash(s)
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const isMissing = (e: unknown) => (e as { code?: string })?.code === 'ENOENT'

/** Sort issue ids by key, then number ('Q-2' < 'Q-10'). */
export function compareIds(a: string, b: string): number {
  const i = a.lastIndexOf('-'), j = b.lastIndexOf('-')
  const ka = a.slice(0, i), kb = b.slice(0, j)
  if (ka !== kb) return ka < kb ? -1 : 1
  return Number(a.slice(i + 1)) - Number(b.slice(j + 1))
}

/** Model fields compared to decide whether a change is user-visible (path and project included). */
const fingerprint = (i: Issue) => JSON.stringify(i)

/** A temp file younger than this may belong to a write in progress in another process; leave it. */
const TEMP_MIN_AGE_MS = 30_000

const NO_HISTORY: readonly HistoryEntry[] = Object.freeze([])
const NO_WORKSPACES: ReadonlySet<string> = new Set()
const DAY_MS = 86_400_000

const PATCH_FIELDS = ['title', 'status', 'priority', 'parent', 'blockedBy', 'labels', 'related', 'milestone', 'due', 'plan', 'links', 'description'] as const

export class Store {
  config: Config = defaultConfig()
  labels: LabelDef[] = []
  projects = new Map<string, Project>()
  views: View[] = []
  /** path -> parse error message for files the index couldn't (re)load. */
  errors = new Map<string, string>()
  /** Full-text index over title, description and activity; maintained on every change. */
  readonly index = new SearchIndex()
  /** CI status of linked PRs, read from memory (the background refresher in src/engine/ci.ts); null when not running. */
  ci: CiLookup | null = null
  /** Custom themes from `themes/*.yml` that passed the checks (src/engine/themes.ts); broken files are in `errors`. */
  themes: Theme[] = []

  private issues = new Map<string, Issue>()
  private dupOf = new Map<string, string>() // path -> id, for files rejected as duplicate ids
  private idByPath = new Map<string, string>()
  private kids = new Map<string, Set<string>>() // parent id -> child ids
  private blocking = new Map<string, Set<string>>() // blocker id -> ids blocked by it
  private queues = new Map<string, Promise<void>>()
  private own = new Map<string, number | bigint>() // path -> hash of the engine's last write
  private listeners = new Set<(e: ChangeEvent) => void>()
  /** Per issue, from the feed log: status moves and agent-session writes (pruned to the stalled window), and the newest write time. */
  private hist = new Map<string, IssueHistory>()
  private lastWrite = new Map<string, number>()
  private feedStart = Infinity
  /** Per issue, from the feed log: when it last moved into a completed status (ms). Never pruned. */
  private doneTimes = new Map<string, number>()
  /** Per issue, from the feed log: when it last went from open to any closed status (ms); NaN once it has been reopened. */
  private closedTimes = new Map<string, number>()

  /** Issue serializer (a seam so tests can inject a broken one; writes are verified against it). */
  serialize: (issue: Issue) => string = serializeIssue

  private constructor(readonly root: string, private portOverride?: number) {}

  /** Effective HTTP port: Store.open's `port` option, else env AITT_PORT, else config.port. */
  get port(): number { return this.portOverride ?? this.config.port }

  static async open(root: string, opts: { port?: number } = {}): Promise<Store> {
    const env = Number(aittEnv('PORT'))
    const s = new Store(root, opts.port ?? (Number.isInteger(env) && env > 0 ? env : undefined))
    await s.loadConfig()
    await s.loadLabels()
    await s.loadViews()
    await s.loadThemes()
    const projectsDir = join(root, 'projects')
    const slugs = await readdir(projectsDir, { withFileTypes: true }).then(
      (ds) => ds.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort(),
      (e) => { if (isMissing(e)) return [] as string[]; throw e },
    )
    // Crash leftovers of atomicWrite, in every folder the engine writes to.
    const writeDirs = [root, join(root, 'views'), ...slugs.flatMap((sl) => ['', 'docs', 'issues'].map((d) => join(projectsDir, sl, d)))]
    for (const d of writeDirs) {
      for (const p of await removeStaleTemps(d, TEMP_MIN_AGE_MS)) console.error(`[store] removed leftover temp file ${p}`)
    }
    const paths: { path: string; slug: string }[] = []
    for (const slug of slugs) {
      await s.loadProject(slug)
      const dir = join(projectsDir, slug, 'issues')
      const files = await readdir(dir).catch((e) => { if (isMissing(e)) return [] as string[]; throw e })
      for (const f of files) if (f.endsWith('.md') && !f.startsWith('.')) paths.push({ path: join(dir, f), slug })
    }
    const BATCH = 512
    for (let i = 0; i < paths.length; i += BATCH) {
      const chunk = paths.slice(i, i + BATCH)
      // Per file: a file removed since readdir is skipped; any other failure goes to `errors`.
      const texts = await Promise.all(chunk.map((p) => readFile(p.path, 'utf8').catch((e: unknown) => (isMissing(e) ? null : e))))
      chunk.forEach(({ path, slug }, k) => {
        const text = texts[k]
        if (text === null) return
        try {
          if (typeof text !== 'string') throw text
          const issue = parseIssue(text, path, slug, { lite: true })
          const dup = s.issues.get(issue.id)
          if (dup) s.setDuplicate(path, issue.id, dup.path)
          else s.setIssue(issue)
        } catch (e) {
          s.errors.set(path, errMsg(e))
        }
      })
    }
    await s.loadHistory()
    return s
  }

  // ---------- reads ----------

  get(id: string): Issue | undefined { return this.issues.get(id) }
  all(): Issue[] { return [...this.issues.values()] }
  children(id: string): Issue[] {
    return [...(this.kids.get(id) ?? [])].sort(compareIds).map((c) => this.issues.get(c)!)
  }
  /** Status moves and agent-session writes on `id` from the feed log, oldest first (the stalled rules read it). */
  history(id: string): readonly HistoryEntry[] { return this.hist.get(id)?.entries() ?? NO_HISTORY }
  /** When `id` last moved into a completed status (Done), from the feed log; undefined when not logged. */
  doneAt(id: string): number | undefined { return this.doneTimes.get(id) }
  /**
   * When a closed issue was closed; undefined while it is open. The logged move, else a close date kept from an import,
   * else `updated` (issues closed before the log began, or on another Mac: the log isn't synced). Right after a reopen
   * the next close isn't logged yet when its event goes out, and `updated` is that moment.
   */
  closedAt(i: Issue): string | undefined {
    if (!this.isClosedStatus(i.status)) return undefined
    const logged = this.closedTimes.get(i.id)
    if (logged !== undefined && !Number.isNaN(logged)) return new Date(logged).toISOString().replace(/\.\d{3}Z$/, 'Z')
    if (logged === undefined) {
      for (const at of [i.extra.completed_at, i.extra.canceled_at]) if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) return at
    }
    return i.updated
  }
  /** Agent sessions that worked on `id` (from the feed log, since it began), oldest first by last write. */
  attempts(id: string): Attempt[] { return this.hist.get(id)?.attempts() ?? [] }
  /** When the feed log begins (Infinity while empty): older issues' moves may be missing from it. */
  get feedStartsAt(): number { return this.feedStart }
  /** Whether a status move of `id` was logged (false: it is still in the status it was created in, as far as the log knows). */
  statusMoved(id: string): boolean { return this.hist.get(id)?.moved ?? false }
  /** The newest status move of `id` in the feed log, however old. */
  lastMove(id: string): HistoryEntry | null { return this.hist.get(id)?.lastMove ?? null }
  /** Agent workspaces seen in `id`'s recent history. */
  historyWorkspaces(id: string): ReadonlySet<string> { return this.hist.get(id)?.workspaces ?? NO_WORKSPACES }
  /** Whether anything is remembered about `id` (false after it is removed). */
  hasHistory(id: string): boolean { return this.hist.has(id) || this.lastWrite.has(id) }
  /** Newest change to `id` in ms: its `updated`, its newest comment, or a logged write (hand edits don't bump `updated`). */
  lastChange(i: Issue): number {
    const t = Math.max(Date.parse(i.updated) || 0, Date.parse(i.activity.at(-1)?.at ?? '') || 0, this.lastWrite.get(i.id) ?? 0)
    return t || NaN
  }
  /** Derived reverse of blocked_by: ids of issues that list `id` as a blocker. */
  blocks(id: string): string[] { return [...(this.blocking.get(id) ?? [])].sort(compareIds) }

  on(fn: (e: ChangeEvent) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** Announce changed CI badges (the CI refresher's only way to reach clients). */
  emitCi(changes: Record<string, CiBadge | null>): void { this.emit({ kind: 'ci', changes }) }

  isOwnWrite(path: string, content: string): boolean {
    const h = this.own.get(path)
    return h !== undefined && h === hash(content)
  }

  // ---------- issue mutations ----------

  async createIssue(input: IssueInput, actor: Actor): Promise<Issue> {
    if (!input.title?.trim()) throw new Error('createIssue: title is required')
    const proj = this.projects.get(input.project)
    if (!proj) throw new Error(`createIssue: unknown project "${input.project}"`)
    if (!proj.key) throw new Error(`createIssue: project "${proj.slug}" has no key`)
    // The number skips ids that are indexed or have a file in any project folder (an unparseable or
    // not-yet-indexed file), and the file is created exclusively: a stale number never overwrites.
    for (let attempt = 1; ; attempt++) {
      const id = await this.enqueue(this.configPath, async () => {
        await this.refreshConfig()
        const projectDirs = await readdir(join(this.root, 'projects')).catch(() => [] as string[])
        const taken = (id: string) => this.issues.has(id) ||
          projectDirs.some((d) => existsSync(join(this.root, 'projects', d, 'issues', `${id}.md`)))
        let n = this.config.nextNumber[proj.key] ?? 1
        while (taken(`${proj.key}-${n}`)) n++
        this.config.nextNumber = { ...this.config.nextNumber, [proj.key]: n + 1 }
        await writeConfig(this.root, this.config)
        await this.rememberFile(this.configPath)
        return `${proj.key}-${n}`
      })
      const at = now()
      const path = join(this.root, 'projects', proj.slug, 'issues', `${id}.md`)
      const draft: Issue = {
        id, title: input.title, status: input.status ?? this.defaultStatus(), priority: input.priority ?? 0,
        labels: input.labels ?? [], parent: input.parent ?? null, blockedBy: input.blockedBy ?? [], related: input.related ?? [],
        milestone: input.milestone ?? null, due: input.due ?? null, plan: input.plan ?? null, links: input.links ?? [],
        created: at, updated: at, touchedBy: actor, extra: { ...(input.extra ?? {}) },
        description: input.description ?? '', activity: [], project: proj.slug, path,
      }
      try {
        return await this.enqueue(id, async () => {
          await mkdir(dirname(path), { recursive: true })
          const issue = await this.writeIssue(draft, path, { create: true })
          this.emit({ kind: 'issue', issue, actor })
          await this.feed({ at, actor, id, kind: 'created', text: issue.title })
          return issue
        })
      } catch (e) {
        if ((e as { code?: string })?.code !== 'EEXIST' || attempt >= 20) throw e
        console.error(`[store] createIssue: ${path} appeared after ${id} was allocated; trying the next number`)
      }
    }
  }

  /**
   * Patch an issue. A function patch runs inside the issue's write queue on the issue freshly read
   * from disk, so read-modify-write changes (append a label, merge links) never lose concurrent updates.
   * It may throw to abort, or return null to write nothing (resolves to the indexed issue).
   */
  async updateIssue(id: string, patchOrFn: IssuePatch | IssuePatchFn, actor: Actor): Promise<Issue> {
    this.mustGet(id)
    return this.enqueue(id, async () => {
      const cur = this.mustGet(id)
      const issue = await this.readFromDisk(cur)
      const patch = typeof patchOrFn === 'function' ? patchOrFn(structuredClone(issue)) : patchOrFn
      if (patch === null) return this.mustGet(id)
      const prev = structuredClone(issue)
      for (const k of PATCH_FIELDS) if (patch[k] !== undefined) (issue as unknown as Record<string, unknown>)[k] = patch[k]
      if (patch.extra) {
        for (const [k, v] of Object.entries(patch.extra)) {
          if (v === undefined) delete issue.extra[k]
          else issue.extra[k] = v
        }
      }
      let path = issue.path
      if (patch.project !== undefined && patch.project !== issue.project) {
        const proj = this.projects.get(patch.project)
        if (!proj) throw new Error(`updateIssue: unknown project "${patch.project}"`)
        issue.project = proj.slug
        path = join(this.root, 'projects', proj.slug, 'issues', `${id}.md`)
      }
      const at = now()
      issue.updated = at
      issue.touchedBy = actor
      const oldPath = issue.path
      if (path !== oldPath) await mkdir(dirname(path), { recursive: true })
      const next = await this.writeIssue(issue, path)
      if (path !== oldPath) {
        await unlink(oldPath).catch((e) => { if (!isMissing(e)) throw e })
        this.own.delete(oldPath)
      }
      this.emit({ kind: 'issue', issue: next, prev, actor })
      for (const f of diffFeed(prev, next, actor, at)) await this.feed(f)
      return next
    })
  }

  async addComment(id: string, body: string, actor: Actor): Promise<ActivityEntry> {
    if (!body.trim()) throw new Error('addComment: body is empty')
    this.mustGet(id)
    return this.enqueue(id, async () => {
      const issue = await this.readFromDisk(this.mustGet(id))
      const prev = structuredClone(issue)
      const at = now()
      const entry: ActivityEntry = { at, actor: actor.actor, body }
      if (actor.workspace) entry.workspace = actor.workspace
      if (actor.workspace && actor.branch) entry.branch = actor.branch
      issue.activity.push(entry)
      issue.updated = at
      issue.touchedBy = actor
      const next = await this.writeIssue(issue, issue.path)
      const comment = next.activity.at(-1)!
      this.emit({ kind: 'issue', issue: next, prev, actor, comment })
      await this.feed({ at, actor, id, kind: 'comment', text: body.slice(0, 200) })
      return comment
    })
  }

  /** Only the owner may delete; agents cancel instead. */
  async deleteIssue(id: string, actor: Actor): Promise<void> {
    if (actor.actor !== 'you') throw new Error('deleteIssue: agents cannot delete issues; set status Canceled instead')
    this.mustGet(id)
    await this.enqueue(id, async () => {
      const cur = this.mustGet(id)
      await unlink(cur.path).catch((e) => { if (!isMissing(e)) throw e })
      this.own.delete(cur.path)
      this.removeIssue(id)
      this.emit({ kind: 'removed', id, actor })
    })
    await this.retryDuplicates([id])
  }

  /**
   * Run `fn` exclusively with other graph-lock holders. Callers that validate parent/blocked_by
   * against the index (cycle checks) hold it across check + write, so two concurrent edits can't
   * each pass the check and together close a cycle. Never take it from inside an issue queue task.
   */
  withGraphLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.enqueue('\0graph', fn)
  }

  // ---------- meta mutations ----------

  async upsertLabel(l: LabelDef): Promise<void> {
    const path = join(this.root, 'labels.yml')
    await this.enqueue(path, async () => {
      const i = this.labels.findIndex((x) => x.name === l.name)
      const labels = [...this.labels]
      if (i === -1) labels.push(l)
      else labels[i] = { ...labels[i], ...l }
      await writeLabels(this.root, labels)
      await this.rememberFile(path)
      this.labels = labels
      this.emit({ kind: 'meta' })
    })
  }

  /** Create or update a project by slug (or name). Keys never change once set. */
  /** `guard` runs inside the queue on the fresh project (undefined when creating) and may throw to refuse. */
  async upsertProject(p: Partial<Project> & { name: string }, guard?: (cur: Project | undefined) => void): Promise<Project> {
    return this.enqueue(this.configPath, async () => {
      await this.refreshConfig()
      const lower = p.name.toLowerCase()
      const known = (p.slug && this.projects.get(p.slug)) ||
        [...this.projects.values()].find((x) => x.name.toLowerCase() === lower)
      const existing = known ? await this.freshProject(known) : undefined
      const defined = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as Partial<Project>
      guard?.(existing)
      let proj: Project
      if (existing) {
        proj = { ...existing, ...defined, slug: existing.slug, key: existing.key }
      } else {
        const slug = p.slug ?? slugify(p.name)
        if (this.projects.has(slug)) throw new Error(`upsertProject: slug "${slug}" already used`)
        const taken = new Set([...this.projects.values()].map((x) => x.key).concat(Object.keys(this.config.nextNumber)))
        const key = p.key ?? deriveKey(p.name, taken)
        proj = { status: 'Active', repos: [], milestones: [], description: '', docs: [], ...defined, slug, name: p.name, key }
      }
      const dir = join(this.root, 'projects', proj.slug)
      await writeProject(dir, proj)
      await this.rememberFile(join(dir, 'project.md'))
      for (const d of proj.docs) await this.rememberFile(join(dir, 'docs', `${d.slug}.md`))
      if (this.config.nextNumber[proj.key] === undefined) {
        this.config.nextNumber = { ...this.config.nextNumber, [proj.key]: 1 }
        await writeConfig(this.root, this.config)
        await this.rememberFile(this.configPath)
      }
      this.projects.set(proj.slug, proj)
      this.emit({ kind: 'meta' })
      return proj
    })
  }

  /** Map a workspace (repo name) to a project slug in config.yml. */
  async mapWorkspace(workspace: string, slug: string): Promise<void> {
    await this.enqueue(this.configPath, async () => {
      await this.refreshConfig()
      if (this.config.workspaces[workspace] === slug) return
      this.config.workspaces = { ...this.config.workspaces, [workspace]: slug }
      await writeConfig(this.root, this.config)
      await this.rememberFile(this.configPath)
      this.emit({ kind: 'meta' })
    })
  }

  /** Create or update (by name, case-insensitive) a milestone of a project. Undefined fields keep their value. */
  async upsertMilestone(slug: string, m: Milestone): Promise<Project> {
    return this.mutateProject(slug, (p) => {
      const lower = m.name.toLowerCase()
      const milestones = [...p.milestones]
      const i = milestones.findIndex((x) => x.name.toLowerCase() === lower)
      const defined = Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) as Partial<Milestone>
      if (i === -1) milestones.push(m)
      else milestones[i] = { ...milestones[i]!, ...defined, name: milestones[i]!.name }
      return { ...p, milestones }
    })
  }

  /** Create or replace a project document (`docs/<docSlug>.md`). */
  async upsertDocument(slug: string, doc: { slug: string; title: string; content: string }, guard?: (cur: Project['docs'][number] | undefined) => void): Promise<Project> {
    return this.mutateProject(slug, (p) => {
      const docs = [...p.docs]
      const i = docs.findIndex((d) => d.slug === doc.slug)
      guard?.(docs[i])
      if (i === -1) docs.push(doc)
      else docs[i] = { ...docs[i]!, title: doc.title, content: doc.content }
      return { ...p, docs }
    })
  }

  /** Create a new document; the slug (from `base`, suffixed -2, -3 … on a clash) is picked inside the queue so concurrent creates never replace each other. */
  async createDocument(slug: string, base: string, doc: { title: string; content: string }): Promise<{ project: Project; slug: string }> {
    let picked = base
    const project = await this.mutateProject(slug, (p) => {
      picked = base
      for (let n = 2; p.docs.some((d) => d.slug === picked); n++) picked = `${base}-${n}`
      return { ...p, docs: [...p.docs, { slug: picked, ...doc }] }
    })
    return { project, slug: picked }
  }

  /** Create or replace a saved view (`views/<slug>.yml`). */
  async saveView(v: View): Promise<View> {
    const path = join(this.root, 'views', `${v.slug}.yml`)
    return this.enqueue(path, async () => {
      await writeView(this.root, v)
      await this.rememberFile(path)
      this.views = [...this.views.filter((x) => x.slug !== v.slug), v].sort((a, b) => (a.slug < b.slug ? -1 : 1))
      this.emit({ kind: 'meta' })
      return v
    })
  }

  /**
   * Add the default views this folder hasn't been offered yet, as ordinary files, and record them in the marker so a
   * deleted one stays deleted. An existing file or view name wins and counts as offered. Never rejects: what fails is
   * logged and, not being recorded, tried again at the next start. The engine's start calls this, not `open`:
   * setup and the CLI also open the store, and a folder setup is still writing must not get views yet.
   */
  async seedDefaultViews(): Promise<void> {
    try {
      if (!existsSync(this.configPath) || existsSync(join(this.root, SETUP_LOCK))) return
      if (this.errors.has(this.configPath) || this.errors.has(join(this.root, 'views'))) return
      const offered = await readOfferedViews(this.root)
      const record = [...offered]
      const names = new Set(this.views.map((v) => String(v.name).toLowerCase()))
      let added = false
      for (const v of defaultViews(this.config)) {
        if (offered.includes(v.slug)) continue
        const path = join(this.root, 'views', `${v.slug}.yml`)
        try {
          if (!names.has(v.name.toLowerCase())) {
            await this.enqueue(path, async () => {
              await createView(this.root, v)
              await this.rememberFile(path)
            })
            added = true
          }
          record.push(v.slug)
        } catch (e) {
          if ((e as { code?: string })?.code === 'EEXIST') record.push(v.slug)
          else console.error(`[store] could not add the default view ${v.slug}: ${errMsg(e)}`)
        }
      }
      if (record.length > offered.length) await writeOfferedViews(this.root, record)
      if (added) {
        await this.loadViews()
        this.emit({ kind: 'meta', note: 'add default views' })
      }
    } catch (e) {
      console.error(`[store] could not add the default views: ${errMsg(e)}`)
    }
  }

  /** Choose the UI theme (`theme` in config.yml): a built-in id or a loaded custom theme. Clients follow the `meta` event. */
  async setTheme(id: string): Promise<void> {
    const known = allThemes(this.themes).map((t) => t.id)
    if (!known.includes(id)) throw new Error(`unknown theme "${id}"; themes: ${known.join(', ')}`)
    await this.enqueue(this.configPath, async () => {
      await this.refreshConfig()
      if (this.config.theme === id) return
      this.config.theme = id
      await writeConfig(this.root, this.config)
      await this.rememberFile(this.configPath)
      this.emit({ kind: 'meta' })
    })
  }

  /**
   * Hide or unhide a project folder in the UIs (`hiddenProjects` in config.yml, src/engine/hidden.ts); `_none` is the
   * folder of issues without a project. Hiding needs an existing project; unhiding any slug clears it from the list.
   * Clients follow the `meta` event.
   */
  async setProjectHidden(slug: string, hidden: boolean): Promise<void> {
    if (hidden && slug !== NO_PROJECT && !this.projects.has(slug)) {
      throw new Error(`unknown project "${slug}"; projects: ${[...this.projects.keys()].filter((p) => p !== NO_PROJECT).sort().join(', ') || 'none'}`)
    }
    await this.enqueue(this.configPath, async () => {
      await this.refreshConfig()
      const cur = this.config.hiddenProjects
      if (cur.includes(slug) === hidden) return
      this.config.hiddenProjects = hidden ? [...cur, slug] : cur.filter((x) => x !== slug)
      await writeConfig(this.root, this.config)
      await this.rememberFile(this.configPath)
      this.emit({ kind: 'meta' })
    })
  }

  /** Read-modify-write a project's files, serialized with upsertProject (config queue). */
  private mutateProject(slug: string, fn: (p: Project) => Project): Promise<Project> {
    return this.enqueue(this.configPath, async () => {
      const known = this.projects.get(slug)
      if (!known) throw new Error(`unknown project "${slug}"`)
      const proj = fn(await this.freshProject(known))
      const dir = join(this.root, 'projects', slug)
      await writeProject(dir, proj)
      await this.rememberFile(join(dir, 'project.md'))
      for (const d of proj.docs) await this.rememberFile(join(dir, 'docs', `${d.slug}.md`))
      this.projects.set(slug, proj)
      this.emit({ kind: 'meta' })
      return proj
    })
  }

  // ---------- external changes (watcher) ----------

  /** Issue and meta files: the ones the engine reads (and writes). Everything else is only committed. */
  readsFile(path: string): boolean {
    return this.loaderFor(path) !== undefined
  }

  private loaderFor(path: string): 'issue' | (() => Promise<boolean>) | undefined {
    const rel = relative(this.root, path).split(sep)
    if (rel[0] === 'projects' && rel[2] === 'issues' && rel.length === 4 && rel[3]!.endsWith('.md')) return 'issue'
    const key = rel.join('/')
    if (key === 'config.yml') return () => this.loadConfig(true)
    if (key === 'labels.yml') return () => this.loadLabels(true)
    if (rel[0] === 'views' && rel.length === 2 && key.endsWith('.yml')) return () => this.loadViews(true)
    // A theme file, or the themes/ folder itself (created, renamed or deleted as a whole): rescan the folder.
    if (rel[0] === 'themes' && (rel.length === 1 || (rel.length === 2 && key.endsWith('.yml')))) return () => this.loadThemes(true)
    if (rel[0] === 'projects' && ((rel.length === 3 && rel[2] === 'project.md') || (rel.length === 4 && rel[2] === 'docs'))) {
      return () => this.loadProject(rel[1]!, true)
    }
    return undefined
  }

  /** Re-read one changed file (issue or meta) after an external edit; ignores the engine's own writes. Any other file emits `file`. */
  async reloadFile(path: string): Promise<void> {
    const rel = relative(this.root, path).split(sep)
    const key = rel.join('/')
    const load = this.loaderFor(path)
    if (load === 'issue') return this.reloadIssue(path, rel[1]!)
    if (!load) {
      // Not something the engine reads or writes, but it lives in the folder: git must still commit it.
      // (Not read here: attachments can be large videos.)
      const gone = await stat(path).then(() => false, () => true)
      this.emit(gone ? { kind: 'file', path: key, deleted: true } : { kind: 'file', path: key })
      return
    }
    // Theme files share one queue: each reload rescans the whole themes/ folder.
    const queue = key === 'config.yml' ? this.configPath : rel[0] === 'themes' ? join(this.root, 'themes') : path
    await this.enqueue(queue, async () => {
      const text = await readFile(path, 'utf8').catch(() => null)
      if (text !== null && this.isOwnWrite(path, text)) return
      if (await load()) this.emit({ kind: 'meta' })
    })
  }

  private async reloadIssue(path: string, slug: string): Promise<void> {
    const removed: string[] = []
    await this.reloadIssueOnce(path, slug, removed)
    await this.retryDuplicates(removed)
  }

  /** After ids leave the index, re-check files that were rejected as duplicates of them. */
  private async retryDuplicates(ids: string[]): Promise<void> {
    for (const id of ids) {
      for (const [p, dupId] of [...this.dupOf]) {
        if (dupId !== id || this.issues.has(id)) continue
        await this.reloadIssue(p, relative(this.root, p).split(sep)[1]!)
      }
    }
  }

  private async reloadIssueOnce(path: string, slug: string, removed: string[]): Promise<void> {
    const key = this.idByPath.get(path) ?? path
    await this.enqueue(key, async () => {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (e) {
        if (!isMissing(e)) throw e
        this.own.delete(path)
        const hadError = this.clearError(path)
        const id = this.idByPath.get(path)
        if (id && this.issues.get(id)?.path === path) {
          this.removeIssue(id)
          removed.push(id)
          this.emit({ kind: 'removed', id, actor: EXTERNAL })
        } else if (hadError) this.emit({ kind: 'meta' })
        return
      }
      if (this.isOwnWrite(path, text)) return
      let issue: Issue
      try {
        issue = { ...parseIssue(text, path, slug) }
      } catch (e) {
        const message = errMsg(e)
        this.clearError(path)
        this.errors.set(path, message)
        this.emit({ kind: 'error', path, message })
        return
      }
      const clearedError = this.clearError(path)
      const prev = this.issues.get(issue.id)
      if (prev && prev.path !== path) {
        // Same id in two files: keep the indexed one unless the old file is gone (an external move).
        const oldExists = await readFile(prev.path, 'utf8').then(() => true, () => false)
        if (oldExists) {
          const message = this.setDuplicate(path, issue.id, prev.path)
          this.emit({ kind: 'error', path, message })
          return
        }
      }
      const replaced = this.idByPath.get(path)
      if (replaced && replaced !== issue.id && this.issues.get(replaced)?.path === path) {
        this.removeIssue(replaced)
        removed.push(replaced)
        this.emit({ kind: 'removed', id: replaced, actor: EXTERNAL })
      }
      if (prev && fingerprint(prev) === fingerprint(issue)) {
        if (clearedError) this.emit({ kind: 'issue', issue: prev, prev, actor: EXTERNAL })
        return
      }
      this.setIssue(issue)
      this.emit({ kind: 'issue', issue, ...(prev ? { prev } : {}), actor: EXTERNAL })
      const at = now()
      const events = prev ? diffFeed(prev, issue, EXTERNAL, at) : [{ at, actor: EXTERNAL, id: issue.id, kind: 'created' as const, text: issue.title }]
      for (const f of events) await this.feed(f)
    })
  }

  // ---------- internals ----------

  private get configPath() { return join(this.root, 'config.yml') }
  private isClosedStatus(name: string): boolean {
    const type = this.config.statuses.find((x) => x.name === name)?.type
    return !!type && CLOSED_TYPES.has(type)
  }

  /**
   * Re-read config.yml before patching it (call inside the config queue), so hand edits the
   * watcher hasn't delivered yet are not overwritten. A config.yml that doesn't parse blocks the write.
   */
  private async refreshConfig(): Promise<void> {
    try {
      this.config = await readConfig(this.root)
      this.errors.delete(this.configPath)
    } catch (e) {
      if (isMissing(e)) return
      const message = errMsg(e)
      this.errors.set(this.configPath, message)
      throw new Error(`config.yml cannot be parsed (${message}); fix it by hand before creating issues or projects`)
    }
  }

  private defaultStatus(): string {
    return (this.config.statuses.find((s) => s.type === 'backlog') ?? this.config.statuses[0])?.name ?? 'Backlog'
  }

  private mustGet(id: string): Issue {
    const i = this.issues.get(id)
    if (!i) throw new Error(`issue ${id} not found`)
    return i
  }

  /** Fresh parse of the issue's file (picks up hand edits the watcher hasn't delivered yet). */
  private async readFromDisk(cur: Issue): Promise<Issue> {
    let text: string
    try {
      text = await readFile(cur.path, 'utf8')
    } catch (e) {
      if (isMissing(e)) throw new Error(`issue ${cur.id} not found (file ${cur.path} is gone)`)
      throw e
    }
    const issue = parseIssue(text, cur.path, cur.project)
    if (issue.id !== cur.id) throw new Error(`issue ${cur.id}: file now holds id ${issue.id}; refusing to write`)
    return issue
  }

  /**
   * Serialize, verify the text reads back as the intended issue (else refuse: nothing is written),
   * record the hash (before writing, so a fast watcher sees it), write, re-index.
   */
  private async writeIssue(issue: Issue, path: string, opts: { create?: boolean } = {}): Promise<Issue> {
    const text = this.serialize(issue)
    let indexed: Issue
    try {
      indexed = { ...parseIssue(text, path, issue.project) }
    } catch (e) {
      return this.refuseWrite(issue, path, `it would not parse (${errMsg(e)})`)
    }
    const bad = readBackMismatch(issue, indexed)
    if (bad.length) return this.refuseWrite(issue, path, `${bad.join(', ')} would not read back as written`)
    this.own.set(path, hash(text))
    try {
      await (opts.create ? atomicCreate : atomicWrite)(path, text)
    } catch (e) {
      this.own.delete(path)
      throw e
    }
    this.clearError(path)
    this.setIssue(indexed)
    return indexed
  }

  private refuseWrite(issue: Issue, path: string, why: string): never {
    const message = `Refusing to write ${issue.id}: ${why}. Nothing was written; the file is unchanged.`
    console.error(`[store] ${message} (${path})`)
    throw new Error(message)
  }

  /** Record `path` as rejected because `id` is already indexed from `other`. Returns the message. */
  private setDuplicate(path: string, id: string, other: string): string {
    const message = `duplicate id ${id} (also in ${other})`
    this.errors.set(path, message)
    this.dupOf.set(path, id)
    return message
  }

  private clearError(path: string): boolean {
    this.dupOf.delete(path)
    return this.errors.delete(path)
  }

  private async rememberFile(path: string): Promise<void> {
    const text = await readFile(path, 'utf8').catch(() => null)
    if (text !== null) this.own.set(path, hash(text))
  }

  private setIssue(issue: Issue): void {
    const old = this.issues.get(issue.id)
    if (old) this.unlinkGraph(old)
    this.issues.set(issue.id, issue)
    this.idByPath.set(issue.path, issue.id)
    if (issue.parent) addTo(this.kids, issue.parent, issue.id)
    for (const b of issue.blockedBy) addTo(this.blocking, b, issue.id)
    this.index.set(issue)
  }

  private removeIssue(id: string): void {
    const old = this.issues.get(id)
    if (!old) return
    this.unlinkGraph(old)
    this.issues.delete(id)
    this.index.remove(id)
    this.hist.delete(id)
    this.lastWrite.delete(id)
    this.doneTimes.delete(id)
    this.closedTimes.delete(id)
  }

  private unlinkGraph(old: Issue): void {
    if (this.idByPath.get(old.path) === old.id) this.idByPath.delete(old.path)
    if (old.parent) removeFrom(this.kids, old.parent, old.id)
    for (const b of old.blockedBy) removeFrom(this.blocking, b, old.id)
  }

  /** Serialize work per key (issue id, or a meta file path). A failed task doesn't block the next. */
  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve()
    const run = prev.then(fn)
    const tail = run.then(() => {}, () => {})
    this.queues.set(key, tail)
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key) })
    return run
  }

  private emit(e: ChangeEvent): void {
    for (const fn of this.listeners) {
      try { fn(e) } catch (err) { console.error('[store] listener failed:', err) }
    }
  }

  /** Append to the feed log (a cache: failures never fail the write) and emit it. */
  private async feed(e: FeedEvent): Promise<void> {
    const project = e.project ?? this.issues.get(e.id)?.project
    const event = project ? { ...e, project } : e
    this.remember(event)
    await appendEvent(this.root, event).catch((err) => console.error('[store] feed append failed:', errMsg(err)))
    this.emit({ kind: 'feed', event })
  }

  /** Read the feed log once at open (a cache: missing or corrupt lines just mean less history). */
  private async loadHistory(): Promise<void> {
    const text = await readFile(feedPath(this.root), 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as FeedEvent
        this.noteFeedStart(e?.at)
        if (e && typeof e.id === 'string' && e.actor && this.issues.has(e.id)) this.remember(e) // deleted issues are forgotten
      } catch { /* partial or corrupt line */ }
    }
  }

  private noteFeedStart(at: unknown): void {
    const t = typeof at === 'string' ? Date.parse(at) : NaN
    if (t < this.feedStart) this.feedStart = t
  }

  private remember(e: FeedEvent): void {
    const t = Date.parse(e.at)
    if (!Number.isFinite(t)) return
    this.noteFeedStart(e.at)
    this.lastWrite.set(e.id, Math.max(t, this.lastWrite.get(e.id) ?? 0))
    if (e.kind === 'status' && e.to && this.config.statuses.find((x) => x.name === e.to)?.type === 'completed') this.doneTimes.set(e.id, t)
    if (e.kind === 'status' && e.to) {
      if (!this.isClosedStatus(e.to)) this.closedTimes.set(e.id, NaN)
      else if (!e.from || !this.isClosedStatus(e.from)) this.closedTimes.set(e.id, t)
    }
    const session = e.actor.actor === 'agent' && e.actor.session ? e.actor.session : undefined
    if (e.kind !== 'status' && !session) return
    const h: HistoryEntry = { t }
    if (e.kind === 'status') { h.from = e.from ?? ''; h.to = e.to ?? '' }
    if (session) h.session = session
    if (e.actor.workspace && e.actor.workspace !== 'external') h.workspace = e.actor.workspace
    if (session && e.actor.client) h.client = e.actor.client
    if (session && e.actor.branch) h.branch = e.actor.branch
    let hist = this.hist.get(e.id)
    if (!hist) this.hist.set(e.id, (hist = new IssueHistory()))
    hist.add(h, this.config.stalled.windowDays * DAY_MS, workingStatus(this.config.statuses, this.config.needsYou.statuses))
  }

  /** Load one meta file; on failure keep the last good value and record the error. Returns true on success (or file gone). */
  private async loadMeta(path: string, fn: () => Promise<void>, notify: boolean): Promise<boolean> {
    try {
      await fn()
      this.errors.delete(path)
      return true
    } catch (e) {
      if (isMissing(e)) { this.errors.delete(path); return true }
      const message = errMsg(e)
      this.errors.set(path, message)
      if (notify) this.emit({ kind: 'error', path, message })
      return false
    }
  }

  private loadConfig(notify = false) {
    return this.loadMeta(this.configPath, async () => { this.config = await readConfig(this.root) }, notify)
  }
  private loadLabels(notify = false) {
    return this.loadMeta(join(this.root, 'labels.yml'), async () => { this.labels = await readLabels(this.root) }, notify)
  }
  private loadViews(notify = false) {
    return this.loadMeta(join(this.root, 'views'), async () => { this.views = await readViews(this.root) }, notify)
  }
  /**
   * (Re)read every `themes/*.yml`. One bad file is a file error and is skipped; the others still load. Always true
   * (the caller emits `meta`, so clients refetch the theme list and the cleared errors); new errors also emit `error`.
   */
  private async loadThemes(notify = false): Promise<boolean> {
    const dir = join(this.root, 'themes')
    const names = await readdir(dir).then((ns) => ns.filter((n) => n.endsWith('.yml') && !n.startsWith('.')).sort(), () => [] as string[])
    for (const p of [...this.errors.keys()]) if (p.startsWith(dir + sep)) this.errors.delete(p)
    const themes: Theme[] = []
    const byName = new Map<string, string>() // lower-case name -> the file that has it (the first by file name wins)
    for (const n of names) {
      const path = join(dir, n)
      try {
        const t = parseThemeFile(await readFile(path, 'utf8'), n)
        const taken = byName.get(t.name.toLowerCase())
        if (taken) throw new Error(`name: "${t.name}" is already the name of themes/${taken}; pick another`)
        byName.set(t.name.toLowerCase(), n)
        themes.push(t)
      } catch (e) {
        if (isMissing(e)) continue
        const message = errMsg(e)
        this.errors.set(path, message)
        if (notify) this.emit({ kind: 'error', path, message })
      }
    }
    this.themes = themes
    return true
  }

  /** Fresh parse of the project's files (picks up hand edits the watcher hasn't delivered yet); a broken file throws rather than being overwritten. */
  private async freshProject(known: Project): Promise<Project> {
    try {
      return await readProject(join(this.root, 'projects', known.slug))
    } catch (e) {
      if (isMissing(e)) throw new Error(`project "${known.slug}" not found (its project.md is gone)`)
      throw e
    }
  }

  private loadProject(slug: string, notify = false) {
    const dir = join(this.root, 'projects', slug)
    return this.loadMeta(join(dir, 'project.md'), async () => {
      try {
        this.projects.set(slug, await readProject(dir))
      } catch (e) {
        if (isMissing(e)) this.projects.delete(slug)
        throw e
      }
    }, notify)
  }
}

function addTo(m: Map<string, Set<string>>, k: string, v: string) {
  let s = m.get(k)
  if (!s) m.set(k, (s = new Set()))
  s.add(v)
}
function removeFrom(m: Map<string, Set<string>>, k: string, v: string) {
  const s = m.get(k)
  if (!s) return
  s.delete(v)
  if (s.size === 0) m.delete(k)
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Names of model fields that differ (excluding bookkeeping: updated, touchedBy, path). */
function changedFields(a: Issue, b: Issue): string[] {
  const skip = new Set(['updated', 'touchedBy', 'path'])
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((k) => !skip.has(k) && !same((a as unknown as Record<string, unknown>)[k], (b as unknown as Record<string, unknown>)[k]))
}

/**
 * Feed events for a change (engine update or watcher reload): status / parent / blocked get their own
 * kinds, appended activity entries become 'comment', everything else one 'updated'.
 */
function diffFeed(prev: Issue, next: Issue, actor: Actor, at: string): FeedEvent[] {
  const out: FeedEvent[] = []
  const base = { at, actor, id: next.id }
  const opt = (k: 'from' | 'to', v: string | null) => (v ? { [k]: v } : {})
  const fields = changedFields(prev, next)
  if (fields.includes('status')) out.push({ ...base, kind: 'status', from: prev.status, to: next.status })
  if (fields.includes('parent')) out.push({ ...base, kind: 'parent', ...opt('from', prev.parent), ...opt('to', next.parent) })
  if (fields.includes('blockedBy')) out.push({ ...base, kind: 'blocked', ...opt('from', prev.blockedBy.join(', ')), to: next.blockedBy.join(', ') })
  if (fields.includes('activity') && next.activity.length > prev.activity.length) {
    for (const e of next.activity.slice(prev.activity.length)) out.push({ ...base, kind: 'comment', text: e.body.slice(0, 200) })
  }
  const rest = fields.filter((f) => f !== 'status' && f !== 'parent' && f !== 'blockedBy' && f !== 'activity')
  if (rest.length) out.push({ ...base, kind: 'updated', text: rest.join(', ') })
  return out
}
