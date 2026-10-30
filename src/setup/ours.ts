import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
/** Which MCP registrations belong to this app (shared by Claude Code setup and the other agent tools' configs). */

export interface McpEntry { scope: 'user' | 'project' | 'local' | 'unknown'; command: string; args: string; env: string[] }

/** This app's server: runs `<…>/aitt mcp` or carries AITT_HOME. */
export const isOurMcp = (e: McpEntry) =>
  /\/aitt mcp$/.test(`${e.command} ${e.args}`.trim()) || e.env.some((l) => /^AITT_HOME=/.test(l))

/** Strict: the command is the engine binary inside an app bundle of ours. */
export const OUR_BUNDLE_BINARY = /\/AI Task Tracking\.app\/Contents\/Resources\/aitt$/

/**
 * Whether `command` is one of `binaries` (absolute, canonical paths), comparing the path as written and, when it
 * exists, its real path. Used by uninstall so that removing one copy of the app leaves another copy's entries alone.
 */
export function runsBinary(command: string, binaries: string[]): boolean {
  if (!command.startsWith('/')) return false
  if (binaries.includes(resolve(command))) return true
  try { return binaries.includes(realpathSync(command)) } catch { return false }
}
