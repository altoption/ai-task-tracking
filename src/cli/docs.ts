import { DOCS_USAGE } from './usage'
import { NOT_RUNNING } from '../mcp/proxy'

/** `aitt docs`: open the user docs the running engine serves at /docs/ in the browser. */
export interface DocsDeps {
  /** The engine port (AITT_PORT, else the data folder's config). */
  port(): Promise<number>
  /** True when an engine answers /api/health at `url`. */
  healthy(url: string): Promise<boolean>
  /** Opens a URL with macOS `open`; returns its exit code. */
  open(url: string): Promise<number>
  log(line: string): void
  error(line: string): void
}

export async function docsCommand(args: string[], deps: DocsDeps): Promise<number> {
  if (args.length) { deps.error(DOCS_USAGE); return 2 }
  const base = `http://127.0.0.1:${await deps.port()}`
  if (!(await deps.healthy(`${base}/api/health`))) { deps.error(NOT_RUNNING); return 1 }
  const url = `${base}/docs/`
  deps.log(url)
  return deps.open(url)
}

/** The engine is up when /api/health answers `{ ok: true }` within a second. */
export async function engineHealthy(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1000) })
    return r.ok && (await r.json() as { ok?: unknown }).ok === true
  } catch {
    return false
  }
}
