import { afterAll, describe, expect, test } from 'bun:test'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_MD_LINE } from '../../src/setup/setup'
import { QUIT_APP_JXA } from '../../src/setup/uninstall'

/**
 * `aitt uninstall` against a temp HOME. `claude`, `osascript` and `defaults` are stubs first on PATH, the Launch
 * Services tool is a stub passed with --lsregister, and "running apps" are copies of /bin/sleep placed at an app
 * bundle's executable path, so nothing on this Mac (the real app, Claude Code, login items, defaults) is touched.
 */
const CLI = join(import.meta.dir, '../../src/cli.ts')
const ROOT = join(import.meta.dir, '../..')
const exists = (p: string) => lstat(p).then(() => true, () => false)
const temps: string[] = []
const procs: { kill(): void }[] = []
afterAll(async () => {
  for (const p of procs) p.kill()
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })))
})

const CLAUDE = `#!/bin/bash
echo "claude $*" >> "$STUB_LOG"
D="$STUB_MCP_DIR"
case "$1 $2" in
  "mcp get") [ -f "$D/$3" ] && { cat "$D/$3"; exit 0; }; echo "No MCP server found with name: $3" >&2; exit 1 ;;
  "mcp remove") rm -f "$D/$5" ;;
  "mcp add")
    printf '%s:\\n  Scope: User config (available in all your projects)\\n  Status: ✔ Connected\\n  Type: stdio\\n  Command: %s\\n  Args: %s\\n  Environment:\\n    %s\\n\\nTo remove this server, run: claude mcp remove "%s" -s user\\n' "$5" "$9" "\${10}" "$7" "$5" > "$D/$5" ;;
esac
`
/**
 * osascript: the JXA quit (-l JavaScript -e <script> <pid> <app>) behaves like the real script: it terminates the
 * process only when it runs from <app>. Login items live in $STUB_LOGIN_ITEMS as "name<TAB>path" lines.
 */
const OSASCRIPT = `#!/bin/bash
if [ "$1" = "-l" ]; then
  pid="$5"; app="$6"
  echo "osascript-jxa $pid $app" >> "$STUB_LOG"
  exe="$(ps -o comm= -p "$pid" 2>/dev/null)"
  case "$exe" in "$app/Contents/MacOS/"*) kill "$pid"; echo ok ;; "") echo none ;; *) echo "other:$exe" ;; esac
  exit 0
fi
echo "osascript $*" >> "$STUB_LOG"
case "$2" in
  *"every login item"*) cat "$STUB_LOGIN_ITEMS" 2>/dev/null; exit 0 ;;
  *"delete login item"*)
    name="$(printf '%s' "$2" | sed -n 's/.*delete login item "\\(.*\\)"$/\\1/p')"
    grep -v "^$name	" "$STUB_LOGIN_ITEMS" > "$STUB_LOGIN_ITEMS.new" || true
    mv "$STUB_LOGIN_ITEMS.new" "$STUB_LOGIN_ITEMS"; exit 0 ;;
esac
exit 1
`
/** defaults: values are files $STUB_DEFAULTS/<domain>/<key>. */
const DEFAULTS = `#!/bin/bash
echo "defaults $*" >> "$STUB_LOG"
f="$STUB_DEFAULTS/$2/$3"
case "$1" in
  read) [ -f "$f" ] && { cat "$f"; exit 0; }; exit 1 ;;
  write) mkdir -p "$STUB_DEFAULTS/$2"; printf '%s' "$5" > "$f" ;;
  export) exit 0 ;;
  *) exit 1 ;;
esac
`
const LSREGISTER = `#!/bin/bash
echo "lsregister $*" >> "$STUB_LOG"
`

const mcpGet = (name: string, command: string, args: string, env: string[] = []) =>
  `${name}:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected\n  Type: stdio\n  Command: ${command}\n  Args: ${args}\n  Environment:\n${env.map((e) => `    ${e}\n`).join('')}\nTo remove this server, run: claude mcp remove ${name} -s user\n`

async function stub(dir: string, name: string, text: string) {
  await writeFile(join(dir, name), text)
  await chmod(join(dir, name), 0o755)
}

/** A fake installed app bundle; `run()` starts a process at its executable path (a copy of /bin/sleep). */
async function fakeApp(dir: string) {
  const app = join(dir, 'AI Task Tracking.app')
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true })
  await mkdir(join(app, 'Contents', 'Resources'), { recursive: true })
  // A copied system binary is killed at launch unless it is re-signed (ad hoc) as an ordinary binary.
  await copyFile('/bin/sleep', join(app, 'Contents', 'MacOS', 'AITaskTracking'))
  expect(Bun.spawnSync(['codesign', '--force', '--sign', '-', join(app, 'Contents', 'MacOS', 'AITaskTracking')]).exitCode).toBe(0)
  await writeFile(join(app, 'Contents', 'Resources', 'aitt'), '#!/bin/sh\n')
  await chmod(join(app, 'Contents', 'Resources', 'aitt'), 0o755)
  const run = async () => {
    const p = Bun.spawn([join(app, 'Contents', 'MacOS', 'AITaskTracking'), '300'], { stdout: 'ignore', stderr: 'ignore' })
    procs.push(p)
    // Wait until ps shows it under its full path.
    for (let i = 0; i < 40; i++) {
      const out = Bun.spawnSync(['ps', '-o', 'comm=', '-p', String(p.pid)]).stdout.toString().trim()
      if (out.startsWith(app)) break
      await Bun.sleep(25)
    }
    return p
  }
  return { app, binary: join(app, 'Contents', 'Resources', 'aitt'), run }
}

async function sandbox() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'aitt-uninstall-')))
  temps.push(base)
  const home = join(base, 'home'), stubs = join(base, 'stubs'), mcp = join(base, 'mcp'), defaults = join(base, 'defaults')
  for (const d of [home, stubs, mcp, defaults]) await mkdir(d, { recursive: true })
  await stub(stubs, 'claude', CLAUDE)
  await stub(stubs, 'osascript', OSASCRIPT)
  await stub(stubs, 'defaults', DEFAULTS)
  await stub(stubs, 'lsregister', LSREGISTER)
  const log = join(base, 'stub.log'), loginItems = join(base, 'login-items')
  await writeFile(log, '')
  const apps = join(base, 'Applications')
  const a = await fakeApp(apps)
  const env: Record<string, string> = {
    HOME: home, PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`, STUB_LOG: log, STUB_MCP_DIR: mcp, STUB_DEFAULTS: defaults,
    STUB_LOGIN_ITEMS: loginItems, LANG: 'en_US.UTF-8',
  }
  const cli = async (args: string[], extra: Record<string, string> = {}) => {
    const p = Bun.spawn([process.execPath, CLI, ...args], { env: { ...env, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, out: out + err }
  }
  const uninstall = (args: string[] = ['--yes']) => cli(['uninstall', '--app', a.app, '--lsregister', join(stubs, 'lsregister'), ...args])
  const calls = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean)
  return { base, home, env, data: join(home, 'AITaskTracking'), apps, app: a, mcp, loginItems, cli, uninstall, calls }
}

/** Set the sandbox up the way `aitt setup` does: MCP, skill, link, two agent tools (with other servers), CLAUDE.md. */
async function installed(sb: Awaited<ReturnType<typeof sandbox>>) {
  await mkdir(join(sb.home, '.codex'), { recursive: true })
  await writeFile(join(sb.home, '.codex', 'config.toml'), '# mine\n[mcp_servers.other]\ncommand = "other"\n')
  await writeFile(join(sb.home, '.codex', 'AGENTS.md'), '# My Codex rules\n- be nice\n')
  await mkdir(join(sb.home, '.cursor'), { recursive: true })
  await writeFile(join(sb.home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2))
  await mkdir(join(sb.home, '.claude'), { recursive: true })
  await writeFile(join(sb.home, '.claude', 'CLAUDE.md'), '# Mine\n- rule one\n')
  const r = await sb.cli(['setup', '--yes', '--binary', sb.app.binary, '--connect', 'codex,cursor', '--claude-md', '--project', 'Web'])
  expect(r.code).toBe(0)
  await writeFile(sb.loginItems, `AI Task Tracking\t${sb.app.app}\nOther\t/Applications/Other.app\n`)
  // Precondition: everything is there.
  expect(await exists(join(sb.mcp, 'ai-task-tracking'))).toBe(true)
  expect(await exists(join(sb.home, '.claude/skills/ai-task-tracking/SKILL.md'))).toBe(true)
  expect(await readlink(join(sb.home, '.local/bin/aitt'))).toBe(sb.app.binary)
  expect(await readFile(join(sb.home, '.codex/config.toml'), 'utf8')).toContain('[mcp_servers.ai-task-tracking]')
  expect(await readFile(join(sb.home, '.codex/AGENTS.md'), 'utf8')).toContain('<!-- ai-task-tracking:start')
  expect(await readFile(join(sb.home, '.claude/CLAUDE.md'), 'utf8')).toContain(CLAUDE_MD_LINE)
}

describe('aitt uninstall', () => {
  test('asks first: without --yes and without a terminal it changes nothing (exit 2)', async () => {
    const sb = await sandbox()
    await installed(sb)
    const r = await sb.uninstall([])
    expect(r.code).toBe(2)
    expect(r.out).toContain('--yes')
    expect(await exists(sb.app.app)).toBe(true)
    expect(await exists(join(sb.mcp, 'ai-task-tracking'))).toBe(true)
    expect(await exists(join(sb.home, '.local/bin/aitt'))).toBe(true)
  })

  test('--yes removes the app, link, skill, login item and our entries; keeps the data and everything else', async () => {
    const sb = await sandbox()
    await installed(sb)
    const config = await readFile(join(sb.data, 'config.yml'), 'utf8')
    const r = await sb.uninstall()
    expect(r.code).toBe(0)
    // app, link, skill, login item
    expect(await exists(sb.app.app)).toBe(false)
    expect(await exists(join(sb.home, '.local/bin/aitt'))).toBe(false)
    expect(await exists(join(sb.home, '.claude/skills/ai-task-tracking'))).toBe(false)
    expect(await readFile(sb.loginItems, 'utf8')).toBe('Other\t/Applications/Other.app\n')
    // Claude Code: removed with the user scope
    expect(await sb.calls()).toContain('claude mcp remove -s user ai-task-tracking')
    expect(await exists(join(sb.mcp, 'ai-task-tracking'))).toBe(false)
    // other agent tools: only our entry and block go
    const toml = await readFile(join(sb.home, '.codex/config.toml'), 'utf8')
    expect(toml).toContain('[mcp_servers.other]')
    expect(toml).not.toContain('ai-task-tracking')
    expect(await readFile(join(sb.home, '.codex/AGENTS.md'), 'utf8')).toBe('# My Codex rules\n- be nice\n')
    expect(JSON.parse(await readFile(join(sb.home, '.cursor/mcp.json'), 'utf8'))).toEqual({ mcpServers: { other: { command: 'x' } } })
    // CLAUDE.md: our line goes, the rest stays
    expect(await readFile(join(sb.home, '.claude/CLAUDE.md'), 'utf8')).toBe('# Mine\n- rule one\n')
    // data folder untouched, and the output says where it is
    expect(await readFile(join(sb.data, 'config.yml'), 'utf8')).toBe(config)
    expect(r.out).toContain(sb.data)
    expect((await sb.calls()).some((c) => c.startsWith('lsregister -u') && c.includes(sb.app.app))).toBe(true)
  })

  test('quits only the app being removed: another copy at a different path keeps running', async () => {
    const sb = await sandbox()
    await installed(sb)
    const other = await fakeApp(join(sb.base, 'live'))
    const mine = await sb.app.run()
    const theirs = await other.run()
    for (const p of [mine, theirs]) expect(() => process.kill(p.pid, 0)).not.toThrow()
    const r = await sb.uninstall()
    expect(r.code).toBe(0)
    expect(await mine.exited).toBe(143) // SIGTERM from the (stub) quit
    expect(theirs.exitCode).toBeNull()
    expect(() => process.kill(theirs.pid, 0)).not.toThrow()
    const quits = (await sb.calls()).filter((c) => c.startsWith('osascript-jxa'))
    expect(quits).toEqual([`osascript-jxa ${mine.pid} ${sb.app.app}`])
    expect(await exists(other.app)).toBe(true)
  })

  test("leaves what isn't ours: another ai-task-tracking server, an edited skill, a link elsewhere", async () => {
    const sb = await sandbox()
    await writeFile(join(sb.mcp, 'ai-task-tracking'), mcpGet('ai-task-tracking', '/opt/someone/else', 'serve'))
    await mkdir(join(sb.home, '.claude/skills/ai-task-tracking'), { recursive: true })
    await writeFile(join(sb.home, '.claude/skills/ai-task-tracking/SKILL.md'), 'my own skill\n')
    await mkdir(join(sb.home, '.local/bin'), { recursive: true })
    await writeFile(join(sb.base, 'mine'), '')
    await symlink(join(sb.base, 'mine'), join(sb.home, '.local/bin/aitt'))
    const r = await sb.uninstall()
    expect(r.code).toBe(0)
    expect(await exists(join(sb.mcp, 'ai-task-tracking'))).toBe(true)
    expect((await sb.calls()).filter((c) => c.startsWith('claude mcp remove'))).toEqual([])
    expect(await readFile(join(sb.home, '.claude/skills/ai-task-tracking/SKILL.md'), 'utf8')).toBe('my own skill\n')
    expect(await readlink(join(sb.home, '.local/bin/aitt'))).toBe(join(sb.base, 'mine'))
    expect(await exists(sb.app.app)).toBe(false)
  })

  test('a second run finds nothing to do and still exits 0; the data folder is never touched', async () => {
    const sb = await sandbox()
    await installed(sb)
    expect((await sb.uninstall()).code).toBe(0)
    const r = await sb.uninstall()
    expect(r.code).toBe(0)
    expect(r.out).toContain('No app at')
    expect(await exists(join(sb.data, 'config.yml'))).toBe(true)
  })

  test('uninstall.sh runs the installed app\'s aitt uninstall (asks unless --yes; no terminal -> exit 2)', async () => {
    const sb = await sandbox()
    await installed(sb)
    // The installed binary: a wrapper around this checkout's CLI.
    await writeFile(sb.app.binary, `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`)
    const sh = async (args: string[], extra: Record<string, string> = {}) => {
      // setsid: no controlling terminal, so /dev/tty can't be opened even when the tests run in one.
      const p = Bun.spawn(['/usr/bin/perl', '-MPOSIX', '-e', 'POSIX::setsid(); exec @ARGV', 'bash', join(ROOT, 'uninstall.sh'), ...args], { env: { ...sb.env, AITT_APP_DIR: sb.apps, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      return { code, out: out + err }
    }
    const asked = await sh([])
    expect(asked.code).toBe(2)
    expect(await exists(sb.app.app)).toBe(true)
    const r = await sh(['--yes', '--lsregister', join(sb.base, 'stubs', 'lsregister')])
    expect(r.code).toBe(0)
    expect(await exists(sb.app.app)).toBe(false)
    expect(await exists(join(sb.home, '.local/bin/aitt'))).toBe(false)
    expect(await exists(join(sb.data, 'config.yml'))).toBe(true)
    const gone = await sh(['--yes'])
    expect(gone.code).toBe(1)
    expect(gone.out).toContain('nothing to uninstall')
  })

  test('refuses a folder that is not one of our app bundles (exit 2, nothing removed)', async () => {
    const sb = await sandbox()
    await installed(sb)
    const notApp = join(sb.base, 'Projects')
    await mkdir(join(notApp, 'keep'), { recursive: true })
    await writeFile(join(notApp, 'keep', 'file.txt'), 'mine')
    // Named like our bundle, but without the engine inside.
    const lookalike = join(sb.base, 'other', 'AI Task Tracking.app')
    await mkdir(join(lookalike, 'Contents'), { recursive: true })
    for (const app of [notApp, lookalike, '/']) {
      const r = await sb.cli(['uninstall', '--yes', '--app', app])
      expect(r.code).toBe(2)
      expect(r.out).toContain('✗ Not uninstalling')
    }
    expect(await readFile(join(notApp, 'keep', 'file.txt'), 'utf8')).toBe('mine')
    expect(await exists(lookalike)).toBe(true)
    expect(await exists(join(sb.mcp, 'ai-task-tracking'))).toBe(true) // nothing else was touched either
    expect(await exists(join(sb.home, '.local/bin/aitt'))).toBe(true)
  })

  test('refuses HOME, a parent of HOME, and a parent of the data folder, even when shaped like our bundle', async () => {
    const sb = await sandbox()
    await installed(sb)
    for (const app of [sb.home, sb.base, join(sb.home, '..')]) {
      const r = await sb.cli(['uninstall', '--yes', '--app', app])
      expect(r.code).toBe(2)
    }
    // A bundle-shaped folder that holds the data folder (AITT_HOME) or the home folder.
    const shaped = join(sb.base, 'odd', 'AI Task Tracking.app')
    await mkdir(join(shaped, 'Contents', 'Resources'), { recursive: true })
    await writeFile(join(shaped, 'Contents', 'Resources', 'aitt'), '#!/bin/sh\n')
    await mkdir(join(shaped, 'data'))
    await writeFile(join(shaped, 'data', 'config.yml'), 'port: 7477\n')
    const withData = await sb.cli(['uninstall', '--yes', '--app', shaped], { AITT_HOME: join(shaped, 'data') })
    expect(withData.code).toBe(2)
    expect(withData.out).toContain('holds the data folder')
    const withHome = await sb.cli(['uninstall', '--yes', '--app', shaped], { HOME: join(shaped, 'data') })
    expect(withHome.code).toBe(2)
    expect(await readFile(join(shaped, 'data', 'config.yml'), 'utf8')).toBe('port: 7477\n')
    expect(await exists(sb.home)).toBe(true)
    expect(await exists(join(sb.data, 'config.yml'))).toBe(true)
  })

  test('uninstalling a second (scratch) copy leaves the registered install alone', async () => {
    const sb = await sandbox()
    await installed(sb) // registered: Claude Code, link, codex + cursor, skill, CLAUDE.md -> sb.app
    const scratch = await fakeApp(join(sb.base, 'scratch'))
    const r = await sb.cli(['uninstall', '--yes', '--app', scratch.app, '--lsregister', join(sb.base, 'stubs', 'lsregister')])
    expect(r.code).toBe(0)
    expect(await exists(scratch.app)).toBe(false)
    expect(await exists(sb.app.app)).toBe(true)
    expect((await sb.calls()).filter((c) => c.startsWith('claude mcp remove'))).toEqual([])
    expect(await exists(join(sb.mcp, 'ai-task-tracking'))).toBe(true)
    expect(await readlink(join(sb.home, '.local/bin/aitt'))).toBe(sb.app.binary)
    expect(await readFile(join(sb.home, '.codex/config.toml'), 'utf8')).toContain('[mcp_servers.ai-task-tracking]')
    expect(await readFile(join(sb.home, '.codex/AGENTS.md'), 'utf8')).toContain('<!-- ai-task-tracking:start')
    expect(JSON.parse(await readFile(join(sb.home, '.cursor/mcp.json'), 'utf8')).mcpServers['ai-task-tracking'].command).toBe(sb.app.binary)
    expect(await exists(join(sb.home, '.claude/skills/ai-task-tracking/SKILL.md'))).toBe(true)
    expect(await readFile(join(sb.home, '.claude/CLAUDE.md'), 'utf8')).toContain(CLAUDE_MD_LINE)
    expect(r.out).toContain('another install')
  })

  test('the installer and the uninstaller quit the app with the same JXA script', async () => {
    const lib = await readFile(join(ROOT, 'scripts/lib.sh'), 'utf8')
    const m = /<<'JXA'\n([\s\S]*?)\nJXA\n/.exec(lib)
    expect(m?.[1]).toBe(QUIT_APP_JXA)
  })
})
