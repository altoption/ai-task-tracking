import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, View } from '../../src/model'
import { parseIssue } from '../../src/store/issueFile'
import {
  deriveKey, initFolder, readConfig, readLabels, readProject, readViews, writeConfig, writeLabels, writeProject, writeView,
} from '../../src/store/metaFiles'

const fixture = join(import.meta.dir, '../fixtures/mini')
const tmp = () => mkdtemp(join(tmpdir(), 'tracker-meta-'))
const exists = (p: string) => stat(p).then(() => true, () => false)

describe('metaFiles', () => {
  test('initFolder creates skeleton', async () => {
    const root = await tmp()
    await initFolder(root)
    for (const p of ['config.yml', 'labels.yml', 'AGENTS.md', '.gitignore', 'projects', 'views']) expect(await exists(join(root, p))).toBe(true)
    const c = await readConfig(root)
    expect(c.statuses).toHaveLength(7)
    expect(c.port).toBe(7477)
    expect(c.needsYou).toEqual({ statuses: ['Waiting', 'In Review'], labels: ['Needs decision', 'Needs review'] })
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('.tracker/')
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toContain('whats_next')
  })

  test('fresh-folder defaults are generic: type labels + needs-you labels, no groups; AGENTS.md has no workspace-specific lists', async () => {
    const root = await tmp()
    await initFolder(root)
    const labels = await readLabels(root)
    expect(labels.map((l) => l.name)).toEqual(['Bug', 'Feature', 'Improvement', 'Task', 'Needs decision', 'Needs review', 'Blocked'])
    expect(labels.every((l) => l.group === null)).toBe(true)
    const agents = await readFile(join(root, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('one type label, plus a scope label if the workspace uses scope labels (see list_issue_labels)')
    for (const s of ['## Start of a session', '## New work', '## While working', '## Handing back / finishing', "## Don't"]) expect(agents).toContain(s)
    for (const s of ['save_issues', 'blockedBy', 'Waiting', 'Needs decision', 'baseDescription', "isn't running", "didn't reply"]) expect(agents).toContain(s)
    expect(agents.startsWith('# AI Task Tracking')).toBe(true)
    expect(agents).toContain('aitt://issue/')
    expect(agents).not.toMatch(/\bTracker\b|tracker:\/\//)
    expect(agents).not.toMatch(/Scope\/\*|Env\//)
    expect(Object.keys((await readConfig(root)).nextNumber)).toEqual([])
  })

  test('initFolder does not overwrite existing files', async () => {
    const root = await tmp()
    await initFolder(root)
    await Bun.write(join(root, 'AGENTS.md'), 'mine\n')
    await initFolder(root)
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('mine\n')
  })

  test('round-trips config, labels, project, view', async () => {
    const root = await tmp()
    await initFolder(root)
    const c = await readConfig(root)
    c.nextNumber = { Q: 276, LC: 3 }
    c.workspaces = { 'web-app': 'support' }
    await writeConfig(root, c)
    expect(await readConfig(root)).toEqual(c)

    const labels = [
      { name: 'Bug', group: null, color: '#eb5757' },
      { name: 'Scope/App', group: 'Scope', color: '#26b5ce' },
    ]
    await writeLabels(root, labels)
    expect(await readLabels(root)).toEqual(labels)

    const p: Project = {
      slug: 'demo', name: 'Demo', key: 'DEMO', status: 'Active', color: '#fff', repos: ['demo'],
      milestones: [{ name: 'M1', description: 'first', target: '2026-12-01' }, { name: 'M2' }],
      description: 'Some *description*.\n\nTwo paragraphs.\n',
      docs: [{ slug: 'notes', title: 'Notes: a title', content: 'Doc body\n' }],
    }
    await writeProject(join(root, 'projects/demo'), p)
    expect(await readProject(join(root, 'projects/demo'))).toEqual(p)

    const v: View = {
      slug: 'mine', name: 'Mine',
      filter: { status: ['Todo'], labels: ['Bug'], blocked: false, includeDone: true },
      display: { layout: 'board', groupBy: 'status', orderBy: 'priority', showSubIssues: true, properties: ['id', 'labels'] },
    }
    await writeView(root, v)
    expect(await readViews(root)).toEqual([v])
  })

  test('deriveKey', () => {
    expect(deriveKey('task-clone', new Set())).toBe('TC')
    expect(deriveKey('task-clone', new Set(['TC']))).toBe('TC2')
    expect(deriveKey('task-clone', new Set(['TC', 'TC2']))).toBe('TC3')
    expect(deriveKey('shop', new Set())).toBe('SHOP')
    expect(deriveKey('warehouse', new Set())).toBe('WAREH')
  })

  test('readProject on fixture returns 2 milestones', async () => {
    const p = await readProject(join(fixture, 'projects/acme-app'))
    expect(p.slug).toBe('acme-app')
    expect(p.key).toBe('Q')
    expect(p.milestones.map((m) => m.name)).toEqual(['MVP', 'Beta'])
    expect(p.docs).toHaveLength(1)
    expect(p.docs[0]!.title).toBe('Architecture notes')
    expect(p.repos).toEqual(['acme-app'])
  })

  test('fixture config, labels and issues parse', async () => {
    const c = await readConfig(fixture)
    expect(c.nextNumber).toEqual({ Q: 7 })
    expect(c.workspaces).toEqual({ 'web-app': 'support' })
    const labels = await readLabels(fixture)
    expect(labels.find((l) => l.name === 'Scope/App')?.group).toBe('Scope')
    expect(labels.find((l) => l.name === 'Bug')?.group).toBeNull()
    const names = labels.map((l) => l.name)
    expect(names).toContain('Scope/App')
    expect(names).toContain('Env/Prod')
    expect(names).toContain('Needs decision')
    const read = async (proj: string, n: number) =>
      parseIssue(await readFile(join(fixture, `projects/${proj}/issues/Q-${n}.md`), 'utf8'), 'x', proj)
    expect((await read('acme-app', 3)).parent).toBe('Q-2')
    expect((await read('acme-app', 2)).parent).toBe('Q-1')
    expect((await read('acme-app', 4)).blockedBy).toEqual(['Q-3'])
    expect((await read('support', 5)).status).toBe('Waiting')
    expect((await read('support', 6)).status).toBe('Done')
  })

  test('unknown keys survive read -> write (project, milestone, doc, label, config)', async () => {
    const root = await tmp()
    await initFolder(root)
    const dir = join(root, 'projects/p')
    await mkdir(join(dir, 'docs'), { recursive: true })
    await Bun.write(join(dir, 'project.md'), '---\nname: P\nkey: P\nstatus: Active\nowner: nick\nrepos: []\nmilestones:\n  - {name: M1, health: green}\n---\nbody\n')
    await Bun.write(join(dir, 'docs/d.md'), '---\ntitle: D\nauthor: me\n---\ndoc\n')
    const p = await readProject(dir)
    expect(p.extra).toEqual({ owner: 'nick' })
    expect(p.milestones[0]!.extra).toEqual({ health: 'green' })
    expect(p.docs[0]!.extra).toEqual({ author: 'me' })
    await writeProject(dir, p)
    const again = await readProject(dir)
    expect(again).toEqual(p)
    expect(await readFile(join(dir, 'project.md'), 'utf8')).toContain('owner: nick')
    expect(await readFile(join(dir, 'docs/d.md'), 'utf8')).toContain('author: me')

    await Bun.write(join(root, 'labels.yml'), 'labels:\n  - {name: Bug, color: "#f00", description: crashes}\n')
    const labels = await readLabels(root)
    expect(labels[0]!.extra).toEqual({ description: 'crashes' })
    await writeLabels(root, labels)
    expect(await readLabels(root)).toEqual(labels)

    await Bun.write(join(root, 'config.yml'), 'port: 7477\neditor: vim\nnextNumber: {Q: 1}\n')
    const c = await readConfig(root)
    expect(c.extra).toEqual({ editor: 'vim' })
    c.nextNumber = { Q: 2 }
    await writeConfig(root, c)
    const c2 = await readConfig(root)
    expect(c2.extra).toEqual({ editor: 'vim' })
    expect(c2.nextNumber).toEqual({ Q: 2 })
  })

  test('writeConfig keeps comments and untouched lines byte-identical', async () => {
    const root = await tmp()
    const text = '# my tracker\nport: 7477   # keep\n\nworkspaces:\n  web-app: support  # mapped\nneedsYou:\n  statuses: [Waiting, In Review]\n  labels: [Needs decision, Needs review]\nnextNumber:\n  Q: 7   # next id\n'
    await Bun.write(join(root, 'config.yml'), text)
    const c = await readConfig(root)
    c.nextNumber = { Q: 8 }
    await writeConfig(root, c)
    const out = await readFile(join(root, 'config.yml'), 'utf8')
    expect(out.replace('Q: 8', 'Q: 7')).toBe(text)
    expect(out).toContain('Q: 8')
    // CRLF file stays CRLF
    await Bun.write(join(root, 'config.yml'), text.replace(/\n/g, '\r\n'))
    const c3 = await readConfig(root)
    c3.nextNumber = { Q: 9 }
    await writeConfig(root, c3)
    const out3 = await readFile(join(root, 'config.yml'), 'utf8')
    expect(out3).toBe(text.replace('Q: 7', 'Q: 9').replace(/\n/g, '\r\n'))
  })

  test('writeConfig does not fold long scalars', async () => {
    const root = await tmp()
    await initFolder(root)
    const c = await readConfig(root)
    c.workspaces = { w: 'x'.repeat(200) + ' ' + 'y'.repeat(50) }
    await writeConfig(root, c)
    expect(await readFile(join(root, 'config.yml'), 'utf8')).toContain(`  w: ${'x'.repeat(200)} ${'y'.repeat(50)}\n`)
  })

  test('project.md with empty front-matter or CRLF is not double-wrapped', async () => {
    const root = await tmp()
    const a = join(root, 'a')
    await mkdir(a, { recursive: true })
    await Bun.write(join(a, 'project.md'), '---\n---\nJust a description\n---\nwith a rule\n')
    const pa = await readProject(a)
    expect(pa.description).toBe('Just a description\n---\nwith a rule\n')
    expect(pa.name).toBe('a')
    await writeProject(a, pa)
    const outA = await readFile(join(a, 'project.md'), 'utf8')
    expect(outA.match(/^---$/gm)!.length).toBe(3) // one fm block (2) + the body's own rule
    expect((await readProject(a)).description).toBe(pa.description)

    const b = join(root, 'b')
    await mkdir(b, { recursive: true })
    await Bun.write(join(b, 'project.md'), '---\r\nname: B\r\nkey: B\r\nstatus: Active\r\nrepos: []\r\nmilestones: []\r\n---\r\nDesc\r\n')
    const pb = await readProject(b)
    expect(pb.name).toBe('B')
    expect(pb.description).toBe('Desc\n')
    await writeProject(b, pb)
    const outB = await readFile(join(b, 'project.md'), 'utf8')
    expect(outB.match(/^---\r?$/gm)!.length).toBe(2)
    expect(outB).toContain('\r\n')
  })

  test('writeConfig adding a new nextNumber key keeps other comments', async () => {
    const root = await tmp()
    const text = '# top\nport: 7477 # p\nnextNumber:\n  Q: 7\n'
    await Bun.write(join(root, 'config.yml'), text)
    const c = await readConfig(root)
    c.nextNumber = { Q: 7, LC: 1 }
    await writeConfig(root, c)
    const out = await readFile(join(root, 'config.yml'), 'utf8')
    expect(out).toBe('# top\nport: 7477 # p\nnextNumber:\n  Q: 7\n  LC: 1\n')
    expect((await readConfig(root)).nextNumber).toEqual({ Q: 7, LC: 1 })
  })
})

describe('final fix: .gitignore migration never follows a symlink', () => {
  test('a symlinked .gitignore is left alone and its target is not copied in', async () => {
    const { mkdtemp, readFile: rf, readlink, symlink, writeFile: wf, lstat } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join: j } = await import('node:path')
    const { ensureGitignoreLine } = await import('../../src/store/metaFiles')
    const root = await mkdtemp(j(tmpdir(), 'tracker-gi-'))
    const outside = await mkdtemp(j(tmpdir(), 'tracker-secret-'))
    const secret = j(outside, 'secret.txt')
    await wf(secret, 'TOP SECRET\n')
    await symlink(secret, j(root, '.gitignore'))
    const warn = console.warn
    const msgs: unknown[] = []
    console.warn = (...a: unknown[]) => { msgs.push(a) }
    try {
      expect(await ensureGitignoreLine(root, '.*.tmp')).toBe(false)
    } finally { console.warn = warn }
    expect((await lstat(j(root, '.gitignore'))).isSymbolicLink()).toBe(true)
    expect(await readlink(j(root, '.gitignore'))).toBe(secret)
    expect(await rf(secret, 'utf8')).toBe('TOP SECRET\n')
    expect(msgs.length).toBe(1)
  })

  test('an oversized .gitignore is skipped, a missing one created, a regular one migrated', async () => {
    const { mkdtemp, readFile: rf, writeFile: wf } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join: j } = await import('node:path')
    const { ensureGitignoreLine } = await import('../../src/store/metaFiles')
    const big = await mkdtemp(j(tmpdir(), 'tracker-gi-'))
    const huge = 'x\n'.repeat(600_000)
    await wf(j(big, '.gitignore'), huge)
    const warn = console.warn
    console.warn = () => {}
    try { expect(await ensureGitignoreLine(big, '.*.tmp')).toBe(false) } finally { console.warn = warn }
    expect(await rf(j(big, '.gitignore'), 'utf8')).toBe(huge)
    const none = await mkdtemp(j(tmpdir(), 'tracker-gi-'))
    expect(await ensureGitignoreLine(none, '.*.tmp')).toBe(true)
    expect(await rf(j(none, '.gitignore'), 'utf8')).toBe('.*.tmp\n')
    await wf(j(none, '.gitignore'), 'a')
    expect(await ensureGitignoreLine(none, '.*.tmp')).toBe(true)
    expect(await rf(j(none, '.gitignore'), 'utf8')).toBe('a\n.*.tmp\n')
  })
})
