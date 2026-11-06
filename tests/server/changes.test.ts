import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepoMap } from '../../src/engine/repos'
import { Store } from '../../src/engine/store'
import { startServer, type RunningServer } from '../../src/server/http'
import { issuePath, miniCopy } from '../engine/helpers'

process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text())
}

let scratch: string
let repo: string
let root: string
let store: Store
let srv: RunningServer
let base: string
const agentHeaders = { 'content-type': 'application/json', 'X-Tracker': '1', 'X-Tracker-Agent': '1' }

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'aitt-changes-'))
  repo = join(scratch, 'shop')
  await git(scratch, 'init', '-q', '-b', 'main', repo)
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'base')
  await git(repo, 'switch', '-q', '-c', 'feat/table')
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\n')
  await git(repo, 'commit', '-q', '-am', 'Add two')
  await git(repo, 'switch', '-q', 'main')
})
afterAll(async () => { await rm(scratch, { recursive: true, force: true }) })

beforeEach(async () => {
  root = await miniCopy()
  store = await Store.open(root, { port: 0 })
  srv = startServer(store, { port: 0, version: 'test', repos: await RepoMap.open(root, () => {}) })
  base = `http://127.0.0.1:${srv.port}`
})
afterEach(async () => {
  await srv.stop()
  await rm(root, { recursive: true, force: true })
})

const agentCall = (name: string, args: unknown, branch: string, repoDir?: unknown) =>
  fetch(`${base}/api/tool/${name}`, {
    method: 'POST', headers: agentHeaders,
    body: JSON.stringify({ args, ctx: { actor: { actor: 'agent', workspace: 'shop', branch, session: 's1', client: 'claude-code' }, ...(repoDir !== undefined ? { repoDir } : {}) } }),
  })
const changes = async (id: string, q = '') => {
  const r = await fetch(`${base}/api/issues/${id}/changes${q}`)
  return { status: r.status, body: (await r.json()) as any }
}
async function until(pred: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await pred()) return; await Bun.sleep(25) }
  throw new Error('timeout')
}

describe('GET /api/issues/<id>/changes', () => {
  test("shows the agent's branch once its repo is learned; the path never reaches the issue file", async () => {
    expect((await agentCall('save_comment', { issueId: 'Q-1', body: 'Ready for review.' }, 'feat/table')).status).toBe(200)
    // No repoDir sent yet: the branch is known, the repo isn't.
    expect((await changes('Q-1')).body).toMatchObject({ state: 'repo-unknown', branch: 'feat/table', workspace: 'shop' })

    expect((await agentCall('save_comment', { issueId: 'Q-1', body: 'Again.' }, 'feat/table', repo)).status).toBe(200)
    await until(async () => (await changes('Q-1')).body.state === 'ok')
    const { body } = await changes('Q-1')
    expect(body).toMatchObject({ state: 'ok', source: 'local', branch: 'feat/table', base: 'main', repo, branches: ['feat/table'] })
    expect(body.commits.map((c: any) => c.subject)).toEqual(['Add two'])
    expect(body.files[0]).toMatchObject({ path: 'a.txt', added: 1, removed: 0 })

    const file = await readFile(issuePath(root, 'acme-app', 'Q-1'), 'utf8')
    expect(file).not.toContain(scratch)
    expect(file).toContain('feat/table')
  })

  test('skips the base branch by default, refuses a branch the issue never recorded', async () => {
    await agentCall('save_comment', { issueId: 'Q-1', body: 'work' }, 'feat/table', repo)
    await agentCall('save_comment', { issueId: 'Q-1', body: 'merged, writing from main' }, 'main', repo)
    await until(async () => (await changes('Q-1')).body.state === 'ok')
    expect((await changes('Q-1')).body.branch).toBe('feat/table')
    expect((await changes('Q-1', '?branch=main')).body.state).toBe('same')
    const bad = await changes('Q-1', `?branch=${encodeURIComponent('--output=/tmp/x')}`)
    expect(bad.status).toBe(400)
    expect(bad.body.state).toBe('unknown-branch')
  })

  test('an issue no agent branch touched, an unknown issue, and a foreign Host', async () => {
    expect((await changes('Q-1')).body.state).toBe('no-branch')
    expect((await changes('NOPE-1')).status).toBe(404)
    const r = await fetch(`${base}/api/issues/Q-1/changes`, { headers: { host: 'evil.example' } })
    expect(r.status).toBe(403)
  })
})
