import { afterAll, describe, expect, test } from 'bun:test'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * install.sh's checks and plan, run as --dry-run (and the paths that stop before changing anything) with a temp
 * HOME, a scratch AITT_APP_DIR and a stub `gh` first on PATH. Each run is under setsid (no controlling terminal),
 * so the installer can never prompt. The full install/upgrade runs (which build the app) are done by hand with the
 * same kind of sandbox; see the B1-B3 report.
 */
const ROOT = join(import.meta.dir, '../..')
const INSTALL = join(ROOT, 'install.sh')
const temps: string[] = []
afterAll(async () => { await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))) })
const exists = (p: string) => lstat(p).then(() => true, () => false)

const GH = `#!/bin/bash
echo "gh $*" >> "$STUB_LOG"
case "$1 $2" in
  "auth status") exit "\${GH_AUTH_EXIT:-0}" ;;
  "api repos/altoption/ai-task-tracking") [ -n "$GH_NO_REPO" ] && exit 1; echo altoption/ai-task-tracking ;;
  "api repos/altoption/ai-task-tracking/contents/scripts/lib.sh"*) base64 < "$STUB_LIB" ;;
  "release view") [ -n "$STUB_RELEASE" ] && { echo "$STUB_RELEASE"; exit 0; }; echo "release not found" >&2; exit 1 ;;
  *) echo "gh stub: unexpected $*" >&2; exit 1 ;;
esac
`

async function sandbox() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'aitt-install-')))
  temps.push(base)
  const home = join(base, 'home'), stubs = join(base, 'stubs'), apps = join(base, 'apps')
  await mkdir(home); await mkdir(stubs)
  await writeFile(join(stubs, 'gh'), GH)
  await chmod(join(stubs, 'gh'), 0o755)
  const log = join(base, 'stub.log')
  await writeFile(log, '')
  const bunDir = join(process.execPath, '..')
  const env: Record<string, string> = {
    HOME: home, AITT_APP_DIR: apps, PATH: `${stubs}:${bunDir}:/usr/bin:/bin:/usr/sbin:/sbin`, STUB_LOG: log,
    STUB_LIB: join(ROOT, 'scripts/lib.sh'), LANG: 'en_US.UTF-8',
  }
  const setsid = ['/usr/bin/perl', '-MPOSIX', '-e', 'POSIX::setsid(); exec @ARGV']
  const go = async (cmd: string[], extra: Record<string, string> = {}, stdin?: string) => {
    const p = Bun.spawn([...setsid, ...cmd], { env: { ...env, ...extra }, cwd: base, stdin: stdin ? new Blob([stdin]) : 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, out: out + err }
  }
  /** From the clone: bash install.sh … */
  const clone = (args: string[], extra: Record<string, string> = {}) => go(['bash', INSTALL, ...args], extra)
  /** As the one-liner runs it: the script on stdin, in a folder that isn't a clone. */
  const piped = async (args: string[], extra: Record<string, string> = {}) => go(['bash', '-s', '--', ...args], extra, await readFile(INSTALL, 'utf8'))
  const calls = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean)
  return { base, home, apps, clone, piped, calls }
}

const untouched = async (sb: Awaited<ReturnType<typeof sandbox>>) => {
  expect(await exists(sb.apps)).toBe(false)
  expect(await readdir(sb.home)).toEqual([])
}

describe('install.sh --dry-run', () => {
  test('from a clone with no release: builds this checkout; changes nothing', async () => {
    const sb = await sandbox()
    const r = await sb.clone(['--dry-run'])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/Release\s+no release\s+build from source/)
    expect(r.out).toMatch(/Source\s+this checkout\s+/)
    expect(r.out).toMatch(/AI Task Tracking\s+not installed\s+install to /)
    expect(r.out).toContain('scratch folder: not registered with macOS')
    expect(r.out).toContain('Dry run: nothing was changed.')
    await untouched(sb)
  })

  test('piped into bash: fetches lib.sh with gh, plans a clone into ~/.aitt/src; its temp folder is removed', async () => {
    const sb = await sandbox()
    const tmp = join(sb.base, 'tmp')
    await mkdir(tmp)
    const r = await sb.piped(['--dry-run'], { TMPDIR: `${tmp}/` }) // macOS's TMPDIR ends with /
    expect(await readdir(tmp)).toEqual([])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/Source\s+—\s+clone altoption\/ai-task-tracking to ~\/.aitt\/src/)
    expect(await sb.calls()).toContain('gh api repos/altoption/ai-task-tracking/contents/scripts/lib.sh --jq .content')
    await untouched(sb)
  })

  test('a release with the macOS zip is preferred; --from-source skips it; --version asks for that tag', async () => {
    const sb = await sandbox()
    const rel = { STUB_RELEASE: 'v0.1.0 AI-Task-Tracking-0.1.0-macos.zip' }
    const r = await sb.clone(['--dry-run'], rel)
    expect(r.out).toMatch(/Release\s+v0.1.0 \(AI-Task-Tracking-0.1.0-macos.zip\)\s+download, verify/)
    const src = await sb.clone(['--dry-run', '--from-source'], rel)
    expect(src.out).toMatch(/Release\s+--from-source\s+build from source/)
    await sb.clone(['--dry-run', '--version', '0.2.0'], rel)
    expect((await sb.calls()).some((c) => c.startsWith('gh release view v0.2.0 --repo altoption/ai-task-tracking'))).toBe(true)
    await untouched(sb)
  })

  test('a release without the macOS zip means a source build', async () => {
    const sb = await sandbox()
    const r = await sb.clone(['--dry-run'], { STUB_RELEASE: 'v0.1.0 ' })
    expect(r.out).toMatch(/Release\s+no release\s+build from source/)
  })

  test('an upgrade is shown as one', async () => {
    const sb = await sandbox()
    await mkdir(join(sb.apps, 'AI Task Tracking.app/Contents'), { recursive: true })
    await writeFile(join(sb.apps, 'AI Task Tracking.app/Contents/Info.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.0.9</string></dict></plist>')
    const r = await sb.clone(['--dry-run'])
    expect(r.out).toMatch(/AI Task Tracking\s+0.0.9 installed\s+upgrade: quit, replace/)
  })
})

describe('install.sh when piped', () => {
  test('--help works without a file to read the comments from', async () => {
    const sb = await sandbox()
    const r = await sb.piped(['--help'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('--from-source')
    expect(r.out).toContain('bash -s -- [options]')
  })
  test('--version fetches lib.sh at that ref', async () => {
    const sb = await sandbox()
    expect((await sb.piped(['--dry-run', '--version', '0.2.0'])).code).toBe(0)
    expect(await sb.calls()).toContain('gh api repos/altoption/ai-task-tracking/contents/scripts/lib.sh?ref=v0.2.0 --jq .content')
  })
})

describe('install.sh stops before changing anything', () => {
  test('without --yes and without a terminal it refuses (exit 1)', async () => {
    const sb = await sandbox()
    const r = await sb.clone([])
    expect(r.code).toBe(1)
    expect(r.out).toContain('run it again with --yes')
    await untouched(sb)
  })

  test('piped, with gh signed out or without access to the repo: a clear blocker (exit 1)', async () => {
    const sb = await sandbox()
    const out = await sb.piped(['--yes'], { GH_AUTH_EXIT: '1' })
    expect(out.code).toBe(1)
    expect(out.out).toContain('✗ Sign the GitHub CLI in: gh auth login')
    const noRepo = await sb.piped(['--yes'], { GH_NO_REPO: '1' })
    expect(noRepo.code).toBe(1)
    expect(noRepo.out).toContain("can't read altoption/ai-task-tracking; ask for access")
    await untouched(sb)
  })

  test('unknown options and a --version without a tag exit 2', async () => {
    const sb = await sandbox()
    expect((await sb.clone(['--bogus'])).code).toBe(2)
    expect((await sb.clone(['--version'])).code).toBe(2)
  })
})

/**
 * Whole installs through the release path, with nothing built: the "release" is a zip of a small ad hoc signed
 * bundle (a signed copy of /bin/sleep as the app, a wrapper around this checkout's CLI as aitt). gh, spctl,
 * osascript, defaults, claude, lsregister and bun are stubs; "running apps" are stand-in processes at temp paths.
 */
const CLI = join(ROOT, 'src/cli.ts')
const E2E_STUBS: Record<string, string> = {
  gh: `#!/bin/bash
echo "gh $*" >> "$STUB_LOG"
case "$1 $2" in
  "auth status") exit 0 ;;
  "api repos/altoption/ai-task-tracking") echo altoption/ai-task-tracking ;;
  "release view") echo "v0.1.0 AI-Task-Tracking-0.1.0-macos.zip" ;;
  "release download")
    pat=""; dir=""; prev=""
    for a in "$@"; do [ "$prev" = "--pattern" ] && pat="$a"; [ "$prev" = "--dir" ] && dir="$a"; prev="$a"; done
    [ -f "$STUB_ASSETS/$pat" ] || exit 1
    cp "$STUB_ASSETS/$pat" "$dir/" ;;
  *) exit 1 ;;
esac
`,
  spctl: '#!/bin/bash\necho "spctl $*" >> "$STUB_LOG"\nexit "${SPCTL_EXIT:-0}"\n',
  osascript: `#!/bin/bash
if [ "$1" = "-l" ]; then
  echo "osascript-jxa $5 $6" >> "$STUB_LOG"
  case "$(ps -o comm= -p "$5")" in "$6/Contents/MacOS/"*) kill "$5" ;; esac
  exit 0
fi
echo "osascript $*" >> "$STUB_LOG"
`,
  defaults: `#!/bin/bash
echo "defaults $*" >> "$STUB_LOG"
case "$1" in read) exit 1 ;; export) exit 0 ;; esac
`,
  claude: '#!/bin/bash\necho "claude $*" >> "$STUB_LOG"\n[ "$1 $2" = "mcp get" ] && exit 1\nexit 0\n',
  lsregister: '#!/bin/bash\necho "lsregister $*" >> "$STUB_LOG"\n',
  gemini: '#!/bin/bash\necho "gemini $*" >> "$STUB_LOG"\n', // a detected agent tool
  bun: '#!/bin/bash\n[ "$1" = "--version" ] && { echo 1.4.4; exit 0; }\necho "bun $*" >> "$STUB_LOG"\nexit 1\n',
}
const procs: { kill(): void; pid: number }[] = []
afterAll(() => { for (const p of procs) p.kill() })

async function bundle(dir: string, version: string) {
  const app = join(dir, 'AI Task Tracking.app')
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true })
  await mkdir(join(app, 'Contents', 'Resources'), { recursive: true })
  await writeFile(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.aitt-test</string>
  <key>CFBundleExecutable</key><string>AITaskTracking</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>
`)
  await copyFile('/bin/sleep', join(app, 'Contents', 'MacOS', 'AITaskTracking'))
  await writeFile(join(app, 'Contents', 'Resources', 'aitt'), `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`)
  await chmod(join(app, 'Contents', 'Resources', 'aitt'), 0o755)
  expect(Bun.spawnSync(['codesign', '--force', '--sign', '-', app]).exitCode).toBe(0)
  return app
}

async function running(app: string) {
  const exe = join(app, 'Contents', 'MacOS', 'AITaskTracking')
  const p = Bun.spawn([exe, '300'], { stdout: 'ignore', stderr: 'ignore' })
  procs.push(p)
  for (let i = 0; i < 40 && !Bun.spawnSync(['ps', '-o', 'comm=', '-p', String(p.pid)]).stdout.toString().startsWith(app); i++) await Bun.sleep(25)
  expect(() => process.kill(p.pid, 0)).not.toThrow()
  return p
}

async function e2e(opts: { appsInHome?: boolean } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'aitt-install-e2e-')))
  temps.push(base)
  const home = join(base, 'home'), stubs = join(base, 'stubs'), assets = join(base, 'assets'), tmp = join(base, 'tmp')
  for (const d of [home, stubs, assets, tmp]) await mkdir(d)
  for (const [n, t] of Object.entries(E2E_STUBS)) { await writeFile(join(stubs, n), t); await chmod(join(stubs, n), 0o755) }
  const built = await bundle(join(base, 'build'), '0.1.0')
  const zip = join(assets, 'AI-Task-Tracking-0.1.0-macos.zip')
  expect(Bun.spawnSync(['ditto', '-c', '-k', '--keepParent', built, zip]).exitCode).toBe(0)
  Bun.spawnSync(['bash', '-c', 'cd "$1" && shasum -a 256 AI-Task-Tracking-0.1.0-macos.zip > AI-Task-Tracking-0.1.0-macos.zip.sha256', '_', assets])
  const apps = opts.appsInHome ? join(home, 'Applications') : join(base, 'apps')
  await mkdir(apps, { recursive: true })
  const log = join(base, 'stub.log')
  await writeFile(log, '')
  const env: Record<string, string> = {
    HOME: home, AITT_APP_DIR: apps, PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`, STUB_LOG: log, STUB_ASSETS: assets,
    AITT_LSREGISTER: join(stubs, 'lsregister'), TMPDIR: tmp, LANG: 'en_US.UTF-8',
  }
  const install = async (args: string[], extra: Record<string, string> = {}) => {
    const p = Bun.spawn(['/usr/bin/perl', '-MPOSIX', '-e', 'POSIX::setsid(); exec @ARGV', 'bash', INSTALL, ...args],
      { env: { ...env, ...extra }, cwd: base, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, out: out + err }
  }
  const calls = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean)
  const version = async () => /<string>([\d.]+)<\/string>\s*<\/dict>/.exec(await readFile(join(apps, 'AI Task Tracking.app/Contents/Info.plist'), 'utf8'))?.[1]
  const leftovers = async () => [...(await readdir(apps)).filter((f) => f.startsWith('.aitt-install')), ...(await readdir(tmp))]
  return { base, home, apps, app: join(apps, 'AI Task Tracking.app'), zip, install, calls, version, leftovers }
}

describe('install.sh release path (end to end, nothing built)', () => {
  test('upgrade: quits only the copy in AITT_APP_DIR, swaps the new app in, runs setup; scratch writes no settings', async () => {
    const t = await e2e()
    await bundle(t.apps, '0.0.9')
    const old = await running(t.app)
    const elsewhere = await running(await bundle(join(t.base, 'live'), '0.0.9'))
    const r = await t.install(['--yes', '--no-launch'], { AITT_HOME: 'data/tracker' })
    expect(r.code).toBe(0)
    expect(r.out).toContain('✓ signature and notarization verified')
    expect(await old.exited).toBe(143)
    expect(() => process.kill(elsewhere.pid, 0)).not.toThrow()
    expect((await t.calls()).filter((c) => c.startsWith('osascript-jxa'))).toEqual([`osascript-jxa ${old.pid} ${t.app}`])
    expect(await t.version()).toBe('0.1.0')
    expect(await t.leftovers()).toEqual([])
    // post_install: setup ran on the absolute data folder; a scratch folder gets no app settings or registration.
    expect(await exists(join(t.base, 'data/tracker/config.yml'))).toBe(true)
    expect(r.out).toContain(`data: ${join(t.base, 'data/tracker')}`)
    expect((await t.calls()).some((c) => c.startsWith('defaults write'))).toBe(false)
    expect((await t.calls()).some((c) => c.startsWith('lsregister'))).toBe(false)
    // …nor any agent tool: no Claude Code entry, no aitt link, no other tools.
    expect((await t.calls()).some((c) => c.startsWith('claude mcp add'))).toBe(false)
    expect(await exists(join(t.home, '.gemini/settings.json'))).toBe(false)
    expect(await exists(join(t.home, '.local/bin/aitt'))).toBe(false)
    expect(await exists(join(t.home, '.claude/skills/ai-task-tracking'))).toBe(false)
  })

  test('scratch with --connect: the named tools are connected', async () => {
    const t = await e2e()
    expect((await t.install(['--yes', '--no-launch', '--connect', 'gemini'])).code).toBe(0)
    expect(await readFile(join(t.home, '.gemini/settings.json'), 'utf8')).toContain('ai-task-tracking')
  })

  test('post_install in ~/Applications: stores an absolute trackerHome, asks for launch at login, registers the app', async () => {
    const t = await e2e({ appsInHome: true })
    const r = await t.install(['--yes', '--no-launch'], { AITT_HOME: 'rel/data/' })
    expect(r.code).toBe(0)
    const c = await t.calls()
    expect(c).toContain(`defaults write io.github.altoption.ai-task-tracking trackerHome -string ${join(t.base, 'rel/data')}`)
    expect(c).toContain('defaults write io.github.altoption.ai-task-tracking enableLoginItemOnLaunch -bool true')
    expect(c).toContain(`lsregister -f ${t.app}`)
    expect(c.some((l) => l.startsWith('claude mcp add -s user ai-task-tracking'))).toBe(true)
    expect(await readFile(join(t.home, '.gemini/settings.json'), 'utf8')).toContain('ai-task-tracking')
  })

  test('a release that fails verification falls back to source; when that build fails the old app stays', async () => {
    const t = await e2e()
    await bundle(t.apps, '0.0.9')
    const r = await t.install(['--yes', '--no-launch'], { SPCTL_EXIT: '3' })
    expect(r.out).toContain('Gatekeeper (spctl) rejects')
    expect(r.out).toContain('building from source instead')
    expect(r.code).not.toBe(0)
    expect(await t.calls()).toContain('bun install --frozen-lockfile') // the source build started (stub bun fails it)
    expect(await t.version()).toBe('0.0.9')
    expect(await t.leftovers()).toEqual([])
  })

  test('a zip that does not match its .sha256 is not installed', async () => {
    const t = await e2e()
    await writeFile(`${t.zip}.sha256`, `${'0'.repeat(64)}  AI-Task-Tracking-0.1.0-macos.zip\n`)
    const r = await t.install(['--yes', '--no-launch'])
    expect(r.out).toContain("doesn't match its .sha256")
    expect(r.out).toContain('building from source instead')
    expect(await exists(t.app)).toBe(false)
    expect(await t.leftovers()).toEqual([])
  })
})
