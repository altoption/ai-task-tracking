import { z } from 'zod'
import { ACTIVITY_CAP, OWNER_ONLY, toolSchemas } from '../tools/schemas'

/**
 * What agents see of AI Task Tracking over MCP: the tool list (with annotations), the server instructions and
 * concise tool results. The engine's HTTP tool API keeps its full shapes (the app's UI and menu bar use them);
 * results are trimmed here, for agents only.
 */

export { ACTIVITY_CAP }

/** Put before the data folder's AGENTS.md in the server instructions. */
export const INSTRUCTIONS_PREAMBLE =
  'Tool results are JSON; omitted fields are empty. Issue writes return id, title, status, url and appUrl (save_comment returns issueId, at, url and appUrl), so no read-back is needed.\n\n'

export const buildInstructions = (agentsMd: string) => INSTRUCTIONS_PREAMBLE + agentsMd

export interface AgentTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: { title: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean }
}

/** Drops `minLength: 1` (the engine still checks it; it only costs every session tokens). */
function lean(v: unknown): any {
  if (Array.isArray(v)) return v.map(lean)
  if (!v || typeof v !== 'object') return v
  return Object.fromEntries(Object.entries(v).filter(([k, x]) => !(k === 'minLength' && x === 1)).map(([k, x]) => [k, lean(x)]))
}

/** The tools agents get, as tools/list sends them (the title is in annotations). */
export function agentTools(): AgentTool[] {
  return Object.entries(toolSchemas).filter(([name]) => !OWNER_ONLY.has(name)).map(([name, t]) => {
    const { $schema: _s, ...inputSchema } = z.toJSONSchema(t.input, { io: 'input', target: 'draft-7' }) as Record<string, unknown>
    return {
      name, description: t.description, inputSchema: lean(inputSchema),
      annotations: {
        title: t.title,
        // destructiveHint false: every write is git-versioned and recoverable, and true would put a permission prompt on the most common calls.
        ...(t.readOnly ? { readOnlyHint: true } : { destructiveHint: false, ...(t.idempotent ? { idempotentHint: true } : {}) }),
        openWorldHint: false,
      },
    }
  })
}

// ---------- results ----------

type Obj = Record<string, any>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const pick = (o: Obj, keys: string[]): Obj => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))
/** Drops null and empty-array fields (list items: absent means none). */
const compact = (o: Obj): Obj => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0)))

const WRITE_KEYS = ['id', 'title', 'status', 'url', 'appUrl']
const written = (i: Obj) => pick(i, WRITE_KEYS)

function treeNode(n: Obj): Obj {
  const kids: Obj[] = Array.isArray(n.children) ? n.children : []
  return {
    ...pick(n, ['id', 'title', 'status']),
    ...(n.blockedBy?.length ? { blockedBy: n.blockedBy } : {}),
    ...(kids.length ? { progress: n.progress, children: kids.map(treeNode) } : {}),
  }
}

const shapers: Record<string, (r: Obj) => Obj> = {
  save_issue: written,
  set_plan: written,
  toggle_task: written,
  save_issues: (r) => ({ issues: r.issues.map((i: Obj) => ({ ...(i.ref ? { ref: i.ref } : {}), ...written(i) })) }),
  save_comment: (r) => pick(r, ['issueId', 'at', 'url', 'appUrl']),
  save_project: ({ description: _d, ...rest }) => rest,
  get_issue(r) {
    const { extra, activity, ...rest } = r
    const all: unknown[] = Array.isArray(activity) ? activity : []
    return {
      ...rest,
      ...(isObj(extra) && Object.keys(extra).length ? { extra } : {}),
      activity: all.slice(-ACTIVITY_CAP),
      ...(all.length > ACTIVITY_CAP
        ? { activityNote: `Showing the last ${ACTIVITY_CAP} of ${all.length} activity entries; list_comments({ issueId: "${r.id}" }) returns all.` }
        : {}),
    }
  },
  get_tree(r) {
    const root: Obj = { ...pick(r, WRITE_KEYS), ...treeNode(r), progress: r.progress }
    if (!root.children || typeof r.url !== 'string' || !r.url.endsWith(`/${r.id}`)) return root
    // Children carry no links; this says how to build one, so agents don't spend a get_issue per child.
    const { children, progress, ...head } = root
    return { ...head, childLinks: `${r.url.slice(0, -String(r.id).length)}{id} · aitt://issue/{id}`, progress, children }
  },
  list_issues: (r) => ({ ...r, issues: r.issues.map(compact) }),
  search: (r) => ({ ...r, issues: r.issues.map(compact) }),
}

/** The agent-facing form of an engine tool result. Unknown shapes (e.g. from an older engine) pass through unchanged. */
export function shapeResult(name: string, data: unknown): unknown {
  const f = shapers[name]
  if (!f || !isObj(data)) return data
  try { return f(data) } catch { return data }
}

/** JSON text with each item of a top-level list on its own line: compact, still easy to scan. */
export function resultText(v: unknown): string {
  if (!isObj(v)) return JSON.stringify(v)
  const parts = Object.entries(v).map(([k, x]) =>
    Array.isArray(x) && x.length > 1 && x.every(isObj)
      ? `${JSON.stringify(k)}:[\n${x.map((e) => JSON.stringify(e)).join(',\n')}\n]`
      : `${JSON.stringify(k)}:${JSON.stringify(x)}`)
  return `{${parts.join(',')}}`
}

export type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Obj; isError?: boolean }

/** An MCP tool result from an engine reply: the shaped JSON as text plus the same object as structuredContent. */
export function toolResult(name: string, data: unknown): ToolResult {
  const shaped = shapeResult(name, data)
  return { content: [{ type: 'text', text: resultText(shaped) }], ...(isObj(shaped) ? { structuredContent: shaped } : {}) }
}
