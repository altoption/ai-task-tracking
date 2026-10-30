import { afterAll, describe, expect, test } from 'bun:test'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every script reads its arguments before doing anything: --help prints usage and exits 0, an unknown argument
 * exits 2, and neither runs a tool. Every tool a script could run is a stub that records the call. (A docs agent
 * once ran `scripts/install.sh --help`, which ignored its arguments and did a full install on the owner's Mac.)
 */
const ROOT = join(import.meta.dir, '../..')
const CLI = join(ROOT, 'src/cli.ts')
const temps: string[] = []
afterAll(async () => { await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))) })
const exists = (p: string) => lstat(p).then(() => true, () => false)
const TOOLS = ['bun', 'swift', 'gh', 'claude', 'osascript', 'defaults', 'codesign', 'xcrun', 'open', 'launchctl', 'git',
  'security', 'lipo', 'spctl', 'ditto', 'pgrep', 'curl', 'brew', 'xcode-select', 'lsregister', 'gemini', 'plutil', 'sw_vers']

async function sandbox() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'aitt-args-')))
  temps.push(base)
  const stubs = join(base, 'stubs'), home = join(base, 'home')
  await mkdir(stubs); await mkdir(home)
  const log = join(base, 'stub.log')
  await writeFile(log, '')
  for (const t of TOOLS) {
    await writeFile(join(stubs, t), `#!/bin/bash\necho "${t} $*" >> "$STUB_LOG"\nexit 1\n`)
    await chmod(join(stubs, t), 0o755)
  }
  const apps = join(base, 'apps')
  const run = async (script: string, args: string[]) => {
    const p = Bun.spawn(['/usr/bin/perl', '-MPOSIX', '-e', 'POSIX::setsid(); exec @ARGV', 'bash', join(ROOT, script), ...args], {
      env: { HOME: home, AITT_APP_DIR: apps, PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`, STUB_LOG: log, AITT_LSREGISTER: join(stubs, 'lsregister') },
      cwd: base, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, out, err, calls: (await readFile(log, 'utf8')).split('\n').filter(Boolean) }
  }
  return { base, home, apps, run }
}

describe('--help and unknown arguments do nothing', () => {
  for (const script of ['install.sh', 'uninstall.sh', 'scripts/install.sh', 'scripts/release.sh', 'app/build.sh']) {
    test(script, async () => {
      const sb = await sandbox()
      for (const help of ['--help', '-h']) {
        const r = await sb.run(script, [help])
        expect(r.code).toBe(0)
        expect(r.out).toMatch(/Usage|Install|Uninstall|Maintainer/)
        expect(r.out).not.toContain('set -euo pipefail')
        expect(r.calls).toEqual([])
      }
      const bad = await sb.run(script, ['--bogus'])
      expect(bad.code).toBe(2)
      expect(bad.err).toContain('--bogus')
      expect(bad.calls).toEqual([])
      expect(await exists(sb.apps)).toBe(false)
      expect(await readdir(sb.home)).toEqual([])
    })
  }

  test('app/build.sh without a destination does nothing (it never defaults to ~/Applications)', async () => {
    const sb = await sandbox()
    const r = await sb.run('app/build.sh', [])
    expect(r.code).toBe(2)
    expect(r.calls).toEqual([])
    expect(await readdir(sb.home)).toEqual([])
  })
})

/**
 * scripts/install.sh end to end from a temp copy of the repo: `bun run build` writes an engine that wraps this
 * checkout's CLI, `swift` hands back a signed stand-in executable, and Claude Code, Gemini (a detected agent tool),
 * defaults, osascript, codesign and lsregister are stubs.
 */
const DEV_STUBS: Record<string, string> = {
  bun: `#!/bin/bash
echo "bun $*" >> "$STUB_LOG"
if [ "$1 $2" = "run build" ]; then mkdir -p dist; printf '#!/bin/bash\\nexec %q %q "$@"\\n' "$REAL_BUN" "$REAL_CLI" > dist/aitt; chmod +x dist/aitt; fi
exit 0
`,
  swift: `#!/bin/bash
echo "swift $*" >> "$STUB_LOG"
for a in "$@"; do [ "$a" = "--show-bin-path" ] && { echo "$STUB_SWIFT_BIN"; exit 0; }; done
exit 0
`,
  codesign: '#!/bin/bash\necho "codesign $*" >> "$STUB_LOG"\n',
  osascript: '#!/bin/bash\necho "osascript $*" >> "$STUB_LOG"\n',
  defaults: '#!/bin/bash\necho "defaults $*" >> "$STUB_LOG"\ncase "$1" in read) exit 1 ;; esac\n',
  claude: '#!/bin/bash\necho "claude $*" >> "$STUB_LOG"\n[ "$1 $2" = "mcp get" ] && exit 1\nexit 0\n',
  gemini: '#!/bin/bash\necho "gemini $*" >> "$STUB_LOG"\n',
  lsregister: '#!/bin/bash\necho "lsregister $*" >> "$STUB_LOG"\n',
  open: '#!/bin/bash\necho "open $*" >> "$STUB_LOG"\n',
}

async function devRepo(opts: { appsInHome?: boolean } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'aitt-devinstall-')))
  temps.push(base)
  const root = join(base, 'repo'), stubs = join(base, 'stubs'), home = join(base, 'home'), swiftBin = join(base, 'swiftbin')
  for (const d of [join(root, 'scripts'), join(root, 'app/Resources'), stubs, home, swiftBin]) await mkdir(d, { recursive: true })
  for (const f of ['scripts/install.sh', 'scripts/lib.sh', 'app/build.sh', 'app/Resources/AppIcon.icns', 'package.json']) await copyFile(join(ROOT, f), join(root, f))
  for (const f of ['scripts/install.sh', 'app/build.sh']) await chmod(join(root, f), 0o755)
  // Signed (ad hoc) like a real build: macOS blocks running anything inside a bundle whose app binary is a
  // copied system binary with a broken signature.
  await copyFile('/bin/sleep', join(swiftBin, 'AITaskTracking'))
  expect(Bun.spawnSync(['codesign', '--force', '--sign', '-', join(swiftBin, 'AITaskTracking')]).exitCode).toBe(0)
  for (const [n, t] of Object.entries(DEV_STUBS)) { await writeFile(join(stubs, n), t); await chmod(join(stubs, n), 0o755) }
  const log = join(base, 'stub.log')
  await writeFile(log, '')
  const apps = opts.appsInHome ? join(home, 'Applications') : join(base, 'apps')
  const run = async (args: string[] = []) => {
    const p = Bun.spawn(['bash', join(root, 'scripts/install.sh'), ...args], {
      env: {
        HOME: home, AITT_APP_DIR: apps, PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`, STUB_LOG: log, STUB_SWIFT_BIN: swiftBin,
        REAL_BUN: process.execPath, REAL_CLI: CLI, AITT_LSREGISTER: join(stubs, 'lsregister'), NO_LAUNCH: '1', LANG: 'en_US.UTF-8',
      },
      cwd: base, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, out: out + err, calls: (await readFile(log, 'utf8')).split('\n').filter(Boolean) }
  }
  return { home, apps, run, gemini: join(home, '.gemini', 'settings.json'), link: join(home, '.local', 'bin', 'aitt') }
}

describe('scripts/install.sh: a scratch install leaves the agent tools alone', () => {
  // Each run starts the real CLI (setup).
  const T = 60_000
  test('scratch AITT_APP_DIR: no Claude Code entry, no aitt link, no other tools', async () => {
    const d = await devRepo()
    const r = await d.run()
    expect(r.code).toBe(0)
    expect(await exists(join(d.apps, 'AI Task Tracking.app/Contents/Resources/aitt'))).toBe(true)
    expect(r.calls.some((c) => c.startsWith('claude mcp add'))).toBe(false)
    expect(await exists(d.gemini)).toBe(false)
    expect(await exists(d.link)).toBe(false)
    expect(r.calls.some((c) => c.startsWith('defaults write') || c.startsWith('lsregister'))).toBe(false)
  }, T)
  test('scratch with an explicit --connect: those tools are connected', async () => {
    const d = await devRepo()
    const r = await d.run(['--connect', 'gemini'])
    expect(r.code).toBe(0)
    expect(await readFile(d.gemini, 'utf8')).toContain('ai-task-tracking')
  }, T)
  test('~/Applications (canonical): registers Claude Code and the link, but no other tool unless --connect names it', async () => {
    const d = await devRepo({ appsInHome: true })
    const r = await d.run()
    expect(r.code).toBe(0)
    expect(r.calls.some((c) => c.startsWith('claude mcp add -s user ai-task-tracking'))).toBe(true)
    expect(await exists(d.link)).toBe(true)
    expect(await exists(d.gemini)).toBe(false)
    expect((await d.run(['--connect', 'gemini'])).code).toBe(0)
    expect(await readFile(d.gemini, 'utf8')).toContain('ai-task-tracking')
  }, T)
})
