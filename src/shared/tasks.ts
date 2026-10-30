/**
 * Markdown task-list lines (`- [ ]` / `- [x]`), shared by the engine's `toggle_task` tool and the UI,
 * so "the n-th task" means the same line on both sides — and the same checkbox marked renders.
 *
 * Skipped: fenced code (``` / ~~~) and indented code blocks (4+ spaces after a blank line, outside a list).
 * Nested list items indented 4+ spaces are list content, not code.
 */

export interface TaskLine { /** index into `md.split('\n')` */ line: number; text: string; checked: boolean }

const FENCE_RE = /^\s*(?:>\s*)*(`{3,}|~{3,})/
const TASK_RE = /^((?:\s*>)*\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\](?=\s)/
const ITEM_RE = /^(?:\s*>)*\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/
const QUOTE_RE = /^(?:\s*>)+ ?/

/** Leading indentation width (tab = 4), after any blockquote markers. */
function indentOf(line: string): number {
  const body = line.replace(QUOTE_RE, '')
  let w = 0
  for (const c of body) {
    if (c === ' ') w++
    else if (c === '\t') w += 4 - (w % 4)
    else break
  }
  return w
}

/** Pure: every task line, in document order. */
export function taskLines(md: string): TaskLine[] {
  const lines = md.split('\n')
  const out: TaskLine[] = []
  let fence: string | null = null
  let inList = false
  let inCode = false // indented code block
  let prevBlank = true
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const f = FENCE_RE.exec(line)
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null
      continue
    }
    if (/^\s*$/.test(line.replace(QUOTE_RE, ''))) { prevBlank = true; continue }
    const indent = indentOf(line)
    if (inCode) {
      if (indent >= 4) continue
      inCode = false
    }
    if (indent >= 4 && !inList && prevBlank) { inCode = true; prevBlank = false; continue }
    if (f) { fence = f[1]!; prevBlank = false; continue }
    if (ITEM_RE.test(line)) inList = true
    else if (indent === 0 && prevBlank) inList = false
    prevBlank = false
    const m = TASK_RE.exec(line)
    if (m) out.push({ line: i, text: line, checked: m[2] !== ' ' })
  }
  return out
}

/** Pure: the `index`-th task line's text, or null. */
export function taskAt(md: string, index: number): TaskLine | null {
  return index >= 0 ? (taskLines(md)[index] ?? null) : null
}

/** Pure: flip the `index`-th task (`[ ]` ↔ `[x]`); out of range: unchanged. Line endings are kept. */
export function toggleTask(md: string, index: number): string {
  const t = taskAt(md, index)
  if (!t) return md
  const lines = md.split('\n')
  const m = TASK_RE.exec(t.text)!
  lines[t.line] = m[1] + (m[2] === ' ' ? '[x]' : '[ ]') + t.text.slice(m[0].length)
  return lines.join('\n')
}
