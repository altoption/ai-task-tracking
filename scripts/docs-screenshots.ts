#!/usr/bin/env bun
/**
 * Screenshots of the app's UI for the docs site and the README (bun run docs:shots). Not part of `bun run check`.
 *
 * Starts a scratch engine (`bun src/cli.ts serve`) on a temp data folder and a free port (never 7477, never your real
 * folder), seeds fictional sample data through the engine's tool API, captures the pages with Playwright at
 * 1440×900 @2x, and writes optimized PNGs to site/src/assets/screenshots/. The engine it started is stopped, by its
 * PID, whatever happens.
 *
 * Stable output: the engine runs with a virtual clock (a Bun preload that replaces Date with the time in a file the
 * seeder sets before each write), the browser clock is fixed, and the data is seeded in a fixed order. The last
 * writes land in the day and a half before the shots, so work in progress is fresh except two stalled issues (one
 * idle, one reopened from Done and from Todo) that Home ▸ Needs you shows with their reasons.
 *
 * CI status never touches GitHub: the engine's PATH starts with a stand-in `gh` that only records that it was called
 * (the script fails if it was), and the PR statuses are seeded into the data folder's `.tracker/ci.json` before the
 * engine starts, checked "2 minutes ago" and not due again for a year.
 *
 * The issue shot opens its attempts list: two agent sessions (two tools), the second pausing with a handoff comment.
 * home-light.png is Home in the Light theme (POST /api/theme around that shot; the others are Graphite, the default).
 *
 * `startEngine` and `seed` are exported for a manual look at the same sample data (a scratch folder and port).
 *
 * Browser: Playwright's own Chromium when installed (bunx playwright-core install chromium), else Google Chrome.
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'

const ROOT = join(import.meta.dir, '..')
const OUT = join(ROOT, 'site', 'src', 'assets', 'screenshots')
const VIEWPORT = { width: 1440, height: 900 }
/** The sample data's "today": every write and the browser clock are pinned around it. */
const T0 = Date.parse('2026-03-02T09:00:00Z')
export const SHOT_TIME = Date.parse('2026-03-12T15:30:00Z')
const HOUR = 3_600_000

// ---------- scratch engine ----------

async function freePort(): Promise<number> {
  for (;;) {
    const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
    const port = s.port!
    s.stop(true)
    if (port !== 7477) return port
  }
}

/** The preload: `Date` and `Date.now()` read the virtual time from $SHOTS_CLOCK (milliseconds). */
const CLOCK_PRELOAD = `import { readFileSync } from 'node:fs'
const file = process.env.SHOTS_CLOCK
const RealDate = Date
const now = () => Number(readFileSync(file, 'utf8'))
class VirtualDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(now()); else super(...a) }
  static now() { return now() }
}
globalThis.Date = VirtualDate
`

interface Engine { base: string; setTime(ms: number): Promise<void>; stop(): Promise<void> }

// ---------- CI status (no real gh) ----------

const PR = (n: number) => `https://github.com/example-co/website/pull/${n}`
/** PR → [state, checks, failing check names]; the seeded issues link these. */
const PRS: Record<number, [string, string, string[]]> = {
  41: ['merged', 'passing', []],
  38: ['merged', 'passing', []],
  52: ['merged', 'passing', []],
  57: ['open', 'failing', ['lint', 'e2e (safari)']],
  61: ['merged', 'passing', []],
}

/** A stand-in `gh` first on the engine's PATH: it records the call and fails as if signed out. */
async function fakeGh(scratch: string): Promise<{ bin: string; log: string }> {
  const bin = join(scratch, 'bin'), log = join(scratch, 'gh-calls')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'gh'), `#!/bin/sh
echo "$*" >> '${log}'
echo 'docs:shots never calls GitHub; run gh auth login' >&2
exit 4
`, { mode: 0o755 })
  return { bin, log }
}

/** `.tracker/ci.json` with the PR statuses above, as the engine's CI refresher writes it (src/engine/ci.ts). */
async function seedCi(home: string): Promise<void> {
  const checkedAt = new Date(SHOT_TIME - 2 * 60_000).toISOString()
  const prs = Object.fromEntries(Object.entries(PRS).map(([n, [state, checks, failing]]) => [PR(Number(n)), {
    status: { pr: Number(n), state, checks, failing, checkedAt }, nextAt: SHOT_TIME + 365 * 24 * HOUR,
  }]))
  await mkdir(join(home, '.tracker'), { recursive: true })
  await writeFile(join(home, '.tracker', 'ci.json'), JSON.stringify({ v: 1, prs }))
}

export async function startEngine(scratch: string, fixedPort?: number): Promise<Engine & { ghCalls: string }> {
  const home = join(scratch, 'data'), clock = join(scratch, 'clock'), preload = join(scratch, 'clock-preload.mjs')
  await writeFile(clock, String(T0))
  await writeFile(preload, CLOCK_PRELOAD)
  await seedCi(home)
  const gh = await fakeGh(scratch)
  const port = fixedPort ?? await freePort()
  if (port === 7477) throw new Error('7477 belongs to the installed app')
  const proc = Bun.spawn(['bun', '--preload', preload, 'src/cli.ts', 'serve'], {
    cwd: ROOT,
    env: {
      ...process.env, AITT_HOME: home, AITT_PORT: String(port), SHOTS_CLOCK: clock, PATH: `${gh.bin}:${process.env.PATH ?? ''}`,
      GIT_AUTHOR_NAME: 'Docs Screenshots', GIT_AUTHOR_EMAIL: 'docs@example.com',
      GIT_COMMITTER_NAME: 'Docs Screenshots', GIT_COMMITTER_EMAIL: 'docs@example.com',
    },
    stdout: 'ignore', stderr: 'pipe',
  })
  const base = `http://127.0.0.1:${port}`
  const stop = async () => { proc.kill(); await proc.exited } // only the engine this script started
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { proc.kill(); process.exit(130) })
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${base}/api/health`).catch(() => null)
    if (r?.ok && (await r.json()).home === home) {
      return { base, stop, setTime: (ms) => writeFile(clock, String(ms)), ghCalls: gh.log }
    }
    if (proc.exitCode !== null) break
    await Bun.sleep(100)
  }
  await stop()
  throw new Error(`the scratch engine didn't start on port ${port}: ${await new Response(proc.stderr).text()}`)
}

// ---------- sample data (fictional) ----------

type Args = Record<string, unknown>
const agent = (workspace: string, branch: string, session = 'shots', client = 'claude-code') => ({ actor: 'agent', workspace, branch, client, session })

export async function seed(engine: Engine): Promise<void> {
  let t = T0
  const call = async (name: string, args: Args, actor?: ReturnType<typeof agent>, stepHours = 3) => {
    t += stepHours * HOUR
    await engine.setTime(t)
    const r = await fetch(`${engine.base}/api/tool/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tracker': '1', ...(actor ? { 'x-tracker-agent': '1' } : {}) },
      body: JSON.stringify({ args, ...(actor ? { ctx: { actor } } : {}) }),
    })
    const body = await r.json() as Record<string, unknown>
    if (!r.ok) throw new Error(`${name}: ${JSON.stringify(body)}`)
    return body
  }
  const web = agent('web-app', 'feat/pricing-page'), mobile = agent('mobile-app', 'fix/offline-sync')

  await call('save_project', { name: 'Website', description: 'The marketing site and docs.' })
  await call('save_project', { name: 'Mobile app', description: 'The iOS and Android app.' })
  // A milestone with the pricing epic and its steps (1 of 4 done), so the project page shows its progress ring.
  // No clock step: the timestamps of everything after it stay as they were.
  const launch = 'Pricing launch'
  await call('save_milestone', { project: 'Website', name: launch, targetDate: '2026-03-27' }, undefined, 0)

  const epic = await call('save_issues', { issues: [
    { ref: 'epic', title: 'Epic: New pricing page', project: 'Website', milestone: launch, labels: ['Feature'], priority: 2, state: 'In Progress',
      description: 'Replace the pricing table with plan cards, a comparison table and an FAQ.' },
    { ref: 's1', parentId: 'ref:epic', title: 'Step 1: Plan cards with monthly / yearly toggle', project: 'Website', milestone: launch, labels: ['Task'], priority: 2, state: 'Done', comment: 'Shipped in PR #41.',
      links: [{ url: PR(41), title: 'PR #41' }] },
    { ref: 's2', parentId: 'ref:epic', title: 'Step 2: Feature comparison table', project: 'Website', milestone: launch, labels: ['Task'], priority: 2, state: 'In Progress', blockedBy: ['ref:s1'],
      links: [{ url: PR(57), title: 'PR #57' }],
      description: 'A table under the plan cards that compares the three plans feature by feature.\n\n- [x] Rows from the plans config\n- [ ] Sticky header while scrolling\n- [ ] Tooltips for the less obvious limits' },
    { ref: 's3', parentId: 'ref:epic', title: 'Step 3: Pricing FAQ', project: 'Website', milestone: launch, labels: ['Task'], priority: 3, blockedBy: ['ref:s2'] },
  ] }, web) as { issues?: { id: string }[] }
  const [epicId, , step2] = (epic.issues ?? []).map((i) => i.id)

  const website: Args[] = [
    { title: 'Hero image is blurry on retina screens', labels: ['Bug'], priority: 2, state: 'Todo' },
    { title: 'Add Open Graph tags to blog posts', labels: ['Improvement'], priority: 3, state: 'Backlog' },
    { title: 'Choose the analytics provider for the new site', labels: ['Task', 'Needs decision'], priority: 2, state: 'Waiting',
      comment: 'Needs: a choice between Plausible and Fathom. Both fit the budget; Plausible has the EU hosting we asked for.' },
    { title: 'Contact form sends twice on slow connections', labels: ['Bug'], priority: 1, state: 'Done', comment: 'Fixed in PR #38: the button disables while sending.',
      links: [{ url: PR(38), title: 'PR #38' }] },
  ]
  const webIds: string[] = []
  for (const a of website) webIds.push((await call('save_issue', { project: 'Website', ...a }, web)).id as string)

  const app: Args[] = [
    { title: 'Offline edits are lost after a crash', labels: ['Bug'], priority: 1, state: 'In Progress' },
    { title: 'Dark mode for the settings screen', labels: ['Feature'], priority: 3, state: 'Todo' },
    { title: 'Push notification opt-in screen', labels: ['Feature'], priority: 2, state: 'Backlog' },
    { title: 'Crash on Android 12 when rotating the camera view', labels: ['Bug'], priority: 2, state: 'Todo' },
    { title: 'Release notes for 2.4', labels: ['Task', 'Needs review'], priority: 3, state: 'Waiting', comment: 'Needs: a read-through before Thursday\'s release.' },
  ]
  const appIds: string[] = []
  for (const a of app) appIds.push((await call('save_issue', { project: 'Mobile app', ...a }, mobile)).id as string)

  // Stalled work: the last writes before the shots. "Offline edits" then sits idle for 31 h in In Progress...
  t = SHOT_TIME - 40 * HOUR
  await call('save_comment', { issueId: appIds[0], body: 'Reproduced: the write-ahead log isn\'t flushed before the app is killed.' }, mobile, 9)
  // ...and the Safari bug is reopened twice (from Done, then from Todo), by three sessions since it was Done.
  const session = (n: string) => agent('web-app', 'fix/safari-checkout', `shots-${n}`)
  const flicker = (await call('save_issue', { project: 'Website', title: 'Checkout button flickers in Safari', labels: ['Bug'], priority: 2, state: 'In Progress' }, session('a'), 1)).id
  await call('save_issue', { id: flicker, state: 'Done', comment: 'Fixed in PR #52: the button no longer re-renders on hover.', links: [{ url: PR(52), title: 'PR #52' }] }, session('a'), 2)
  await call('save_issue', { id: flicker, state: 'In Progress' }, session('b'), 3)
  await call('save_issue', { id: flicker, state: 'Todo' }, session('c'), 3)
  await call('save_issue', { id: flicker, state: 'In Progress' }, session('d'), 3)

  if (step2) {
    await call('save_comment', { issueId: step2, body: 'Columns: Starter, Team, Business. Pulling the limits from the plans config so the table can\'t drift.' }, web, 1)
    await call('save_comment', { issueId: step2, body: 'Mobile layout: the table scrolls sideways with the first column pinned.' }, web, 1)
    // A second attempt, from another tool, that pauses with a handoff comment (get_issue's handoff shows it).
    const codex = agent('web-app', 'feat/pricing-table', 'shots-codex', 'codex')
    await call('save_comment', { issueId: step2, body: 'Done: rows from the plans config. Next: sticky header. Blocking: lint fails on PR #57.' }, codex, 1)
  }
  if (epicId) await call('save_comment', { issueId: epicId, body: 'Step 1 is live behind the pricing flag. Next: the comparison table.' }, web, 1)

  // Today, for Home's Agent activity: a Claude Code session that finishes two issues and is still writing, and a
  // Codex session that hands a question back (it waits on you).
  const cc = agent('web-app', 'fix/retina-hero', 'shots-today')
  const cx = agent('mobile-app', 'fix/camera-rotation', 'shots-today-cx', 'codex')
  t = SHOT_TIME - 6 * HOUR
  await call('save_issue', { id: appIds[3], state: 'In Progress' }, cx, 0)
  await call('save_issue', { id: appIds[3], state: 'Waiting', comment: 'Needs: lock the camera view to portrait, or support rotation on Android 12 only? Locking is a one-line fix.' }, cx, 1)
  t = SHOT_TIME - 3 * HOUR
  await call('save_issue', { id: webIds[0], state: 'In Progress' }, cc, 0)
  await call('save_comment', { issueId: webIds[0], body: 'The hero now ships 1x, 2x and 3x sources; srcset picks the sharp one.' }, cc, 1)
  await call('save_issue', { id: webIds[0], state: 'Done', comment: `Fixed in PR #61 (${PR(61)}).`, links: [{ url: PR(61), title: 'PR #61' }] }, cc, 0.5)
  t = SHOT_TIME - HOUR / 4
  await call('save_issue', { id: webIds[1], state: 'Done', comment: 'Added og:title, og:image and twitter:card to every post.' }, cc, 0.1)
  await engine.setTime(SHOT_TIME)
}

// ---------- capture ----------

async function launch(): Promise<Browser> {
  if (existsSync(chromium.executablePath())) return chromium.launch()
  console.log('• Playwright\'s Chromium isn\'t installed; using Google Chrome (bunx playwright-core install chromium for the bundled one)')
  return chromium.launch({ channel: 'chrome' })
}

interface Shot { file: string; route: string; prepare?: (page: Page) => Promise<void>; theme?: string }

/** Choose the engine's theme (every open page follows it). */
async function setTheme(base: string, theme: string): Promise<void> {
  const r = await fetch(`${base}/api/theme`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tracker': '1' }, body: JSON.stringify({ theme }) })
  if (!r.ok) throw new Error(`theme ${theme}: ${await r.text()}`)
}

async function capture(base: string, shots: Shot[]): Promise<Map<string, Buffer>> {
  const browser = await launch()
  const out = new Map<string, Buffer>()
  try {
    // Fixed locale and time zone: the issue page shows absolute dates. Graphite (the default) unless a shot names a theme.
    const context = await browser.newContext({
      viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'dark', reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC',
    })
    // As in the app's window: no "Open in AI Task Tracking" link (the UI's own dismiss flag).
    await context.addInitScript(() => { try { localStorage.setItem('tracker.hideOpenInApp', '1') } catch { /* none */ } })
    for (const s of shots) {
      if (s.theme) await setTheme(base, s.theme)
      const page = await context.newPage()
      await page.clock.setFixedTime(SHOT_TIME)
      await page.goto(`${base}/${s.route}`)
      await page.waitForLoadState('networkidle').catch(() => {}) // the live event stream keeps one request open
      await page.waitForSelector('.sidebar .nav-item')
      await s.prepare?.(page)
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(300)
      out.set(s.file, await page.screenshot({ animations: 'disabled', caret: 'hide' }))
      await page.close()
      if (s.theme) await setTheme(base, 'graphite')
    }
  } finally {
    await browser.close()
  }
  return out
}

/** Palette-quantized PNG via sharp (from the docs site's packages); the raw PNG when sharp isn't there. */
async function optimize(png: Buffer): Promise<Buffer> {
  try {
    const sharp = createRequire(join(ROOT, 'site', 'package.json'))('sharp')
    return await sharp(png).png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 }).toBuffer()
  } catch (e) {
    console.warn(`! not optimizing (${(e as Error).message.split('\n')[0]}); run bun run docs:install`)
    return png
  }
}

async function main(): Promise<void> {
  if (!existsSync(join(ROOT, 'ui', 'dist', 'index.html'))) throw new Error('ui/dist is missing: run bun run build:ui')
  const scratch = await mkdtemp(join(tmpdir(), 'aitt-shots-'))
  let engine: (Engine & { ghCalls: string }) | undefined
  try {
    engine = await startEngine(scratch)
    console.log(`• scratch engine on ${engine.base} (data in ${scratch})`)
    await seed(engine)
    const snapshot = await (await fetch(`${engine.base}/api/snapshot`)).json() as { issues: { id: string; title: string }[]; projects: { slug: string; name: string }[] }
    const byTitle = (t: string) => snapshot.issues.find((i) => i.title === t)?.id ?? (() => { throw new Error(`no issue "${t}"`) })()
    const website = snapshot.projects.find((p) => p.name === 'Website')?.slug ?? 'website'
    const shots: Shot[] = [
      { file: 'home.png', route: '#/' },
      { file: 'issue.png', route: `#/issue/${byTitle('Step 2: Feature comparison table')}`, prepare: (page) => page.click('.attempts-head') },
      { file: 'project.png', route: `#/project/${website}` },
      {
        file: 'command-bar.png', route: '#/',
        prepare: async (page) => {
          await page.keyboard.press('Meta+k')
          await page.keyboard.type('pricing', { delay: 20 })
          await page.waitForTimeout(400)
        },
      },
      { file: 'home-light.png', route: '#/', theme: 'light' },
      { file: 'settings.png', route: '#/settings/appearance', prepare: (page) => page.waitForSelector('.settings-theme').then(() => {}) },
      // Last: the collapsed state is saved in the context's localStorage and would carry into later shots.
      { file: 'sidebar-collapsed.png', route: `#/project/${website}`, prepare: (page) => page.click('[aria-label="Collapse sidebar"]') },
    ]
    const images = await capture(engine.base, shots)
    if (existsSync(engine.ghCalls)) throw new Error(`the engine ran gh (${engine.ghCalls}); the CI statuses should have come from the seeded cache`)
    await mkdir(OUT, { recursive: true })
    for (const [file, png] of images) {
      const small = await optimize(png)
      await writeFile(join(OUT, file), small)
      console.log(`• ${join('site/src/assets/screenshots', file)}  ${(small.length / 1024).toFixed(0)} kB`)
    }
  } finally {
    await engine?.stop()
    await rm(scratch, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`)
    process.exit(1)
  }
}
