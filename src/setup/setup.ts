/**
 * `aitt setup`: first-run setup of a data folder and of Claude Code. Interactive on a TTY; every step
 * also has a flag so an installer can run it non-interactively (`--yes` takes the defaults).
 *
 * Steps: data folder → first project → optional GitHub backup →
 * `aitt` on PATH → Claude Code MCP registration → other agent tools (Codex, Cursor, …) → agent skill →
 * optional CLAUDE.md line.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Store } from '../engine/store'
import { atomicWrite } from '../store/atomic'
import { initFolder } from '../store/metaFiles'
import { aittEnv, DEFAULT_HOME_DIR } from '../shared/env'
import skillText from '../../skills/ai-task-tracking/SKILL.md' with { type: 'text' }
import { CLIENT_IDS, CLIENTS, clientStatus, configPath, connectClient, detectClient, type ClientId } from './clients'
import { backupFile, fileMode } from './files'
import { isOurMcp, type McpEntry } from './ours'
export { isOurMcp, OUR_BUNDLE_BINARY, type McpEntry } from './ours'

/** While this exists the app waits instead of starting the engine on a half-written folder. */
export const SETUP_LOCK = join('.tracker', 'setup.lock')
export const SKILL_TEXT: string = skillText
export const CLAUDE_MD_LINE =
  'Issue tracking: use AI Task Tracking (its MCP tools; see the `ai-task-tracking` skill). Track every piece of work as an issue; the rules arrive with the MCP server.'
/** This in CLAUDE.md means the line is already there. */
const CLAUDE_MD_MARK = 'Issue tracking: use AI Task Tracking'
/** The Claude Code MCP server name. */
export const MCP_NAME = 'ai-task-tracking'
export const SKILL_MARKER = '.shipped-sha256'
/** The app bundle's name (in ~/Applications or /Applications). */
export const APP_NAME = 'AI Task Tracking.app'

/** Thrown by a prompt on Ctrl-C so setup's cleanup (the setup lock) still runs. */
export class SetupInterrupted extends Error {
  constructor() { super('setup interrupted') }
}

/** Single-quote for a POSIX shell (same as FirstRun.shellQuote in the app). */
export const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export interface SetupIO {
  /** False with --yes or without a TTY: every question takes its default. */
  interactive: boolean
  ask(question: string, def: string): Promise<string>
  log(line: string): void
}

/** Flags: undefined = ask (interactive) or the default (non-interactive). */
export interface SetupOptions {
  /** The user's home directory (tests point it at a temp folder). */
  userHome: string
  home?: string
  project?: string
  /** `owner/name`, or false for no backup. Non-interactive default: no backup. */
  backup?: string | false
  link?: boolean
  mcp?: boolean
  skill?: boolean
  /** Non-interactive default: leave ~/.claude/CLAUDE.md alone. */
  claudeMd?: boolean
  /** Other agent tools to connect, or false for none. Default: ask (interactive) or every detected one. */
  connect?: ClientId[] | false
  /** Where app bundles are looked for (test hook; default /Applications and ~/Applications). */
  appDirs?: string[]
  /** The compiled aitt binary to register and link (default: this executable when compiled). */
  binary?: string
  env: Record<string, string | undefined>
}

export const SETUP_USAGE = `Usage: aitt setup [options]
Sets up AI Task Tracking: a data folder and Claude Code. Asks on a terminal; --yes takes every default.
  --yes, -y               no questions (defaults: no backup, no CLAUDE.md line)
  --home <dir>            data folder (default: $AITT_HOME or ~/AITaskTracking)
  --project <name>        first project, e.g. your team (only when the folder has no projects)
  --backup <owner/name>   back up to a new private GitHub repo (needs gh); --no-backup to skip
  --no-link               don't link ~/.local/bin/aitt to the app's binary
  --no-mcp                don't register the ai-task-tracking MCP server with Claude Code
  --no-skill              don't install the agent skill into ~/.claude/skills/ai-task-tracking
  --connect <tools>       connect other agent tools, comma-separated: ${CLIENT_IDS.join(',')}
                          (default: every detected one); --no-connect to skip
  --claude-md             add the AI Task Tracking line to ~/.claude/CLAUDE.md; --no-claude-md to skip
  --binary <path>         aitt binary to register (default: this one, when it is the app's)`

/** Parse `aitt setup` arguments. Returns an error string for unknown or incomplete flags. */
export function parseSetupArgs(args: string[]): { yes: boolean; help: boolean; opts: Partial<SetupOptions> } | string {
  const opts: Partial<SetupOptions> = {}
  let yes = false, help = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const value = () => {
      const v = args[++i]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`)
      return v
    }
    try {
      switch (a) {
        case '--yes': case '-y': yes = true; break
        case '--help': case '-h': help = true; break
        case '--home': opts.home = value(); break
        case '--project': opts.project = value(); break
        case '--backup': {
          const v = value()
          if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) return `--backup takes owner/name, got "${v}"`
          opts.backup = v
          break
        }
        case '--no-backup': opts.backup = false; break
        case '--link': opts.link = true; break
        case '--no-link': opts.link = false; break
        case '--mcp': opts.mcp = true; break
        case '--no-mcp': opts.mcp = false; break
        case '--skill': opts.skill = true; break
        case '--no-skill': opts.skill = false; break
        case '--connect': {
          const ids = value().split(',').map((x) => x.trim()).filter(Boolean)
          const bad = ids.filter((x) => !(CLIENT_IDS as string[]).includes(x))
          if (bad.length) return `--connect: unknown tool ${bad.join(', ')} (tools: ${CLIENT_IDS.join(', ')})`
          opts.connect = ids as ClientId[]
          break
        }
        case '--no-connect': opts.connect = false; break
        case '--claude-md': opts.claudeMd = true; break
        case '--no-claude-md': opts.claudeMd = false; break
        case '--binary': opts.binary = value(); break
        default: return `unknown option ${a}`
      }
    } catch (e) {
      return (e as Error).message
    }
  }
  return { yes, help, opts }
}

// ---------- helpers ----------

interface RunResult { code: number; out: string; err: string }

/** Run a child process. */
export async function run(cmd: string[], env: Record<string, string | undefined>, cwd?: string): Promise<RunResult> {
  try {
    const p = Bun.spawn(cmd, { env: env as Record<string, string>, cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 120_000 })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, out: out.trim(), err: err.trim() }
  } catch (e) {
    return { code: 127, out: '', err: e instanceof Error ? e.message : String(e) }
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as { code?: string }).code === 'EPERM' }
}

export const which = (cmd: string, env: SetupOptions['env']) => Bun.which(cmd, { PATH: env.PATH ?? '' })
const yesNo = (answer: string) => /^y(es)?$/i.test(answer.trim())
export const tilde = (p: string, userHome: string) => (p === userHome || p.startsWith(`${userHome}/`) ? `~${p.slice(userHome.length)}` : p)
const expand = (p: string, userHome: string) => resolve(p === '~' ? userHome : p.startsWith('~/') ? join(userHome, p.slice(2)) : p)

/** 'tracker' (has config.yml), 'empty' (missing, or only our lock / .DS_Store), else 'other'. */
async function folderKind(home: string): Promise<'tracker' | 'empty' | 'other'> {
  if (existsSync(join(home, 'config.yml'))) return 'tracker'
  const entries = await readdir(home).catch(() => null)
  if (entries === null) return 'empty'
  return entries.every((e) => e === '.DS_Store' || e === '.tracker') ? 'empty' : 'other'
}

async function projectNames(home: string): Promise<string[]> {
  const store = await Store.open(home, { port: 0 })
  return [...store.projects.values()].filter((p) => p.slug !== '_none').map((p) => p.name)
}

/** The compiled aitt binary: --binary, else this executable when it isn't bun itself, else the installed app's. */
async function findBinary(opts: SetupOptions): Promise<string | undefined> {
  if (opts.binary) return resolve(opts.binary)
  const self = process.execPath
  if (!/^bun(-debug)?$/.test(basename(self))) return realpath(self).catch(() => self)
  for (const dir of [join(opts.userHome, 'Applications'), '/Applications']) {
    const p = join(dir, APP_NAME, 'Contents', 'Resources', 'aitt')
    if (existsSync(p)) return p
  }
  return undefined
}

// ---------- steps ----------

export async function runSetup(opts: SetupOptions, io: SetupIO): Promise<number> {
  const { env, userHome } = opts
  const ask = async (q: string, def: string, flag: string | undefined) => (flag !== undefined ? flag : io.interactive ? io.ask(q, def) : def)
  const confirm = async (q: string, def: boolean, flag: boolean | undefined) =>
    flag !== undefined ? flag : io.interactive ? yesNo((await io.ask(`${q} [${def ? 'Y/n' : 'y/N'}]`, def ? 'y' : 'n')) || (def ? 'y' : 'n')) : def

  // 1. Data folder
  const defHome = aittEnv('HOME', env) || join(userHome, DEFAULT_HOME_DIR)
  const home = expand(await ask(`Data folder [${tilde(defHome, userHome)}]`, tilde(defHome, userHome), opts.home), userHome)
  const kind = await folderKind(home)
  if (kind === 'other') {
    io.log(`✗ ${home} has other files and no config.yml. Choose an empty folder or an existing AI Task Tracking folder (--home).`)
    return 1
  }
  io.log(kind === 'tracker' ? `✓ Data folder ${home} (existing; kept as is)` : `• Data folder ${home} (new)`)

  // The lock tells the app to wait while a new folder is written. A lock left behind means an earlier
  // setup was interrupted; we take it over and remove it when done.
  const lock = join(home, SETUP_LOCK)
  const stale = await readFile(lock, 'utf8').catch(() => null)
  if (stale !== null) {
    const pid = Number(stale.trim())
    if (pid > 0 && pid !== process.pid && isAlive(pid)) {
      io.log(`✗ Another setup (process ${pid}) is running on ${home}. Wait for it to finish.`)
      return 1
    }
    if (kind === 'tracker') io.log('! An earlier setup of this folder was interrupted; it is resumed now.')
  }
  if (kind === 'empty' || stale !== null) {
    await mkdir(dirname(lock), { recursive: true })
    await writeFile(lock, `${process.pid}\n`)
  }
  try {
    // 2. Fresh folder: an empty skeleton
    if (kind === 'empty') {
      await initFolder(home)
      io.log('✓ Created the folder skeleton (config.yml, labels.yml, AGENTS.md)')
    }

    // 3. First project
    const names = await projectNames(home)
    if (names.length) {
      io.log(`✓ Projects: ${names.join(', ')}`)
      if (opts.project && !names.some((n) => n.toLowerCase() === opts.project!.toLowerCase())) {
        io.log(`• Not creating "${opts.project}": the folder already has projects (create more in the app or with save_project).`)
      }
    } else {
      const name = (await ask('First project, e.g. your team (Enter to skip)', '', opts.project)).trim()
      if (name) {
        const store = await Store.open(home, { port: 0 })
        const p = await store.upsertProject({ name })
        io.log(`✓ Created project "${p.name}" (issue ids ${p.key}-1, ${p.key}-2, …)`)
      } else {
        io.log('• No project yet: an agent\'s first issue creates one named after its repo.')
      }
    }

    // 4. Backup
    const backupCode = await setupBackup(home, opts, io, ask, confirm)
    if (backupCode !== 0) return backupCode
  } finally {
    await rm(lock, { force: true })
  }

  // 5–8. This machine: PATH, Claude Code, skill, CLAUDE.md
  const binary = await findBinary(opts)
  await linkBinary(binary, opts, io, confirm)
  await registerMcp(home, binary, opts, io, confirm)
  const clientsOk = await connectAgentTools(home, binary, opts, io)
  await installSkill(opts, io, confirm)
  await addClaudeMdLine(opts, io, confirm)
  if (!clientsOk) {
    io.log('\nSome agent tools could not be connected (see ✗ above); fix that and run aitt setup again.')
    return 1
  }

  io.log('\nDone. Open AI Task Tracking from the menu bar (or `open -a "AI Task Tracking"`), and restart Claude Code sessions to pick up the tools.')
  return 0
}

type Ask = (q: string, def: string, flag: string | undefined) => Promise<string>
type Confirm = (q: string, def: boolean, flag: boolean | undefined) => Promise<boolean>

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

async function setupBackup(home: string, opts: SetupOptions, io: SetupIO, ask: Ask, confirm: Confirm): Promise<number> {
  const { env } = opts
  if (existsSync(join(home, '.git'))) {
    const origin = await run(['git', 'remote', 'get-url', 'origin'], env, home)
    if (origin.code === 0) { io.log(`✓ Backup: ${origin.out}`); return 0 }
  }
  const want = opts.backup === false ? false : opts.backup ? true : await confirm('Back up to a private GitHub repo?', false, undefined)
  if (!want) { io.log('• No backup (run aitt setup again to add one)'); return 0 }
  if (!which('gh', env)) {
    io.log('✗ Backup needs the GitHub CLI: brew install gh && gh auth login, then run aitt setup again.')
    return opts.backup ? 1 : 0
  }
  if ((await run(['gh', 'auth', 'status', '--hostname', 'github.com'], env)).code !== 0) {
    io.log('✗ The GitHub CLI is not signed in to github.com: run gh auth login, then aitt setup again.')
    return opts.backup ? 1 : 0
  }
  let repo = opts.backup || ''
  if (!repo) {
    const user = await run(['gh', 'api', 'user', '--jq', '.login'], env)
    let owner = user.code === 0 ? user.out.trim() : ''
    if (!owner) owner = (await ask('GitHub owner (user or organization) for the backup repo (Enter to skip)', '', undefined)).trim()
    if (!owner) { io.log('• No backup (no GitHub owner)'); return 0 }
    for (let attempt = 0; attempt < 3 && !repo; attempt++) {
      const typed = (await ask(`Repository [${owner}/ai-task-tracking-data]`, `${owner}/ai-task-tracking-data`, undefined)).trim() || `${owner}/ai-task-tracking-data`
      if (REPO_NAME.test(typed)) repo = typed
      else io.log(`  "${typed}" is not owner/name (letters, digits, . _ -).`)
    }
    if (!repo) { io.log('✗ No valid repository name; no backup.'); return 1 }
  }
  if (!existsSync(join(home, '.git'))) {
    const init = await run(['git', 'init', '-q', '-b', 'main'], env, home)
    if (init.code !== 0) { io.log(`✗ git init failed: ${init.err}`); return 1 }
  }
  await run(['git', 'add', '-A'], env, home)
  const hasName = (await run(['git', 'config', 'user.name'], env, home)).out && (await run(['git', 'config', 'user.email'], env, home)).out
  const ident = hasName ? [] : ['-c', 'user.name=AI Task Tracking', '-c', 'user.email=aitt@localhost']
  const head = await run(['git', 'rev-parse', '-q', '--verify', 'HEAD'], env, home)
  const staged = await run(['git', 'diff', '--cached', '--quiet'], env, home)
  if (head.code !== 0 || staged.code !== 0) {
    const c = await run(['git', ...ident, 'commit', '-q', '-m', 'aitt setup'], env, home)
    if (c.code !== 0) { io.log(`✗ git commit failed: ${c.err || c.out}`); return 1 }
  }
  const created = await run(['gh', 'repo', 'create', repo, '--private', '--source', home, '--remote', 'origin', '--push'], env, home)
  if (created.code !== 0) {
    io.log(`✗ gh repo create ${repo} failed: ${(created.err || created.out).split('\n')[0]}`)
    return 1
  }
  io.log(`✓ Backup: private repo ${repo} (AI Task Tracking pushes to it automatically)`)
  return 0
}

/** The app bundle this product ships as; a link into one is ours to update. */
export const OUR_BUNDLE = /\/AI Task Tracking\.app\//

async function linkBinary(binary: string | undefined, opts: SetupOptions, io: SetupIO, confirm: Confirm): Promise<void> {
  if (opts.link === false) return
  if (!binary) { if (opts.link) io.log('• Not linking aitt: no app binary found (pass --binary).'); return }
  const binDir = join(opts.userHome, '.local', 'bin')
  const target = join(binDir, 'aitt')
  const shown = tilde(target, opts.userHome)
  const cur = await lstat(target).catch(() => null)
  if (cur && !cur.isSymbolicLink()) { io.log(`• ${shown} exists and is not a link; left alone.`); return }
  const to = cur ? resolve(binDir, await readlink(target)) : null
  if (to === binary) {
    io.log(`✓ aitt on PATH: ${shown}`)
  } else {
    if (to !== null && existsSync(to) && !OUR_BUNDLE.test(to)) {
      io.log(`• ${shown} points to ${to}, which isn't this app; left alone. Remove it and run setup again to link this one.`)
      return
    }
    if (!(await confirm(`Link ${shown} → ${binary}?`, true, opts.link))) return
    await mkdir(binDir, { recursive: true })
    if (cur) await unlink(target)
    await symlink(binary, target)
    io.log(`✓ Linked ${shown} → ${binary}`)
  }
  if (!(opts.env.PATH ?? '').split(':').includes(binDir)) {
    io.log('  ~/.local/bin is not on your PATH. Add this line to ~/.zshrc, then open a new terminal:')
    io.log('    export PATH="$HOME/.local/bin:$PATH"')
  }
}

// ---------- Claude Code MCP ----------

/** Parse `claude mcp get <name>` output (Scope / Command / Args / Environment lines). */
export function parseMcpGet(out: string): McpEntry {
  const field = (k: string) => new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm').exec(out)?.[1]?.trim() ?? ''
  const scopeText = field('Scope')
  const scope = /^user/i.test(scopeText) ? 'user' : /^project/i.test(scopeText) ? 'project' : /^local/i.test(scopeText) ? 'local' : 'unknown'
  const env: string[] = []
  const lines = out.split('\n')
  const at = lines.findIndex((l) => /^\s*Environment:\s*$/.test(l))
  if (at >= 0) {
    for (const l of lines.slice(at + 1)) {
      if (!/^\s+\S+=/.test(l)) break
      env.push(l.trim())
    }
  }
  return { scope, command: field('Command'), args: field('Args'), env }
}


export async function mcpEntry(name: string, env: SetupOptions['env']): Promise<McpEntry | null> {
  const r = await run(['claude', 'mcp', 'get', name], env)
  return r.code === 0 && /Command:/.test(r.out) ? parseMcpGet(r.out) : null
}

async function registerMcp(home: string, binary: string | undefined, opts: SetupOptions, io: SetupIO, confirm: Confirm): Promise<void> {
  if (opts.mcp === false) return
  const { env } = opts
  const manual = `claude mcp add -s user ${MCP_NAME} -e ${shellQuote(`AITT_HOME=${home}`)} -- ${shellQuote(binary ?? '<app>/Contents/Resources/aitt')} mcp`
  if (!which('claude', env)) {
    io.log(`• Claude Code (claude) not found. After installing it, register AI Task Tracking with:\n    ${manual}`)
    return
  }
  if (!binary) { io.log(`• Install the AI Task Tracking app first, then register it with:\n    ${manual}`); return }

  const existing = await mcpEntry(MCP_NAME, env)
  if (existing && !isOurMcp(existing)) {
    io.log(`• Claude Code already has an MCP server named "${MCP_NAME}" that isn't this app; left alone.\n  Remove it, then run:\n    ${manual}`)
    return
  }
  const current = existing && existing.command === binary && existing.args === 'mcp' && existing.env.length === 1 && existing.env[0] === `AITT_HOME=${home}`
  if (current) {
    io.log(`✓ Claude Code MCP server "${MCP_NAME}" (user scope)`)
  } else {
    if (!(await confirm(`Register AI Task Tracking with Claude Code as the "${MCP_NAME}" MCP server?`, true, opts.mcp))) return
    if (existing && existing.scope === 'user') await run(['claude', 'mcp', 'remove', '-s', 'user', MCP_NAME], env)
    const r = await run(['claude', 'mcp', 'add', '-s', 'user', MCP_NAME, '-e', `AITT_HOME=${home}`, '--', binary, 'mcp'], env)
    if (r.code !== 0) {
      io.log(`✗ claude mcp add failed: ${(r.err || r.out).split('\n')[0]}\n  Nothing else was changed. Run it yourself:\n    ${manual}`)
      return
    }
    io.log(`✓ Claude Code MCP server "${MCP_NAME}" → AI Task Tracking (user scope)`)
  }
}

// ---------- other agent tools ----------

/** Connect the chosen tools. A failure is reported per tool and doesn't stop the others; false if any failed. */
async function connectAgentTools(home: string, binary: string | undefined, opts: SetupOptions, io: SetupIO): Promise<boolean> {
  if (opts.connect === false) return true
  const ctx = { userHome: opts.userHome, env: opts.env, ...(opts.appDirs ? { appDirs: opts.appDirs } : {}) }
  const show = (s: string) => s.replaceAll(`${opts.userHome}/`, '~/')
  const detected = CLIENT_IDS.filter((id) => detectClient(id, ctx))
  if (opts.connect === undefined && !detected.length) return true
  if (!binary) { io.log('• Not connecting other agent tools: no app binary found (pass --binary).'); return true }
  const target = { binary, home }
  io.log('Other agent tools:')
  for (const id of CLIENT_IDS) {
    const found = detected.includes(id)
    const state = found || opts.connect?.includes(id) ? await clientStatus(id, ctx, target) : 'not found'
    io.log(`  ${found ? '✓' : '–'} ${id.padEnd(15)}${show(configPath(id, ctx)).padEnd(60)} ${state}`)
  }
  for (const id of CLIENT_IDS) {
    const other = CLIENTS[id].sharesWith
    if (other && configPath(id, ctx) === configPath(other, ctx) && (detected.includes(id) || opts.connect?.includes(id))) {
      io.log(`  ${CLIENTS[id].label} shares ${show(configPath(id, ctx))} with ${CLIENTS[other].label}: connecting one connects both.`)
    }
  }
  let chosen: ClientId[] = opts.connect ?? detected
  if (opts.connect === undefined && io.interactive) {
    const answer = (await io.ask(`Connect which? [${detected.join(',')}] (comma-separated, or none)`, detected.join(','))).trim()
    const ids = /^none$/i.test(answer) ? [] : answer.split(',').map((x) => x.trim()).filter(Boolean)
    const bad = ids.filter((x) => !(CLIENT_IDS as string[]).includes(x))
    if (bad.length) io.log(`  Skipping unknown tool(s): ${bad.join(', ')}`)
    chosen = ids.filter((x): x is ClientId => (CLIENT_IDS as string[]).includes(x))
  }
  let ok = true
  const written = new Set<string>() // tools that share a config file (Codex, ChatGPT desktop) write it once
  for (const id of chosen) {
    if (written.has(configPath(id, ctx))) continue
    written.add(configPath(id, ctx))
    let r: Awaited<ReturnType<typeof connectClient>>
    try {
      r = await connectClient(id, ctx, target)
    } catch (e) {
      ok = false
      io.log(`✗ ${CLIENTS[id].label}: could not connect: ${show(e instanceof Error ? e.message : String(e))}`)
      continue
    }
    io.log(`${r.status === 'skipped' ? '•' : '✓'} ${show(r.message)}`)
    for (const b of r.backups) io.log(`  Backed up the previous file to ${show(b)}`)
    const hint = CLIENTS[id].instructionsHint
    if (hint && r.status !== 'skipped') io.log(`  Instructions: ${hint}`)
  }
  return ok
}

// ---------- skill and CLAUDE.md ----------

async function installSkill(opts: SetupOptions, io: SetupIO, confirm: Confirm): Promise<void> {
  if (opts.skill === false) return
  const dir = join(opts.userHome, '.claude', 'skills', 'ai-task-tracking')
  const path = join(dir, 'SKILL.md')
  const marker = join(dir, SKILL_MARKER)
  const cur = await readFile(path, 'utf8').catch(() => null)
  if (cur === SKILL_TEXT) {
    if (!existsSync(marker)) await writeFile(marker, `${sha256(SKILL_TEXT)}\n`)
    io.log(`✓ Agent skill: ${tilde(path, opts.userHome)}`)
    return
  }
  const shipped = (await readFile(marker, 'utf8').catch(() => '')).trim()
  const edited = cur !== null && sha256(cur) !== shipped
  const q = cur === null ? `Install the agent skill in ${tilde(dir, opts.userHome)}?`
    : edited ? `${tilde(path, opts.userHome)} was changed after it was installed. Replace it (your copy is kept as a backup)?`
    : `Update the agent skill in ${tilde(dir, opts.userHome)}?`
  if (!(await confirm(q, true, opts.skill))) return
  await mkdir(dir, { recursive: true })
  const mode = await fileMode(path)
  if (edited) {
    const bak = `${path}.bak-aitt-${stamp()}`
    await backupFile(path, bak, mode ?? 0o600)
    io.log(`  Backed up your copy to ${tilde(bak, opts.userHome)}`)
  }
  await atomicWrite(path, SKILL_TEXT, mode)
  await writeFile(marker, `${sha256(SKILL_TEXT)}\n`)
  io.log(`✓ Agent skill ${cur === null ? 'installed' : 'updated'}: ${tilde(path, opts.userHome)}`)
}

async function addClaudeMdLine(opts: SetupOptions, io: SetupIO, confirm: Confirm): Promise<void> {
  if (opts.claudeMd === false) return
  const path = join(opts.userHome, '.claude', 'CLAUDE.md')
  const shown = tilde(path, opts.userHome)
  // A symlinked CLAUDE.md (e.g. into a dotfiles repo) is edited at its target; the link stays. A link to a
  // missing file (a dotfiles volume that isn't mounted) is left alone: writing would replace the link.
  const link = await lstat(path).then((st) => st.isSymbolicLink(), () => false)
  const target = await realpath(path).catch(() => null)
  if (link && target === null) {
    io.log(`• ${shown} left unchanged: it's a link to ${await readlink(path).catch(() => '?')}, and the linked file is missing.`)
    return
  }
  const file = target ?? path
  const cur = await readFile(file, 'utf8').catch(() => '')
  if (cur.includes(CLAUDE_MD_MARK)) { io.log(`✓ ${shown} already mentions AI Task Tracking`); return }
  if (io.interactive && opts.claudeMd === undefined) io.log(`  This line tells every Claude Code session to use AI Task Tracking:\n    ${CLAUDE_MD_LINE}`)
  if (!(await confirm(`Add it to ${shown}?`, false, opts.claudeMd))) return
  await mkdir(dirname(file), { recursive: true })
  if (existsSync(file)) {
    const bak = `${file}.bak-aitt-${stamp()}`
    await backupFile(file, bak, (await fileMode(file)) ?? 0o600)
    io.log(`  Backed up ${shown} to ${tilde(bak, opts.userHome)}`)
  }
  await atomicWrite(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${cur ? '\n' : ''}${CLAUDE_MD_LINE}\n`, await fileMode(file))
  io.log(`✓ Added the AI Task Tracking line to ${shown}`)
}

// ---------- terminal IO ----------

/**
 * Apply typed characters to a prompt buffer: Enter finishes, Ctrl-C interrupts, Backspace/Delete
 * erase, other control characters (escape sequences' ESC, tabs, …) are ignored. `echo` is what to
 * print for a visible prompt.
 */
export function feedKeys(buf: string, chunk: string): { buf: string; done: boolean; interrupted: boolean; echo: string } {
  let echo = ''
  for (const ch of chunk) {
    const code = ch.codePointAt(0)!
    if (ch === '\r' || ch === '\n') return { buf, done: true, interrupted: false, echo }
    if (ch === '\u0003') return { buf, done: false, interrupted: true, echo }
    if (ch === '\u007f' || ch === '\b') {
      if (buf) { buf = [...buf].slice(0, -1).join(''); echo += '\b \b' }
      continue
    }
    if (code < 0x20) continue
    buf += ch
    echo += ch
  }
  return { buf, done: false, interrupted: false, echo }
}

export function terminalIO(interactive: boolean): SetupIO {
  const readLine = async (question: string): Promise<string> => {
    process.stdout.write(question)
    const stdin = process.stdin
    // Raw mode on a terminal so Ctrl-C arrives as a key and setup can clean up before exiting.
    const raw = !!stdin.isTTY
    if (raw) stdin.setRawMode(true)
    stdin.resume()
    return new Promise((done, fail) => {
      let buf = ''
      const onData = (chunk: Buffer) => {
        const r = feedKeys(buf, chunk.toString('utf8'))
        buf = r.buf
        if (raw) process.stdout.write(r.echo)
        if (r.interrupted) { finish(); fail(new SetupInterrupted()) }
        else if (r.done) { finish(); done(buf) }
      }
      const finish = () => {
        stdin.off('data', onData)
        if (raw) stdin.setRawMode(false)
        stdin.pause()
        if (raw) process.stdout.write('\n')
      }
      stdin.on('data', onData)
    })
  }
  return {
    interactive,
    ask: async (q, def) => (await readLine(`${q} `)).trim() || def,
    log: (line) => console.log(line),
  }
}
