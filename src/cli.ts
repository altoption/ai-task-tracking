#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import pkg from '../package.json'
import { startGit } from './engine/git'
import { CiRefresher } from './engine/ci'
import { search } from './engine/queries'
import { Store } from './engine/store'
import { generateSynthetic } from './engine/synthetic'
import { watchFolder } from './engine/watch'
import { buildSnapshot, startServer } from './server/http'
import { shutdown } from './server/shutdown'
import { docsCommand, engineHealthy } from './cli/docs'
import { openCommand } from './cli/open'
import { BENCH_USAGE, GUIDANCE_USAGE, USAGE } from './cli/usage'
import { agentGuidance, cursorRule } from './setup/clients'
import { runProxy } from './mcp/proxy'
import { uninstallCommand } from './setup/uninstall'
import { parseSetupArgs, runSetup, SETUP_USAGE, SetupInterrupted, terminalIO } from './setup/setup'
import { initFolder, readConfig } from './store/metaFiles'
import { aittEnv, DEFAULT_HOME_DIR } from './shared/env'

const dataHome = () => aittEnv('HOME') || join(homedir(), DEFAULT_HOME_DIR)

async function serve(): Promise<void> {
  const root = dataHome()
  if (!existsSync(join(root, 'config.yml'))) await initFolder(root)
  const store = await Store.open(root)
  const watcher = watchFolder(store)
  const git = startGit(store, { commitDelayMs: 2000, pushDelayMs: 300_000 })
  // CI status of linked PRs: `gh` runs only in this background refresher, never on a request.
  const ci = await CiRefresher.start(store)
  const server = startServer(store, { port: store.port, version: pkg.version, git, ci })
  console.log(`aitt ${pkg.version} serving ${root} on http://127.0.0.1:${server.port}`)
  // After git's startup, so the views get their own commit; never holds up or fails the start.
  const seeded = git.ready.catch(() => {}).then(() => store.seedDefaultViews())
  let stopping = false
  const onSignal = async () => {
    if (stopping) return
    stopping = true
    await ci.stop().catch(() => {})
    // A seed still running would write its marker after the last commit; shutdown's own deadline still holds.
    await Promise.race([seeded, Bun.sleep(5000)])
    process.exit(await shutdown({ server, watcher, git, deadlineMs: 5000 }))
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  // The app holds our stdin open; if the app dies (even SIGKILL) the pipe closes and we shut down like SIGTERM.
  if (aittEnv('PARENT_LIFELINE') === '1') {
    process.stdin.on('end', onSignal)
    process.stdin.on('close', onSignal)
    process.stdin.resume()
  }
}

/** The engine port: AITT_PORT, else the data folder's config.yml, else 7477. */
async function enginePort(home: string): Promise<number> {
  const port = Number(aittEnv('PORT'))
  if (Number.isInteger(port) && port > 0) return port
  return (await readConfig(home).catch(() => undefined))?.port ?? 7477
}

async function mcp(): Promise<void> {
  const home = dataHome()
  const port = await enginePort(home)
  const t = Number(aittEnv('MCP_TIMEOUT_MS')) // test hook: overrides both timeouts
  await runProxy({ port, home, ...(t > 0 ? { timeouts: { read: t, write: t } } : {}) })
}

async function setup(args: string[]): Promise<number> {
  const parsed = parseSetupArgs(args)
  if (typeof parsed === 'string') { console.error(`aitt setup: ${parsed}\n${SETUP_USAGE}`); return 2 }
  if (parsed.help) { console.log(SETUP_USAGE); return 0 }
  const interactive = !parsed.yes && !!process.stdin.isTTY && !!process.stdout.isTTY
  const env = { ...process.env }
  try {
    return await runSetup({ ...parsed.opts, userHome: process.env.HOME || homedir(), env }, terminalIO(interactive))
  } catch (e) {
    if (e instanceof SetupInterrupted) { console.error('\naitt setup: interrupted'); return 130 }
    throw e
  }
}

async function bench(n: number): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'aitt-bench-'))
  try {
    const time = async <T>(label: string, fn: () => Promise<T> | T): Promise<T> => {
      const t = performance.now()
      const r = await fn()
      console.log(`${label.padEnd(12)} ${(performance.now() - t).toFixed(1)} ms`)
      return r
    }
    await time(`generate ${n}`, () => generateSynthetic(root, n))
    const store = await time('open', () => Store.open(root, { port: 0 }))
    const snap = await time('snapshot', () => JSON.stringify(buildSnapshot(store)))
    console.log(`snapshot size ${(snap.length / 1024).toFixed(0)} kB, ${store.all().length} issues`)
    await time('search', () => search(store, 'fan curve'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const [cmd, arg] = process.argv.slice(2)
switch (cmd) {
  case 'serve': await serve(); break
  case 'mcp': await mcp(); break
  case 'open': process.exit(await openCommand(process.argv.slice(3), {
    open: async (url) => Bun.spawn(['/usr/bin/open', url], { stdout: 'ignore', stderr: 'ignore' }).exited,
    port: () => enginePort(dataHome()),
    log: (l) => console.log(l),
  }))
  case 'docs': process.exit(await docsCommand(process.argv.slice(3), {
    port: () => enginePort(dataHome()),
    healthy: engineHealthy,
    open: async (url) => Bun.spawn(['/usr/bin/open', url], { stdout: 'ignore', stderr: 'ignore' }).exited,
    log: (l) => console.log(l),
    error: (l) => console.error(l),
  }))
  case 'guidance': {
    const a = process.argv.slice(3)
    if (a.length > 1 || (a[0] !== undefined && a[0] !== '--cursor')) { console.error(GUIDANCE_USAGE); process.exit(2) }
    process.stdout.write(a[0] ? cursorRule() : agentGuidance())
    break
  }
  case 'setup': process.exit(await setup(process.argv.slice(3)))
  case 'uninstall': process.exit(await uninstallCommand(process.argv.slice(3), { ...process.env }, process.env.HOME || homedir(), terminalIO))
  case '--version': console.log(pkg.version); break
  case 'bench': {
    const n = Number(arg)
    if (!Number.isInteger(n) || n <= 0) { console.error(BENCH_USAGE); process.exit(2) }
    await bench(n)
    break
  }
  default: console.error(USAGE); process.exit(cmd ? 2 : 0)
}
