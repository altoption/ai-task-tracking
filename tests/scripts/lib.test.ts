import { afterAll, describe, expect, test } from 'bun:test'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * scripts/lib.sh, function by function, in `bash` with a temp HOME and stubs first on PATH. "Running apps" are
 * ad hoc signed copies of /bin/sleep at an app bundle's executable path; nothing real is quit or registered.
 */
const LIB = join(import.meta.dir, '../../scripts/lib.sh')
const temps: string[] = []
const procs: { kill(): void }[] = []
afterAll(async () => {
  for (const p of procs) p.kill()
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })))
})

async function sandbox() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'aitt-lib-')))
  temps.push(base)
  const stubs = join(base, 'stubs'), home = join(base, 'home')
  await mkdir(stubs); await mkdir(home)
  const log = join(base, 'stub.log')
  await writeFile(log, '')
  // osascript: the JXA quit kills the pid when it runs from the given bundle, unless $STUB_STUBBORN is set.
  await writeFile(join(stubs, 'osascript'), `#!/bin/bash
[ "$1" = "-l" ] || exit 1
echo "jxa $5 $6" >> "$STUB_LOG"
[ -n "$STUB_STUBBORN" ] && exit 0
case "$(ps -o comm= -p "$5")" in "$6/Contents/MacOS/"*) kill "$5" ;; esac
`)
  await chmod(join(stubs, 'osascript'), 0o755)
  const env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`, STUB_LOG: log }
  const sh = (script: string, extra: Record<string, string> = {}) => {
    const p = Bun.spawnSync(['bash', '-c', `set -euo pipefail; source ${JSON.stringify(LIB)}; ${script}`], { env: { ...env, ...extra } })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }
  const fakeApp = async (dir: string) => {
    const app = join(base, dir, 'AI Task Tracking.app')
    const exe = join(app, 'Contents', 'MacOS', 'AITaskTracking')
    await mkdir(join(exe, '..'), { recursive: true })
    await copyFile('/bin/sleep', exe)
    expect(Bun.spawnSync(['codesign', '--force', '--sign', '-', exe]).exitCode).toBe(0)
    const run = async () => {
      const p = Bun.spawn([exe, '300'], { stdout: 'ignore', stderr: 'ignore' })
      procs.push(p)
      for (let i = 0; i < 40 && !Bun.spawnSync(['ps', '-o', 'comm=', '-p', String(p.pid)]).stdout.toString().startsWith(app); i++) await Bun.sleep(25)
      expect(() => process.kill(p.pid, 0)).not.toThrow()
      return p
    }
    return { app, run }
  }
  return { base, home, log, sh, fakeApp, calls: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean) }
}

describe('scripts/lib.sh', () => {
  test('version_ge', async () => {
    const { sh } = await sandbox()
    const ge = (a: string, b: string) => sh(`version_ge ${a} ${b}`).code === 0
    expect(ge('1.4.4', '1.4')).toBe(true)
    expect(ge('1.4', '1.4.0')).toBe(true)
    expect(ge('1.3.9', '1.4')).toBe(false)
    expect(ge('1.10.0', '1.4')).toBe(true)
    expect(ge('v2.0.0', '1.4')).toBe(true)
    expect(ge('13.0', '13')).toBe(true)
    expect(ge('12.7.6', '13')).toBe(false)
    expect(ge('26.0.1', '13')).toBe(true)
    expect(ge('1.4.0-canary.1', '1.4')).toBe(true)
  })

  test('should_register: only ~/Applications and /Applications', async () => {
    const { sh, home } = await sandbox()
    expect(sh(`should_register ${JSON.stringify(join(home, 'Applications'))}`).code).toBe(0)
    expect(sh(`should_register ${JSON.stringify(join(home, 'Applications/'))}`).code).toBe(0)
    expect(sh('should_register /Applications').code).toBe(0)
    expect(sh(`should_register ${JSON.stringify(join(home, 'scratch'))}`).code).toBe(1)
    expect(sh('should_register /tmp/x/Applications').code).toBe(1)
  })

  test('should_register compares canonical paths: a link to ~/Applications counts, a look-alike path does not', async () => {
    const { sh, home, base } = await sandbox()
    await mkdir(join(home, 'Applications'))
    Bun.spawnSync(['ln', '-s', join(home, 'Applications'), join(base, 'apps-link')])
    expect(sh(`should_register ${JSON.stringify(join(base, 'apps-link'))}`).code).toBe(0)
    expect(sh(`should_register ${JSON.stringify(join(home, 'x', '..', 'Applications'))}`).code).toBe(0)
    expect(sh(`should_register ${JSON.stringify(join(base, 'Applications'))}`).code).toBe(1)
  })

  test('abs_path expands ~ and makes a relative path absolute, without a trailing slash', async () => {
    const { sh, home } = await sandbox()
    expect(sh('abs_path "~"').out.trim()).toBe(home)
    expect(sh('abs_path "~/AITaskTracking/"').out.trim()).toBe(join(home, 'AITaskTracking'))
    expect(sh('cd /tmp && abs_path data/x').out.trim()).toBe('/tmp/data/x')
    expect(sh('abs_path /a/b/').out.trim()).toBe('/a/b')
    expect(sh('abs_path /').out.trim()).toBe('/')
  })

  test('canon_dir resolves symlinked folders (as ps reports them) and leaves a missing path as is', async () => {
    const { sh } = await sandbox()
    expect(sh('canon_dir /tmp').out.trim()).toBe('/private/tmp')
    expect(sh('canon_dir /no/such/dir').out.trim()).toBe('/no/such/dir')
  })

  test('app_pids matches the exact bundle path, not another copy, a prefix-sharing folder or the name', async () => {
    const sb = await sandbox()
    const mine = await sb.fakeApp('a')
    const other = await sb.fakeApp('b')
    const twin = await sb.fakeApp('a2') // ".../a2/AI Task Tracking.app" doesn't start with ".../a/AI Task Tracking.app/"
    const pm = await mine.run(), po = await other.run(), pt = await twin.run()
    expect(sb.sh(`app_pids ${JSON.stringify(mine.app)}`).out.trim().split('\n')).toEqual([String(pm.pid)])
    expect(sb.sh(`app_pids ${JSON.stringify(`${mine.app}/`)}`).out.trim()).toBe(String(pm.pid))
    expect(sb.sh(`app_pids ${JSON.stringify(join(sb.base, 'none', 'AI Task Tracking.app'))}`).out).toBe('')
    for (const p of [po, pt]) p.kill()
  })

  test('quit_app quits only the copy at the given path and waits for it', async () => {
    const sb = await sandbox()
    const mine = await sb.fakeApp('scratch')
    const live = await sb.fakeApp('live')
    const pm = await mine.run(), pl = await live.run()
    const r = sb.sh(`quit_app ${JSON.stringify(mine.app)} 5`)
    expect(r.code).toBe(0)
    expect(await pm.exited).toBe(143)
    expect(() => process.kill(pl.pid, 0)).not.toThrow()
    expect(await sb.calls()).toEqual([`jxa ${pm.pid} ${mine.app}`])
    // Nothing running there: no osascript call at all.
    expect(sb.sh(`quit_app ${JSON.stringify(mine.app)} 5`).code).toBe(0)
    expect(await sb.calls()).toHaveLength(1)
    pl.kill()
  })

  test('quit_app gives up (exit 1) when the app does not quit in time', async () => {
    const sb = await sandbox()
    const mine = await sb.fakeApp('slow')
    const p = await mine.run()
    const r = sb.sh(`quit_app ${JSON.stringify(mine.app)} 1 || echo "rc=$?"`, { STUB_STUBBORN: '1' })
    expect(r.out).toContain('rc=1')
    expect(r.err).toContain('still running')
    expect(() => process.kill(p.pid, 0)).not.toThrow()
    p.kill()
  })

  test('run_setup: a failing setup is reported and the install continues; an interrupt stops it', async () => {
    const sb = await sandbox()
    const fake = join(sb.base, 'aitt')
    await writeFile(fake, '#!/bin/bash\necho "setup $*"\nexit "${FAKE_RC:-0}"\n')
    await chmod(fake, 0o755)
    const go = (rc: string) => sb.sh(`run_setup ${JSON.stringify(fake)} setup --yes; echo "after=$?"`, { FAKE_RC: rc })
    expect(go('0').out).toBe('setup setup --yes\nafter=0\n')
    const failed = go('1')
    expect(failed.out).toBe('setup setup --yes\nafter=0\n')
    expect(failed.err).toContain('aitt setup exited with 1')
    expect(sb.sh(`run_setup ${JSON.stringify(fake)} setup || echo "stopped=$?"`, { FAKE_RC: '130' }).out).toContain('stopped=130')
  })

  test('aitt_zip_name is the release asset name the installer looks for', async () => {
    const { sh } = await sandbox()
    expect(sh('aitt_zip_name 0.1.0').out).toBe('AI-Task-Tracking-0.1.0-macos.zip')
    expect(sh('case "$(aitt_zip_name 1.2.3)" in $AITT_ZIP_GLOB) echo match ;; esac').out).toBe('match\n')
  })
})
