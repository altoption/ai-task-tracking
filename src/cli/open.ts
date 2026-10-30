/** `aitt open <ID|project-slug|link>`: show an issue or project in the app, or in the browser when the app isn't installed. */

export type OpenTarget =
  | { kind: 'issue'; id: string; port?: number }
  | { kind: 'project'; slug: string; port?: number }
  | { kind: 'new'; port?: number }

export const OPEN_USAGE = `Usage: aitt open <ID | project-slug | link>
  aitt open ATT-1                  an issue
  aitt open website                a project (project/<slug> when the slug looks like an id, e.g. project/phase-2)
  aitt open aitt://issue/ATT-1     an app link, or a http://127.0.0.1:<port>/#/… link from a tool result`

const ID = /^[A-Za-z0-9]+-\d+$/
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

function fromRoute(kind: string, arg: string | undefined): OpenTarget | undefined {
  const a = arg ? decodeURIComponent(arg) : ''
  if (kind === 'issue' && ID.test(a)) return { kind: 'issue', id: a.toUpperCase() }
  if (kind === 'project' && SLUG.test(a)) return { kind: 'project', slug: a }
  if (kind === 'new' && !a) return { kind: 'new' }
  return undefined
}

/** Parse what the user typed. Throws with a one-line reason when it isn't something the app can show. */
export function parseOpenTarget(input: string): OpenTarget {
  const s = input.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const bad = new Error(`"${s}" is not an AI Task Tracking link (aitt://issue/ATT-1, or http://127.0.0.1:<port>/#/issue/ATT-1).`)
    const app = /^aitt:\/\/([a-z]+)\/?([^/?#]*)\/?$/i.exec(s)
    if (app) return fromRoute(app[1]!.toLowerCase(), app[2] || undefined) ?? (() => { throw bad })()
    const web = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)\/#\/([a-z]+)\/?([^/?#]*)(\?.*)?$/i.exec(s)
    const t = web ? fromRoute(web[3]!.toLowerCase(), web[4] || undefined) : undefined
    if (!t) throw bad
    return { ...t, port: Number(web![2]) }
  }
  if (ID.test(s)) return { kind: 'issue', id: s.toUpperCase() }
  const proj = /^project\/(.+)$/.exec(s)?.[1] ?? s
  if (SLUG.test(proj)) return { kind: 'project', slug: proj }
  throw new Error(`"${s}" is not an issue id (ATT-1), a project slug (website) or an AI Task Tracking link.`)
}

const path = (t: OpenTarget) =>
  t.kind === 'issue' ? `issue/${encodeURIComponent(t.id)}` : t.kind === 'project' ? `project/${encodeURIComponent(t.slug)}` : 'new'

/** The link the app handles (same as tool results' appUrl). */
export const appLink = (t: OpenTarget) => `aitt://${path(t)}`
/** The browser link (same as tool results' url). */
export const httpLink = (t: OpenTarget, port: number) => `http://127.0.0.1:${port}/#/${path(t)}`

export interface OpenDeps {
  /** Opens a URL with macOS `open`; returns its exit code (non-zero when no app handles the scheme). */
  open(url: string): Promise<number>
  /** The engine port (AITT_PORT, else the data folder's config). */
  port(): Promise<number>
  log(line: string): void
}

export async function openCommand(args: string[], deps: OpenDeps): Promise<number> {
  if (args.length !== 1) { deps.log(OPEN_USAGE); return 2 }
  let t: OpenTarget
  try { t = parseOpenTarget(args[0]!) } catch (e) { deps.log(`aitt open: ${(e as Error).message}\n${OPEN_USAGE}`); return 2 }
  const app = appLink(t)
  if ((await deps.open(app)) === 0) return 0
  const web = httpLink(t, t.port ?? (await deps.port()))
  if ((await deps.open(web)) === 0) {
    deps.log(`The AI Task Tracking app isn't installed (nothing opens ${app}); opened ${web} in the browser.`)
    return 0
  }
  deps.log(`aitt open: Could not open ${app} or ${web}. Is AI Task Tracking installed and running?`)
  return 1
}
