import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { FeedEvent } from '../../src/engine/eventlog'
import type { IssueSummary, LabelDef } from '../../src/model'
import { activityItems, buildTree, filterOptions, labelOptions, treeProgress } from '../../ui/issuePage'
import { isAllowedUrl, linkifyIds, makeSanitizer, renderMarkdown, rewriteUrl, toggleTask } from '../../ui/markdown'
import { taskLines } from '../../src/shared/tasks'

const sanitize = makeSanitizer(new JSDOM('').window as unknown as Window)
const safe = (md: string, keys?: string[]) => sanitize(renderMarkdown(md, { project: 'acme-app', keys }))

describe('linkifyIds', () => {
  test('wraps ids in anchors to the issue route', () => {
    expect(linkifyIds('see Q-271 and LC-3')).toBe('see <a class="issue-ref" href="#/issue/Q-271">Q-271</a> and <a class="issue-ref" href="#/issue/LC-3">LC-3</a>')
  })
  test('escapes the surrounding text', () => {
    expect(linkifyIds('<b>Q-1</b> & co')).toBe('&lt;b&gt;<a class="issue-ref" href="#/issue/Q-1">Q-1</a>&lt;/b&gt; &amp; co')
  })
  test('only known keys when given; not inside words or paths', () => {
    expect(linkifyIds('ABC-1 and Q-2', ['Q'])).toBe('ABC-1 and <a class="issue-ref" href="#/issue/Q-2">Q-2</a>')
    expect(linkifyIds('xQ-2 a/Q-3 Q-4b')).toBe('xQ-2 a/Q-3 Q-4b')
  })
})

describe('toggleTask', () => {
  const md = ['intro', '- [ ] one', '* [x] two', '', '```', '- [ ] in code', '```', '  1. [ ] three', '- [] not a task', '> - [X] quoted'].join('\n')
  test('flips only the n-th task, counting in document order', () => {
    expect(toggleTask(md, 0)).toBe(md.replace('- [ ] one', '- [x] one'))
    expect(toggleTask(md, 1)).toBe(md.replace('* [x] two', '* [ ] two'))
    expect(toggleTask(md, 2)).toBe(md.replace('1. [ ] three', '1. [x] three'))
    expect(toggleTask(md, 3)).toBe(md.replace('> - [X] quoted', '> - [ ] quoted'))
  })
  test('tasks inside fenced code are not counted; out of range is a no-op', () => {
    expect(toggleTask(md, 4)).toBe(md)
    expect(toggleTask(md, -1)).toBe(md)
  })
  test('keeps CRLF line endings', () => {
    expect(toggleTask('- [ ] a\r\n- [ ] b\r\n', 1)).toBe('- [ ] a\r\n- [x] b\r\n')
  })
  test('the n-th rendered checkbox is the n-th toggled task', () => {
    const html = safe(md)
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(4)
  })
  const indented = ['para', '', '    - [ ] indented code', '    - [x] still code', '', '- [ ] real', '    - [ ] nested real', '', 'text', '- [x] after'].join('\n')
  test('indented code blocks are skipped; nested list items are not code', () => {
    expect(taskLines(indented).map((t) => t.text.trim())).toEqual(['- [ ] real', '- [ ] nested real', '- [x] after'])
    expect(toggleTask(indented, 0)).toBe(indented.replace('- [ ] real', '- [x] real'))
    expect(toggleTask(indented, 1)).toBe(indented.replace('- [ ] nested real', '- [x] nested real'))
  })
  test('the finder agrees with the renderer on how many tasks there are', () => {
    for (const doc of [md, indented]) {
      const rendered = (safe(doc).match(/class="task"/g) ?? []).length
      expect([doc, rendered]).toEqual([doc, taskLines(doc).length])
    }
  })
})

describe('rewriteUrl', () => {
  const ctx = { project: 'acme-app' }
  test('imported relative files go to the engine files route', () => {
    expect(rewriteUrl('../files/import-your-data.png', ctx)).toBe('/files/acme-app/import-your-data.png')
    expect(rewriteUrl('../files/a%20b.png', ctx)).toBe('/files/acme-app/a%20b.png')
  })
  test('everything else is unchanged', () => {
    for (const u of ['https://example.com/x', '#/issue/Q-1', '/files/x/y.png', 'notes.md']) expect(rewriteUrl(u, ctx)).toBe(u)
  })
})

describe('isAllowedUrl', () => {
  test('http, https, relative and fragments', () => {
    for (const u of ['https://a.b/c', 'http://a.b', '#/issue/Q-1', '/files/p/x.png', 'x/y.png', '../files/z.png', '?q=1']) expect(isAllowedUrl(u)).toBe(true)
  })
  test('scripts, data, protocol-relative and obfuscated schemes are refused', () => {
    for (const u of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', ' javascript:x', 'data:text/html,x', 'vbscript:x', '//evil.example/x', 'file:///etc/passwd'])
      expect(isAllowedUrl(u)).toBe(false)
  })
})

describe('renderMarkdown + sanitizer', () => {
  test('script tags and event handlers are stripped', () => {
    const html = safe('hi <script>alert(1)</script>\n\n<img src="x.png" onerror="alert(1)">')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
  })
  test('javascript: links lose their href', () => {
    const html = safe('[x](javascript:alert(1)) <a href="javascript:alert(2)">y</a>')
    expect(html).not.toContain('javascript:')
  })
  test('external links open in a new tab without opener; internal links do not', () => {
    const html = safe('[ext](https://example.com) [int](#/issue/Q-1)')
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">ext</a>')
    expect(html).toContain('<a href="#/issue/Q-1">int</a>')
  })
  test('imported images are rewritten and kept', () => {
    expect(safe('![shot](../files/connect-your-tools.png)')).toContain('<img src="/files/acme-app/connect-your-tools.png" alt="shot">')
  })
  test('ids are linked in text but not in code or inside existing links', () => {
    const html = safe('see Q-271, `Q-272`, [Q-273](#/issue/Q-273) and ABC-1', ['Q'])
    expect(html).toContain('<a class="issue-ref" href="#/issue/Q-271">Q-271</a>')
    expect(html).toContain('<code>Q-272</code>')
    expect(html).toContain('<a href="#/issue/Q-273">Q-273</a>')
    expect(html).not.toContain('#/issue/ABC-1')
  })
  test('raw <input> in the source is not a task: no task class, disabled', () => {
    const html = safe('<input type="checkbox" class="task" data-task="x" checked> raw\n\n- [ ] real')
    const inputs = html.match(/<input[^>]*>/g) ?? []
    expect(inputs.length).toBe(2)
    expect(inputs[0]).not.toContain('class=')
    expect(inputs[0]).toContain('disabled')
    expect(inputs[0]).not.toContain('data-task')
    expect(inputs[1]).toContain('class="task"')
    expect(inputs[1]).not.toContain('disabled')
    expect(inputs[1]).not.toContain('data-task')
  })
  test('task checkboxes are enabled and GFM tables render', () => {
    const html = safe('- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(html).toMatch(/<input[^>]*type="checkbox"/)
    expect(html).not.toMatch(/<input[^>]*disabled/)
    expect(html).toContain('<table>')
  })
})

const sum = (id: string, over: Partial<IssueSummary> = {}): IssueSummary => ({
  id, title: id, status: 'Todo', priority: 0, labels: [], parent: null, blockedBy: [], related: [], milestone: null, due: null, plan: null,
  links: [], created: '2026-10-01T00:00:00Z', updated: '2026-10-01T00:00:00Z', project: 'p', childCount: 0, progress: { done: 0, total: 0 },
  blocks: [], workspaces: [], ...over,
})

describe('buildTree', () => {
  test('children to any depth, ordered by number', () => {
    const issues = new Map([sum('Q-1'), sum('Q-10', { parent: 'Q-1' }), sum('Q-2', { parent: 'Q-1' }), sum('Q-3', { parent: 'Q-2' })].map((i) => [i.id, i]))
    const t = buildTree(issues, 'Q-1')
    expect(t.map((n) => n.issue.id)).toEqual(['Q-2', 'Q-10'])
    expect(t[0]!.children.map((n) => n.issue.id)).toEqual(['Q-3'])
  })
  test('a parent cycle terminates', () => {
    const issues = new Map([sum('Q-1', { parent: 'Q-2' }), sum('Q-2', { parent: 'Q-1' })].map((i) => [i.id, i]))
    const t = buildTree(issues, 'Q-1')
    expect(t.map((n) => n.issue.id)).toEqual(['Q-2'])
    expect(t[0]!.children).toEqual([])
  })
})

describe('treeProgress', () => {
  test('counts every descendant; closed ones are done (live, so a new child counts at once)', () => {
    const issues = new Map([sum('Q-1'), sum('Q-2', { parent: 'Q-1', status: 'Done' }), sum('Q-3', { parent: 'Q-1' }), sum('Q-4', { parent: 'Q-3', status: 'Canceled' })].map((i) => [i.id, i]))
    const closed = (s: string) => s === 'Done' || s === 'Canceled'
    const t = buildTree(issues, 'Q-1')
    expect(treeProgress(t, closed)).toEqual({ done: 2, total: 3 })
    expect(treeProgress(t[1]!.children, closed)).toEqual({ done: 1, total: 1 })
  })
})

describe('activityItems', () => {
  const ev = (over: Partial<FeedEvent>): FeedEvent => ({ at: '2026-10-28T12:00:00Z', actor: { actor: 'agent', workspace: 'shop' }, id: 'Q-1', kind: 'status', ...over })
  test('comments interleave with status/parent/blocked/created events by time; feed comments and plain updates are dropped', () => {
    const items = activityItems(
      [{ at: '2026-10-28T11:00:00Z', actor: 'you', body: 'first' }, { at: '2026-10-28T13:00:00Z', actor: 'agent', workspace: 'shop', body: 'second' }],
      [ev({ kind: 'comment', text: 'second', at: '2026-10-28T13:00:00Z' }), ev({ kind: 'updated', at: '2026-10-28T12:30:00Z' }), ev({ to: 'Done' }), ev({ kind: 'created', at: '2026-10-28T10:00:00Z' })],
    )
    expect(items.map((x) => (x.kind === 'comment' ? x.entry.body : x.event.kind))).toEqual(['created', 'first', 'status', 'second'])
  })
})

describe('pickers', () => {
  const labels: LabelDef[] = [{ name: 'Bug', group: null, color: '#f00' }, { name: 'Scope/CDP', group: 'Scope', color: '#00f' }, { name: 'Scope/App', group: 'Scope', color: '#00f' }]
  test('labels are grouped (ungrouped first) and sorted within a group', () => {
    expect(labelOptions(labels).map((o) => `${o.group ?? ''}:${o.label}`)).toEqual([':Bug', 'Scope:App', 'Scope:CDP'])
  })
  test('type-ahead matches every word in label, group or value', () => {
    const opts = labelOptions(labels)
    expect(filterOptions(opts, 'sco app').map((o) => o.value)).toEqual(['Scope/App'])
    expect(filterOptions(opts, '').length).toBe(3)
  })
})
