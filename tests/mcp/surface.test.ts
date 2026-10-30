import { describe, expect, test } from 'bun:test'
import type { Actor } from '../../src/model'
import { Store } from '../../src/engine/store'
import { agentTools, ACTIVITY_CAP, buildInstructions, INSTRUCTIONS_PREAMBLE, resultText, shapeResult, toolResult } from '../../src/mcp/surface'
import { DEFAULT_AGENTS_MD } from '../../src/store/metaFiles'
import { callTool } from '../../src/tools/handlers'
import { miniCopy } from '../engine/helpers'

/**
 * The agent-facing MCP surface. Tool names and argument names are a contract (agents and the owner's rules use
 * them); descriptions and result shapes are product UI with a size budget.
 */

const NAMES = [
  'whats_next', 'get_issue', 'get_tree', 'search', 'list_issues', 'list_comments',
  'save_issue', 'save_issues', 'save_comment', 'toggle_task', 'set_plan',
  'list_projects', 'get_project', 'save_project', 'list_milestones', 'save_milestone', 'get_document', 'save_document',
  'list_issue_statuses', 'list_issue_labels', 'save_issue_label', 'list_teams',
]
const READ_ONLY = ['whats_next', 'get_issue', 'get_tree', 'search', 'list_issues', 'list_comments', 'list_projects', 'get_project',
  'list_milestones', 'get_document', 'list_issue_statuses', 'list_issue_labels', 'list_teams']

/**
 * Budget for every tool definition + the default instructions, in tokens (chars / 4).
 * Before B9 (2026-10-28): 19,392 chars ≈ 4,848 tokens (no annotations). After: 17,707 chars ≈ 4,427 tokens; with typed save_issues items (for strict-schema clients) 18,833 ≈ 4,708; the cap is
 * ~10% above it. Raise it only deliberately.
 */
const TOKEN_CAP = 5_180

type Schema = { type?: string; description?: string; properties?: Record<string, Schema>; items?: Schema; anyOf?: Schema[] }

/** A schema without its descriptions (recursively; a property named "description" stays). */
const bare = (v: unknown): unknown => Array.isArray(v) ? v.map(bare)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k, x]) => !(k === 'description' && typeof x === 'string')).map(([k, x]) => [k, bare(x)])) : v

/**
 * Paths of properties without a description. save_issues items carry save_issue's typed fields without their
 * descriptions (the `issues` description points at save_issue for the meanings), plus a described `ref`.
 */
function undescribed(s: Schema, path: string, out: string[]): void {
  for (const [k, p] of Object.entries(s.properties ?? {})) {
    const here = `${path}.${k}`
    if (!p.description) out.push(here)
    const inner = p.items ?? p.anyOf?.find((x) => x.items || x.properties)?.items ?? p
    if (here === 'save_issues.issues') {
      if (!inner.properties?.ref?.description) out.push(`${here}[].ref`)
      if (!/save_issue arguments/.test(p.description ?? '')) out.push(`${here} (points at save_issue)`)
      continue
    }
    if (inner.properties) undescribed(inner, `${here}[]`, out)
  }
}

describe('tool list', () => {
  test('names are the agreed set (owner-only tools hidden)', () => {
    expect(agentTools().map((t) => t.name).sort()).toEqual([...NAMES].sort())
  })

  test('every tool has a title, a description with one example, and every argument a description', () => {
    const missing: string[] = []
    for (const t of agentTools()) {
      if (!t.annotations.title) missing.push(`${t.name} (title)`)
      // Tools with arguments show one example call; argument-free ones need none.
      const examples = (t.description.match(/Example: /g) ?? []).length
      const hasArgs = Object.keys((t.inputSchema as Schema).properties ?? {}).length > 0
      if (examples !== (hasArgs ? 1 : 0)) missing.push(`${t.name} (${hasArgs ? 'one' : 'no'} "Example: ")`)
      if (hasArgs && !t.description.includes(`Example: ${t.name}(`)) missing.push(`${t.name} (example calls the tool)`)
      undescribed(t.inputSchema as Schema, t.name, missing)
    }
    expect(missing).toEqual([])
  })

  test('save_issues items are typed with exactly save_issue\'s fields (for strict-schema clients), plus ref', () => {
    const tools = agentTools()
    const single = (tools.find((t) => t.name === 'save_issue')!.inputSchema as Schema).properties!
    const item = (tools.find((t) => t.name === 'save_issues')!.inputSchema as Schema).properties!.issues!.items!
    const { ref, ...fields } = item.properties!
    expect(ref).toEqual({ type: 'string', description: expect.stringContaining('ref:<name>') })
    expect(Object.keys(fields)).toEqual(Object.keys(single))
    expect(fields).toEqual(bare(single) as Record<string, Schema>)
    expect(JSON.stringify(fields)).not.toMatch(/"description":"/)
    expect(fields.labels).toEqual({ type: 'array', items: { type: 'string' } })
    expect(fields.priority).toMatchObject({ type: 'integer', minimum: 0, maximum: 4 })
  })

  test(`activity cap wording comes from ACTIVITY_CAP`, () => {
    const d = (n: string) => agentTools().find((t) => t.name === n)!.description
    expect(d('get_issue')).toContain(`last ${ACTIVITY_CAP} activity entries`)
    expect(d('list_comments')).toContain(`only the last ${ACTIVITY_CAP}`)
  })

  test('list_teams has a plain title', () => {
    expect(agentTools().find((t) => t.name === 'list_teams')!.annotations.title).toBe('List ID prefixes (teams)')
  })

  test('the preamble does not repeat the AGENTS.md opener and states the result conventions it relies on', () => {
    expect(INSTRUCTIONS_PREAMBLE).not.toMatch(/issue tracker/)
    expect(INSTRUCTIONS_PREAMBLE).toMatch(/omitted fields are empty/i)
    expect(INSTRUCTIONS_PREAMBLE).toContain('save_comment returns issueId, at, url and appUrl')
  })

  test('annotations: read tools are read-only; writes are non-destructive; nothing is open-world', () => {
    for (const t of agentTools()) {
      const a = t.annotations
      expect(a.title, t.name).toBeTruthy()
      expect(a.openWorldHint, t.name).toBe(false)
      if (READ_ONLY.includes(t.name)) expect(a.readOnlyHint, t.name).toBe(true)
      else { expect(a.readOnlyHint, t.name).toBeUndefined(); expect(a.destructiveHint, t.name).toBe(false) }
    }
    const idem = agentTools().filter((t) => t.annotations.idempotentHint).map((t) => t.name).sort()
    expect(idem).toEqual(['save_issue_label', 'save_milestone', 'set_plan'])
  })

  test('no owner-specific examples in what agents read', () => {
    const text = JSON.stringify(agentTools()) + buildInstructions(DEFAULT_AGENTS_MD)
    expect(text).not.toMatch(/Assistant|Scope\/\*/)
  })

  test('size budget: tool definitions + default instructions', () => {
    const chars = JSON.stringify(agentTools()).length + buildInstructions(DEFAULT_AGENTS_MD).length
    const tokens = Math.round(chars / 4)
    console.log(`MCP surface: ${chars} chars ≈ ${tokens} tokens (cap ${TOKEN_CAP})`)
    expect(tokens).toBeLessThanOrEqual(TOKEN_CAP)
  })

  test('default instructions stay short and workflow-first', () => {
    const lines = buildInstructions(DEFAULT_AGENTS_MD).trimEnd().split('\n')
    expect(lines.length).toBeLessThanOrEqual(40)
    expect(lines.findIndex((l) => /^## Start of a session/.test(l))).toBeLessThan(8)
  })

  test('snapshot: changes to the tool list are reviewed deliberately (bun test -u to accept)', () => {
    expect(agentTools()).toMatchSnapshot()
  })
})

// ---------- results ----------

const agent: Actor = { actor: 'agent', workspace: 'web-app', branch: 'main', session: 's1' }
async function setup() {
  const s = await Store.open(await miniCopy())
  const call = (name: string, args: unknown = {}) => callTool(s, name, args, { actor: agent }) as Promise<Record<string, any>>
  return { s, call }
}

describe('results', () => {
  test('save_issue (and set_plan, toggle_task) return id, title, status, url, appUrl', async () => {
    const { call } = await setup()
    const out = shapeResult('save_issue', await call('save_issue', { title: 'Small fix', labels: ['Bug'], description: 'long text' })) as any
    expect(Object.keys(out)).toEqual(['id', 'title', 'status', 'url', 'appUrl'])
    expect(out.appUrl).toBe(`aitt://issue/${out.id}`)
    const planned = shapeResult('set_plan', await call('set_plan', { id: out.id, plan: 'now' })) as any
    expect(Object.keys(planned)).toEqual(['id', 'title', 'status', 'url', 'appUrl'])
  })

  test('save_issues returns one line per item: ref, id, title, status, url, appUrl', async () => {
    const { call } = await setup()
    const raw = await call('save_issues', { issues: [
      { ref: 'epic', title: 'Epic: import', labels: ['Feature'] },
      { ref: 's1', parentId: 'ref:epic', title: 'Step 1', labels: ['Task'] },
      { parentId: 'ref:epic', title: 'Step 2', labels: ['Task'], blockedBy: ['ref:s1'] },
    ] })
    const { content, structuredContent } = toolResult('save_issues', raw)
    const items = structuredContent!.issues as Record<string, unknown>[]
    expect(items.map((i) => Object.keys(i))).toEqual([
      ['ref', 'id', 'title', 'status', 'url', 'appUrl'], ['ref', 'id', 'title', 'status', 'url', 'appUrl'], ['id', 'title', 'status', 'url', 'appUrl'],
    ])
    expect(content[0]!.text.split('\n')).toHaveLength(5) // {"issues":[ + 3 items + ]}
    expect(JSON.parse(content[0]!.text)).toEqual(structuredContent!)
  })

  test('get_tree: links only at the root; nodes carry id, title, status, blockers, progress, children', async () => {
    const { call } = await setup()
    const saved = await call('save_issues', { issues: [
      { ref: 'epic', title: 'Epic', labels: ['Feature'] },
      { ref: 'a', parentId: 'ref:epic', title: 'A', labels: ['Task'] },
      { parentId: 'ref:a', title: 'A.1', labels: ['Task'] },
      { parentId: 'ref:epic', title: 'B', labels: ['Task'], blockedBy: ['ref:a'] },
    ] })
    const epic = saved.issues[0].id
    const tree = shapeResult('get_tree', await call('get_tree', { id: epic })) as any
    expect(Object.keys(tree)).toEqual(['id', 'title', 'status', 'url', 'appUrl', 'childLinks', 'progress', 'children'])
    // children carry no links; the root says how to build them, so no get_issue per child is needed
    expect(tree.childLinks).toBe(`${tree.url.slice(0, -epic.length)}{id} · aitt://issue/{id}`)
    expect(tree.progress).toEqual({ done: 0, total: 3 })
    const [a, b] = tree.children
    expect(a).toEqual({ id: saved.issues[1].id, title: 'A', status: 'Backlog', progress: { done: 0, total: 1 }, children: [{ id: saved.issues[2].id, title: 'A.1', status: 'Backlog' }] })
    expect(b).toEqual({ id: saved.issues[3].id, title: 'B', status: 'Backlog', blockedBy: [saved.issues[1].id] })
  })

  test('whats_next and get_issue pass stalled through to agents', async () => {
    const { s, call } = await setup()
    await s.updateIssue('Q-1', { labels: ['Feature'] }, agent)
    s.config.stalled = { idleHours: 1e-9, windowDays: 7, reopens: 2, sessions: 3 }
    await Bun.sleep(5)
    const next = toolResult('whats_next', await call('whats_next')).structuredContent as any
    expect(Object.keys(next)[0]).toBe('stalled') // first, so the agent sees its own stalled work
    expect(next.stalled).toEqual([expect.objectContaining({ id: 'Q-1', why: 'idle 0 h in In Progress' })])
    expect((shapeResult('get_issue', await call('get_issue', { id: 'Q-1' })) as any).stalled).toBe('idle 0 h in In Progress')
  })

  test(`get_issue is full but keeps only the last ${ACTIVITY_CAP} activity entries, saying how to get the rest`, async () => {
    const { call } = await setup()
    const { id } = await call('save_issue', { title: 'Chatty', labels: ['Task'] })
    for (let k = 0; k < ACTIVITY_CAP + 5; k++) await call('save_comment', { issueId: id, body: `note ${k}` })
    const raw = await call('get_issue', { id })
    const out = shapeResult('get_issue', raw) as any
    expect(out.url).toBe(raw.url)
    expect(out.appUrl).toBe(raw.appUrl)
    expect(out.description).toBe(raw.description)
    expect(out.activity).toHaveLength(ACTIVITY_CAP)
    expect(out.activity.at(-1).body).toBe(raw.activity.at(-1).body)
    expect(out.activityNote).toBe(`Showing the last ${ACTIVITY_CAP} of ${raw.activity.length} activity entries; list_comments({ issueId: "${id}" }) returns all.`)
    expect(out.extra).toBeUndefined()
    const short = shapeResult('get_issue', await call('get_issue', { id: 'Q-1' })) as any
    expect(short.activityNote).toBeUndefined()
  })

  test('save_comment returns the issue id, time and links, not the echoed body', async () => {
    const { call } = await setup()
    const out = shapeResult('save_comment', await call('save_comment', { issueId: 'Q-1', body: 'A long finding.' })) as any
    expect(Object.keys(out)).toEqual(['issueId', 'at', 'url', 'appUrl'])
  })

  test('list_issues and search items omit null and empty fields', async () => {
    const { call } = await setup()
    for (const name of ['list_issues', 'search']) {
      const out = shapeResult(name, await call(name, name === 'search' ? { query: 'a' } : {})) as any
      expect(out.issues.length).toBeGreaterThan(0)
      for (const i of out.issues) {
        expect(i.url).toBeDefined()
        for (const v of Object.values(i)) expect(v === null || (Array.isArray(v) && v.length === 0)).toBe(false)
      }
    }
  })

  test('unknown shapes pass through; text is JSON', () => {
    expect(shapeResult('get_issue', 'odd')).toBe('odd')
    expect(shapeResult('save_issues', { surprise: true })).toEqual({ surprise: true })
    expect(JSON.parse(resultText({ a: [{ x: 1 }, { x: 2 }], b: null }))).toEqual({ a: [{ x: 1 }, { x: 2 }], b: null })
  })
})
