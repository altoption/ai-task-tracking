import { afterAll, describe, expect, test } from 'bun:test'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pkg from '../../package.json'

/**
 * scripts/release.sh's checks, which all run before the build: stubs for `security` (identities), `xcrun`
 * (notary profile) and `gh` come first on PATH, and every case here stops before anything is built or signed.
 * The real build + sign is run by hand (--skip-notarize --no-publish); see the B1-B3 report.
 */
const RELEASE = join(import.meta.dir, '../../scripts/release.sh')
const temps: string[] = []
afterAll(async () => { await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))) })

const SECURITY = `#!/bin/bash
[ -n "$NO_IDENTITY" ] && { echo "     0 valid identities found"; exit 0; }
echo '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Someone (AAAAAAAAAA)"'
echo '  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Developer ID Application: Example Corp (TEAM123456)"'
echo '     2 valid identities found'
`
const XCRUN = `#!/bin/bash
echo "xcrun $*" >> "$STUB_LOG"
[ "$1 $2" = "notarytool history" ] && exit "\${NOTARY_EXIT:-0}"
exit 1
`
const GH = `#!/bin/bash
echo "gh $*" >> "$STUB_LOG"
case "$1 $2" in "auth status") exit 0 ;; "release view") exit "\${RELEASE_EXISTS:-1}" ;; esac
exit 1
`

async function sandbox() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'aitt-release-')))
  temps.push(base)
  const stubs = join(base, 'stubs')
  await mkdir(stubs)
  for (const [n, t] of [['security', SECURITY], ['xcrun', XCRUN], ['gh', GH]] as const) {
    await writeFile(join(stubs, n), t)
    await chmod(join(stubs, n), 0o755)
  }
  // Any build step is a failure here: `bun` on PATH records the call and fails.
  await writeFile(join(stubs, 'bun'), '#!/bin/bash\necho "bun $*" >> "$STUB_LOG"\nexit 99\n')
  await chmod(join(stubs, 'bun'), 0o755)
  const log = join(base, 'stub.log')
  await writeFile(log, '')
  const run = async (args: string[], extra: Record<string, string> = {}) => {
    const p = Bun.spawn(['bash', RELEASE, ...args, '--out', join(base, 'out')], {
      env: { HOME: base, PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`, STUB_LOG: log, ...extra }, stdout: 'pipe', stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, out: out + err }
  }
  const calls = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean)
  return { run, calls }
}

describe('scripts/release.sh checks (before any build)', () => {
  test('needs a version, and it must be package.json\'s', async () => {
    const sb = await sandbox()
    expect((await sb.run([])).code).toBe(2)
    const other = await sb.run(['9.9.9', '--no-publish'])
    expect(other.code).toBe(1)
    expect(other.out).toContain(`version 9.9.9 isn't package.json's (${pkg.version})`)
  })

  test('--skip-notarize without --no-publish is refused', async () => {
    const sb = await sandbox()
    const r = await sb.run([pkg.version, '--skip-notarize'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('never published; add --no-publish')
  })

  test('no Developer ID identity: a clear stop (AITT_SIGN_ID is the override)', async () => {
    const sb = await sandbox()
    const r = await sb.run([pkg.version, '--skip-notarize', '--no-publish'], { NO_IDENTITY: '1' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('no "Developer ID Application" signing identity')
  })

  test('a missing notary profile stops with the exact store-credentials command (default profile aitt-notary)', async () => {
    const sb = await sandbox()
    const r = await sb.run([pkg.version, '--no-publish'], { NOTARY_EXIT: '1' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('xcrun notarytool store-credentials "aitt-notary" --apple-id <your Apple ID email> --team-id TEAM123456 --password <app-specific password>')
    const custom = await sb.run([pkg.version, '--no-publish'], { NOTARY_EXIT: '1', AITT_NOTARY_PROFILE: 'mine' })
    expect(custom.out).toContain('store-credentials "mine"')
    expect((await sb.calls()).some((c) => c.startsWith('bun'))).toBe(false)
  })

  test('publishing refuses a release tag that already exists', async () => {
    const sb = await sandbox()
    const r = await sb.run([pkg.version], { RELEASE_EXISTS: '0' })
    expect(r.code).toBe(1)
    expect(r.out).toContain(`release v${pkg.version} already exists on altoption/ai-task-tracking`)
    expect((await sb.calls()).some((c) => c.startsWith('bun'))).toBe(false)
  })

  test('the identity picked is the first Developer ID Application one; the checks pass and the build starts', async () => {
    const sb = await sandbox()
    const r = await sb.run([pkg.version, '--skip-notarize', '--no-publish'])
    expect(r.out).toContain('signing as: Developer ID Application: Example Corp (TEAM123456)')
    expect(r.code).toBe(99) // the stub bun: the build was reached
  })
})

/**
 * The whole pipeline with every tool stubbed: a copy of the release scripts in a temp root (so the real dist/ is
 * never touched), with fake bun/swift/lipo builds, and codesign, notarytool, stapler, spctl, git and gh that log.
 */
const ROOT = join(import.meta.dir, '../..')
const PIPE_STUBS: Record<string, string> = {
  bun: `#!/bin/bash
echo "bun $*" >> "$STUB_LOG"
prev=""; for a in "$@"; do [ "$prev" = "--outfile" ] && { printf 'engine' > "$a"; chmod +x "$a"; }; prev="$a"; done
exit 0
`,
  lipo: `#!/bin/bash
echo "lipo $*" >> "$STUB_LOG"
case "$1" in -create) cp -p "$4" "$3" ;; -archs) echo "x86_64 arm64" ;; esac
`,
  swift: `#!/bin/bash
echo "swift $*" >> "$STUB_LOG"
for a in "$@"; do [ "$a" = "--show-bin-path" ] && { echo "$STUB_SWIFT_BIN"; exit 0; }; done
exit 0
`,
  codesign: '#!/bin/bash\necho "codesign $*" >> "$STUB_LOG"\n',
  spctl: '#!/bin/bash\necho "spctl $*" >> "$STUB_LOG"\n',
  xcrun: `#!/bin/bash
echo "xcrun $*" >> "$STUB_LOG"
case "$1 $2" in
  "notarytool history") exit 0 ;;
  "notarytool submit") printf '{"id":"sub-123","status":"%s","message":"Processing complete"}' "\${NOTARY_STATUS:-Accepted}" ;;
  "notarytool log") echo "notary log for $3" ;;
  "stapler staple") ;;
esac
`,
  git: `#!/bin/bash
echo "git $*" >> "$STUB_LOG"
[ "$1" = "-C" ] && shift 2
case "$1" in
  status) [ -n "$GIT_DIRTY" ] && echo " M x" ;;
  fetch) ;;
  branch) [ -z "$GIT_UNPUSHED" ] && echo "  origin/main" ;;
  rev-parse) echo 0123456789abcdef0123456789abcdef01234567 ;;
esac
`,
  gh: `#!/bin/bash
echo "gh $*" >> "$STUB_LOG"
case "$1 $2" in "auth status") exit 0 ;; "release view") exit 1 ;; "release create") exit 0 ;; esac
exit 1
`,
  security: SECURITY,
}

async function pipeline() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'aitt-release-pipe-')))
  temps.push(base)
  const root = join(base, 'repo'), stubs = join(base, 'stubs'), swiftBin = join(base, 'swiftbin')
  for (const d of ['scripts', 'app/Resources', 'dist']) await mkdir(join(root, d), { recursive: true })
  for (const f of ['scripts/lib.sh', 'scripts/release.sh', 'app/build.sh', 'app/engine.entitlements', 'app/Resources/AppIcon.icns', 'package.json']) {
    await copyFile(join(ROOT, f), join(root, f))
  }
  for (const f of ['scripts/release.sh', 'app/build.sh']) await chmod(join(root, f), 0o755)
  await mkdir(stubs); await mkdir(swiftBin)
  await writeFile(join(swiftBin, 'AITaskTracking'), 'app')
  for (const [n, t] of Object.entries(PIPE_STUBS)) { await writeFile(join(stubs, n), t); await chmod(join(stubs, n), 0o755) }
  const log = join(base, 'stub.log')
  await writeFile(log, '')
  const out = join(base, 'out')
  const run = async (args: string[], extra: Record<string, string> = {}) => {
    const p = Bun.spawn(['bash', join(root, 'scripts/release.sh'), ...args, '--out', out], {
      env: { HOME: base, PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`, STUB_LOG: log, STUB_SWIFT_BIN: swiftBin, ...extra }, stdout: 'pipe', stderr: 'pipe',
    })
    const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, out: o + e }
  }
  const calls = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean)
  return { out, run, calls, app: join(out, 'AI Task Tracking.app'), zip: join(out, `AI-Task-Tracking-${pkg.version}-macos.zip`) }
}

const ID = 'Developer ID Application: Example Corp (TEAM123456)'

describe('scripts/release.sh pipeline (stubbed tools)', () => {
  test('signs inside-out, verifies, notarizes, staples, zips and publishes the built commit', async () => {
    const p = await pipeline()
    const r = await p.run([pkg.version])
    expect(r.code).toBe(0)
    const c = await p.calls()
    const at = (pred: (l: string) => boolean) => c.findIndex(pred)
    const engine = at((l) => l.startsWith('codesign --force --options runtime --timestamp --entitlements') && l.includes(`--sign ${ID}`) && l.endsWith('Contents/Resources/aitt'))
    const app = at((l) => l === `codesign --force --options runtime --timestamp --sign ${ID} ${p.app}`)
    const verify = at((l) => l.startsWith('codesign --verify --deep --strict'))
    const submit = at((l) => l.startsWith('xcrun notarytool submit') && l.includes('--wait --output-format json'))
    const staple = at((l) => l === `xcrun stapler staple ${p.app}`)
    const publish = at((l) => l.startsWith(`gh release create v${pkg.version}`))
    for (const i of [engine, app, verify, submit, staple, publish]) expect(i).toBeGreaterThan(-1)
    expect(engine).toBeLessThan(app)
    expect(app).toBeLessThan(verify)
    expect(verify).toBeLessThan(submit)
    expect(submit).toBeLessThan(staple)
    expect(staple).toBeLessThan(publish)
    expect(c[publish]).toContain('--target 0123456789abcdef0123456789abcdef01234567')
    expect(await lstat(p.zip).then((s) => s.isFile())).toBe(true)
    expect(await readFile(`${p.zip}.sha256`, 'utf8')).toContain(`AI-Task-Tracking-${pkg.version}-macos.zip`)
  })

  test('a rejected notarization (status Invalid) stops before stapling, zipping and publishing, and prints the log', async () => {
    const p = await pipeline()
    const r = await p.run([pkg.version], { NOTARY_STATUS: 'Invalid' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('notarization status: Invalid')
    expect(r.out).toContain('notary log for sub-123')
    const c = await p.calls()
    expect(c.some((l) => l.startsWith('xcrun stapler'))).toBe(false)
    expect(c.some((l) => l.startsWith('gh release create'))).toBe(false)
    expect(await lstat(p.zip).then(() => true, () => false)).toBe(false)
  })

  test('publishing needs HEAD pushed and a clean tree (checked before building)', async () => {
    const p = await pipeline()
    const unpushed = await p.run([pkg.version], { GIT_UNPUSHED: '1' })
    expect(unpushed.code).toBe(1)
    expect(unpushed.out).toContain("HEAD isn't on any branch of origin; push it first")
    const dirty = await p.run([pkg.version], { GIT_DIRTY: '1' })
    expect(dirty.code).toBe(1)
    expect(dirty.out).toContain('the working tree has changes')
    expect((await p.calls()).some((l) => l.startsWith('bun'))).toBe(false)
  })
})
