import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite } from '../../src/store/atomic'
import { IssueParseError, parseIssue, serializeIssue } from '../../src/store/issueFile'

const fixture = await Bun.file(join(import.meta.dir, '../fixtures/issue-q42.md')).text()
const P = '/x/projects/shop/issues/Q-42.md'

describe('issueFile', () => {
  test('round-trips the spec example byte-for-byte', () => {
    const issue = parseIssue(fixture, P, 'shop')
    expect(issue.id).toBe('Q-42')
    expect(issue.priority).toBe(0)
    expect(issue.plan).toBe('next')
    expect(issue.labels).toEqual(['Feature', 'Scope/App'])
    expect(issue.project).toBe('shop')
    expect(issue.path).toBe(P)
    expect(serializeIssue(issue)).toBe(fixture)
  })

  test('preserves unknown front-matter keys in order', () => {
    const text = fixture.replace('due: null\n', 'due: null\npr: 1414\nestimate: 3\n')
    const issue = parseIssue(text, P, 'shop')
    expect(issue.extra).toEqual({ pr: 1414, estimate: 3 })
    expect(Object.keys(issue.extra)).toEqual(['pr', 'estimate'])
    expect(serializeIssue(issue)).toBe(text)
    // also after a real change
    issue.status = 'Done'
    const out = serializeIssue(issue)
    expect(out).toContain('status: Done')
    expect(out.indexOf('due: null')).toBeLessThan(out.indexOf('pr: 1414'))
    expect(out.indexOf('pr: 1414')).toBeLessThan(out.indexOf('estimate: 3'))
    expect(out.indexOf('estimate: 3')).toBeLessThan(out.indexOf('plan: next'))
  })

  test('parses activity entries', () => {
    const issue = parseIssue(fixture, P, 'shop')
    expect(issue.activity.length).toBe(2)
    expect(issue.activity[0]!.actor).toBe('agent')
    expect(issue.activity[0]!.workspace).toBe('web-app')
    expect(issue.activity[0]!.branch).toBe('fix/recipe-parser')
    expect(issue.activity[0]!.at).toBe('2026-10-28T14:02Z')
    expect(issue.activity[0]!.body).toBe('PR opened #57 …')
    expect(issue.activity[1]!.actor).toBe('you')
    expect(issue.activity[1]!.workspace).toBeUndefined()
    expect(issue.activity[1]!.body).toBe('Looks good.')
    expect(issue.touchedBy).toEqual({ actor: 'agent', workspace: 'acme-app', branch: 'main', session: 'a1b2c3d4' })
  })

  test('comment containing a fake heading round-trips', () => {
    const issue = parseIssue(fixture, P, 'shop')
    const body = 'before\n## Activity\n### 2026-01-01T00:00:00Z · agent · x\nafter'
    issue.activity.push({ at: '2026-10-29T00:00:00Z', actor: 'you', body })
    const text = serializeIssue(issue)
    const again = parseIssue(text, P, 'shop')
    expect(again.activity.length).toBe(3)
    expect(again.activity[2]!.body).toBe(body)
    expect(again.description).toBe(issue.description)
    expect(serializeIssue(again)).toBe(text)
  })

  test('escaping is lossless for text that already starts with spaces', () => {
    const issue = parseIssue(fixture, P, 'shop')
    const body = [' ## Activity', '  ### 2026-01-01T00:00:00Z · agent · x', '   ## Activity', '## Activity', ' ### not a heading'].join('\n')
    issue.activity.push({ at: '2026-10-29T00:00:00Z', actor: 'agent', workspace: 'w', body })
    issue.description = 'intro\n ## Activity\n  ### 2026-01-01T00:00:00Z · agent · x'
    const again = parseIssue(serializeIssue(issue), P, 'shop')
    expect(again.activity.length).toBe(3)
    expect(again.activity[2]!.body).toBe(body)
    expect(again.description).toBe(issue.description)
  })

  test('description containing ## Activity', () => {
    const issue = parseIssue(fixture, P, 'shop')
    issue.description = 'Intro\n\n## Activity\n### 2026-01-01T00:00:00Z · agent · x\nfake'
    const text = serializeIssue(issue)
    const again = parseIssue(text, P, 'shop')
    expect(again.description).toBe(issue.description)
    expect(again.activity.length).toBe(2)
    expect(serializeIssue(again)).toBe(text)
  })

  test('serializes a new issue (no source document) and parses it back', () => {
    const issue = parseIssue(fixture, P, 'shop')
    const fresh = { ...issue, id: 'Q-300', title: 'Has: colon', labels: ['A'], extra: { pr: 7 }, activity: [] }
    const text = serializeIssue(fresh)
    const back = parseIssue(text, P, 'shop')
    expect(back.id).toBe('Q-300')
    expect(back.title).toBe('Has: colon')
    expect(back.extra).toEqual({ pr: 7 })
    expect(back.activity).toEqual([])
    expect(back.links).toEqual(issue.links)
  })

  test('invalid YAML throws IssueParseError with path', () => {
    const bad = '---\nid: [unclosed\ntitle: x\n---\nbody\n'
    try {
      parseIssue(bad, '/x/bad.md', 'p')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(IssueParseError)
      expect((e as IssueParseError).path).toBe('/x/bad.md')
      expect((e as IssueParseError).message.length).toBeGreaterThan(0)
    }
  })

  test('missing front matter throws IssueParseError', () => {
    expect(() => parseIssue('no front matter', '/x/n.md', 'p')).toThrow(IssueParseError)
  })
})

describe('atomicWrite', () => {
  test('leaves no temp file and replaces content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tracker-atomic-'))
    const f = join(dir, 'a.md')
    await atomicWrite(f, 'one')
    await atomicWrite(f, 'two')
    expect(await readFile(f, 'utf8')).toBe('two')
    expect(await readdir(dir)).toEqual(['a.md'])
  })
})

describe('fix round 1', () => {
  test('mutating keys rewrites only those lines', () => {
    const issue = parseIssue(fixture, P, 'shop')
    issue.updated = '2026-11-01T00:00:00Z'
    issue.touchedBy = { actor: 'agent', workspace: 'web-app', branch: 'dev' }
    issue.blockedBy = ['Q-1', 'Q-2']
    const out = serializeIssue(issue)
    const changed = new Set(['updated', 'touched_by', 'blocked_by'])
    const lines = fixture.split('\n')
    const outLines = out.split('\n')
    expect(outLines.length).toBe(lines.length)
    for (let i = 0; i < lines.length; i++) {
      const key = /^([a-z_]+):/.exec(lines[i]!)?.[1]
      if (key && changed.has(key)) continue
      expect(outLines[i]).toBe(lines[i]!)
    }
    expect(out).toContain('blocked_by: [Q-1, Q-2]')
    expect(out).toContain('touched_by: {actor: agent, workspace: web-app, branch: dev}')
    expect(out).toContain('updated: 2026-11-01T00:00:00Z')
    expect(out).toContain('priority: 0            # 0 none')
    expect(out).toContain('labels: [Feature, Scope/App]')
  })

  test('changed key keeps its trailing comment and padding', () => {
    const issue = parseIssue(fixture, P, 'shop')
    issue.priority = 2
    expect(serializeIssue(issue)).toContain('priority: 2            # 0 none, 1 urgent')
  })

  test('removed extra key is deleted; new extra key appended', () => {
    const text = fixture.replace('due: null\n', 'due: null\npr: 1414\n')
    const issue = parseIssue(text, P, 'shop')
    delete issue.extra.pr
    issue.extra.estimate = 3
    const out = serializeIssue(issue)
    expect(out).not.toContain('pr: 1414')
    expect(out).toContain('estimate: 3\n---\n')
  })

  test('CRLF files round-trip with activity intact', () => {
    const crlf = fixture.replace(/\n/g, '\r\n')
    const issue = parseIssue(crlf, P, 'shop')
    expect(issue.activity.length).toBe(2)
    expect(issue.description).toBe('Description markdown…')
    expect(serializeIssue(issue)).toBe(crlf)
    issue.status = 'Done'
    const out = serializeIssue(issue)
    expect(out).toContain('status: Done\r\n')
    expect(out.replace(/\r\n/g, '')).not.toContain('\n')
  })

  test('touched_by keeps the agent client (optional) next to workspace', () => {
    const issue = parseIssue(fixture, P, 'shop')
    issue.touchedBy = { actor: 'agent', workspace: 'web', branch: 'main', session: '42', client: 'codex' }
    const out = serializeIssue(issue)
    expect(out).toContain('touched_by: {actor: agent, workspace: web, branch: main, session: "42", client: codex}')
    expect(parseIssue(out, P, 'shop').touchedBy).toEqual({ actor: 'agent', workspace: 'web', branch: 'main', session: '42', client: 'codex' })
  })

  test('legacy repo key is read as workspace; writes use workspace', () => {
    const issue = parseIssue(fixture, P, 'shop')
    expect(issue.touchedBy?.workspace).toBe('acme-app')
    expect(serializeIssue(issue)).toContain('repo: acme-app')
    issue.touchedBy = { ...issue.touchedBy!, branch: 'x' }
    const out = serializeIssue(issue)
    expect(out).toContain('workspace: acme-app')
    expect(out).not.toContain('repo:')
  })

  test('lite parse yields the same model as a full parse, without source', () => {
    const crlf = fixture.replace(/\n/g, '\r\n')
    for (const text of [fixture, crlf]) {
      const lite = parseIssue(text, P, 'shop', { lite: true })
      expect(JSON.stringify(lite)).toBe(JSON.stringify(parseIssue(text, P, 'shop')))
      expect(Object.getOwnPropertySymbols(lite)).toEqual([])
    }
    expect(() => parseIssue('---\nid: Q-1\ntitle: [unclosed\n---\n', P, 'q', { lite: true })).toThrow(IssueParseError)
    // duplicate keys: the full parser rejects them, so lite must too
    expect(() => parseIssue('---\nid: Q-1\nid: Q-2\n---\n', P, 'q', { lite: true })).toThrow(IssueParseError)
  })
})

describe('final fix: activity section never drops text', () => {
  const head = '---\nid: Q-1\ntitle: x\nstatus: Todo\n---\n'
  /** Every non-blank body line of `text` (ignoring structural escaping) still appears in `out`. */
  const keepsAllLines = (text: string, out: string) => {
    const norm = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean)
    const outLines = new Set(norm(out))
    for (const l of norm(text)) expect(outLines.has(l)).toBe(true)
  }

  test('lines between ## Activity and the first entry heading survive (t1 repro)', () => {
    const text = head + 'Desc line\n\n## Activity\nMy hand-written note with no heading\n### 2026-10-28 · you\nnote with date-only heading\n### 2026-10-28T14:02Z · agent · web-app\nreal entry\n'
    const i = parseIssue(text, '/x/Q-1.md', 'p')
    expect(i.description).toContain('My hand-written note with no heading')
    expect(i.description).toContain('### 2026-10-28 · you')
    expect(i.description).toContain('note with date-only heading')
    expect(i.activity.map((e) => e.body)).toEqual(['real entry'])
    i.title = 'y'
    const out = serializeIssue(i)
    keepsAllLines(text.replace('title: x', 'title: y'), out)
    const again = parseIssue(out, '/x/Q-1.md', 'p')
    expect(again.description).toBe(i.description)
    expect(again.activity).toEqual(i.activity)
    expect(serializeIssue(again)).toBe(out) // stable after the first write
  })

  test('bare ## Activity in a hand-written description (no entries) is kept as description', () => {
    const text = head + 'Intro\n\n## Activity\nWe plan to log things here.\n'
    const i = parseIssue(text, '/x/Q-1.md', 'p')
    expect(i.description).toBe('Intro\n\n## Activity\nWe plan to log things here.')
    expect(i.activity).toEqual([])
    i.status = 'Done'
    const out = serializeIssue(i)
    keepsAllLines(text.replace('Todo', 'Done'), out)
    expect(parseIssue(out, '/x/Q-1.md', 'p').description).toBe(i.description)
  })

  test('malformed first heading only (no well-formed entry) is kept as description', () => {
    const text = head + '## Activity\n### 2026-10-28 14:02 · you\nhello\n'
    const i = parseIssue(text, '/x/Q-1.md', 'p')
    expect(i.activity).toEqual([])
    expect(i.description).toBe('## Activity\n### 2026-10-28 14:02 · you\nhello')
    i.title = 'z'
    keepsAllLines(text.replace('title: x', 'title: z'), serializeIssue(i))
  })

  test('valid files (blank lines before the first entry included) parse as before and round-trip', () => {
    const text = head + 'D\n\n## Activity\n### 2026-10-28T14:02Z · you\nbody\n'
    const i = parseIssue(text, '/x/Q-1.md', 'p')
    expect(i.description).toBe('D')
    expect(i.activity.length).toBe(1)
    expect(serializeIssue(i)).toBe(text)
    const blank = head + 'D\n\n## Activity\n\n### 2026-10-28T14:02Z · you\nbody\n'
    const j = parseIssue(blank, '/x/Q-1.md', 'p')
    expect(j.description).toBe('D')
    expect(j.activity.map((e) => e.body)).toEqual(['body'])
  })
})

describe('final fix: patchRaw keeps multi-line block scalars whole', () => {
  const text = '---\nid: Q-1\ntitle: |\n  First paragraph\n\n  Second paragraph\nstatus: Todo\nnotes: |\n  a\n\n  b\n---\nDesc\n'
  test('changing a block-scalar title with a blank line (t2 repro)', () => {
    const i = parseIssue(text, '/x/Q-1.md', 'p')
    i.title = 'New title'
    const out = serializeIssue(i)
    const j = parseIssue(out, '/x/Q-1.md', 'p')
    expect(j.title).toBe('New title')
    expect(j.status).toBe('Todo')
    expect(j.extra.notes).toBe('a\n\nb\n')
    expect(out).toContain('status: Todo\nnotes: |\n  a\n\n  b\n---\n')
  })
  test('changing a block-scalar extra key with a blank line', () => {
    const k = parseIssue(text, '/x/Q-1.md', 'p')
    k.extra.notes = 'z'
    const out = serializeIssue(k)
    const j = parseIssue(out, '/x/Q-1.md', 'p')
    expect(j.extra.notes).toBe('z')
    expect(j.title).toBe('First paragraph\n\nSecond paragraph\n')
    expect(out.startsWith('---\nid: Q-1\ntitle: |\n  First paragraph\n\n  Second paragraph\nstatus: Todo\n')).toBe(true)
  })
  test('blank lines between top-level keys still end a block', () => {
    const t = '---\nid: Q-1\ntitle: a\n\nstatus: Todo\n---\n'
    const i = parseIssue(t, '/x/Q-1.md', 'p')
    i.title = 'b'
    expect(serializeIssue(i)).toBe('---\nid: Q-1\ntitle: b\n\nstatus: Todo\n---\n')
  })
})
