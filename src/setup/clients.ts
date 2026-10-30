/**
 * Other MCP-capable agent tools (Codex CLI, Cursor, VS Code, Windsurf, Gemini CLI, Claude Desktop): detect them,
 * register the `ai-task-tracking` server in each one's user-level config, and write the agent guidance where the
 * tool reads global instructions. Claude Code is handled in setup.ts (`claude mcp add` + the skill).
 *
 * Edits are surgical and reversible: other servers and settings are kept, a file is backed up
 * (`<file>.bak-aitt-<timestamp>`) before it changes, a second run changes nothing, an `ai-task-tracking` entry that
 * isn't ours is left alone.
 * Updating our own entry merges: only `command`, `args`, `type` (where the tool requires it) and `env.AITT_HOME` are
 * set; every other key and env var the user added stays, in place. Disconnecting removes the whole entry.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import skillText from '../../skills/ai-task-tracking/SKILL.md' with { type: 'text' }
import { atomicWrite } from '../store/atomic'
import { backupFile, fileMode } from './files'
import { isOurMcp, runsBinary } from './ours'

export const SERVER = 'ai-task-tracking'

export type ClientId = 'codex' | 'chatgpt' | 'cursor' | 'vscode' | 'windsurf' | 'gemini' | 'claude-desktop'
export interface ClientCtx {
  userHome: string
  env: Record<string, string | undefined>
  /**
   * Where app bundles are looked for (default /Applications and ~/Applications). Tests only: the environment
   * variable AITT_TEST_APP_SEARCH_DIRS (colon-separated) replaces the default, so a subprocess under test never sees
   * the real /Applications. Not related to AITT_APP_DIR (where the installers put the app).
   */
  appDirs?: string[]
}
type Format = 'toml' | 'mcpServers' | 'servers'

interface ClientSpec {
  label: string
  /** Command-line tool name, when the tool has one. */
  cli?: string
  /** App bundle name, when the tool is a desktop app. */
  app?: string
  /** The tool's user config folder; its presence (with the app) means the tool has been used. */
  dir(c: ClientCtx): string
  file: string
  format: Format
  /** The entry carries `"type": "stdio"` (VS Code requires it; Cursor's docs list it). */
  stdioType?: boolean
  /** A global instructions file the tool reads, where setup keeps a marked guidance block. */
  guidance?: string
  /** Official docs for the config location and format. */
  docs: string
  /** What a user does for instructions when there is no global file setup can write. */
  instructionsHint?: string
  /** Another tool whose config file this one may use (setup and uninstall handle a shared file once). */
  sharesWith?: ClientId
  /** Overrides the default detection (CLI on PATH, or app bundle plus config folder). */
  detect?(c: ClientCtx, appDirs: string[]): boolean
}

const appSupport = (c: ClientCtx, name: string) => join(c.userHome, 'Library', 'Application Support', name)

const CODEX: ClientSpec = {
  label: 'Codex CLI', cli: 'codex', app: 'Codex.app', dir: (c) => c.env.CODEX_HOME || join(c.userHome, '.codex'),
  file: 'config.toml', format: 'toml', guidance: 'AGENTS.md', docs: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli',
}

export const CLIENTS: Record<ClientId, ClientSpec> = {
  codex: CODEX,
  // ChatGPT desktop runs MCP servers through its bundled Codex agent, which reads ~/.codex/config.toml. Always that
  // path: a GUI app doesn't see a shell's $CODEX_HOME (when that is set elsewhere, codex and chatgpt are two files).
  chatgpt: {
    ...CODEX, label: 'ChatGPT desktop', cli: undefined, app: 'ChatGPT.app', sharesWith: 'codex', dir: (c) => join(c.userHome, '.codex'),
    detect: (c, appDirs) => appDirs.some((d) => existsSync(join(d, 'ChatGPT.app'))) || existsSync(appSupport(c, 'com.openai.chat')),
  },
  cursor: {
    label: 'Cursor', cli: 'cursor', app: 'Cursor.app', dir: (c) => join(c.userHome, '.cursor'),
    file: 'mcp.json', format: 'mcpServers', stdioType: true, docs: 'https://cursor.com/docs/context/mcp',
    instructionsHint: 'Cursor keeps user rules in its settings, not a file: per repo, run aitt guidance --cursor > .cursor/rules/ai-task-tracking.mdc',
  },
  vscode: {
    label: 'VS Code (Copilot agent mode)', cli: 'code', app: 'Visual Studio Code.app', dir: (c) => appSupport(c, join('Code', 'User')),
    file: 'mcp.json', format: 'servers', stdioType: true, docs: 'https://code.visualstudio.com/docs/agents/reference/mcp-configuration',
    instructionsHint: 'per repo, add the output of aitt guidance to .github/copilot-instructions.md',
  },
  windsurf: {
    label: 'Windsurf', cli: 'windsurf', app: 'Windsurf.app', dir: (c) => join(c.userHome, '.codeium', 'windsurf'),
    file: 'mcp_config.json', format: 'mcpServers', docs: 'https://docs.windsurf.com/windsurf/cascade/mcp',
    instructionsHint: 'add the output of aitt guidance to your Windsurf rules',
  },
  gemini: {
    label: 'Gemini CLI', cli: 'gemini', dir: (c) => join(c.userHome, '.gemini'),
    file: 'settings.json', format: 'mcpServers', guidance: 'GEMINI.md', docs: 'https://geminicli.com/docs/tools/mcp-server/',
  },
  'claude-desktop': {
    label: 'Claude Desktop', app: 'Claude.app', dir: (c) => appSupport(c, 'Claude'),
    file: 'claude_desktop_config.json', format: 'mcpServers', docs: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers',
    instructionsHint: 'add the output of aitt guidance to a Claude project\'s instructions',
  },
}
export const CLIENT_IDS = Object.keys(CLIENTS) as ClientId[]

export const configPath = (id: ClientId, c: ClientCtx) => join(CLIENTS[id].dir(c), CLIENTS[id].file)
export const guidancePath = (id: ClientId, c: ClientCtx) => (CLIENTS[id].guidance ? join(CLIENTS[id].dir(c), CLIENTS[id].guidance!) : undefined)

/**
 * Installed: its CLI is on PATH, or its app bundle exists and its config folder does (the app has been run).
 * ChatGPT desktop: its app bundle or its Application Support folder.
 */
export function detectClient(id: ClientId, c: ClientCtx): boolean {
  const spec = CLIENTS[id]
  const dirs = c.appDirs ?? c.env.AITT_TEST_APP_SEARCH_DIRS?.split(':').filter(Boolean) ?? ['/Applications', join(c.userHome, 'Applications')]
  if (spec.detect) return spec.detect(c, dirs)
  if (spec.cli && Bun.which(spec.cli, { PATH: c.env.PATH ?? '' })) return true
  return !!spec.app && dirs.some((d) => existsSync(join(d, spec.app!))) && existsSync(spec.dir(c))
}

// ---------- guidance (one source: the skill's workflow section) ----------

const GUIDANCE_SECTION = /<!-- aitt:guidance:start[^>]*-->\n([\s\S]*?)<!-- aitt:guidance:end -->/

/** The instructions other agent tools get: the skill's workflow section under a short header. */
export function agentGuidance(): string {
  const section = GUIDANCE_SECTION.exec(skillText)?.[1]?.trim()
  if (!section) throw new Error('skills/ai-task-tracking/SKILL.md lost its aitt:guidance markers')
  return `## Issue tracking: AI Task Tracking

Track your work as issues in AI Task Tracking, the local tracker on this Mac, with the \`${SERVER}\` MCP tools.
Its rules also arrive as the MCP server's instructions; where they differ from this, they win. If a tool says
"AI Task Tracking isn't running", ask the user to open it from the menu bar; if it "didn't reply", check with
get_issue before retrying.

${section}
`
}

/** A Cursor project rule (`.cursor/rules/ai-task-tracking.mdc`) with the same guidance. */
export const cursorRule = () =>
  `---\ndescription: Issue tracking with AI Task Tracking (MCP server ${SERVER})\nalwaysApply: true\n---\n${agentGuidance()}`

const BLOCK_START = `<!-- ${SERVER}:start (added by aitt setup; re-running setup updates it, uninstall removes it) -->`
const BLOCK_END = `<!-- ${SERVER}:end -->`
const BLOCK_RE = new RegExp(`\\n?<!-- ${SERVER}:start[^\\n]*-->\\n[\\s\\S]*?<!-- ${SERVER}:end -->\\n?`)

function withBlock(text: string): string {
  const block = `${BLOCK_START}\n${agentGuidance()}${BLOCK_END}\n`
  if (BLOCK_RE.test(text)) return text.replace(BLOCK_RE, (m) => `${m.startsWith('\n') ? '\n' : ''}${block}`)
  return text ? `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}` : block
}
const withoutBlock = (text: string) => text.replace(BLOCK_RE, '')

// ---------- server entries ----------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

export interface Target { binary: string; home: string }

function desiredEntry(spec: ClientSpec, t: Target): Obj {
  return { ...(spec.stdioType ? { type: 'stdio' } : {}), command: t.binary, args: ['mcp'], env: { AITT_HOME: t.home } }
}

/** Our entry updated: the keys we own are set (existing ones in place, new ones last); the user's keys are kept. */
function mergedEntry(spec: ClientSpec, cur: unknown, t: Target): Obj {
  const want = desiredEntry(spec, t)
  if (!isObj(cur)) return want
  return { ...cur, ...want, env: isObj(cur.env) ? { ...cur.env, AITT_HOME: t.home } : want.env }
}

/** An entry as the Claude Code ownership checks see it. */
function asMcp(v: unknown) {
  const e = isObj(v) ? v : {}
  const args = Array.isArray(e.args) ? e.args.map(String).join(' ') : ''
  const env = isObj(e.env) ? Object.entries(e.env).map(([k, x]) => `${k}=${String(x)}`) : []
  return { scope: 'user' as const, command: typeof e.command === 'string' ? e.command : '', args, env }
}
const ours = (v: unknown) => isOurMcp(asMcp(v))
/** Which entries an edit may replace or remove: by default any of ours; uninstall narrows it to one app's binary. */
interface Owns { server(v: unknown): boolean }
const ANY_OF_OURS: Owns = { server: ours }
const onlyBinaries = (binaries: string[]): Owns => ({
  server: (v) => ours(v) && runsBinary(asMcp(v).command, binaries),
})
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** Equal content, key order aside (a TOML edit may add a key in a different spot than a JS spread would). */
const sameContent = (a: unknown, b: unknown) => Bun.deepEquals(a, b, true)

class Refusal extends Error {}

/** The tool's server table: `servers` for VS Code, `mcpServers` for the JSON tools, `mcp_servers` for Codex. */
const containerKey = (f: Format) => (f === 'toml' ? 'mcp_servers' : f)

function parse(format: Format, text: string): Obj {
  if (!text.trim()) return {}
  let v: unknown
  try { v = format === 'toml' ? Bun.TOML.parse(text) : JSON.parse(text) } catch {
    throw new Refusal(format === 'toml' ? "it isn't valid TOML" : "it isn't plain JSON (setup doesn't edit files with comments or trailing commas)")
  }
  if (!isObj(v)) throw new Refusal('its top level is not an object')
  const box = v[containerKey(format)]
  if (box !== undefined && !isObj(box)) throw new Refusal(`its "${containerKey(format)}" is not an object`)
  return v
}

// TOML is edited as text so comments and layout survive: a new entry is appended; our existing entry is edited in
// place (only the lines of the keys we own); removing an entry removes its whole `[mcp_servers.<name>]` table and
// its `[mcp_servers.<name>.…]` subtables.
/** A file's line ending (CRLF when it has any), so inserted lines match it. */
const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n')
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const tableHeader = (name: string) => new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*("?)${esc(name)}\\1\\s*(\\.[^\\]]*)?\\]\\s*(#.*)?$`)

/**
 * Remove the named tables. Comment and blank lines after a removed table's last key belong to whatever follows
 * (typically a comment introducing the next table), so they are kept unless the file ends there.
 */
function removeTomlTables(text: string, name: string): string {
  const header = tableHeader(name)
  const eol = eolOf(text)
  const out: string[] = []
  let skipping = false
  let trailing: string[] = [] // comment/blank lines seen while skipping, after the last key
  for (const line of text.split(eol)) {
    if (/^\s*\[/.test(line)) {
      const ours = header.test(line)
      if (skipping && !ours) {
        // Don't double the blank line that separated the removed table from what came before.
        while (trailing.length && !trailing[0]!.trim() && out.length && !out[out.length - 1]!.trim()) trailing.shift()
        out.push(...trailing)
      }
      trailing = []
      skipping = ours
      if (!skipping) out.push(line)
    } else if (!skipping) out.push(line)
    else if (/^\s*(#.*)?$/.test(line)) trailing.push(line)
    else trailing = []
  }
  if (skipping) out.push(...trailing.filter((l) => l.trim()))
  let result = out.join(eol)
  // Removed at the end: one line ending stays, as the file had (none when nothing is left).
  if (skipping) result = result.replace(/(\r?\n)+$/, '') + (result.trim() && text.endsWith('\n') ? eol : '')
  return result
}

const tomlTables = (t: Target) =>
  `[mcp_servers.${SERVER}]\ncommand = ${JSON.stringify(t.binary)}\nargs = ["mcp"]\n\n[mcp_servers.${SERVER}.env]\nAITT_HOME = ${JSON.stringify(t.home)}\n`

const unsupported = (why: string) => new Refusal(`setup can't safely edit (unsupported layout: ${why}); add the entry by hand`)
const notTables = () => unsupported(`"${SERVER}" is not written as [mcp_servers.${SERVER}] tables`)
const TOML_STR = String.raw`"(?:[^"\\]|\\.)*"|'[^']*'`

/**
 * Set `command`, `args` and `env.AITT_HOME` in our existing `[mcp_servers.ai-task-tracking]` table, touching only
 * the lines whose value differs; a missing key is added after the table's last key. Everything else (the user's
 * keys, env vars, comments, order) stays byte for byte. A layout this can't place an edit in is refused.
 */
function updateTomlEntry(text: string, had: Obj, t: Target): string {
  const eol = eolOf(text)
  const lines = text.split(eol)
  const header = tableHeader(SERVER)
  const isHeader = (l: string) => /^\s*\[/.test(l)
  /** The line of our table (`''`) or subtable (`'.env'`). */
  const table = (sub: string) => lines.findIndex((l) => {
    const m = header.exec(l)
    return !!m && (m[2] ?? '').replace(/[\s"']/g, '') === sub
  })
  const end = (h: number) => { let i = h + 1; while (i < lines.length && !isHeader(lines[i]!)) i++; return i }
  const lastKey = (h: number) => { let k = h; for (let i = h + 1; i < end(h); i++) if (!/^\s*(#.*)?$/.test(lines[i]!)) k = i; return k }
  const keyAt = (h: number, key: string) => {
    const re = new RegExp(`^\\s*(["']?)${esc(key)}\\1\\s*=`)
    for (let i = h + 1; i < end(h); i++) if (re.test(lines[i]!)) return i
    return -1
  }
  /** `key = literal` in the table at line `h`: the value is replaced (a trailing comment kept), or the key added. */
  const set = (h: number, key: string, literal: string) => {
    const i = keyAt(h, key)
    if (i < 0) { lines.splice(lastKey(h) + 1, 0, `${key} = ${literal}`); return }
    const line = lines[i]!
    const m = new RegExp(`^(\\s*(["']?)${esc(key)}\\2\\s*=\\s*)(${TOML_STR}|\\[[^\\[\\]]*\\])(\\s*(?:#.*)?)$`).exec(line)
    if (m) { lines[i] = `${m[1]}${literal}${m[4]}`; return }
    if (/=\s*\[[^\]]*$/.test(line)) { // a multi-line array: replaced by one line
      let j = i + 1
      while (j < end(h) && !/^[^#]*\]\s*(#.*)?$/.test(lines[j]!)) j++
      if (j < end(h)) { lines.splice(i, j - i + 1, `${/^\s*/.exec(line)![0]}${key} = ${literal}`); return }
    }
    throw notTables()
  }
  if (table('') < 0) throw notTables()
  if (had.command !== t.binary) set(table(''), 'command', JSON.stringify(t.binary))
  if (!sameContent(had.args, ['mcp'])) set(table(''), 'args', '["mcp"]')
  const env = isObj(had.env) ? had.env : undefined
  if (env?.AITT_HOME !== t.home) {
    const home = JSON.stringify(t.home)
    const sub = table('.env')
    const main = table('')
    const inline = keyAt(main, 'env')
    if (sub >= 0) set(sub, 'AITT_HOME', home)
    else if (inline >= 0) { // env = { … } on one line
      const line = lines[inline]!
      const val = new RegExp(`(\\bAITT_HOME\\s*=\\s*)(${TOML_STR})`)
      lines[inline] = val.test(line) ? line.replace(val, (_m, k: string) => `${k}${home}`)
        : /\{\s*\}/.test(line) ? line.replace(/\{\s*\}/, () => `{ AITT_HOME = ${home} }`)
        : line.replace(/\s*\}(\s*(?:#.*)?)$/, (_m, c: string) => `, AITT_HOME = ${home} }${c}`)
    } else if (had.env !== undefined) throw notTables()
    else lines.splice(lastKey(main) + 1, 0, '', `[mcp_servers.${SERVER}.env]`, `AITT_HOME = ${home}`)
  }
  return lines.join(eol)
}

function editToml(text: string, cur: Obj, t: Target | undefined, owns: Owns): string {
  let next = text
  const box = (cur.mcp_servers ?? {}) as Obj
  const had = box[SERVER]
  const update = !!t && had !== undefined && owns.server(had)
  if (update) next = updateTomlEntry(next, isObj(had) ? had : {}, t)
  else if (!t && had !== undefined && owns.server(had)) next = removeTomlTables(next, SERVER)
  else if (t) {
    const eol = eolOf(next)
    next = `${next}${next && !next.endsWith('\n') ? eol : ''}${next ? eol : ''}${tomlTables(t).replaceAll('\n', eol)}`
  }
  // Check the edit: our entry is exactly what we meant (the user's keys in it included), and nothing else changed.
  let parsed: Obj
  try { parsed = parse('toml', next) } catch { throw notTables() }
  const pbox = (parsed.mcp_servers ?? {}) as Obj
  const { [SERVER]: _had, ...expected } = box
  const { [SERVER]: mine, ...rest } = pbox
  const { mcp_servers: _a, ...otherNew } = parsed
  const { mcp_servers: _b, ...otherOld } = cur
  const wanted = update ? mergedEntry(CODEX, had, t!) : t ? desiredEntry(CODEX, t) : had !== undefined && !owns.server(had) ? had : undefined
  if (!same(rest, expected) || !same(otherNew, otherOld) || !sameContent(mine, wanted)) throw notTables()
  return next
}

/** The indent a JSON file already uses (tabs or N spaces), so a rewrite doesn't reformat it; 2 for a new file. */
export function jsonIndent(text: string | null): string {
  return /\n([ \t]+)\S/.exec(text ?? '')?.[1] ?? '  '
}

function editJson(spec: ClientSpec, cur: Obj, t: Target | undefined, indent: string, owns: Owns): string {
  const key = containerKey(spec.format)
  const box: Obj = { ...((cur[key] as Obj | undefined) ?? {}) }
  if (t) box[SERVER] = mergedEntry(spec, box[SERVER], t) // in place: an existing entry keeps its position and user keys
  else if (owns.server(box[SERVER])) delete box[SERVER]
  return `${JSON.stringify({ ...cur, [key]: box }, null, indent)}\n`
}

// ---------- connect / disconnect ----------

export interface ClientResult {
  status: 'connected' | 'disconnected' | 'unchanged' | 'skipped'
  /** One line for the setup log. */
  message: string
  backups: string[]
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

/**
 * Write `next` over `path` (following a symlink), backing up the old file first. Returns the backup path.
 * Configs often hold other servers' API keys, so permissions never widen: the new file and the backup get the
 * original's mode (the symlink target's), and a new file is created 0600.
 */
async function replaceFile(path: string, prev: string | null, next: string): Promise<string | undefined> {
  const real = await realpath(path).catch(() => path)
  await mkdir(dirname(real), { recursive: true })
  const mode = prev === null ? 0o600 : (await fileMode(real)) ?? 0o600
  let bak: string | undefined
  if (prev !== null) {
    bak = `${path}.bak-aitt-${stamp()}`
    if (existsSync(bak)) bak = `${bak}-${createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 6)}`
    await backupFile(real, bak, mode)
  }
  await atomicWrite(real, next, mode)
  return bak
}

/** The target of `path` when it is a symlink whose target doesn't exist. */
async function brokenLink(path: string): Promise<string | undefined> {
  const st = await lstat(path).catch(() => null)
  if (!st?.isSymbolicLink()) return undefined
  if (await stat(path).then(() => true, () => false)) return undefined
  return readlink(path).catch(() => '?')
}

async function apply(id: ClientId, c: ClientCtx, t: Target | undefined, owns: Owns = ANY_OF_OURS): Promise<ClientResult> {
  const spec = CLIENTS[id]
  const file = configPath(id, c)
  const gpath = guidancePath(id, c)
  const skip = (why: string, f = file): ClientResult => ({ status: 'skipped', message: `${spec.label}: ${f} left unchanged: ${why}.`, backups: [] })
  // A link to a missing file (a dotfiles repo on an unmounted volume): writing would replace the link. Skip.
  for (const f of [file, gpath]) {
    const link = f ? await brokenLink(f) : undefined
    if (link) return skip(`it's a link to ${link}, and the linked file is missing`, f)
  }
  const prev = await readFile(file, 'utf8').catch(() => null)
  let cur: Obj
  try { cur = parse(spec.format, prev ?? '') } catch (e) {
    if (e instanceof Refusal) return skip(e.message)
    throw e
  }
  const box = (cur[containerKey(spec.format)] ?? {}) as Obj
  if (t && SERVER in box && !ours(box[SERVER])) return skip(`it already has an "${SERVER}" server that isn't this app`)
  let next: string
  try {
    next = spec.format === 'toml' ? editToml(prev ?? '', cur, t, owns)
      : editJson(spec, cur, t, jsonIndent(prev), owns).replaceAll('\n', eolOf(prev ?? '')) // JSON strings hold no raw newlines
  } catch (e) {
    if (e instanceof Refusal) return skip(e.message)
    throw e
  }
  // JSON is rewritten only when its content changes (never just to reformat it).
  const hasOurs = SERVER in box && owns.server(box[SERVER])
  const configChanged = spec.format === 'toml' ? next !== (prev ?? '') : (t || hasOurs) && (prev === null || !same(parse(spec.format, next), cur))
  const backups: string[] = []
  if (configChanged) {
    const bak = await replaceFile(file, prev, next)
    if (bak) backups.push(bak)
  }
  let guidanceChanged = false
  if (gpath) {
    const gprev = await readFile(gpath, 'utf8').catch(() => null)
    // The block stays while another install of ours is still registered here.
    const left = ((parse(spec.format, next)[containerKey(spec.format)] ?? {}) as Obj)[SERVER]
    const gnext = t ? withBlock(gprev ?? '') : left !== undefined && ours(left) ? gprev ?? '' : withoutBlock(gprev ?? '')
    if (gnext !== (gprev ?? '') && !(gprev === null && !t)) {
      const bak = await replaceFile(gpath, gprev, gnext)
      if (bak) backups.push(bak)
      guidanceChanged = true
    }
  }
  if (!configChanged && !guidanceChanged) {
    return { status: 'unchanged', message: `${spec.label}: ${t ? 'already connected' : 'nothing of AI Task Tracking to remove'} (${file})`, backups }
  }
  const what = [configChanged && file, guidanceChanged && gpath].filter(Boolean).join(' and ')
  return {
    status: t ? 'connected' : 'disconnected',
    message: `${spec.label}: ${t ? 'connected' : 'disconnected'} (${what}); restart ${spec.label} to ${t ? 'load' : 'drop'} the tools`,
    backups,
  }
}

/** Register the ai-task-tracking server (and guidance block, where the tool has a global file) idempotently. */
export const connectClient = (id: ClientId, c: ClientCtx, t: Target) => apply(id, c, t)
/**
 * Remove only what setup added: our server entry and our guidance block.
 * With `binaries` (uninstall), only entries whose command is one of them; the guidance block stays while another
 * entry of ours remains.
 */
export const disconnectClient = (id: ClientId, c: ClientCtx, binaries?: string[]) =>
  apply(id, c, undefined, binaries ? onlyBinaries(binaries) : ANY_OF_OURS)

export const UNSUPPORTED_STATUS = "can't update automatically (unsupported layout)"
/**
 * Whether the tool's config already has our server, as wanted ('connected'), stale ('outdated'), stale in a layout
 * setup would refuse to edit, or not.
 */
export async function clientStatus(id: ClientId, c: ClientCtx, t: Target | undefined): Promise<'connected' | 'outdated' | typeof UNSUPPORTED_STATUS | 'not connected' | 'other' | 'unreadable'> {
  const spec = CLIENTS[id]
  const prev = await readFile(configPath(id, c), 'utf8').catch(() => null)
  let cur: Obj
  try { cur = parse(spec.format, prev ?? '') } catch { return 'unreadable' }
  const entry = ((cur[containerKey(spec.format)] ?? {}) as Obj)[SERVER]
  if (entry === undefined) return 'not connected'
  if (!ours(entry)) return 'other'
  if (t && sameContent(entry, mergedEntry(spec, entry, t))) return 'connected'
  if (t && spec.format === 'toml') {
    try { editToml(prev ?? '', cur, t, ANY_OF_OURS) } catch (e) { if (e instanceof Refusal) return UNSUPPORTED_STATUS; throw e }
  }
  return 'outdated'
}
