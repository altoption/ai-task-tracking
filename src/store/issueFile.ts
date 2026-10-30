import { Document, isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'
import type { ActivityEntry, Actor, Issue, PlanSlot, Priority } from '../model'

export class IssueParseError extends Error {
  constructor(public path: string, message: string) {
    super(message)
    this.name = 'IssueParseError'
  }
}

// Known front-matter keys in canonical order (file keys are snake_case).
const KNOWN = [
  'id', 'title', 'status', 'priority', 'labels', 'parent', 'blocked_by', 'related', 'milestone',
  'due', 'plan', 'links', 'created', 'updated', 'touched_by',
] as const
const KNOWN_SET = new Set<string>(KNOWN)

// Structural lines (only ever honoured at column 0). Escaped copies carry extra leading spaces.
const STRUCT = /^( *)(### \d{4}-\d{2}-\d{2}T\S+ · |## Activity$)/
const ESCAPED = /^ ( *)(### \d{4}-\d{2}-\d{2}T\S+ · |## Activity$)/
const HEADING = /^### (\d{4}-\d{2}-\d{2}T\S+) · (.*)$/

/** Hidden per-Issue state used to re-emit untouched front matter verbatim. */
const SRC = Symbol('issueFile.source')
interface Source { raw: string; doc: Document; snapshot: Record<string, string>; eol: string }

// ---------- escaping ----------
const escapeBody = (s: string) => s.split('\n').map((l) => (STRUCT.test(l) ? ' ' + l : l)).join('\n')
const unescapeBody = (s: string) => s.split('\n').map((l) => (ESCAPED.test(l) ? l.slice(1) : l)).join('\n')
const trimEnd = (s: string) => s.replace(/\n+$/, '')

// ---------- front matter <-> model ----------
function actorFromFile(v: unknown): Actor | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const a: Actor = { actor: (o.actor === 'agent' ? 'agent' : 'you') }
  const ws = o.repo ?? o.workspace
  if (typeof ws === 'string') a.workspace = ws
  if (typeof o.branch === 'string') a.branch = o.branch
  if (o.session !== undefined && o.session !== null) a.session = String(o.session)
  if (typeof o.client === 'string') a.client = o.client
  return a
}
function actorToFile(a: Actor): Record<string, unknown> {
  const o: Record<string, unknown> = { actor: a.actor }
  if (a.workspace !== undefined) o.workspace = a.workspace
  if (a.branch !== undefined) o.branch = a.branch
  if (a.session !== undefined) o.session = a.session
  if (a.client !== undefined) o.client = a.client
  return o
}

/** The file-keyed value of every front-matter key the model currently implies (known keys, then extras). */
function frontMatterOf(i: Issue): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    id: i.id, title: i.title, status: i.status, priority: i.priority, labels: i.labels,
    parent: i.parent, blocked_by: i.blockedBy, related: i.related, milestone: i.milestone,
    due: i.due, plan: i.plan, links: i.links, created: i.created, updated: i.updated,
  }
  if (i.touchedBy) fm.touched_by = actorToFile(i.touchedBy)
  for (const [k, v] of Object.entries(i.extra)) fm[k] = v
  return fm
}
const snap = (fm: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(fm).map(([k, v]) => [k, JSON.stringify(v ?? null)]))

function node(doc: Document, v: unknown) {
  const n = doc.createNode(v)
  if (isSeq(n) || isMap(n)) (n as YAMLSeq | YAMLMap).flow = true
  return n
}

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

// ---------- parse ----------
/** Unquoted top-level keys of a front-matter block, for the lite parser's (partial) duplicate-key check. */
function hasDuplicateTopKey(raw: string): boolean {
  const seen = new Set<string>()
  for (const l of raw.split('\n')) {
    const k = /^([^\s#:-][^:]*?)\s*:(?:\s|$)/.exec(l)?.[1]
    if (k === undefined) continue
    if (seen.has(k)) return true
    seen.add(k)
  }
  return false
}

/**
 * Parse an issue file. `lite: true` (bulk loading) uses Bun's native YAML parser and attaches no
 * hidden source, so the result serializes canonically rather than verbatim. Use it only for
 * read-only indexing; re-parse in full before modifying and writing back.
 *
 * Lite is NOT strictly equivalent to the full parser: it falls back to the full parser only for a
 * duplicate unquoted top-level key. Nested duplicate keys, quoted duplicate keys and `<<` merge keys
 * can load under lite yet be rejected (or read differently) by the full parse on the next update.
 */
export function parseIssue(text: string, path: string, project: string, opts?: { lite?: boolean }): Issue {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  if (eol === '\r\n') text = text.replace(/\r\n/g, '\n')
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text)
  if (!m) throw new IssueParseError(path, 'missing YAML front matter (file must start with ---)')
  const raw = m[1]!
  const lite = !!opts?.lite && !hasDuplicateTopKey(raw)
  let doc: Document | undefined
  let fm: unknown
  if (lite) {
    try {
      fm = Bun.YAML.parse(raw)
    } catch (e) {
      throw new IssueParseError(path, `invalid YAML front matter: ${e instanceof Error ? e.message : String(e)}`)
    }
  } else {
    doc = parseDocument(raw)
    if (doc.errors.length) throw new IssueParseError(path, `invalid YAML front matter: ${doc.errors[0]!.message}`)
    fm = doc.toJS() as unknown
  }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) throw new IssueParseError(path, 'front matter must be a YAML mapping')
  const o = fm as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) throw new IssueParseError(path, 'front matter is missing "id"')

  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (!KNOWN_SET.has(k)) extra[k] = v

  const body = text.slice(m[0].length)
  const lines = body.split('\n')
  // The activity section starts at the last column-0 `## Activity` only when nothing but empty
  // lines separates it from a well-formed entry heading. Otherwise (hand-written text, a malformed
  // first heading, or no entry at all) that line and everything up to the first well-formed heading
  // stay description text, so no byte is ever dropped. Files the engine writes never hit this.
  const actIdx = lines.lastIndexOf('## Activity')
  let descEnd = lines.length // description = lines[0, descEnd)
  let entriesFrom = lines.length // activity entries are parsed from here
  if (actIdx !== -1) {
    let k = actIdx + 1
    while (k < lines.length && lines[k] === '') k++
    if (k < lines.length && HEADING.test(lines[k]!)) {
      descEnd = actIdx
      entriesFrom = k
    } else {
      while (k < lines.length && !HEADING.test(lines[k]!)) k++
      descEnd = entriesFrom = k
    }
  }
  const description = unescapeBody(trimEnd(lines.slice(0, descEnd).join('\n')))

  const activity: ActivityEntry[] = []
  if (entriesFrom < lines.length) {
    let cur: { head: RegExpExecArray; lines: string[] } | null = null
    const flush = () => {
      if (!cur) return
      activity.push(entryFrom(cur.head, unescapeBody(trimEnd(cur.lines.join('\n')))))
    }
    for (const l of lines.slice(entriesFrom)) {
      const h = HEADING.exec(l)
      if (h) { flush(); cur = { head: h, lines: [] } } else if (cur) cur.lines.push(l)
    }
    flush()
  }

  const issue: Issue = {
    id: o.id,
    title: String(o.title ?? ''),
    status: String(o.status ?? ''),
    priority: (typeof o.priority === 'number' ? o.priority : 0) as Priority,
    labels: strArr(o.labels),
    parent: strOrNull(o.parent),
    blockedBy: strArr(o.blocked_by),
    related: strArr(o.related),
    milestone: strOrNull(o.milestone),
    due: strOrNull(o.due),
    plan: (strOrNull(o.plan) as PlanSlot),
    links: Array.isArray(o.links) ? (o.links as { title: string; url: string }[]).map((l) => ({ title: String(l.title), url: String(l.url) })) : [],
    created: String(o.created ?? ''),
    updated: String(o.updated ?? ''),
    extra, description, activity, project, path,
  }
  const touched = actorFromFile(o.touched_by)
  if (touched) issue.touchedBy = touched

  if (!doc) return issue
  const source: Source = { raw, doc, snapshot: snap(frontMatterOf(issue)), eol }
  Object.defineProperty(issue, SRC, { value: source, enumerable: false, writable: true })
  return issue
}

function entryFrom(h: RegExpExecArray, body: string): ActivityEntry {
  // rest: "<actor>" | "<actor> · <workspace>" | "<actor> · <workspace> (<branch>)"
  const [actor = '', ...restParts] = h[2]!.split(' · ')
  const rest = restParts.join(' · ')
  const e: ActivityEntry = { at: h[1]!, actor: actor.trim(), body }
  if (rest) {
    const b = /^(.*) \((.*)\)$/.exec(rest)
    if (b) { e.workspace = b[1]!; e.branch = b[2]! } else e.workspace = rest
  }
  return e
}


const YOPTS = { lineWidth: 0, flowCollectionPadding: false } as const

/** Patch only the changed top-level keys into the original raw front-matter text. */
function patchRaw(src: Source, fm: Record<string, unknown>, now: Record<string, string>): string {
  const lines = src.raw.split('\n')
  // top-level key blocks: key line + following indented lines
  const blocks = new Map<string, { start: number; end: number }>()
  for (let i = 0; i < lines.length; i++) {
    const k = /^([A-Za-z_][\w-]*)\s*:/.exec(lines[i]!)?.[1]
    if (!k) continue
    // Indented (or `- `) lines continue the block; empty lines belong to it only when another
    // continuation line follows (block scalars like `title: |` may contain blank lines).
    let end = i + 1
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!
      if (/^[ \t]+\S|^- /.test(l)) end = j + 1
      else if (!/^[ \t]*$/.test(l)) break
    }
    blocks.set(k, { start: i, end })
  }
  const edits: { start: number; end: number; text: string[] }[] = []
  const appended: string[] = []
  const render = (k: string, v: unknown) => {
    const d = new Document({})
    d.contents = d.createNode({})
    d.set(k, v !== null && typeof v === 'object' ? node(d, v) : v)
    return d.toString(YOPTS).replace(/\n+$/, '')
  }
  for (const [k, v] of Object.entries(fm)) {
    if (src.snapshot[k] === now[k]) continue
    const b = blocks.get(k)
    if (!b) { appended.push(render(k, v)); continue }
    let text = render(k, v)
    // keep a trailing same-line comment (and its padding)
    const old = src.doc.get(k, true) as { comment?: string } | null
    const c = old && typeof old === 'object' ? old.comment : undefined
    if (c !== undefined) {
      const first = lines[b.start]!
      const idx = first.lastIndexOf('#' + c)
      if (idx > 0) text += /\s*$/.exec(first.slice(0, idx))![0] + first.slice(idx)
    }
    edits.push({ start: b.start, end: b.end, text: text.split('\n') })
  }
  for (const k of Object.keys(src.snapshot)) {
    if (k in now) continue
    const b = blocks.get(k)
    if (b) edits.push({ start: b.start, end: b.end, text: [] })
  }
  edits.sort((x, y) => y.start - x.start)
  for (const e of edits) lines.splice(e.start, e.end - e.start, ...e.text)
  return [...lines, ...appended].join('\n')
}

// ---------- serialize ----------
function frontMatterText(issue: Issue): string {
  const fm = frontMatterOf(issue)
  const src = (issue as unknown as Record<symbol, Source | undefined>)[SRC]
  if (src) {
    const now = snap(fm)
    const same = Object.keys(now).length === Object.keys(src.snapshot).length &&
      Object.entries(now).every(([k, v]) => src.snapshot[k] === v)
    if (same) return src.raw
    return patchRaw(src, fm, now)
  }
  const doc = new Document({})
  doc.contents = doc.createNode({})
  for (const [k, v] of Object.entries(fm)) {
    if (v !== null && typeof v === 'object') doc.set(k, node(doc, v))
    else doc.set(k, v)
  }
  return doc.toString(YOPTS).replace(/\n+$/, '')
}

export function serializeIssue(issue: Issue): string {
  let out = `---\n${frontMatterText(issue)}\n---\n`
  const desc = trimEnd(issue.description)
  if (desc) out += escapeBody(desc) + '\n'
  if (issue.activity.length) {
    out += `${desc ? '\n' : ''}## Activity\n`
    for (const e of issue.activity) {
      let head = `### ${e.at} · ${e.actor}`
      if (e.workspace) head += ` · ${e.workspace}${e.branch ? ` (${e.branch})` : ''}`
      out += head + '\n'
      const b = trimEnd(e.body)
      if (b) out += escapeBody(b) + '\n'
    }
  }
  const eol = (issue as unknown as Record<symbol, Source | undefined>)[SRC]?.eol ?? '\n'
  return eol === '\n' ? out : out.replace(/\n/g, eol)
}

// ---------- read-back verification ----------
/** JSON with object keys sorted, so key order never counts as a difference. */
function stable(v: unknown): string {
  return JSON.stringify(v ?? null, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x)
}
/** Text as the file format stores it: CRLF read as LF (a file is either LF or CRLF), trailing newlines dropped (R22). */
const fmtText = (s: string) => trimEnd(String(s ?? '').replace(/\r\n/g, '\n'))
/** The parts of an issue that its file must reproduce exactly, normalized the way the format defines. */
function persisted(i: Issue): Record<string, unknown> {
  const t = i.touchedBy ? actorFromFile(actorToFile(i.touchedBy)) : undefined
  return {
    id: i.id, title: String(i.title ?? ''), status: String(i.status ?? ''), priority: i.priority ?? 0,
    labels: i.labels.map(String), parent: i.parent ?? null, blockedBy: i.blockedBy.map(String), related: i.related.map(String),
    milestone: i.milestone ?? null, due: i.due ?? null, plan: i.plan ?? null,
    links: i.links.map((l) => ({ title: String(l.title), url: String(l.url) })),
    created: i.created, updated: i.updated, touchedBy: t ?? null,
    description: fmtText(i.description),
    activity: i.activity.map((e) => ({
      at: e.at, actor: e.actor, workspace: e.workspace ?? null, branch: e.workspace ? e.branch ?? null : null, body: fmtText(e.body),
    })),
    extra: i.extra,
  }
}

/**
 * Compare the issue the engine meant to write with the issue its serialized text parses back to.
 * Returns the names of fields that differ (empty = safe to write).
 */
export function readBackMismatch(intended: Issue, readBack: Issue): string[] {
  const a = persisted(intended), b = persisted(readBack)
  return Object.keys(a).filter((k) => stable(a[k]) !== stable(b[k]))
}
