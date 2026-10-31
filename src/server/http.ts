import { realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Actor, Issue, IssueSummary } from '../model'
import { readFeed } from '../engine/eventlog'
import type { GitStatus, SyncResult } from '../engine/git'
import { ciBadge, issueCi, type CiHealth } from '../engine/ci'
import { attemptsOf } from '../engine/attempts'
import { allThemes, selectedTheme } from '../engine/themes'
import {
  feedVisibleTest, hiddenHealth, hiddenProjectsOut, hiddenSlugs, inHiddenFolder, visibleNextNumber, visibleParts, visibleTest,
} from '../engine/hidden'
import { ancestors, home, needsYouCount, needsYouList, progress, search, writerWorkspaces } from '../engine/queries'
import type { ChangeEvent, Store } from '../engine/store'
import { callTool, issueOut, ToolError, type ToolCtx } from '../tools/handlers'
import { toolSchemas } from '../tools/schemas'
import { defaultDocs, defaultUi, type UiSource } from './uiAssets'

const HEARTBEAT_MS = 15_000
const SSE_QUEUE_LIMIT = 256 // undrained chunks tolerated per client
const UI_DIST = resolve(import.meta.dir, '../../ui/dist')
const DOCS_DIST = resolve(import.meta.dir, '../../site/dist/docs')

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>AI Task Tracking</title>
<body style="font:16px system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem">
<h1>AI Task Tracking is running</h1><p>The UI has not been built yet (<code>ui/dist</code> is missing). The JSON API is available under <code>/api</code>.</p></body>`

/**
 * An issue without its body. With `visible` (the UI's summaries; src/engine/hidden.ts), children, progress and the
 * issues it blocks count only issues in visible projects, so a visible epic says nothing about hidden children.
 */
export function summarize(s: Store, i: Issue, visible?: (i: Issue) => boolean): IssueSummary {
  const { description: _d, activity: _a, extra: _e, path: _p, ...rest } = i
  const ci = ciBadge(s.ci, i)
  const shown = (id: string) => { const x = s.get(id); return !x || visible!(x) }
  return {
    ...rest,
    childCount: visible ? s.children(i.id).filter(visible).length : s.children(i.id).length,
    progress: progress(s, i.id, visible),
    blocks: visible ? s.blocks(i.id).filter(shown) : s.blocks(i.id),
    workspaces: writerWorkspaces(i),
    ...(ci ? { ci } : {}),
  }
}

/** A hidden issue linked from a visible one (a child or an ancestor): only its id, shown as "in a hidden project". */
export interface HiddenStub { id: string; hidden: true }


/**
 * `/api/home` with summaries (cheap, and carries `workspaces` for the switcher); Needs-you items carry
 * `stalled: <reason>` and `ciReason: "CI failing on PR #12"` when those apply.
 */
function homeOut(s: Store) {
  const visible = visibleTest(s)
  const h = home(s, Date.now(), { visible })
  const sum = (i: Issue) => summarize(s, i, visible)
  return {
    needsYou: h.needsYou.map((i) => {
      const reason = h.stalled.get(i.id)
      const ci = h.ci.get(i.id)
      return { ...sum(i), ...(reason ? { stalled: reason } : {}), ...(ci ? { ciReason: ci } : {}) }
    }),
    inProgress: h.inProgress.map(sum),
    readyNext: h.readyNext.map((x) => ({ issue: sum(x.issue), unblocks: x.unblocks })),
    blocked: h.blocked.map((x) => ({ issue: sum(x.issue), blockers: x.blockers })),
  }
}

function ciProblems(s: Store, i: Issue): { ciProblems?: Record<string, string> } {
  const out: Record<string, string> = {}
  for (const l of i.links) { const p = s.ci?.problem(l.url); if (p) out[l.url] = p }
  return Object.keys(out).length ? { ciProblems: out } : {}
}

/**
 * SSE/wire form of a store event: issue events carry summaries, never full issues. The stream feeds the UI and the
 * app's notifications, so hidden projects (src/engine/hidden.ts) stay out of it: a change to an issue in a hidden
 * project goes out only as `{ kind: 'hidden', id, project, parent? }` (the UI drops the issue if it had it, and a
 * page showing it, its parent or a relation refetches), feed events of hidden issues become the same (a deleted one's
 * are dropped), CI changes leave them out, and file errors and file events inside a hidden project's folder aren't
 * sent. Null: send nothing.
 */
export function wireEvent(s: Store, e: ChangeEvent): unknown {
  if (e.kind === 'meta' || e.kind === 'removed') return e
  const hidden = hiddenSlugs(s)
  const touched = (i: Issue, prev?: Issue) => {
    // What else a page may be showing it on: the project and parent it left, and issues it newly (un)blocks or relates to.
    const rel = prev
      ? [...symDiff(prev.blockedBy, i.blockedBy), ...symDiff(prev.related, i.related)]
      : [...i.blockedBy, ...i.related]
    return {
      kind: 'hidden', id: i.id, project: i.project, ...(i.parent ? { parent: i.parent } : {}),
      ...(prev && prev.project !== i.project ? { prevProject: prev.project } : {}),
      ...(prev?.parent && prev.parent !== i.parent ? { prevParent: prev.parent } : {}),
      ...(rel.length ? { rel: [...new Set(rel)] } : {}),
    }
  }
  if (e.kind === 'issue') {
    if (hidden.has(e.issue.project)) return touched(e.issue, e.prev)
    const visible = visibleTest(s)
    const { issue, prev, comment, ...rest } = e
    return { ...rest, issue: summarize(s, issue, visible), ...(prev ? { prev: summarize(s, prev, visible) } : {}), ...(comment ? { comment } : {}) }
  }
  if (!hidden.size) return e
  if (e.kind === 'feed') {
    const i = s.get(e.event.id)
    if (i) return hidden.has(i.project) ? touched(i) : e
    return feedVisibleTest(s)!(e.event) ? e : null
  }
  if (e.kind === 'ci') {
    const changes = Object.fromEntries(Object.entries(e.changes).filter(([id]) => { const i = s.get(id); return !i || !hidden.has(i.project) }))
    return Object.keys(changes).length ? { ...e, changes } : null
  }
  if (e.kind === 'error' || e.kind === 'file') return inHiddenFolder(s, e.path) ? null : e
  return e
}

/** Ids in exactly one of the two lists. */
function symDiff(a: string[], b: string[]): string[] {
  return [...a.filter((x) => !b.includes(x)), ...b.filter((x) => !a.includes(x))]
}

/**
 * The UI's copy of everything: issue summaries, config, labels, projects, views, file errors and themes, with hidden
 * projects left out (visibleParts). `hidden` names what is left out, for direct links only: the hidden projects that
 * exist (slug and name) and the ids of their issues.
 */
export function buildSnapshot(s: Store) {
  const v = visibleParts(s)
  const visible = visibleTest(s)
  const nextNumber = visibleNextNumber(s)
  const config = v.workspaces === s.config.workspaces && nextNumber === s.config.nextNumber ? s.config : { ...s.config, workspaces: v.workspaces, nextNumber }
  return {
    issues: v.issues.map((i) => summarize(s, i, visible)),
    config,
    labels: v.labels,
    projects: v.projects,
    views: s.views,
    errors: [...s.errors].filter(([path]) => !inHiddenFolder(s, path)).map(([path, message]) => ({ path, message })),
    themes: themesOut(s),
    hidden: { projects: hiddenProjectsOut(s), issues: v.hiddenIds },
  }
}

/**
 * The theme list (built-ins, then `themes/*.yml`), the chosen id as configured (`theme` in config.yml) and the one
 * actually shown (`effective`: an unknown id, such as a deleted theme file, shows Dark).
 */
export function themesOut(s: Store) {
  const list = allThemes(s.themes)
  return { selected: s.config.theme, effective: selectedTheme(list, s.config.theme).id, list }
}

/**
 * For the app (in /api/health): `selected` and `effective` as in the snapshot (themesOut), and per theme what its
 * window needs: id, name, base (`system` follows macOS) and background color.
 */
function themeHealth(s: Store) {
  const { selected, effective, list } = themesOut(s)
  return {
    selected, effective,
    themes: list.map((t) => ({ id: t.id, name: t.name, base: t.base, ...(t.base === 'system' ? {} : { bg: t.colors.bg }) })),
  }
}

export interface RunningServer {
  port: number
  /** Stop listening, wait (up to drainMs) for in-flight API requests to finish, then close SSE streams and the rest. */
  stop(drainMs?: number): Promise<void>
}
export interface ServerOpts {
  port: number; version: string; hostname?: string; uiDir?: string
  /** `sync` backs POST /api/sync (503 without it). */
  git?: { status(): GitStatus; sync?(opts: { push: boolean }): Promise<SyncResult>; refresh?(): Promise<GitStatus> }
  /** Overrides uiDir: where the UI comes from (tests pass an embedded source). */
  ui?: UiSource
  /** Where the docs site served at /docs/ comes from (default: embedded in the binary, else site/dist/docs). */
  docs?: UiSource
  /** The CI refresher (src/engine/ci.ts): its state in /api/health, and POST /api/ci for the app's setting. */
  ci?: { health(): CiHealth; setSetting(on: boolean): void }
}

const json = (body: unknown, status = 200) => Response.json(body, { status })
const fail = (status: number, error: string) => json({ error }, status)

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', woff2: 'font/woff2', map: 'application/json', txt: 'text/plain; charset=utf-8',
  // The docs site: Pagefind's search index is compressed binary (.pagefind holds its wasm).
  wasm: 'application/wasm', pagefind: 'application/octet-stream', pf_meta: 'application/octet-stream',
  pf_index: 'application/octet-stream', pf_fragment: 'application/octet-stream', webp: 'image/webp', woff: 'font/woff',
}
const mimeOf = (name: string) => MIME[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'

function serveStatic(ui: UiSource, pathname: string): Response {
  const rel = pathname === '/' || pathname === '' ? 'index.html' : pathname.slice(1)
  let name: string
  try { name = decodeURIComponent(rel) } catch { return fail(400, 'bad path') }
  const file = ui.get(name)
  if (!file) {
    return name === 'index.html' ? new Response(PLACEHOLDER, { headers: { 'content-type': MIME.html! } }) : fail(404, 'not found')
  }
  return new Response(file, { headers: { 'content-type': mimeOf(name) } })
}

const DOCS_MISSING = `<!doctype html><meta charset="utf-8"><title>Docs not built</title>
<body style="font:16px system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem">
<h1>The docs aren't in this build</h1><p>Build them with <code>bun run docs:build</code> (or <code>bun run build</code> for the binary).</p></body>`

/** Astro's `_astro/` files carry a content hash in their names, so they never change; pages and Pagefind's index do. */
const docsCache = (name: string) => (name.startsWith('_astro/') ? 'public, max-age=31536000, immutable' : 'no-cache')

/**
 * `GET /docs/…` → the built docs site. `/docs` redirects to `/docs/`, a folder serves its index.html, and a page
 * path without its trailing slash redirects to it. Anything else missing is a 404 (the site's own 404 page),
 * never the UI. Only plain segments resolve: no `..`, dotfiles, backslashes or NULs, whatever their encoding.
 */
export function serveDocs(docs: UiSource, pathname: string, search = ''): Response {
  if (pathname === '/docs') return new Response(null, { status: 301, headers: { location: `/docs/${search}` } })
  let rel: string
  try { rel = decodeURIComponent(pathname.slice('/docs/'.length)) } catch { return fail(400, 'bad path') }
  const segments = rel.split('/')
  const plain = segments.every((s, i) => (s === '' ? i === segments.length - 1 : !s.startsWith('.') && !/[\\\0]/.test(s)))
  const notFound = () => {
    const page = docs.get('index.html') ? docs.get('404.html') : DOCS_MISSING
    return page ? new Response(page, { status: 404, headers: { 'content-type': MIME.html!, 'cache-control': 'no-cache' } }) : fail(404, 'not found')
  }
  if (!plain) return notFound()
  const name = rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel
  const file = docs.get(name)
  if (file) return new Response(file, { headers: { 'content-type': mimeOf(name), 'x-content-type-options': 'nosniff', 'cache-control': docsCache(name) } })
  if (!rel.endsWith('/') && docs.get(`${rel}/index.html`)) return new Response(null, { status: 301, headers: { location: `${pathname}/${search}` } })
  return notFound()
}

/** Attachments: images and video that issue markdown links as `../files/<name>` (rewritten by the UI). */
const FILE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8',
}
// Opened directly, a file (e.g. an SVG with script) must not run in the app's origin, which can call tools.
const FILE_HEADERS = { 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'" }
const plainSegment = (s: string) => s !== '' && !s.startsWith('.') && !/[/\\\0]/.test(s)

/** `GET /files/<slug>/<name>` → `<root>/projects/<slug>/files/<name>`; one plain segment each, no dotfiles, no symlinks out. */
export function serveDataFile(root: string, rawSlug: string, rawName: string): Response {
  let slug: string, name: string
  try { slug = decodeURIComponent(rawSlug); name = decodeURIComponent(rawName) } catch { return fail(400, 'bad path') }
  if (!plainSegment(slug) || !plainSegment(name)) return fail(404, 'not found')
  const dir = join(root, 'projects', slug, 'files')
  const full = join(dir, name)
  try {
    if (!statSync(full).isFile()) return fail(404, 'not found')
    const real = realpathSync(full)
    if (!real.startsWith(realpathSync(dir) + sep)) return fail(404, 'not found')
  } catch { return fail(404, 'not found') }
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return new Response(Bun.file(full), { headers: { 'content-type': FILE_MIME[ext] ?? 'application/octet-stream', ...FILE_HEADERS } })
}

export function sseResponse(store: Store, signal: AbortSignal): Response {
  let unsub = () => {}
  let beat: ReturnType<typeof setInterval> | undefined
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const cleanup = () => { unsub(); if (beat) clearInterval(beat) }
      const send = (chunk: string) => {
        // A reader that stopped draining gets dropped (it reconnects and refetches the snapshot) rather than queued forever.
        if ((c.desiredSize ?? 1) <= 0) { cleanup(); try { c.close() } catch { /* already closed */ } return }
        try { c.enqueue(enc.encode(chunk)) } catch { cleanup() }
      }
      unsub = store.on((e) => {
        const wire = wireEvent(store, e)
        if (wire !== null) send(`data: ${JSON.stringify(wire)}\n\n`)
      })
      beat = setInterval(() => send(': heartbeat\n\n'), HEARTBEAT_MS)
      signal.addEventListener('abort', cleanup)
      send(': connected\n\n')
    },
    cancel() { unsub(); if (beat) clearInterval(beat) },
  }, new CountQueuingStrategy({ highWaterMark: SSE_QUEUE_LIMIT }))
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } })
}

async function toolRoute(store: Store, name: string, req: Request): Promise<Response> {
  if (!toolSchemas[name]) return fail(404, `Unknown tool "${name}". Available tools: ${Object.keys(toolSchemas).join(', ')}.`)
  let body: { args?: unknown; ctx?: { actor?: Actor } }
  try { body = (await req.json()) as typeof body } catch { return fail(400, 'Request body must be JSON: { "args": {...} }') }
  if (!body || typeof body !== 'object') return fail(400, 'Request body must be a JSON object')
  let ctx: ToolCtx = { actor: { actor: 'you' } }
  if (req.headers.get('x-tracker-agent') === '1') {
    const a = body.ctx?.actor
    if (!a || a.actor !== 'agent') return fail(400, 'ctx.actor.actor must be "agent" when X-Tracker-Agent is set')
    ctx = { actor: a }
  }
  try {
    return json(await callTool(store, name, body.args ?? {}, ctx))
  } catch (e) {
    if (e instanceof ToolError) return fail(400, e.message)
    return fail(500, e instanceof Error ? e.message : String(e))
  }
}

/**
 * What counts as Needs-you and as done, for clients that classify events themselves (the app's notifications), and
 * the stalled thresholds (config.stalled; the engine applies them, `stalled` in /api/health is the result).
 */
function rules(s: Store) {
  return {
    needsYouStatuses: s.config.needsYou.statuses, needsYouLabels: s.config.needsYou.labels,
    doneStatuses: s.config.statuses.filter((x) => x.type === 'completed').map((x) => x.name),
    stalled: s.config.stalled,
  }
}

/** `POST /api/ci` `{ "enabled": false }` — the app's "Show CI status" setting (the owner only, never agents). */
async function ciRoute(ci: ServerOpts['ci'], req: Request): Promise<Response> {
  if (req.headers.get('x-tracker-agent') === '1') return fail(403, 'agents cannot change the CI status setting')
  if (!ci) return fail(503, 'CI status is not available')
  let body: { enabled?: unknown }
  try { body = await req.json() as typeof body } catch { return fail(400, 'Request body must be JSON: { "enabled": true|false }') }
  if (typeof body?.enabled !== 'boolean') return fail(400, 'Request body must be JSON: { "enabled": true|false }')
  ci.setSetting(body.enabled)
  return json(ci.health())
}

/** `POST /api/theme` `{ "theme": "light" }` — choose the UI theme (the owner only: the app's Settings and ⌘K). */
async function themeRoute(store: Store, req: Request): Promise<Response> {
  if (req.headers.get('x-tracker-agent') === '1') return fail(403, 'agents cannot change the theme')
  let body: { theme?: unknown }
  try { body = await req.json() as typeof body } catch { return fail(400, 'Request body must be JSON: { "theme": "<id>" }') }
  if (typeof body?.theme !== 'string' || !body.theme) return fail(400, 'Request body must be JSON: { "theme": "<id>" }')
  try {
    await store.setTheme(body.theme)
  } catch (e) {
    return fail(400, e instanceof Error ? e.message : String(e))
  }
  return json(themeHealth(store))
}

/**
 * `POST /api/hidden-projects` `{ "project": "<slug>", "hidden": true }` — hide or unhide one project folder in the UIs
 * (the owner only: the app's Settings and the project page). One change per request, so the app and a browser
 * changing different projects at once don't undo each other. Answers with the list as /api/health reports it.
 */
async function hiddenProjectsRoute(store: Store, req: Request): Promise<Response> {
  if (req.headers.get('x-tracker-agent') === '1') return fail(403, 'agents cannot hide or unhide projects')
  const usage = 'Request body must be JSON: { "project": "<slug>", "hidden": true|false }'
  let body: { project?: unknown; hidden?: unknown }
  try { body = await req.json() as typeof body } catch { return fail(400, usage) }
  if (typeof body?.project !== 'string' || !plainSegment(body.project) || typeof body.hidden !== 'boolean') return fail(400, usage)
  try {
    await store.setProjectHidden(body.project, body.hidden)
  } catch (e) {
    return fail(400, e instanceof Error ? e.message : String(e))
  }
  return json(hiddenHealth(store))
}

/** `POST /api/sync` — commit now, then push unless the body says `{ "push": false }`. */
async function syncRoute(git: ServerOpts['git'], req: Request): Promise<Response> {
  if (req.headers.get('x-tracker-agent') === '1') return fail(403, 'agents cannot run a sync; the engine commits and pushes on its own')
  if (!git?.sync) return fail(503, 'git sync is not available')
  const text = await req.text()
  let body: { push?: unknown } = {}
  if (text.trim()) {
    try { body = JSON.parse(text) } catch { return fail(400, 'Request body must be JSON: { "push": false } or empty') }
  }
  return json(await git.sync({ push: body?.push !== false }))
}

export function startServer(store: Store, opts: ServerOpts): RunningServer {
  const ui = opts.ui ?? defaultUi(opts.uiDir ?? UI_DIST)
  const docs = opts.docs ?? defaultDocs(DOCS_DIST)
  const inflight = new Set<Promise<Response>>()
  const server = Bun.serve({
    hostname: opts.hostname ?? '127.0.0.1',
    port: opts.port,
    idleTimeout: 0, // SSE streams are long-lived; heartbeats keep proxies honest
    fetch(req) {
      const p = handle(req)
      if (new URL(req.url).pathname !== '/api/events') {
        inflight.add(p)
        void p.finally(() => inflight.delete(p))
      }
      return p
    },
  })
  async function handle(req: Request): Promise<Response> {
      const url = new URL(req.url)
      const host = req.headers.get('host')
      if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) return fail(403, 'forbidden host')
      if (req.method === 'POST' && req.headers.get('x-tracker') !== '1') return fail(403, 'missing X-Tracker header')
      const p = url.pathname
      try {
        if (req.method === 'GET' || req.method === 'HEAD') {
          if (p === '/api/health') {
            // `?fresh=1` (the app's quit check) re-reads ahead/pending from git; the 3 s poll uses the cached status.
            const git = url.searchParams.get('fresh') === '1' && opts.git?.refresh ? await opts.git.refresh() : opts.git?.status() ?? {}
            // `needsYou` counts stalled issues; `stalled` lists the ids in Needs you only because they stalled and
            // `stalledAll` every stalled id (the app notifies once per stalled episode).
            // The menu bar leaves hidden projects out of the count, the stalled ids and their notifications.
            const ny = needsYouCount(store, Date.now(), visibleTest(store))
            return json({
              ok: true, version: opts.version, home: store.root, needsYou: ny.count, stalled: ny.stalledOnly, stalledAll: ny.stalledAll,
              git, rules: rules(store),
              // CI status: on/off, the app's setting as last heard, and a one-line reason when off or failing ("gh not signed in").
              ...(opts.ci ? { ci: opts.ci.health() } : {}),
              theme: themeHealth(store),
              // For the app's Settings: every project and the hidden ones (`hiddenProjects` in config.yml).
              hiddenProjects: hiddenHealth(store),
            })
          }
          if (p === '/api/snapshot') return json(buildSnapshot(store))
          if (p === '/api/home') return json(homeOut(store))
          if (p === '/api/needs-you') {
            // `?stalled=0`: leave stalled-only rows out (before the 50-row cut), for the app with its stalled setting off.
            const opt = { visible: visibleTest(store), ...(url.searchParams.get('stalled') === '0' ? { stalled: false } : {}) }
            return json(needsYouList(store, 50, Date.now(), opt).map(({ issue: i, why, stalled, ci }) => ({
              id: i.id, title: i.title, why, updated: i.updated, ...(stalled ? { stalled } : {}), ...(ci ? { ci } : {}),
            })))
          }
          if (p === '/api/events') return sseResponse(store, req.signal)
          if (p === '/api/feed') {
            const n = Number(url.searchParams.get('limit') ?? 50)
            const limit = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1000) : 50
            const id = url.searchParams.get('id')
            // One issue's history answers for any issue (a direct link); the general feed leaves hidden projects out.
            // Either way reading stops once `limit` entries matched.
            if (id) return json(readFeed(store.root, limit, (e) => e.id === id))
            return json(readFeed(store.root, limit, feedVisibleTest(store)))
          }
          if (p === '/api/search') {
            const visible = visibleTest(store)
            return json(search(store, url.searchParams.get('q') ?? '', 50, visible).map((i) => summarize(store, i, visible)))
          }
          const pm = /^\/api\/projects\/([^/]+)$/.exec(p)
          if (pm) {
            // A direct read (the project page's link), hidden or not: the project, whether it is hidden, its issues.
            // A hidden project was asked for by its path, so its issues count all their children; a visible one's
            // count only visible children, like everywhere else in the UI.
            let slug: string
            try { slug = decodeURIComponent(pm[1]!) } catch { return fail(400, 'malformed project slug') }
            const project = store.projects.get(slug)
            if (!project) return fail(404, `project ${pm[1]} not found`)
            const hidden = hiddenSlugs(store).has(slug)
            const visible = hidden ? undefined : visibleTest(store)
            return json({
              project, hidden,
              issues: store.all().filter((i) => i.project === slug).map((i) => summarize(store, i, visible)),
            })
          }
          const m = /^\/api\/issues\/([^/]+)$/.exec(p)
          if (m) {
            let id: string
            try { id = decodeURIComponent(m[1]!) } catch { return fail(400, 'malformed issue id') }
            const i = store.get(id)
            if (!i) return fail(404, `issue ${m[1]} not found`)
            const ci = issueCi(store.ci, i)
            // A visible issue's hidden children and ancestors are stubs (id only, "in a hidden project"), and its
            // summaries count only visible children. A hidden issue was opened by its link, so it shows its real
            // children and ancestors.
            const all = visibleTest(store)
            const visible = all && all(i) ? all : undefined
            const out = (x: Issue): IssueSummary | HiddenStub => (visible && !visible(x) ? { id: x.id, hidden: true } : summarize(store, x, visible))
            return json({
              ...issueOut(store, i),
              children: store.children(i.id).map(out),
              ancestors: ancestors(store, i.id).map(out),
              blocks: store.blocks(i.id),
              // One per agent session that worked on it, oldest first (src/engine/attempts.ts).
              attempts: attemptsOf(store, i),
              // PR url → its CI status (state, checks, failing names, checkedAt), when CI status is on and known.
              ...(ci.length ? { ci: Object.fromEntries(ci.map((x) => [x.url, x.status])) } : {}),
              // PR url → why it has no status ("no access with gh"): shown on this issue only, never in health.
              ...ciProblems(store, i),
            })
          }
          const f = /^\/files\/([^/]+)\/([^/]+)$/.exec(p)
          if (f) return serveDataFile(store.root, f[1]!, f[2]!)
          if (p.startsWith('/api/') || p.startsWith('/files/')) return fail(404, 'not found')
          if (p === '/docs' || p.startsWith('/docs/')) return serveDocs(docs, p, url.search)
          return serveStatic(ui, p)
        }
        if (req.method === 'POST') {
          const m = /^\/api\/tool\/([^/]+)$/.exec(p)
          if (m) {
            let name: string
            try { name = decodeURIComponent(m[1]!) } catch { return fail(400, 'malformed tool name') }
            return await toolRoute(store, name, req)
          }
          if (p === '/api/sync') return await syncRoute(opts.git, req)
          if (p === '/api/ci') return await ciRoute(opts.ci, req)
          if (p === '/api/theme') return await themeRoute(store, req)
          if (p === '/api/hidden-projects') return await hiddenProjectsRoute(store, req)
          return fail(404, 'not found')
        }
        return fail(405, 'method not allowed')
      } catch (e) {
        return fail(500, e instanceof Error ? e.message : String(e))
      }
  }
  return {
    port: server.port!,
    async stop(drainMs = 3000) {
      void server.stop(false) // stop listening; open connections (SSE) stay until closed below
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled([...inflight]),
        new Promise((r) => { timer = setTimeout(r, drainMs) }),
      ])
      if (timer) clearTimeout(timer)
      await server.stop(true)
    },
  }
}
