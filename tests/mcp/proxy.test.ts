import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { pathToFileURL } from 'node:url'
import { Store } from '../../src/engine/store'
import { startServer, type RunningServer } from '../../src/server/http'
import { miniCopy } from '../engine/helpers'
import { agentTools, INSTRUCTIONS_PREAMBLE } from '../../src/mcp/surface'

const cli = join(import.meta.dir, '../../src/cli.ts')
let root: string, store: Store, srv: RunningServer, wsDir: string

beforeAll(async () => {
  root = await miniCopy()
  await writeFile(join(root, 'AGENTS.md'), '# Custom rules\nBe nice.\n')
  store = await Store.open(root, { port: 0 })
  srv = startServer(store, { port: 0, version: 'test', git: { status: () => ({ lastCommit: 'x' }) } })
  wsDir = join(realpathSync(mkdtempSync(join(tmpdir(), 'tracker-mcp-'))), 'my-workspace')
  mkdirSync(wsDir)
})
afterAll(async () => {
  await srv.stop()
  rmSync(root, { recursive: true, force: true })
  rmSync(join(wsDir, '..'), { recursive: true, force: true })
})

async function connect(port: number, cwd = wsDir, extra: Record<string, string> = {}, roots?: string[]) {
  const env = { ...process.env as Record<string, string>, AITT_PORT: String(port), AITT_HOME: root, ...extra }
  const transport = new StdioClientTransport({ command: 'bun', args: [cli, 'mcp'], cwd, env, stderr: 'ignore' })
  const client = new Client({ name: 'test', version: '0' }, roots ? { capabilities: { roots: {} } } : {})
  if (roots) client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: roots.map((uri) => ({ uri })) }))
  await client.connect(transport)
  return client
}
const text = (r: any) => (r.content as any[])[0].text as string

describe('tracker mcp', () => {
  test('lists save_issue and whats_next tools, hides owner-only ones', async () => {
    const c = await connect(srv.port)
    const names = (await c.listTools()).tools.map(t => t.name)
    expect(names).toContain('save_issue')
    expect(names).toContain('whats_next')
    expect(names).not.toContain('delete_issue')
    expect(names).not.toContain('save_view')
    await c.close()
  })

  test('instructions are the short preamble plus AGENTS.md', async () => {
    const c = await connect(srv.port)
    expect(c.getInstructions()).toBe(`${INSTRUCTIONS_PREAMBLE}# Custom rules\nBe nice.\n`)
    expect(c.getServerVersion()?.name).toBe('ai-task-tracking')
    await c.close()
  })

  test('tools/list sends descriptions, schemas and annotations exactly as agentTools() builds them', async () => {
    const c = await connect(srv.port)
    const listed = (await c.listTools()).tools
    expect(JSON.parse(JSON.stringify(listed))).toEqual(JSON.parse(JSON.stringify(agentTools())))
    expect(listed.find((t) => t.name === 'get_issue')?.annotations).toEqual({ title: 'Get issue', readOnlyHint: true, openWorldHint: false })
    await c.close()
  })

  test('save_issue round-trip records workspace from cwd; the write returns the brief shape as text and structuredContent', async () => {
    const c = await connect(srv.port)
    const r: any = await c.callTool({ name: 'save_issue', arguments: { title: 'From proxy', labels: ['Feature'] } })
    expect(r.isError).toBeFalsy()
    const created = JSON.parse(text(r))
    expect(Object.keys(created)).toEqual(['id', 'title', 'status', 'url', 'appUrl'])
    expect(r.structuredContent).toEqual(created)
    const got: any = await c.callTool({ name: 'get_issue', arguments: { id: created.id } })
    expect(JSON.stringify(JSON.parse(text(got)))).toContain('my-workspace')
    await c.close()
  })

  test('a branch switch during the session is recorded on the next write', async () => {
    const repo = join(wsDir, '..', 'branchy'); mkdirSync(repo, { recursive: true })
    const g = (...a: string[]) => expect(Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo }).exitCode).toBe(0)
    g('init', '-q', '-b', 'feat/one'); g('commit', '-q', '--allow-empty', '-m', 'init')
    const c = await connect(srv.port, repo)
    const first: any = await c.callTool({ name: 'save_issue', arguments: { title: 'On one', labels: ['Feature'] } })
    expect(store.get(JSON.parse(text(first)).id)?.touchedBy?.branch).toBe('feat/one')
    g('switch', '-q', '-c', 'feat/two')
    const second: any = await c.callTool({ name: 'save_issue', arguments: { title: 'On two', labels: ['Feature'] } })
    expect(store.get(JSON.parse(text(second)).id)?.touchedBy?.branch).toBe('feat/two')
    await c.close()
  })

  test('started in $HOME (as desktop apps do): the workspace comes from the client\'s MCP roots', async () => {
    const fakeHome = join(wsDir, '..', 'fake-home'); mkdirSync(fakeHome, { recursive: true })
    const project = join(wsDir, '..', 'rooted-project'); mkdirSync(project, { recursive: true })
    const c = await connect(srv.port, fakeHome, { HOME: fakeHome }, [pathToFileURL(project).href])
    const r: any = await c.callTool({ name: 'save_issue', arguments: { title: 'From roots', labels: ['Feature'] } })
    expect(r.isError).toBeFalsy()
    expect(store.get(JSON.parse(text(r)).id)?.touchedBy?.workspace).toBe('rooted-project')
    await c.close()
  })

  test('started in $HOME with no roots: AITT_WORKSPACE names the workspace', async () => {
    const fakeHome = join(wsDir, '..', 'fake-home'); mkdirSync(fakeHome, { recursive: true })
    const c = await connect(srv.port, fakeHome, { HOME: fakeHome, AITT_WORKSPACE: 'named-ws' })
    const r: any = await c.callTool({ name: 'save_issue', arguments: { title: 'From env', labels: ['Feature'] } })
    expect(store.get(JSON.parse(text(r)).id)?.touchedBy?.workspace).toBe('named-ws')
    await c.close()
  })

  test('engine error -> isError with the engine message', async () => {
    const c = await connect(srv.port)
    const r: any = await c.callTool({ name: 'get_issue', arguments: { id: 'NOPE-999' } })
    expect(r.isError).toBe(true)
    expect(text(r).length).toBeGreaterThan(0)
    await c.close()
  })

  test('bad arguments -> the engine\'s message with the tool\'s example call; owner-only tools are refused', async () => {
    const c = await connect(srv.port)
    const r: any = await c.callTool({ name: 'save_issue', arguments: { id: 'Q-1', priority: 9 } })
    expect(r.isError).toBe(true)
    expect(text(r)).toStartWith('Invalid arguments for save_issue:\n- priority:')
    expect(text(r)).toContain('Example: save_issue(')
    const del: any = await c.callTool({ name: 'delete_issue', arguments: { id: 'Q-1' } })
    expect(del.isError).toBe(true)
    expect(text(del)).toStartWith('Unknown tool "delete_issue"')
    expect(store.get('Q-1')).toBeDefined()
    await c.close()
  })

  test('engine down -> isError with the exact sentence', async () => {
    const c = await connect(1) // nothing listens on port 1
    const r: any = await c.callTool({ name: 'whats_next', arguments: {} })
    expect(r.isError).toBe(true)
    expect(text(r)).toBe("AI Task Tracking isn't running — open it from the menu bar (or run: aitt serve).")
    await c.close()
  })

  test('engine accepts but never replies -> timeout message, not "isn\'t running"', async () => {
    const hang = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => {}) })
    const c = await connect(hang.port!, wsDir, { AITT_MCP_TIMEOUT_MS: '300' })
    const r: any = await c.callTool({ name: 'save_issue', arguments: { title: 'x', labels: ['Feature'] } })
    expect(r.isError).toBe(true)
    expect(text(r)).toBe("AI Task Tracking didn't reply within 0.3 s; the change may have been applied — check with get_issue or list_issues before retrying.")
    await c.close()
    await hang.stop(true)
  })
})
