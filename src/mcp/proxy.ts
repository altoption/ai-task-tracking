import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import pkg from '../../package.json'
import { DEFAULT_AGENTS_MD } from '../store/metaFiles'
import { agentTools, buildInstructions, toolResult, type ToolResult } from './surface'
import { homedir } from 'node:os'
import type { Actor } from '../model'
import { findClient, resolveSessionWorkspace, resolveWorkspace } from './workspace'
export const NOT_RUNNING = "AI Task Tracking isn't running — open it from the menu bar (or run: aitt serve)."
const READ_TIMEOUT_MS = 5000
const WRITE_TIMEOUT_MS = 30_000
const isWrite = (name: string) => name.startsWith('save_') || name === 'set_plan' || name === 'toggle_task'

const err = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] })

export async function runProxy(opts: { port: number; home: string; timeouts?: { read: number; write: number } }): Promise<void> {
  const instructions = buildInstructions(await readFile(join(opts.home, 'AGENTS.md'), 'utf8').catch(() => DEFAULT_AGENTS_MD))
  const { client, session } = findClient(process.ppid)
  const who = { ...(session ? { session } : {}), ...(client ? { client } : {}) }
  // The workspace is resolved on the first call (roots can only be asked once the client has initialized) and again
  // after roots change; the branch is re-read on every call, since a session can switch branches.
  let sessionP: ReturnType<typeof resolveSessionWorkspace> | undefined
  const actor = async (): Promise<Actor> => {
    const s = await (sessionP ??= resolveSessionWorkspace({
      cwd: process.cwd(), userHome: process.env.HOME || homedir(), env: process.env, listRoots,
    }))
    const branch = s.dir ? resolveWorkspace(s.dir).branch : undefined
    return { actor: 'agent', workspace: s.workspace, ...(branch ? { branch } : {}), ...who }
  }
  const base = `http://127.0.0.1:${opts.port}`

  async function forward(name: string, args: unknown): Promise<ToolResult> {
    const ms = isWrite(name) ? (opts.timeouts?.write ?? WRITE_TIMEOUT_MS) : (opts.timeouts?.read ?? READ_TIMEOUT_MS)
    let res: Response
    let body: string
    try {
      res = await fetch(`${base}/api/tool/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Tracker': '1', 'X-Tracker-Agent': '1' },
        body: JSON.stringify({ args: args ?? {}, ctx: { actor: await actor() } }),
        signal: AbortSignal.timeout(ms),
      })
      body = await res.text()
    } catch (e) {
      const n = (e as { name?: string })?.name
      if (n === 'TimeoutError' || n === 'AbortError') {
        const secs = Number((ms / 1000).toFixed(2))
        return err(`AI Task Tracking didn't reply within ${secs} s; the change may have been applied — check with get_issue or list_issues before retrying.`)
      }
      return err(NOT_RUNNING)
    }
    if (!res.ok) {
      try { return err(String(JSON.parse(body).error ?? body)) } catch { return err(body || `HTTP ${res.status}`) }
    }
    try { return toolResult(name, JSON.parse(body)) } catch { return { content: [{ type: 'text', text: body }] } }
  }

  // The low-level server: the engine validates arguments (one error format, with an example call, for every tool).
  const tools = agentTools()
  const known = new Set(tools.map((t) => t.name))
  const server = new Server({ name: 'ai-task-tracking', version: pkg.version }, { capabilities: { tools: {} }, instructions })
  async function listRoots(): Promise<string[]> {
    if (!server.getClientCapabilities()?.roots) return []
    return (await server.listRoots(undefined, { timeout: 2000 })).roots.map((r) => r.uri)
  }
  server.setNotificationHandler(RootsListChangedNotificationSchema, () => { sessionP = undefined })
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, (req) => {
    const name = req.params.name
    if (!known.has(name)) return err(`Unknown tool "${name}". Tools: ${[...known].join(', ')}.`)
    return forward(name, req.params.arguments ?? {})
  })
  await server.connect(new StdioServerTransport())
}
