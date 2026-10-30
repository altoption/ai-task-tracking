/**
 * `aitt uninstall` (also run by uninstall.sh): remove what the installer and `aitt setup` added on this Mac, and
 * nothing else. The data folder is never touched; the output says where it is and how to delete it by hand.
 *
 * Removed: the running app (asked to quit, by process id, only when it runs from the bundle being removed), the
 * Claude Code `ai-task-tracking` entry only when it runs one of our app bundles,
 * our entries and guidance blocks in the other agent tools' configs (disconnectClient), the agent
 * skill when it is the shipped copy, the ~/.local/bin/aitt link when it points into one of our bundles, the
 * CLAUDE.md line setup adds, the login item, and the app bundle.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readdir, readFile, readlink, realpath, rm, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { DEFAULT_HOME_DIR, aittEnv } from '../shared/env'
import { atomicWrite } from '../store/atomic'
import { CLIENT_IDS, CLIENTS, disconnectClient } from './clients'
import { backupFile, backupName, fileMode } from './files'
import { OUR_BUNDLE_BINARY, runsBinary } from './ours'
import {
  APP_NAME, CLAUDE_MD_LINE, MCP_NAME, mcpEntry, run, SKILL_MARKER, SKILL_TEXT, tilde, which,
  type SetupIO,
} from './setup'

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
/** The app's bundle id, which is also its UserDefaults domain. */
export const BUNDLE_ID = 'io.github.altoption.ai-task-tracking'

const LIST_LOGIN_ITEMS = `tell application "System Events"
  set out to ""
  repeat with li in every login item
    set out to out & (name of li) & tab & (path of li) & linefeed
  end repeat
end tell
return out`

/** Names of the login items (System Events) whose path is `app`; SMAppService main-app items show there too. */
export async function loginItemNames(app: string, env: Record<string, string | undefined>): Promise<string[] | null> {
  const r = await run(['osascript', '-e', LIST_LOGIN_ITEMS], env)
  if (r.code !== 0) return null
  const want = app.replace(/\/$/, '')
  return r.out.split('\n').map((l) => l.split('\t')).filter(([, p]) => p?.trim().replace(/\/$/, '') === want).map(([n]) => n!)
}

/**
 * Ask one process to quit, the way the Dock's Quit does, but addressed by process id: argv = [pid, app bundle path,
 * optional "check"]. It quits only when that process's bundle is exactly the given path, so another copy of the app
 * (same bundle id, different folder) is never asked. Prints none | other:<path> | ok.
 * Keep identical to the copy in scripts/lib.sh (a test compares them).
 */
export const QUIT_APP_JXA = `ObjC.import('AppKit');
function run(argv) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
  if (!app || app.isNil()) return 'none';
  const url = app.bundleURL;
  const path = !url || url.isNil() ? '' : url.path.js;
  if (path !== argv[1]) return 'other:' + path;
  if (argv[2] !== 'check') app.terminate;
  return 'ok';
}`

export interface UninstallOptions {
  userHome: string
  /** The app bundle to remove. */
  app: string
  yes: boolean
  env: Record<string, string | undefined>
  /** Test hook: the Launch Services tool. */
  lsregister?: string
  /** How long to wait for the app to quit (it may first back up to GitHub). */
  quitTimeoutMs?: number
}

/** Processes whose executable is inside `<app>/Contents/MacOS/` (exact path prefix, never a name pattern). */
export async function appPids(app: string, env: UninstallOptions['env']): Promise<number[]> {
  const r = await run(['/bin/ps', '-axo', 'pid=,comm='], env)
  const prefix = `${app.replace(/\/$/, '')}/Contents/MacOS/`
  return r.out.split('\n').flatMap((l) => {
    const m = /^\s*(\d+)\s(.*)$/.exec(l)
    return m && m[2]!.startsWith(prefix) ? [Number(m[1])] : []
  })
}

/** Quit the app running from `app` (and only it). False if it is still running at the deadline. */
export async function quitApp(app: string, env: UninstallOptions['env'], io: SetupIO, timeoutMs = 90_000): Promise<boolean> {
  const pids = await appPids(app, env)
  if (!pids.length) return true
  io.log(`• Quitting the running app (${tilde(app, env.HOME ?? '')})…`)
  for (const pid of pids) await run(['osascript', '-l', 'JavaScript', '-e', QUIT_APP_JXA, String(pid), app], env)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await appPids(app, env)).length) return true
    await Bun.sleep(250)
  }
  return false
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** The bundle name this product ships as, and the engine binary inside it. */
const BUNDLES: Record<string, string> = { [APP_NAME]: 'aitt' }

/** The engine binaries of the bundle at `app` (an absolute, canonical path). */
export const bundleBinaries = (app: string) => Object.values(BUNDLES).map((b) => join(app, 'Contents', 'Resources', b))

const canonical = (p: string) => realpath(p).catch(() => resolve(p))
const isSameOrInside = (inner: string, outer: string) => inner === outer || inner.startsWith(outer === '/' ? '/' : `${outer}/`)

/**
 * Why `app` must not be removed, or null when it may. It must be named like one of our bundles, must not be (or
 * hold) the home folder or the data folder, and, when it exists, must be a folder with our engine binary inside.
 * A path that doesn't exist is allowed: there is nothing to delete, and its registrations can still be removed.
 */
export async function appPathRefusal(app: string, userHome: string, dataHome: string): Promise<string | null> {
  const name = basename(app)
  if (!(name in BUNDLES)) return `${app} isn't an app bundle of ours (expected …/${APP_NAME})`
  for (const [what, p] of [['the home folder', userHome], ['the data folder', dataHome]] as const) {
    if (isSameOrInside(await canonical(p), app)) return `${app} holds ${what} (${p})`
  }
  const st = await lstat(app).catch(() => null)
  if (!st) return null
  if (!st.isDirectory()) return `${app} isn't a folder`
  const engine = join(app, 'Contents', 'Resources', BUNDLES[name]!)
  if (!(await lstat(engine).then((e) => e.isFile(), () => false))) return `${app} has no ${engine.slice(app.length + 1)}; it doesn't look like our app`
  return null
}

export async function runUninstall(opts: UninstallOptions, io: SetupIO): Promise<number> {
  const { env, userHome } = opts
  const app = opts.app.replace(/\/$/, '')
  const show = (p: string) => tilde(p, userHome)
  const dataHome = aittEnv('HOME', env) || (await run(['defaults', 'read', BUNDLE_ID, 'trackerHome'], env)).out.trim()
    || join(userHome, DEFAULT_HOME_DIR)
  const refusal = await appPathRefusal(app, userHome, dataHome)
  if (refusal) { io.log(`✗ Not uninstalling: ${refusal}. Nothing was changed.`); return 2 }
  const binaries = bundleBinaries(app)
  const thisApp = (command: string) => runsBinary(command, binaries)

  io.log('This removes AI Task Tracking from this Mac:')
  io.log(`  • the app ${show(app)}${existsSync(app) ? '' : ' (not there)'} and its login item`)
  io.log(`  • the "${MCP_NAME}" MCP server in Claude Code and in other agent tools, and the ~/.local/bin/aitt link (only those that run this app)`)
  io.log('  • the agent skill (~/.claude/skills/ai-task-tracking) and the CLAUDE.md line, unless another install stays registered')
  io.log(`Your data stays where it is: ${dataHome}`)
  if (!opts.yes) {
    if (!io.interactive) { io.log('✗ Not uninstalling: run it in a terminal to confirm, or pass --yes.'); return 2 }
    if (!/^y(es)?$/i.test((await io.ask('Uninstall AI Task Tracking? [y/N]', 'n')).trim())) { io.log('Nothing was changed.'); return 1 }
  }

  // 1. The app must be gone before its bundle is removed.
  if (!(await quitApp(app, env, io, opts.quitTimeoutMs))) {
    io.log(`✗ ${show(app)} is still running (a backup prompt may be waiting). Quit it from the menu bar, then run uninstall again. Nothing was removed.`)
    return 1
  }

  let ok = true
  const step = async (what: string, fn: () => Promise<void>) => {
    try { await fn() } catch (e) { ok = false; io.log(`✗ ${what}: ${e instanceof Error ? e.message : String(e)}`) }
  }

  // Another install of ours that stays registered keeps the shared pieces (skill, CLAUDE.md line).
  const others: string[] = []
  const otherInstall = (command: string) => {
    if (!thisApp(command) && OUR_BUNDLE_BINARY.test(command) && existsSync(command)) others.push(command)
  }

  // 2. Claude Code: only entries whose command is this app's binary.
  await step('Claude Code', async () => {
    if (!which('claude', env)) return
    const name = MCP_NAME
    const e = await mcpEntry(name, env)
    if (!e) return
    if (!(e.args === 'mcp' && thisApp(e.command))) {
      otherInstall(e.command)
      io.log(`• Claude Code's "${name}" server runs ${e.command}, not this app (another install?); left alone.`)
      return
    }
    if (e.scope !== 'user') { io.log(`• A ${e.scope}-scope "${name}" entry runs this app; remove it with: claude mcp remove ${name} -s ${e.scope}`); return }
    const r = await run(['claude', 'mcp', 'remove', '-s', 'user', name], env)
    if (r.code !== 0) throw new Error(`claude mcp remove ${name} failed: ${(r.err || r.out).split('\n')[0]}`)
    io.log(`✓ Removed the "${name}" MCP server from Claude Code (restart its sessions)`)
  })

  // 3. Other agent tools: only our entry and guidance block.
  for (const id of CLIENT_IDS.filter((x) => !CLIENTS[x].sharesWith)) { // a shared file is cleaned once
    await step(CLIENTS[id].label, async () => {
      const r = await disconnectClient(id, { userHome, env }, binaries)
      if (r.status !== 'unchanged') io.log(`${r.status === 'skipped' ? '•' : '✓'} ${r.message.replaceAll(`${userHome}/`, '~/')}`)
      for (const b of r.backups) io.log(`  Backed up the previous file to ${show(b)}`)
    })
  }

  // 4. The aitt link, when it points at this app's binary.
  await step('aitt link', async () => {
    const link = join(userHome, '.local', 'bin', 'aitt')
    const st = await lstat(link).catch(() => null)
    if (!st) return
    const to = st.isSymbolicLink() ? resolve(dirname(link), await readlink(link)) : null
    if (to === null || !thisApp(to)) {
      if (to !== null) otherInstall(to)
      io.log(`• ${show(link)} isn't a link to this app; left alone.`)
      return
    }
    await unlink(link)
    io.log(`✓ Removed ${show(link)}`)
  })

  // 5–6. Shared by every install: the skill (when it is the copy setup installed; an edited one is the user's)
  // and the CLAUDE.md line go only when no other install of ours stays registered (Claude Code's entry or the
  // aitt link still pointing at another existing bundle).
  const shared = others.length === 0
  if (!shared) io.log(`• Keeping the agent skill and the CLAUDE.md line: another install stays registered (${[...new Set(others)].map(show).join(', ')}).`)
  if (shared) await step('Agent skill', async () => {
    const dir = join(userHome, '.claude', 'skills', 'ai-task-tracking')
    const st = await lstat(dir).catch(() => null)
    if (!st) return
    if (!st.isDirectory()) { io.log(`• ${show(dir)} is not a folder; left alone.`); return }
    const text = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => null)
    const shipped = (await readFile(join(dir, SKILL_MARKER), 'utf8').catch(() => '')).trim()
    if (text !== null && text !== SKILL_TEXT && sha256(text) !== shipped) {
      io.log(`• ${show(join(dir, 'SKILL.md'))} was changed after it was installed; left alone (delete it yourself if you don't need it).`)
      return
    }
    await rm(join(dir, 'SKILL.md'), { force: true })
    await rm(join(dir, SKILL_MARKER), { force: true })
    const rest = await readdir(dir)
    if (rest.length) io.log(`✓ Removed the agent skill; ${show(dir)} still holds your files (${rest.join(', ')})`)
    else { await rmdir(dir); io.log(`✓ Removed the agent skill (${show(dir)})`) }
  })

  // The CLAUDE.md line (exactly the one setup adds), edited at a symlink's target.
  if (shared) await step('CLAUDE.md', () => removeClaudeMdLine(userHome, io))

  // 7. Login item, Launch Services, the bundle.
  await step('Login item', async () => {
    const names = await loginItemNames(app, env)
    if (names === null) { io.log('• Could not read the login items; if "AI Task Tracking" is listed in System Settings ▸ General ▸ Login Items, remove it.'); return }
    for (const name of names) {
      const r = await run(['osascript', '-e', `tell application "System Events" to delete login item ${JSON.stringify(name)}`], env)
      if (r.code !== 0) throw new Error(`could not remove the login item "${name}": ${(r.err || r.out).split('\n')[0]}`)
      io.log(`✓ Removed the login item "${name}"`)
    }
  })
  await step('App', async () => {
    if (!existsSync(app)) { io.log(`• No app at ${show(app)}`); return }
    const again = await appPathRefusal(app, userHome, dataHome) // checked again right before deleting
    if (again) throw new Error(`not removing it: ${again}`)
    await run([opts.lsregister ?? LSREGISTER, '-u', app], env)
    await rm(app, { recursive: true, force: true })
    io.log(`✓ Removed ${show(app)}`)
  })

  io.log(`\nYour data is still in ${dataHome}. To delete it as well: rm -rf '${dataHome.replaceAll("'", `'\\''`)}'`)
  io.log(`  (and its GitHub backup repo, if you made one). Settings: defaults delete ${BUNDLE_ID}`)
  if (!ok) io.log('\nSome steps failed (see ✗ above); fix that and run uninstall again.')
  return ok ? 0 : 1
}

async function removeClaudeMdLine(userHome: string, io: SetupIO): Promise<void> {
  const path = join(userHome, '.claude', 'CLAUDE.md')
  const file = await realpath(path).catch(() => null)
  if (file === null) return // missing, or a link to a missing file
  const cur = await readFile(file, 'utf8')
  const lines = cur.split('\n')
  const at = lines.indexOf(CLAUDE_MD_LINE)
  if (at < 0) return
  // Setup added a blank line before ours; take it out with the line.
  const from = at > 0 && lines[at - 1] === '' ? at - 1 : at
  const next = [...lines.slice(0, from), ...lines.slice(at + 1)].join('\n')
  const mode = (await fileMode(file)) ?? 0o600
  const bak = backupName(file)
  await backupFile(file, bak, mode)
  await atomicWrite(file, next, mode)
  io.log(`✓ Removed the AI Task Tracking line from ${tilde(path, userHome)} (backup: ${tilde(bak, userHome)})`)
}

export const UNINSTALL_USAGE = `Usage: aitt uninstall [--yes] [--app <path>]
Removes AI Task Tracking from this Mac: the app, its login item, and the MCP entries and ~/.local/bin/aitt link that
run this app; the agent skill and the CLAUDE.md line too, unless another install stays registered. Your data folder
is kept. Asks first unless --yes.
  --app <path>   the app bundle to remove (default: the one this aitt is in, else ~/Applications/${APP_NAME}).
                 Must be named ${APP_NAME} and have its engine inside; never a folder that
                 holds your home or data folder.`

/** The bundle this binary lives in, if it is one of ours. */
async function ownBundle(): Promise<string | undefined> {
  const self = await realpath(process.execPath).catch(() => process.execPath)
  return OUR_BUNDLE_BINARY.test(self) ? resolve(self, '..', '..', '..') : undefined
}

export async function uninstallCommand(args: string[], env: Record<string, string | undefined>, userHome: string, io: (interactive: boolean) => SetupIO): Promise<number> {
  let yes = false, app: string | undefined, lsregister: string | undefined
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--yes': case '-y': yes = true; break
      case '--app': app = args[++i]; if (!app) { console.error(UNINSTALL_USAGE); return 2 } break
      case '--lsregister': lsregister = args[++i]; break // test hook
      case '--help': case '-h': console.log(UNINSTALL_USAGE); return 0
      default: console.error(`aitt uninstall: unknown option ${args[i]}\n${UNINSTALL_USAGE}`); return 2
    }
  }
  const target = app ? resolve(app) : (await ownBundle()) ?? join(env.AITT_APP_DIR || join(userHome, 'Applications'), APP_NAME)
  const appPath = await realpath(target).catch(() => target)
  const interactive = !yes && !!process.stdin.isTTY && !!process.stdout.isTTY
  return runUninstall({ userHome, app: appPath, yes, env, lsregister }, io(interactive))
}
