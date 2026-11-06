/**
 * Files agents attach to a comment (save_comment `attachments`): screenshots and PDFs.
 *
 * The agent names local paths. The MCP proxy reads them (src/mcp/proxy.ts, `readUploads`) and sends the bytes next to
 * the arguments as `ctx.uploads`, so the arguments keep the shape agents see. The engine checks each file again, stores
 * it as `projects/<slug>/files/<issue>-<sha8>.<ext>` (served by GET /files/…) and adds `![alt](../files/<name>)` to the
 * comment. The engine picks the file name; nothing from the agent reaches a path.
 */
import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { mkdir, open, readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'
import type { Issue } from '../model'
import { atomicWrite } from '../store/atomic'

/** What may be attached: images (shown inline) and PDF (linked). No SVG: it can carry script. */
export const ATTACH_EXT: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'])
export const ATTACH_MAX_BYTES = 5 * 1024 * 1024
export const ATTACH_MAX = 4

export interface Attachment { path: string; alt?: string }
/** One attachment as the proxy read it: the file's bytes (base64), or why it couldn't. */
export interface Upload { path: string; data?: string; error?: string }

const extOf = (p: string) => extname(p).slice(1).toLowerCase()
const realOrSelf = (p: string) => { try { return realpathSync(p) } catch { return p } }

/** An attachment's path is refused (a reason) or accepted (undefined), by extension. */
export function refuseExt(path: string): string | undefined {
  const ext = extOf(path)
  return ATTACH_EXT.has(ext) ? undefined : `${basename(path)}: only ${[...ATTACH_EXT].join(', ')} files can be attached`
}

/**
 * Proxy side: read the files, each resolved from `cwd` and required (after symlinks) to be inside one of `roots`
 * (the session's project folder, the temp folder), with an allowed extension and at most ATTACH_MAX_BYTES.
 */
export async function readUploads(list: unknown, cwd: string, roots: string[]): Promise<Upload[]> {
  if (!Array.isArray(list)) return []
  const inside = roots.filter(Boolean).map((r) => realOrSelf(r))
  const out: Upload[] = []
  for (const item of list.slice(0, ATTACH_MAX)) {
    const path = item && typeof item === 'object' && typeof (item as Attachment).path === 'string' ? (item as Attachment).path : ''
    if (!path) continue
    const fail = (error: string) => out.push({ path, error })
    const ext = refuseExt(path)
    if (ext) { fail(ext); continue }
    const abs = isAbsolute(path) ? path : resolve(cwd, path)
    let real: string
    try { real = realpathSync(abs) } catch { fail(`${path}: file not found`); continue }
    if (!inside.some((r) => real === r || real.startsWith(r + sep))) { fail(`${path}: only files inside the project folder or the temp folder can be attached`); continue }
    try {
      if (!statSync(real).isFile()) { fail(`${path}: not a file`); continue }
      if (statSync(real).size > ATTACH_MAX_BYTES) { fail(`${path}: larger than ${ATTACH_MAX_BYTES / 1024 / 1024} MB`); continue }
      // Read at most one byte past the limit, in case the file grew since the stat.
      const fh = await open(real, 'r')
      let buf: Buffer
      try { buf = Buffer.alloc(ATTACH_MAX_BYTES + 1); const { bytesRead } = await fh.read(buf, 0, buf.length, 0); buf = buf.subarray(0, bytesRead) } finally { await fh.close() }
      if (buf.length > ATTACH_MAX_BYTES) { fail(`${path}: larger than ${ATTACH_MAX_BYTES / 1024 / 1024} MB`); continue }
      out.push({ path, data: buf.toString('base64') })
    } catch (e) {
      fail(`${path}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}

/** Text safe inside `![…]`: no brackets, parentheses or line breaks, at most 80 characters. */
const cleanAlt = (s: string) => s.replace(/[[\]()\r\n\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)

/**
 * Engine side: store the uploaded files for `issue` and return the markdown to append (one image or link per line).
 * Throws an Error with an agent-readable message when an attachment can't be stored.
 */
export async function storeAttachments(root: string, issue: Pick<Issue, 'id' | 'project'>, list: Attachment[], uploads: unknown): Promise<string> {
  if (!list.length) return ''
  if (list.length > ATTACH_MAX) throw new Error(`At most ${ATTACH_MAX} attachments per comment.`)
  if (issue.project === '_none') throw new Error('Attachments need an issue in a project.')
  const got = new Map<string, Upload>()
  if (Array.isArray(uploads)) {
    for (const u of uploads as Upload[]) if (u && typeof u.path === 'string') got.set(u.path, u)
  }
  const dir = join(root, 'projects', issue.project, 'files')
  const lines: string[] = []
  for (const a of list) {
    const ext = refuseExt(a.path)
    if (ext) throw new Error(ext)
    const u = got.get(a.path)
    if (!u) throw new Error(`${a.path}: attachments are read by the agent connection (MCP); this call had none for this file.`)
    if (u.error) throw new Error(u.error)
    const bytes = Buffer.from(u.data ?? '', 'base64')
    if (!bytes.length) throw new Error(`${a.path}: the file is empty`)
    if (bytes.length > ATTACH_MAX_BYTES) throw new Error(`${a.path}: larger than ${ATTACH_MAX_BYTES / 1024 / 1024} MB`)
    const name = `${issue.id.toLowerCase()}-${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}.${extOf(a.path)}`
    await mkdir(dir, { recursive: true })
    const full = join(dir, name)
    const same = await readFile(full).then((b) => b.equals(bytes), () => false)
    if (!same) await atomicWrite(full, bytes)
    const alt = cleanAlt(a.alt ?? '') || cleanAlt(basename(a.path, extname(a.path))) || 'attachment'
    lines.push(extOf(a.path) === 'pdf' ? `[${alt}](../files/${name})` : `![${alt}](../files/${name})`)
  }
  return lines.join('\n')
}
