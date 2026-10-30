/**
 * Markdown for issue descriptions and comments: `marked` (GFM, task lists) → `DOMPurify`.
 *
 * Pure helpers (tested without a browser): `linkifyIds`, `toggleTask` (from src/shared/tasks), `rewriteUrl`, `isAllowedUrl`,
 * `renderMarkdown` (unsafe HTML), `makeSanitizer(window)`. The issue page renders only
 * `sanitize(renderMarkdown(...))` — the one place HTML from data reaches the DOM.
 */
import DOMPurify from 'dompurify'
import { Marked, type Tokens } from 'marked'

/** Marks checkboxes the renderer made (task items); raw `<input>` in the source never knows it, so it can't pose as a task. */
const TASK_MARK = Math.random().toString(36).slice(2) + Date.now().toString(36)

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!)

/** An issue id standing alone: not glued to a word, path or another id (`xQ-2`, `a/Q-3`, `Q-4b` are not ids). */
const ID_RE = /(?<![A-Za-z0-9_/-])([A-Z][A-Z0-9]{0,9})-(\d+)(?![A-Za-z0-9_/-])/g
const ID_AT_START = /^([A-Z][A-Z0-9]{0,9})-(\d+)(?![A-Za-z0-9_/-])/

const idAnchor = (id: string) => `<a class="issue-ref" href="#/issue/${id}">${id}</a>`
const keyOk = (key: string, keys?: ReadonlySet<string>) => !keys || keys.has(key)

/** Pure: HTML for plain text with issue ids (`Q-271`, `LC-3`) linked to `#/issue/<id>`. With `keys`, only those id keys link (so `AHU-1` stays text). */
export function linkifyIds(text: string, keys?: Iterable<string>): string {
  const set = keys ? new Set(keys) : undefined
  let out = ''
  let last = 0
  for (const m of text.matchAll(ID_RE)) {
    if (!keyOk(m[1]!, set)) continue
    out += escapeHtml(text.slice(last, m.index)) + idAnchor(m[0])
    last = m.index! + m[0].length
  }
  return out + escapeHtml(text.slice(last))
}

// The n-th task line: one finder shared with the engine's toggle_task tool.
export { taskAt, taskLines, toggleTask } from '../src/shared/tasks'

export interface MdContext {
  /** The issue's project slug: attachments (`../files/x.png`) live in `projects/<slug>/files/`. */
  project: string
  /** Id keys that auto-link (e.g. project keys). Omitted: any `ABC-12`. */
  keys?: Iterable<string>
}

const FILE_RE = /^\.\.\/files\/([^/?#]+)$/

/** Pure: `../files/x` → the engine's `/files/<project>/x`; anything else unchanged. */
export function rewriteUrl(url: string, ctx: Pick<MdContext, 'project'>): string {
  const f = FILE_RE.exec(url)
  if (f) return `/files/${encodeURIComponent(ctx.project)}/${f[1]}`
  return url
}

/** Pure: link/image targets allowed in rendered markdown — http(s), relative paths, `?query` and `#fragments`. */
export function isAllowedUrl(url: string): boolean {
  // Browsers ignore control characters and whitespace inside a scheme (`java\nscript:`).
  const s = url.replace(/[\u0000- \u007f-\u009f]/g, '')
  if (/^[/\\]{2}/.test(s)) return false // protocol-relative: another host
  if (/^https?:/i.test(s)) return true
  return !/^[^/?#]*:/.test(s) // any other scheme
}

// One parser; the per-call context is read synchronously during `parse`.
let current: { ctx: MdContext; keys?: ReadonlySet<string> } = { ctx: { project: '' } }
// `breaks`: a single newline is a line break (issue text written by agents and other tools relies on it).
const marked = new Marked({ gfm: true, breaks: true })
marked.use({
  extensions: [{
    name: 'issueRef',
    level: 'inline',
    start(src: string) {
      for (const m of src.matchAll(ID_RE)) if (keyOk(m[1]!, current.keys)) return m.index
      return undefined
    },
    tokenizer(src: string) {
      if (this.lexer.state.inLink) return undefined
      const m = ID_AT_START.exec(src)
      if (!m || !keyOk(m[1]!, current.keys)) return undefined
      return { type: 'issueRef', raw: m[0], id: m[0] }
    },
    renderer(t) { return idAnchor((t as unknown as { id: string }).id) },
  }],
  walkTokens(t) {
    if (t.type === 'link' || t.type === 'image') (t as Tokens.Link | Tokens.Image).href = rewriteUrl((t as Tokens.Link).href, current.ctx)
  },
  renderer: {
    // Enabled: the issue page toggles the task in the markdown on click.
    checkbox({ checked }: Tokens.Checkbox) { return `<input type="checkbox" data-task="${TASK_MARK}"${checked ? ' checked=""' : ''}> ` },
  },
})

/** Pure: markdown → HTML (NOT safe: always pass through a sanitizer before it reaches the DOM). */
export function renderMarkdown(md: string, ctx: MdContext): string {
  current = { ctx, keys: ctx.keys ? new Set(ctx.keys) : undefined }
  try { return marked.parse(md, { async: false }) as string } finally { current = { ctx: { project: '' } } }
}

/** A sanitizer bound to a window: DOMPurify's HTML profile, plus our URL allow-list and external links in a new tab. */
export function makeSanitizer(win: Window): (html: string) => string {
  const purify = DOMPurify(win as unknown as Parameters<typeof DOMPurify>[0])
  purify.addHook('afterSanitizeAttributes', (node) => {
    for (const attr of ['href', 'src', 'action', 'formaction', 'poster', 'xlink:href']) {
      const v = node.getAttribute?.(attr)
      if (v != null && !isAllowedUrl(v)) node.removeAttribute(attr)
    }
    if (node.tagName === 'INPUT') {
      // Only renderer-made checkboxes are clickable tasks; anything else from the source is inert.
      const ours = node.getAttribute('data-task') === TASK_MARK
      node.removeAttribute('data-task')
      node.removeAttribute('class')
      if (ours) node.setAttribute('class', 'task')
      else node.setAttribute('disabled', '')
    }
    if (node.tagName === 'A') {
      if (/^https?:/i.test(node.getAttribute('href') ?? '')) {
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noopener noreferrer')
      } else {
        node.removeAttribute('target')
      }
    }
  })
  return (html) => purify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style', 'srcset', 'id', 'name'],
  }) as unknown as string
}
