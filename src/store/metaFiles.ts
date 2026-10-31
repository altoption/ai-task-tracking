import { constants as fsConstants } from 'node:fs'
import { mkdir, open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import YAML from 'yaml'
import type { Config, LabelDef, Milestone, Project, StatusDef, View } from '../model'
import { atomicWrite, GITIGNORE_LINES } from './atomic'
import { DEFAULT_STALLED, normalizeStalled } from '../engine/stalled'
import { DEFAULT_CI, normalizeCi } from '../engine/ci'
import { DEFAULT_THEME } from '../engine/themes'

export const DEFAULT_STATUSES: StatusDef[] = [
  { name: 'Backlog', type: 'backlog', color: '#bec2c8' },
  { name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
  { name: 'In Progress', type: 'started', color: '#f2c94c' },
  { name: 'Waiting', type: 'started', color: '#f2994a' },
  { name: 'Done', type: 'completed', color: '#5e6ad2' },
  { name: 'Canceled', type: 'canceled', color: '#95a2b3' },
  { name: 'Duplicate', type: 'duplicate', color: '#95a2b3' },
]

export function defaultConfig(): Config {
  return {
    port: 7477,
    statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
    workspaces: {},
    needsYou: { statuses: ['Waiting', 'In Review'], labels: ['Needs decision', 'Needs review'] },
    stalled: { ...DEFAULT_STALLED },
    ci: { ...DEFAULT_CI },
    nextNumber: {},
    theme: DEFAULT_THEME,
    hiddenProjects: [],
  }
}

export const DEFAULT_LABELS: LabelDef[] = [
  { name: 'Bug', group: null, color: '#eb5757' },
  { name: 'Feature', group: null, color: '#bb87fc' },
  { name: 'Improvement', group: null, color: '#4ea7fc' },
  { name: 'Task', group: null, color: '#95a2b3' },
  { name: 'Needs decision', group: null, color: '#f2994a' },
  { name: 'Needs review', group: null, color: '#f2c94c' },
  { name: 'Blocked', group: null, color: '#eb5757' },
]

export const DEFAULT_AGENTS_MD = `# AI Task Tracking — how to track your work

This is the user's issue tracker on this Mac. Your repo (or folder) and branch are recorded on every write automatically. The user watches your changes live.

## Start of a session
- The user names an issue → \`get_issue({ id })\` (or \`get_tree\` for an epic) and work from it.
- Otherwise → \`whats_next()\` and propose what to pick up; or \`list_issues({ project })\`.
- Before creating anything, \`search({ query })\` so you don't duplicate an existing issue.

## New work
- Track every piece of work as an issue before writing code.
- Every issue needs a project (omit it and your repo's mapped project is used) and one type label, plus a scope label if the workspace uses scope labels (see list_issue_labels). Type labels: Bug, Feature, Improvement, Task. Priority: 1 urgent, 2 high, 3 medium, 4 low.
- Multi-step work = an epic with one child per step, created in ONE call; chain the steps with blockedBy:
  \`save_issues({ issues: [ { ref: "epic", title: "Epic: …", labels: ["Feature"] }, { ref: "s1", parentId: "ref:epic", title: "Step 1: …", labels: ["Task"] }, { parentId: "ref:epic", title: "Step 2: …", labels: ["Task"], blockedBy: ["ref:s1"] } ] })\`
- Description: the ask, context, acceptance criteria; decisions under a \`## Decided\` heading (dated).
- Milestones: only for a set of issues in ONE project that must ship together toward a dated or named outcome (a release, a pilot, a demo/customer date). Create one with \`save_milestone\` (targetDate when known) only when the user names that outcome; assign the children, not just the epic, with \`milestone\`. Not for breaking work down (epics), categorising (labels) or across projects; never invent one — ask.

## While working
- Start: \`save_issue({ id, state: "In Progress" })\`.
- Findings, decisions, PRs: \`save_comment({ issueId, body })\` — dated, short, with links (GitHub PR/commit URLs become issue links automatically).
- Dependencies: \`save_issue({ id, addBlockedBy: ["ENG-12"] })\` / \`removeBlockedBy\`. Never leave a dependency only in prose.
- Pausing (ending the session or switching issues): leave a one-line handoff comment: what's done, what's next, what's blocking.
- Editing a description someone else may have changed: pass \`baseDescription\` (the text you read); if refused, re-read and re-apply. Tick a checklist item with \`toggle_task\`.

## Handing back / finishing
- Need the user (decision, review, access): \`save_issue({ id, state: "Waiting", comment: "Needs: … (<date>)" })\`, or add the label "Needs decision" / "Needs review". These show in the user's "Needs you".
- Done: \`save_issue({ id, state: "Done", comment: "Shipped in PR #123 (commit abc123): …" })\`. Moving to Done, Waiting, Canceled or Duplicate requires a \`comment\` (or a \`save_comment\` from you in the last 10 minutes).
- Not doing it: \`state: "Canceled"\` with a reason. Never delete.

## Don't
- Don't set Next/Later on the user's board (\`set_plan\` next/later is the user's); don't create views; don't re-post issues that already exist.
- When you mention an issue to the user, print it as a markdown link plus the app link, from the tool result's \`url\` and \`appUrl\`: \`[ENG-1 Title](http://127.0.0.1:7477/#/issue/ENG-1) · aitt://issue/ENG-1\`.
- If a tool says "AI Task Tracking isn't running", ask the user to open AI Task Tracking from the menu bar. If it says it "didn't reply… may have been applied", check with \`get_issue\`/\`list_issues\` before retrying.
`

// ---------- helpers ----------

const YOPTS = { lineWidth: 0 } as const

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

async function readYaml(path: string): Promise<unknown> {
  return YAML.parse((await readFile(path, 'utf8')).replace(/\r\n/g, '\n'))
}

function pickExtra(raw: Record<string, unknown>, known: string[]): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {}
  for (const k of Object.keys(raw)) if (!known.includes(k)) extra[k] = raw[k]
  return Object.keys(extra).length ? extra : undefined
}

/** Split `---\n<yaml>\n---\n<body>`; handles CRLF and an empty `---\n---` block. Text without front-matter is all body. */
function splitFrontMatter(input: string): { fm: Record<string, unknown>; body: string } {
  const text = input.replace(/\r\n/g, '\n')
  let yamlText: string, body: string
  if (text.startsWith('---\n---\n') || text === '---\n---') {
    yamlText = ''
    body = text.slice(8)
  } else {
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
    if (!m) return { fm: {}, body: text }
    yamlText = m[1]!
    body = m[2]!
  }
  const fm = YAML.parse(yamlText)
  return { fm: isObj(fm) ? fm : {}, body }
}

function withFrontMatter(fm: Record<string, unknown>, body: string): string {
  return `---\n${YAML.stringify(fm, YOPTS)}---\n${body}`
}

/** Write text, keeping CRLF line endings if the existing file used them. */
async function writeKeepingEol(path: string, text: string): Promise<void> {
  const prev = await readFile(path, 'utf8').catch(() => '')
  await atomicWrite(path, prev.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text)
}

type Edit = [start: number, end: number, text: string]

/**
 * Update YAML text so it holds `obj`, splicing only what differs: unchanged lines, comments and
 * formatting stay byte-identical. Changed scalars are replaced in place; a changed collection
 * or added/removed nested key re-renders just that top-level entry.
 */
function patchYamlText(text: string, obj: Record<string, unknown>, defaults: Record<string, unknown> = {}): string {
  const fresh = () => YAML.stringify(obj, YOPTS)
  if (text.trim() === '') return fresh()
  const doc = YAML.parseDocument(text)
  if (doc.errors.length) throw new Error(`cannot update YAML with errors: ${doc.errors[0]!.message}`)
  if (!YAML.isMap(doc.contents)) return fresh()
  const map = doc.contents

  const inPlace = (node: unknown, val: unknown, out: Edit[]): boolean => {
    if (YAML.isScalar(node) && (val === null || typeof val !== 'object')) {
      if (node.value !== val) out.push([node.range![0], node.range![1], YAML.stringify(val, YOPTS).trimEnd()])
      return true
    }
    if (YAML.isMap(node) && isObj(val)) {
      const keys = node.items.map((i) => String((i.key as YAML.Scalar).value))
      if (keys.length !== Object.keys(val).length || keys.some((k) => !(k in val))) return false
      return node.items.every((i) => inPlace(i.value, val[String((i.key as YAML.Scalar).value)], out))
    }
    if (YAML.isNode(node)) return isDeepStrictEqual(node.toJS(doc), val)
    return false
  }

  const edits: Edit[] = []
  const seen = new Set<string>()
  for (const pair of map.items) {
    const k = String((pair.key as YAML.Scalar).value)
    seen.add(k)
    const keyStart = (pair.key as YAML.Scalar).range![0]
    const valEnd = YAML.isNode(pair.value) ? pair.value.range![1] : (pair.key as YAML.Scalar).range![1] + 1
    if (!(k in obj)) {
      edits.push([keyStart, text[valEnd] === '\n' ? valEnd + 1 : valEnd, ''])
      continue
    }
    const local: Edit[] = []
    if (YAML.isNode(pair.value) && inPlace(pair.value, obj[k], local)) edits.push(...local)
    else edits.push([keyStart, valEnd, YAML.stringify({ [k]: obj[k] }, YOPTS).trimEnd() + (text[valEnd - 1] === '\n' ? '\n' : '')])
  }
  let out = text
  for (const [st, en, t] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, st) + t + out.slice(en)
  for (const [k, v] of Object.entries(obj)) {
    if (seen.has(k) || (k in defaults && isDeepStrictEqual(v, defaults[k]))) continue
    out += (out.endsWith('\n') ? '' : '\n') + YAML.stringify({ [k]: v }, YOPTS)
  }
  return out
}

async function patchYamlFile(path: string, obj: Record<string, unknown>, defaults?: Record<string, unknown>): Promise<void> {
  const prev = await readFile(path, 'utf8').catch(() => '')
  const crlf = prev.includes('\r\n')
  const out = patchYamlText(prev.replace(/\r\n/g, '\n'), obj, defaults)
  await atomicWrite(path, crlf ? out.replace(/\n/g, '\r\n') : out)
}

// ---------- config ----------

const CONFIG_KEYS = ['port', 'statuses', 'workspaces', 'needsYou', 'stalled', 'ci', 'nextNumber', 'theme', 'hiddenProjects']

/** `hiddenProjects`: a list of slugs, trimmed and deduplicated; anything else (a string, numbers, empties) is dropped. */
function normalizeHidden(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const x of raw) if (typeof x === 'string' && x.trim() && !out.includes(x.trim())) out.push(x.trim())
  return out
}

export async function readConfig(root: string): Promise<Config> {
  const d = defaultConfig()
  const raw = ((await readYaml(join(root, 'config.yml'))) ?? {}) as Partial<Config> & Record<string, unknown>
  const extra = pickExtra(raw, CONFIG_KEYS)
  return {
    port: raw.port ?? d.port,
    statuses: raw.statuses ?? d.statuses,
    workspaces: raw.workspaces ?? d.workspaces,
    needsYou: { ...d.needsYou, ...(raw.needsYou ?? {}) },
    stalled: normalizeStalled(raw.stalled),
    ci: normalizeCi(raw.ci),
    nextNumber: raw.nextNumber ?? d.nextNumber,
    theme: typeof raw.theme === 'string' && raw.theme.trim() ? raw.theme.trim() : d.theme,
    hiddenProjects: normalizeHidden(raw.hiddenProjects),
    ...(extra ? { extra } : {}),
  }
}

export async function writeConfig(root: string, c: Config): Promise<void> {
  const { extra, ...known } = c
  await patchYamlFile(join(root, 'config.yml'), { ...known, ...(extra ?? {}) }, { ...defaultConfig() })
}

// ---------- labels ----------

const LABEL_KEYS = ['name', 'group', 'color']

/** On disk `name` is the full name ('Scope/Docs'); a bare name plus `group:` is also accepted. */
export async function readLabels(root: string): Promise<LabelDef[]> {
  const raw = (await readYaml(join(root, 'labels.yml'))) as { labels?: Record<string, unknown>[] } | null
  return (raw?.labels ?? []).map((l) => {
    let name = String(l.name)
    let group: string | null = null
    if (typeof l.group === 'string' && l.group) {
      group = l.group
      if (!name.startsWith(`${group}/`)) name = `${group}/${name}`
    } else if (name.includes('/')) group = name.slice(0, name.indexOf('/'))
    const extra = pickExtra(l, LABEL_KEYS)
    return { name, group, color: typeof l.color === 'string' ? l.color : '#95a2b3', ...(extra ? { extra } : {}) }
  })
}

export async function writeLabels(root: string, labels: LabelDef[]): Promise<void> {
  const out = labels.map((l) => ({ name: l.name, color: l.color, ...(l.extra ?? {}) }))
  await atomicWrite(join(root, 'labels.yml'), YAML.stringify({ labels: out }, YOPTS))
}

// ---------- projects ----------

const PROJECT_KEYS = ['name', 'key', 'status', 'color', 'repos', 'milestones']
const MILESTONE_KEYS = ['name', 'description', 'target']

export async function readProject(dir: string): Promise<Project> {
  const slug = dir.replace(/\/+$/, '').split('/').pop()!
  const { fm, body } = splitFrontMatter(await readFile(join(dir, 'project.md'), 'utf8'))
  const docs: Project['docs'] = []
  const docsDir = join(dir, 'docs')
  if (await exists(docsDir)) {
    for (const f of (await readdir(docsDir)).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort()) {
      const d = splitFrontMatter(await readFile(join(docsDir, f), 'utf8'))
      const dslug = f.slice(0, -3)
      const extra = pickExtra(d.fm, ['title'])
      docs.push({ slug: dslug, title: typeof d.fm.title === 'string' ? d.fm.title : dslug, content: d.body, ...(extra ? { extra } : {}) })
    }
  }
  const milestones = Array.isArray(fm.milestones) ? (fm.milestones as Record<string, unknown>[]) : []
  const extra = pickExtra(fm, PROJECT_KEYS)
  return {
    slug,
    name: typeof fm.name === 'string' ? fm.name : slug,
    key: String(fm.key ?? ''),
    status: typeof fm.status === 'string' ? fm.status : 'Active',
    ...(typeof fm.color === 'string' ? { color: fm.color } : {}),
    repos: Array.isArray(fm.repos) ? (fm.repos as unknown[]).map(String) : [],
    milestones: milestones.map((m) => {
      const mx = pickExtra(m, MILESTONE_KEYS)
      return {
        name: String(m.name),
        ...(m.description !== undefined ? { description: String(m.description) } : {}),
        ...(m.target !== undefined ? { target: String(m.target) } : {}),
        ...(mx ? { extra: mx } : {}),
      }
    }),
    description: body,
    docs,
    ...(extra ? { extra } : {}),
  }
}

export async function writeProject(dir: string, p: Project): Promise<void> {
  await mkdir(join(dir, 'issues'), { recursive: true })
  const fm: Record<string, unknown> = { name: p.name, key: p.key, status: p.status }
  if (p.color) fm.color = p.color
  fm.repos = p.repos
  fm.milestones = p.milestones.map(({ extra, ...m }) => ({ ...m, ...(extra ?? {}) }))
  Object.assign(fm, p.extra ?? {})
  await writeKeepingEol(join(dir, 'project.md'), withFrontMatter(fm, p.description))
  if (p.docs.length) {
    await mkdir(join(dir, 'docs'), { recursive: true })
    for (const d of p.docs) await writeKeepingEol(join(dir, 'docs', `${d.slug}.md`), withFrontMatter({ title: d.title, ...(d.extra ?? {}) }, d.content))
  }
}

// ---------- views ----------

export async function readViews(root: string): Promise<View[]> {
  const dir = join(root, 'views')
  if (!(await exists(dir))) return []
  const views: View[] = []
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.yml')).sort()) {
    const raw = (await readYaml(join(dir, f))) as Omit<View, 'slug'>
    views.push({ ...raw, slug: f.slice(0, -4), filter: raw.filter ?? {} })
  }
  return views
}

export async function writeView(root: string, v: View): Promise<void> {
  await mkdir(join(root, 'views'), { recursive: true })
  const { slug, ...rest } = v
  await atomicWrite(join(root, 'views', `${slug}.yml`), YAML.stringify(rest, YOPTS))
}

// ---------- folder init ----------

export async function initFolder(root: string): Promise<void> {
  await mkdir(join(root, 'projects'), { recursive: true })
  await mkdir(join(root, 'views'), { recursive: true })
  const ensure = async (name: string, content: () => Promise<void> | void) => {
    if (!(await exists(join(root, name)))) await content()
  }
  await ensure('config.yml', () => writeConfig(root, defaultConfig()))
  await ensure('labels.yml', () => writeLabels(root, DEFAULT_LABELS))
  await ensure('AGENTS.md', () => atomicWrite(join(root, 'AGENTS.md'), DEFAULT_AGENTS_MD))
  await ensure('.gitignore', () => atomicWrite(join(root, '.gitignore'), `.tracker/\n${GITIGNORE_LINES.join('\n')}\n`))
}

const GITIGNORE_MAX_BYTES = 1024 * 1024

/**
 * Read a top-level data-folder file for read-modify-write without following symlinks: opened with
 * O_NOFOLLOW and checked with fstat on the same handle (no lstat/open race). Returns '' if missing,
 * null (after a warning) if it is a symlink, not a regular file, or larger than `maxBytes`.
 */
async function readRegularFile(path: string, maxBytes: number): Promise<string | null> {
  let fh
  try {
    fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'ENOENT') return ''
    if (code === 'ELOOP' || code === 'EMLINK') { console.warn(`[meta] ${path} is a symlink; leaving it alone`); return null }
    throw e
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) { console.warn(`[meta] ${path} is not a regular file; leaving it alone`); return null }
    if (st.size > maxBytes) { console.warn(`[meta] ${path} is larger than ${maxBytes} bytes; leaving it alone`); return null }
    return await fh.readFile('utf8')
  } finally {
    await fh.close()
  }
}

/**
 * Idempotently make sure `.gitignore` has `line` (exact, trimmed match), keeping every existing line.
 * Never follows a symlinked `.gitignore` (its target would be copied into the repo) and skips
 * non-regular or oversized files with a warning. Returns true if it wrote.
 */
export async function ensureGitignoreLine(root: string, line: string): Promise<boolean> {
  const path = join(root, '.gitignore')
  const cur = await readRegularFile(path, GITIGNORE_MAX_BYTES)
  if (cur === null) return false
  if (cur.split(/\r?\n/).some((l) => l.trim() === line)) return false
  const eol = cur.includes('\r\n') ? '\r\n' : '\n'
  await atomicWrite(path, `${cur}${cur && !cur.endsWith('\n') ? eol : ''}${line}${eol}`)
  return true
}

// ---------- keys ----------

/** Short project key from a name: multi-word -> initials ('task-clone' -> 'TC'); single word -> uppercase, max 5 chars. De-duplicated with a numeric suffix. */
export function deriveKey(name: string, taken: Set<string>): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  let base = words.length > 1 ? words.map((w) => w[0]!).join('') : (words[0] ?? 'P')
  base = base.toUpperCase().slice(0, 5)
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`
}
