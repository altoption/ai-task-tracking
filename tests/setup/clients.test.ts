import { afterAll, describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  agentGuidance, clientStatus, CLIENTS, configPath, connectClient, cursorRule, detectClient, disconnectClient, guidancePath, type ClientId,
} from '../../src/setup/clients'
import { SKILL_TEXT } from '../../src/setup/setup'

/** Every test runs in a fake HOME under the temp dir; nothing here reads or writes a real client config. */
const temps: string[] = []
afterAll(async () => { await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))) })
async function fakeHome() {
  const base = await mkdtemp(join(tmpdir(), 'aitt-clients-'))
  temps.push(base)
  const userHome = join(base, 'home')
  await mkdir(userHome)
  const ctx = { userHome, env: { PATH: join(base, 'bin') } as Record<string, string | undefined>, appDirs: [join(base, 'Applications')] }
  return { base, userHome, ctx }
}
const BIN = '/home/x/Applications/AI Task Tracking.app/Contents/Resources/aitt'
const DATA = '/home/x/AITaskTracking'
const target = { binary: BIN, home: DATA }
const write = async (p: string, s: string) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, s) }
const backups = async (p: string) => (await readdir(dirname(p))).filter((f) => f.startsWith(`${p.split('/').pop()}.bak-aitt-`))

describe('guidance comes from one source (the skill)', () => {
  test('agentGuidance is the skill\'s workflow section under a product heading', () => {
    const section = /<!-- aitt:guidance:start[^>]*-->\n([\s\S]*?)<!-- aitt:guidance:end -->/.exec(SKILL_TEXT)![1]!.trim()
    const g = agentGuidance()
    expect(g).toContain(section)
    expect(g).toMatch(/^## Issue tracking: AI Task Tracking/)
    for (const s of ['save_milestone', 'aitt://issue/', "isn't running", 'ai-task-tracking']) expect(g).toContain(s)
  })
  test('the Cursor rule is the same text with always-apply frontmatter', () => {
    expect(cursorRule()).toBe(`---\ndescription: Issue tracking with AI Task Tracking (MCP server ai-task-tracking)\nalwaysApply: true\n---\n${agentGuidance()}`)
  })
})

describe('detectClient', () => {
  test('a CLI on PATH counts; an app counts only with its config folder', async () => {
    const { base, userHome, ctx } = await fakeHome()
    expect(detectClient('codex', ctx)).toBe(false)
    await write(join(base, 'bin', 'codex'), '#!/bin/sh\n'); await chmod(join(base, 'bin', 'codex'), 0o755)
    expect(detectClient('codex', ctx)).toBe(true)
    await mkdir(join(base, 'Applications', 'Cursor.app'), { recursive: true })
    expect(detectClient('cursor', ctx)).toBe(false)
    await mkdir(join(userHome, '.cursor'))
    expect(detectClient('cursor', ctx)).toBe(true)
  })
  test('config paths follow each tool\'s docs', async () => {
    const { userHome, ctx } = await fakeHome()
    const p = (id: ClientId) => configPath(id, ctx).slice(userHome.length)
    expect(p('codex')).toBe('/.codex/config.toml')
    expect(p('cursor')).toBe('/.cursor/mcp.json')
    expect(p('vscode')).toBe('/Library/Application Support/Code/User/mcp.json')
    expect(p('windsurf')).toBe('/.codeium/windsurf/mcp_config.json')
    expect(p('gemini')).toBe('/.gemini/settings.json')
    expect(p('claude-desktop')).toBe('/Library/Application Support/Claude/claude_desktop_config.json')
    expect(configPath('codex', { ...ctx, env: { CODEX_HOME: '/c' } })).toBe('/c/config.toml')
    expect(guidancePath('codex', ctx)?.slice(userHome.length)).toBe('/.codex/AGENTS.md')
    expect(guidancePath('gemini', ctx)?.slice(userHome.length)).toBe('/.gemini/GEMINI.md')
    expect(guidancePath('cursor', ctx)).toBeUndefined()
  })
})

const CODEX_FIXTURE = `# my codex config
model = "gpt-5"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]

[mcp_servers.context7.env]
TOKEN = "keep-me"

[profiles.fast]
model = "gpt-5-mini"
`

describe('Codex (TOML + AGENTS.md block)', () => {
  test('adds the server, keeps everything else byte for byte, backs up, appends the guidance block; second run is a no-op', async () => {
    const { userHome, ctx } = await fakeHome()
    const cfg = join(userHome, '.codex', 'config.toml'), md = join(userHome, '.codex', 'AGENTS.md')
    await write(cfg, CODEX_FIXTURE)
    await write(md, '# My rules\nBe terse.\n')
    const r = await connectClient('codex', ctx, target)
    expect(r.status).toBe('connected')
    const text = await readFile(cfg, 'utf8')
    expect(text.startsWith(CODEX_FIXTURE)).toBe(true)
    const parsed = Bun.TOML.parse(text) as any
    expect(parsed.mcp_servers['ai-task-tracking']).toEqual({ command: BIN, args: ['mcp'], env: { AITT_HOME: DATA } })
    expect(parsed.mcp_servers.context7.env.TOKEN).toBe('keep-me')
    expect(parsed.profiles.fast.model).toBe('gpt-5-mini')
    expect(await backups(cfg)).toHaveLength(1)
    const agents = await readFile(md, 'utf8')
    expect(agents.startsWith('# My rules\nBe terse.\n')).toBe(true)
    expect(agents).toContain(agentGuidance())
    expect(await backups(md)).toHaveLength(1)

    const again = await connectClient('codex', ctx, target)
    expect(again.status).toBe('unchanged')
    expect(await readFile(cfg, 'utf8')).toBe(text)
    expect(await readFile(md, 'utf8')).toBe(agents)
    expect(await backups(cfg)).toHaveLength(1)
  })

  test('a moved binary updates our table in place (no duplicate table)', async () => {
    const { userHome, ctx } = await fakeHome()
    const cfg = join(userHome, '.codex', 'config.toml')
    await write(cfg, CODEX_FIXTURE)
    await connectClient('codex', ctx, target)
    const r = await connectClient('codex', ctx, { ...target, binary: '/Applications/AI Task Tracking.app/Contents/Resources/aitt' })
    expect(r.status).toBe('connected')
    const text = await readFile(cfg, 'utf8')
    expect(text.match(/^\[mcp_servers\.ai-task-tracking\]/gm)).toHaveLength(1)
    expect((Bun.TOML.parse(text) as any).mcp_servers['ai-task-tracking'].command).toBe('/Applications/AI Task Tracking.app/Contents/Resources/aitt')
  })

  test('an ai-task-tracking entry that is not ours, an inline-table entry, or invalid TOML: left untouched', async () => {
    for (const body of [
      '[mcp_servers.ai-task-tracking]\ncommand = "/usr/local/bin/someone-else"\nargs = []\n',
      'mcp_servers = { ai-task-tracking = { command = "/x/aitt", args = ["mcp"] } }\n',
      '[mcp_servers\nbroken',
    ]) {
      const { userHome, ctx } = await fakeHome()
      const cfg = join(userHome, '.codex', 'config.toml')
      await write(cfg, body)
      const r = await connectClient('codex', ctx, target)
      expect(r.status).toBe('skipped')
      expect(await readFile(cfg, 'utf8')).toBe(body)
      expect(await backups(cfg)).toHaveLength(0)
    }
  })

  test('no config yet: creates it (no backup)', async () => {
    const { userHome, ctx } = await fakeHome()
    expect((await connectClient('codex', ctx, target)).status).toBe('connected')
    const cfg = join(userHome, '.codex', 'config.toml')
    expect((Bun.TOML.parse(await readFile(cfg, 'utf8')) as any).mcp_servers['ai-task-tracking'].args).toEqual(['mcp'])
    expect(await backups(cfg)).toHaveLength(0)
  })
})

const JSON_CLIENTS: [ClientId, string, Record<string, unknown>][] = [
  ['cursor', 'mcpServers', { type: 'stdio', command: BIN, args: ['mcp'], env: { AITT_HOME: DATA } }],
  ['vscode', 'servers', { type: 'stdio', command: BIN, args: ['mcp'], env: { AITT_HOME: DATA } }],
  ['windsurf', 'mcpServers', { command: BIN, args: ['mcp'], env: { AITT_HOME: DATA } }],
  ['gemini', 'mcpServers', { command: BIN, args: ['mcp'], env: { AITT_HOME: DATA } }],
  ['claude-desktop', 'mcpServers', { command: BIN, args: ['mcp'], env: { AITT_HOME: DATA } }],
]

describe.each(JSON_CLIENTS)('%s (JSON "%s")', (id, key, entry) => {
  const fixture = (extra: Record<string, unknown> = {}) => ({
    theme: 'dark', [key]: { other: { command: 'npx', args: ['-y', 'other-mcp'], env: { K: 'v' } }, ...extra }, nested: { a: [1, 2] },
  })
  test('adds the server, keeps other servers and settings, backs up once; second run is a no-op', async () => {
    const { ctx } = await fakeHome()
    const cfg = configPath(id, ctx)
    await write(cfg, JSON.stringify(fixture(), null, 2))
    expect((await connectClient(id, ctx, target)).status).toBe('connected')
    const after = JSON.parse(await readFile(cfg, 'utf8'))
    expect(after).toEqual({ ...fixture(), [key]: { ...fixture()[key] as object, 'ai-task-tracking': entry } })
    expect(await backups(cfg)).toHaveLength(1)
    const text = await readFile(cfg, 'utf8')
    expect((await connectClient(id, ctx, target)).status).toBe('unchanged')
    expect(await readFile(cfg, 'utf8')).toBe(text)
    expect(await backups(cfg)).toHaveLength(1)
  })
  test('someone else\'s ai-task-tracking entry and unreadable JSON are left untouched', async () => {
    for (const body of [JSON.stringify(fixture({ 'ai-task-tracking': { command: 'node', args: ['other.js'] } })), '{ "theme": "dark", // comment\n }']) {
      const { ctx } = await fakeHome()
      const cfg = configPath(id, ctx)
      await write(cfg, body)
      expect((await connectClient(id, ctx, target)).status).toBe('skipped')
      expect(await readFile(cfg, 'utf8')).toBe(body)
    }
  })
  test('disconnect removes only our entry (and our guidance block), with a backup', async () => {
    const { ctx } = await fakeHome()
    const cfg = configPath(id, ctx)
    await write(cfg, JSON.stringify(fixture(), null, 2))
    const gp = guidancePath(id, ctx)
    if (gp) await write(gp, '# Mine\n')
    await connectClient(id, ctx, target)
    expect((await disconnectClient(id, ctx)).status).toBe('disconnected')
    expect(JSON.parse(await readFile(cfg, 'utf8'))).toEqual(fixture())
    if (gp) expect(await readFile(gp, 'utf8')).toBe('# Mine\n')
    expect((await disconnectClient(id, ctx)).status).toBe('unchanged')
  })
})

describe('disconnect: Codex', () => {
  test('removes our tables and guidance block; leaves the rest and someone else\'s entry', async () => {
    const { userHome, ctx } = await fakeHome()
    const cfg = join(userHome, '.codex', 'config.toml'), md = join(userHome, '.codex', 'AGENTS.md')
    await write(cfg, CODEX_FIXTURE)
    await write(md, '# My rules\n')
    await connectClient('codex', ctx, target)
    expect((await disconnectClient('codex', ctx)).status).toBe('disconnected')
    expect(await readFile(cfg, 'utf8')).toBe(CODEX_FIXTURE)
    expect(await readFile(md, 'utf8')).toBe('# My rules\n')
    const other = '[mcp_servers.ai-task-tracking]\ncommand = "/usr/local/bin/someone-else"\n'
    await writeFile(cfg, other)
    expect((await disconnectClient('codex', ctx)).status).toBe('unchanged')
    expect(await readFile(cfg, 'utf8')).toBe(other)
  })
})

describe('CLIENTS', () => {
  test('seven tools (ChatGPT desktop shares Codex\'s file), each with a docs link', () => {
    expect(Object.keys(CLIENTS)).toEqual(['codex', 'chatgpt', 'cursor', 'vscode', 'windsurf', 'gemini', 'claude-desktop'])
    for (const c of Object.values(CLIENTS)) expect(c.docs).toMatch(/^https:\/\//)
  })
})

describe('file permissions (configs often hold other servers\' API keys)', () => {
  const mode = async (p: string) => (await stat(p)).mode & 0o777
  test.each(['codex', 'cursor'] as ClientId[])('%s: a 0600 config stays 0600 after the write, and its backup is 0600', async (id) => {
    const { ctx } = await fakeHome()
    const cfg = configPath(id, ctx)
    await write(cfg, id === 'codex' ? CODEX_FIXTURE : JSON.stringify({ mcpServers: { other: { command: 'x', env: { KEY: 'secret' } } } }))
    await chmod(cfg, 0o600)
    const r = await connectClient(id, ctx, target)
    expect(r.status).toBe('connected')
    expect(await mode(cfg)).toBe(0o600)
    expect(r.backups.length).toBeGreaterThan(0)
    for (const b of r.backups) expect(await mode(b)).toBe(0o600)
  })
  test('a 0644 file keeps 0644 (the mode is preserved, not changed)', async () => {
    const { ctx } = await fakeHome()
    const cfg = configPath('cursor', ctx)
    await write(cfg, '{}')
    await chmod(cfg, 0o644)
    const r = await connectClient('cursor', ctx, target)
    expect(await mode(cfg)).toBe(0o644)
    expect(await mode(r.backups[0]!)).toBe(0o644)
  })
  test('new files (config and guidance block) are created 0600', async () => {
    const { ctx } = await fakeHome()
    await connectClient('codex', ctx, target)
    expect(await mode(configPath('codex', ctx))).toBe(0o600)
    expect(await mode(guidancePath('codex', ctx)!)).toBe(0o600)
  })
  test('a symlinked config: the target keeps its 0600 mode and the link stays a link', async () => {
    const { base, ctx } = await fakeHome()
    const real = join(base, 'dotfiles', 'mcp.json')
    await write(real, '{}')
    await chmod(real, 0o600)
    const cfg = configPath('cursor', ctx)
    await mkdir(dirname(cfg), { recursive: true })
    await symlink(real, cfg)
    const r = await connectClient('cursor', ctx, target)
    expect(await mode(real)).toBe(0o600)
    expect((await lstat(cfg)).isSymbolicLink()).toBe(true)
    expect(JSON.parse(await readFile(real, 'utf8')).mcpServers['ai-task-tracking'].command).toBe(BIN)
    expect(await mode(r.backups[0]!)).toBe(0o600)
  })
})

describe('fix round', () => {
  test('a config that is a symlink to a missing file (e.g. an unmounted dotfiles volume): skipped, link kept', async () => {
    for (const id of ['cursor', 'codex'] as ClientId[]) {
      const { base, ctx } = await fakeHome()
      const cfg = configPath(id, ctx)
      await mkdir(dirname(cfg), { recursive: true })
      const gone = join(base, 'Volumes', 'gone', 'cfg')
      await symlink(gone, cfg)
      const r = await connectClient(id, ctx, target)
      expect(r.status).toBe('skipped')
      expect(r.message).toContain('linked file is missing')
      expect((await lstat(cfg)).isSymbolicLink()).toBe(true)
      expect(await readdir(dirname(cfg))).toEqual([cfg.split('/').pop()!])
    }
  })

  test('a guidance file that is a broken symlink: the client is skipped, nothing written', async () => {
    const { base, ctx } = await fakeHome()
    const gp = guidancePath('codex', ctx)!
    await mkdir(dirname(gp), { recursive: true })
    await symlink(join(base, 'missing', 'AGENTS.md'), gp)
    const r = await connectClient('codex', ctx, target)
    expect(r.status).toBe('skipped')
    expect(r.message).toContain('linked file is missing')
    expect(await readdir(dirname(gp))).toEqual(['AGENTS.md'])
  })

  test('removing our TOML tables keeps comment lines that introduce the next table', async () => {
    const { userHome, ctx } = await fakeHome()
    const cfg = join(userHome, '.codex', 'config.toml')
    const body = `model = "m"\n\n[mcp_servers.ai-task-tracking]\ncommand = "/x/AI Task Tracking.app/Contents/Resources/aitt"\nargs = ["mcp"]\n\n# Fast profile: used for quick edits\n[profiles.fast]\nmodel = "mini"\n`
    await write(cfg, body)
    await disconnectClient('codex', ctx)
    expect(await readFile(cfg, 'utf8')).toBe(`model = "m"\n\n# Fast profile: used for quick edits\n[profiles.fast]\nmodel = "mini"\n`)
  })

  test('refusal reasons: invalid JSON says comments/trailing commas; an unsupported TOML layout says so, not "invalid"', async () => {
    const a = await fakeHome()
    await write(configPath('cursor', a.ctx), '{ "a": 1, }')
    expect((await connectClient('cursor', a.ctx, target)).message).toMatch(/isn't plain JSON/)
    const b = await fakeHome()
    await write(configPath('codex', b.ctx), 'mcp_servers = { ai-task-tracking = { command = "/x/aitt", args = ["mcp"] } }\n')
    const m = (await connectClient('codex', b.ctx, target)).message
    expect(m).toContain("can't safely edit (unsupported layout:")
    expect(m).not.toMatch(/comments|isn't valid/)
  })

  test.each([['\t', 'tabs'], ['    ', '4 spaces'], ['  ', '2 spaces']])('JSON keeps its indent (%#: %s)', async (indent) => {
    const { ctx } = await fakeHome()
    const cfg = configPath('claude-desktop', ctx)
    await write(cfg, JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, indent))
    await connectClient('claude-desktop', ctx, target)
    const text = await readFile(cfg, 'utf8')
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, indent)}\n`)
  })
})

describe('updating our existing entry merges: user keys survive (ATT-26)', () => {
  // What ChatGPT desktop's "custom MCP" form writes to ~/.codex/config.toml.
  const chatgptToml = (bin = BIN, home = DATA) => `model = "gpt-5"

[mcp_servers.ai-task-tracking]
enabled = true
# pinned by me: the repo whose project is the default
command = ${JSON.stringify(bin)}
args = ["mcp"]
cwd = "/path/to/repo"

[mcp_servers.ai-task-tracking.env]
AITT_HOME = ${JSON.stringify(home)}
EXTRA = "keep"

[profiles.fast]
model = "mini"
`
  const mtime = async (p: string) => (await stat(p)).mtimeMs

  test('TOML: enabled, cwd, an extra env var and a comment survive a binary and data-folder change, in place', async () => {
    const { userHome, ctx } = await fakeHome()
    const cfg = join(userHome, '.codex', 'config.toml')
    await write(cfg, chatgptToml('/old/AI Task Tracking.app/Contents/Resources/aitt', '/old/data'))
    const r = await connectClient('codex', ctx, target)
    expect(r.status).toBe('connected')
    expect(await readFile(cfg, 'utf8')).toBe(chatgptToml())
    expect((Bun.TOML.parse(await readFile(cfg, 'utf8')) as any).mcp_servers['ai-task-tracking']).toEqual({
      enabled: true, command: BIN, args: ['mcp'], cwd: '/path/to/repo', env: { AITT_HOME: DATA, EXTRA: 'keep' },
    })
    expect(await backups(cfg)).toHaveLength(1)
  })

  test('TOML: an entry that is already right is a byte-identical no-op: no backup, mtime untouched, "already connected"', async () => {
    const { userHome, ctx } = await fakeHome()
    const cfg = join(userHome, '.codex', 'config.toml'), md = join(userHome, '.codex', 'AGENTS.md')
    await write(cfg, chatgptToml())
    await connectClient('codex', ctx, target) // first run adds the AGENTS.md block only
    expect(await readFile(cfg, 'utf8')).toBe(chatgptToml())
    expect(await backups(cfg)).toHaveLength(0)
    const before = [await mtime(cfg), await mtime(md)]
    await Bun.sleep(15)
    const r = await connectClient('codex', ctx, target)
    expect(r.status).toBe('unchanged')
    expect(r.message).toContain('already connected')
    expect(r.backups).toEqual([])
    expect(await readFile(cfg, 'utf8')).toBe(chatgptToml())
    expect([await mtime(cfg), await mtime(md)]).toEqual(before)
    expect(await backups(cfg)).toHaveLength(0)
    expect(await backups(md)).toHaveLength(0)
  })

  test('TOML: missing keys are added inside our table; a missing env table is added; an inline env keeps its other vars', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['[mcp_servers.ai-task-tracking]\nenabled = false\ncommand = "/x/aitt"\nargs = ["mcp"]\ncwd = "/r"\n', { enabled: false, command: BIN, args: ['mcp'], cwd: '/r', env: { AITT_HOME: DATA } }],
      ['[mcp_servers.ai-task-tracking]\nenv = { AITT_HOME = "/o", K = "v" }\ncommand = "/x/aitt"\nargs = [\n  "mcp",\n]\ntimeout = 5\n', { env: { AITT_HOME: DATA, K: 'v' }, command: BIN, args: ['mcp'], timeout: 5 }],
      ['[mcp_servers.ai-task-tracking]\ncwd = "/r"\n\n[mcp_servers.ai-task-tracking.env]\nAITT_HOME = "/o"\n', { cwd: '/r', command: BIN, args: ['mcp'], env: { AITT_HOME: DATA } }],
    ]
    for (const [body, want] of cases) {
      const { userHome, ctx } = await fakeHome()
      const cfg = join(userHome, '.codex', 'config.toml')
      await write(cfg, `# top\n${body}\n[profiles.fast]\nmodel = "mini"\n`)
      expect((await connectClient('codex', ctx, target)).status).toBe('connected')
      const text = await readFile(cfg, 'utf8')
      expect(text.startsWith('# top\n')).toBe(true)
      expect(text.match(/^\[mcp_servers\.ai-task-tracking\]/gm)).toHaveLength(1)
      const parsed = Bun.TOML.parse(text) as any
      expect(parsed.mcp_servers['ai-task-tracking']).toEqual(want)
      expect(parsed.profiles.fast.model).toBe('mini')
      expect((await connectClient('codex', ctx, target)).status).toBe('unchanged')
      expect(await readFile(cfg, 'utf8')).toBe(text)
    }
  })

  test('TOML: disconnect still removes our whole entry, user keys included', async () => {
    const { userHome, ctx } = await fakeHome()
    const cfg = join(userHome, '.codex', 'config.toml')
    await write(cfg, chatgptToml())
    expect((await disconnectClient('codex', ctx)).status).toBe('disconnected')
    expect(await readFile(cfg, 'utf8')).toBe('model = "gpt-5"\n\n[profiles.fast]\nmodel = "mini"\n')
  })

  test.each(JSON_CLIENTS)('%s JSON: extra keys (disabled, cwd) and env vars survive; the indent is kept; a re-run is a no-op', async (id, key, entry) => {
    const { ctx } = await fakeHome()
    const cfg = configPath(id, ctx)
    const old = { disabled: false, command: '/old/AI Task Tracking.app/Contents/Resources/aitt', args: ['mcp'], cwd: '/path/to/repo', env: { EXTRA: 'keep', AITT_HOME: '/old' } }
    await write(cfg, `${JSON.stringify({ [key]: { 'ai-task-tracking': old, other: { command: 'x' } } }, null, '\t')}\n`)
    expect((await connectClient(id, ctx, target)).status).toBe('connected')
    const text = await readFile(cfg, 'utf8')
    const got = JSON.parse(text)[key]['ai-task-tracking']
    expect(got).toEqual({ ...old, ...entry, env: { EXTRA: 'keep', AITT_HOME: DATA } })
    expect(Object.keys(got).slice(0, 4)).toEqual(['disabled', 'command', 'args', 'cwd'])
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, '\t')}\n`)
    expect(await clientStatus(id, ctx, target)).toBe('connected')
    const m = await mtime(cfg)
    await Bun.sleep(15)
    const again = await connectClient(id, ctx, target)
    expect(again.status).toBe('unchanged')
    expect(again.message).toContain('already connected')
    expect(await mtime(cfg)).toBe(m)
    expect(await backups(cfg)).toHaveLength(1)
    expect((await disconnectClient(id, ctx)).status).toBe('disconnected')
    expect(JSON.parse(await readFile(cfg, 'utf8'))[key]).toEqual({ other: { command: 'x' } })
  })

  test('clientStatus: an entry with user keys is "connected" when our keys are right', async () => {
    const { userHome, ctx } = await fakeHome()
    await write(join(userHome, '.codex', 'config.toml'), chatgptToml())
    expect(await clientStatus('codex', ctx, target)).toBe('connected')
    expect(await clientStatus('codex', ctx, { ...target, home: '/elsewhere' })).toBe('outdated')
  })
})

describe('ChatGPT desktop (alias of the Codex config)', () => {
  test('detected by its app or its Application Support folder; shares the Codex file', async () => {
    const { base, userHome, ctx } = await fakeHome()
    expect(detectClient('chatgpt', ctx)).toBe(false)
    await mkdir(join(base, 'Applications', 'ChatGPT.app'), { recursive: true })
    expect(detectClient('chatgpt', ctx)).toBe(true)
    const b = await fakeHome()
    await mkdir(join(b.userHome, 'Library', 'Application Support', 'com.openai.chat'), { recursive: true })
    expect(detectClient('chatgpt', b.ctx)).toBe(true)
    expect(configPath('chatgpt', ctx)).toBe(configPath('codex', ctx))
    expect(configPath('chatgpt', ctx).slice(userHome.length)).toBe('/.codex/config.toml')
    expect(CLIENTS.chatgpt.sharesWith).toBe('codex')
  })
})

describe('ATT-26 fix round', () => {
  test('chatgpt always uses ~/.codex/config.toml (the GUI app never sees $CODEX_HOME)', async () => {
    const { userHome, ctx } = await fakeHome()
    const env = { ...ctx.env, CODEX_HOME: '/elsewhere/codex' }
    expect(configPath('chatgpt', { ...ctx, env })).toBe(join(userHome, '.codex', 'config.toml'))
    expect(guidancePath('chatgpt', { ...ctx, env })).toBe(join(userHome, '.codex', 'AGENTS.md'))
    expect(configPath('codex', { ...ctx, env })).toBe('/elsewhere/codex/config.toml')
  })

  test('clientStatus says when the writer would refuse, instead of "outdated"', async () => {
    const { userHome, ctx } = await fakeHome()
    await write(join(userHome, '.codex', 'config.toml'), 'mcp_servers = { ai-task-tracking = { command = "/x/aitt", args = ["mcp"] } }\n')
    expect(await clientStatus('codex', ctx, target)).toBe("can't update automatically (unsupported layout)")
  })

  test('CRLF files keep CRLF on inserted lines; a re-run is a no-op', async () => {
    const { userHome, ctx } = await fakeHome()
    const cfg = join(userHome, '.codex', 'config.toml')
    const body = '# top\r\n[mcp_servers.ai-task-tracking]\r\ncwd = "/r" # mine\r\nargs = [\r\n  "mcp",\r\n]\r\ncommand = "/old/aitt" # old\r\n\r\n[profiles.fast]\r\nmodel = "mini"\r\n'
    await write(cfg, body)
    expect((await connectClient('codex', ctx, target)).status).toBe('connected')
    const text = await readFile(cfg, 'utf8')
    expect(text.replace(/\r\n/g, '')).not.toContain('\n')
    expect((Bun.TOML.parse(text) as any).mcp_servers['ai-task-tracking']).toEqual({ cwd: '/r', args: ['mcp'], command: BIN, env: { AITT_HOME: DATA } })
    expect(text).toContain(`command = ${JSON.stringify(BIN)} # old\r\n`)
    expect((await connectClient('codex', ctx, target)).status).toBe('unchanged')
    expect(await readFile(cfg, 'utf8')).toBe(text)
    // a new entry appended to a CRLF file, and a CRLF JSON file
    const b = await fakeHome()
    await write(configPath('codex', b.ctx), 'model = "m"\r\n')
    await connectClient('codex', b.ctx, target)
    expect((await readFile(configPath('codex', b.ctx), 'utf8')).replace(/\r\n/g, '')).not.toContain('\n')
    await write(configPath('cursor', b.ctx), '{\r\n  "mcpServers": {}\r\n}\r\n')
    await connectClient('cursor', b.ctx, target)
    expect((await readFile(configPath('cursor', b.ctx), 'utf8')).replace(/\r\n/g, '')).not.toContain('\n')
  })

  test('disconnect keeps the trailing newline when our table was last with no blank line before it', async () => {
    for (const eol of ['\n', '\r\n']) {
      const { userHome, ctx } = await fakeHome()
      const cfg = join(userHome, '.codex', 'config.toml')
      await write(cfg, ['model = "m"', '[mcp_servers.ai-task-tracking]', 'command = "/x/AI Task Tracking.app/Contents/Resources/aitt"', 'args = ["mcp"]', ''].join(eol))
      expect((await disconnectClient('codex', ctx)).status).toBe('disconnected')
      expect(await readFile(cfg, 'utf8')).toBe(`model = "m"${eol}`)
    }
  })
})
