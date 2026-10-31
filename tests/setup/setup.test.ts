import { afterAll, describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, stat, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConfig, readProject } from '../../src/store/metaFiles'
import {
  feedKeys, isOurMcp, parseMcpGet, parseSetupArgs, runSetup, SETUP_LOCK, SetupInterrupted, shellQuote, type SetupIO,
} from '../../src/setup/setup'

/**
 * Setup runs against a temp HOME with stub `gh` and `claude` first on PATH; PATH has no other
 * directory that holds the real ones, so the user's Claude Code config and GitHub are never touched.
 */
const CLI = join(import.meta.dir, '../../src/cli.ts')
const REPO_SKILL = join(import.meta.dir, '../../skills/ai-task-tracking/SKILL.md')
const exists = (p: string) => lstat(p).then(() => true, () => false)
const temps: string[] = []
const tmp = async (prefix: string) => { const d = await mkdtemp(join(tmpdir(), prefix)); temps.push(d); return d }
afterAll(async () => { await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))) })

const GH = `#!/bin/bash
echo "gh $*" >> "$STUB_LOG"
case "$1 $2" in
  "auth status") exit "\${GH_AUTH_EXIT:-0}" ;;
  "api user") [ -n "$GH_USER_FAIL" ] && exit 1; echo octo ;;
  "repo create")
    src=""; prev=""
    for a in "$@"; do [ "$prev" = "--source" ] && src="$a"; prev="$a"; done
    git -C "$src" remote add origin "https://github.com/$3.git" ;;
esac
`
/** Fake Claude Code: MCP entries are files in $STUB_MCP_DIR holding \`claude mcp get\` output. */
const CLAUDE = `#!/bin/bash
echo "claude $*" >> "$STUB_LOG"
D="$STUB_MCP_DIR"
case "$1 $2" in
  "mcp get") [ -f "$D/$3" ] && { cat "$D/$3"; exit 0; }; echo "No MCP server found with name: $3" >&2; exit 1 ;;
  "mcp remove") rm -f "$D/$5" ;;
  "mcp add")
    [ -n "$CLAUDE_ADD_FAIL" ] && { echo "add failed: boom" >&2; exit 1; }
    printf '%s:\\n  Scope: User config (available in all your projects)\\n  Status: ✔ Connected\\n  Type: stdio\\n  Command: %s\\n  Args: %s\\n  Environment:\\n    %s\\n\\nTo remove this server, run: claude mcp remove "%s" -s user\\n' "$5" "$9" "\${10}" "$7" "$5" > "$D/$5" ;;
esac
`

/** \`claude mcp get\` output as Claude Code prints it. */
const mcpGet = (name: string, command: string, args: string, env: string[] = [], scope = 'User config (available in all your projects)') =>
  `${name}:\n  Scope: ${scope}\n  Status: ✔ Connected\n  Type: stdio\n  Command: ${command}\n  Args: ${args}\n  Environment:\n${env.map((e) => `    ${e}\n`).join('')}\nTo remove this server, run: claude mcp remove ${name} -s user\n`

async function sandbox(opts: { claude?: boolean; appDir?: string } = {}) {
  const base = await tmp('tracker setup-')
  const home = join(base, 'home')
  const stubs = join(base, 'stubs')
  await mkdir(home, { recursive: true })
  await mkdir(stubs)
  await writeFile(join(stubs, 'gh'), GH)
  await chmod(join(stubs, 'gh'), 0o755)
  if (opts.claude !== false) {
    await writeFile(join(stubs, 'claude'), CLAUDE)
    await chmod(join(stubs, 'claude'), 0o755)
  }
  const binary = join(base, opts.appDir ?? 'AI Task Tracking.app', 'Contents', 'Resources', 'aitt')
  await mkdir(join(binary, '..'), { recursive: true })
  await writeFile(binary, '#!/bin/sh\n')
  await chmod(binary, 0o755)
  const log = join(base, 'stub.log')
  await writeFile(log, '')
  const mcp = join(base, 'mcp')
  await mkdir(mcp)
  const env: Record<string, string> = { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, STUB_LOG: log, STUB_MCP_DIR: mcp, LANG: 'en_US.UTF-8', AITT_TEST_APP_SEARCH_DIRS: join(base, 'Applications') }
  const setup = async (args: string[], extraEnv: Record<string, string> = {}) => {
    const p = Bun.spawn([process.execPath, CLI, 'setup', ...args], { env: { ...env, ...extraEnv }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, out: out + err }
  }
  const calls = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean)
  return { base, home, data: join(home, 'AITaskTracking'), binary, mcp, setup, calls }
}

describe('aitt setup --yes (non-interactive)', () => {
  test('fresh folder: skeleton, first project with a derived key, PATH link, MCP, skill; no backup, no CLAUDE.md', async () => {
    const sb = await sandbox()
    const r = await sb.setup(['--yes', '--project', 'Platform Team', '--binary', sb.binary])
    expect(r.code).toBe(0)
    const c = await readConfig(sb.data)
    expect(c.nextNumber).toEqual({ PT: 1 })
    expect(c.port).toBe(7477)
    const p = await readProject(join(sb.data, 'projects', 'platform-team'))
    expect(p.name).toBe('Platform Team')
    expect(p.key).toBe('PT')
    expect(await exists(join(sb.data, SETUP_LOCK))).toBe(false)
    expect(await readlink(join(sb.home, '.local/bin/aitt'))).toBe(sb.binary)
    expect(r.out).toContain('export PATH="$HOME/.local/bin:$PATH"')
    expect(await readFile(join(sb.home, '.claude/skills/ai-task-tracking/SKILL.md'), 'utf8')).toBe(await readFile(REPO_SKILL, 'utf8'))
    expect(await exists(join(sb.home, '.claude/CLAUDE.md'))).toBe(false)
    expect(await sb.calls()).toEqual([
      'claude mcp get ai-task-tracking',
      `claude mcp add -s user ai-task-tracking -e AITT_HOME=${sb.data} -- ${sb.binary} mcp`,
    ])
    expect(await readFile(join(sb.home, '.claude/skills/ai-task-tracking/.shipped-sha256'), 'utf8')).toMatch(/^[0-9a-f]{64}\n$/)
    expect(await exists(join(sb.data, '.git'))).toBe(false)
  })

  test('--home picks the folder; re-running keeps an existing folder untouched and adds no second project', async () => {
    const sb = await sandbox()
    const data = join(sb.base, 'elsewhere')
    expect((await sb.setup(['--yes', '--home', data, '--project', 'Web', '--no-mcp', '--no-link'])).code).toBe(0)
    await writeFile(join(data, 'AGENTS.md'), 'my rules\n')
    const again = await sb.setup(['--yes', '--home', data, '--project', 'Other', '--no-mcp', '--no-link'])
    expect(again.code).toBe(0)
    expect(again.out).toContain('existing')
    expect(await readFile(join(data, 'AGENTS.md'), 'utf8')).toBe('my rules\n')
    expect((await readdir(join(data, 'projects'))).sort()).toEqual(['web'])
  })

  test('--backup owner/name: commits the folder and creates a private repo with gh; a second run sees origin and skips', async () => {
    const sb = await sandbox()
    const r = await sb.setup(['--yes', '--project', 'Web', '--backup', 'octo/tracker-data', '--no-mcp', '--no-link', '--no-skill'])
    expect(r.code).toBe(0)
    expect(await sb.calls()).toEqual([
      'gh auth status --hostname github.com',
      `gh repo create octo/tracker-data --private --source ${sb.data} --remote origin --push`,
    ])
    const log = Bun.spawnSync(['git', '-C', sb.data, 'log', '--format=%s'], { env: { PATH: '/usr/bin:/bin', HOME: sb.home } })
    expect(log.stdout.toString().trim()).toBe('aitt setup')
    const tracked = Bun.spawnSync(['git', '-C', sb.data, 'ls-files'], { env: { PATH: '/usr/bin:/bin', HOME: sb.home } }).stdout.toString()
    expect(tracked).toContain('config.yml')
    expect(tracked).not.toContain('.tracker/')
    const again = await sb.setup(['--yes', '--no-mcp', '--no-link', '--no-skill'])
    expect(again.out).toContain('Backup: https://github.com/octo/tracker-data.git')
    expect((await sb.calls()).filter((l) => l.startsWith('gh repo create'))).toHaveLength(1)
  })

  test('a token in the backup remote\'s URL never reaches the output', async () => {
    const sb = await sandbox()
    const flags = ['--yes', '--no-mcp', '--no-link', '--no-skill']
    expect((await sb.setup(flags)).code).toBe(0)
    const git = (...args: string[]) => Bun.spawnSync(['git', '-C', sb.data, ...args], { env: { PATH: '/usr/bin:/bin', HOME: sb.home } }).exitCode
    expect(git('init', '-q')).toBe(0)
    expect(git('remote', 'add', 'origin', 'https://someone:fake-token-123@example.invalid/octo/data.git')).toBe(0)
    const r = await sb.setup(flags)
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('fake-token-123')
    expect(r.out).toContain('Backup: https://***@example.invalid/octo/data.git')
  })

  test('--backup when gh is not signed in fails with the fix, and creates no repo', async () => {
    const sb = await sandbox()
    const r = await sb.setup(['--yes', '--backup', 'octo/data', '--no-mcp', '--no-link', '--no-skill'], { GH_AUTH_EXIT: '1' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('gh auth login')
    expect(await sb.calls()).toEqual(['gh auth status --hostname github.com'])
  })

  test('without claude on PATH: prints the manual MCP command, shell-quoted (paths with spaces), and succeeds', async () => {
    const sb = await sandbox({ claude: false, appDir: 'My Apps/AI Task Tracking.app' })
    const data = join(sb.base, 'My Data')
    const r = await sb.setup(['--yes', '--home', data, '--binary', sb.binary, '--no-link'])
    expect(r.code).toBe(0)
    expect(sb.binary).toContain(' ')
    expect(r.out).toContain(`claude mcp add -s user ai-task-tracking -e 'AITT_HOME=${data}' -- '${sb.binary}' mcp`)
  })

  test('--claude-md appends the line once, keeps what was there, backs up first, and edits a symlinked file at its target', async () => {
    const sb = await sandbox()
    const dotfiles = join(sb.base, 'dotfiles')
    await mkdir(dotfiles)
    await writeFile(join(dotfiles, 'CLAUDE.md'), '# Mine\n- rule one')
    await mkdir(join(sb.home, '.claude'), { recursive: true })
    await symlink(join(dotfiles, 'CLAUDE.md'), join(sb.home, '.claude/CLAUDE.md'))
    for (let i = 0; i < 2; i++) expect((await sb.setup(['--yes', '--claude-md', '--no-mcp', '--no-link'])).code).toBe(0)
    expect((await lstat(join(sb.home, '.claude/CLAUDE.md'))).isSymbolicLink()).toBe(true)
    const text = await readFile(join(dotfiles, 'CLAUDE.md'), 'utf8')
    expect(text.startsWith('# Mine\n- rule one\n')).toBe(true)
    expect(text.match(/Issue tracking: use AI Task Tracking/g)).toHaveLength(1)
    const baks = (await readdir(dotfiles)).filter((f) => f.startsWith('CLAUDE.md.bak-aitt-'))
    expect(baks).toHaveLength(1)
    expect(await readFile(join(dotfiles, baks[0]!), 'utf8')).toBe('# Mine\n- rule one')
  })

  test('skill: an edited installed copy is backed up before it is replaced; an untouched older copy is just updated', async () => {
    const sb = await sandbox()
    const dir = join(sb.home, '.claude/skills/ai-task-tracking')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), 'my edits\n')
    expect((await sb.setup(['--yes', '--no-mcp', '--no-link'])).code).toBe(0)
    const ours = await readFile(REPO_SKILL, 'utf8')
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe(ours)
    const baks = (await readdir(dir)).filter((f) => f.startsWith('SKILL.md.bak-aitt-'))
    expect(baks).toHaveLength(1)
    expect(await readFile(join(dir, baks[0]!), 'utf8')).toBe('my edits\n')
    // A previously shipped version (its hash is the marker) is replaced without a backup.
    const older = 'older shipped skill\n'
    await writeFile(join(dir, 'SKILL.md'), older)
    await writeFile(join(dir, '.shipped-sha256'), `${new Bun.CryptoHasher('sha256').update(older).digest('hex')}\n`)
    expect((await sb.setup(['--yes', '--no-mcp', '--no-link'])).code).toBe(0)
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe(ours)
    expect((await readdir(dir)).filter((f) => f.startsWith('SKILL.md.bak-aitt-'))).toHaveLength(1)
  })

  test('a non-empty folder that is not an AI Task Tracking folder is refused and left alone', async () => {
    const sb = await sandbox()
    const other = join(sb.base, 'docs')
    await mkdir(other)
    await writeFile(join(other, 'notes.txt'), 'x')
    const r = await sb.setup(['--yes', '--home', other, '--no-mcp', '--no-link', '--no-skill'])
    expect(r.code).toBe(1)
    expect(await readdir(other)).toEqual(['notes.txt'])
  })

  test('the link never replaces a regular file', async () => {
    const sb = await sandbox()
    await mkdir(join(sb.home, '.local/bin'), { recursive: true })
    await writeFile(join(sb.home, '.local/bin/aitt'), 'mine')
    expect((await sb.setup(['--yes', '--binary', sb.binary, '--no-mcp'])).code).toBe(0)
    expect(await readFile(join(sb.home, '.local/bin/aitt'), 'utf8')).toBe('mine')
  })

  test('the link replaces a symlink only when it dangles or points into an app bundle of ours', async () => {
    const sb = await sandbox()
    const link = join(sb.home, '.local/bin/aitt')
    await mkdir(join(sb.home, '.local/bin'), { recursive: true })
    const other = join(sb.base, 'other-tracker')
    await writeFile(other, '#!/bin/sh\n')
    await symlink(other, link)
    const kept = await sb.setup(['--yes', '--binary', sb.binary, '--no-mcp', '--no-skill'])
    expect(kept.code).toBe(0)
    expect(await readlink(link)).toBe(other)
    expect(kept.out).toContain("isn't this app; left alone")
    for (const to of [join(sb.base, 'gone', 'tracker'), join(sb.base, 'Old', 'AI Task Tracking.app', 'Contents', 'Resources', 'aitt')]) {
      if (to.includes('.app')) { await mkdir(join(to, '..'), { recursive: true }); await writeFile(to, '') }
      await rm(link)
      await symlink(to, link)
      expect((await sb.setup(['--yes', '--binary', sb.binary, '--no-mcp', '--no-skill'])).code).toBe(0)
      expect(await readlink(link)).toBe(sb.binary)
    }
  })

  test('an interrupted earlier setup (lock left on a set-up folder) is reported and cleared', async () => {
    const sb = await sandbox()
    expect((await sb.setup(['--yes', '--project', 'Web', '--no-mcp', '--no-link', '--no-skill'])).code).toBe(0)
    await mkdir(join(sb.data, '.tracker'), { recursive: true })
    await writeFile(join(sb.data, SETUP_LOCK), '999999\n')
    const r = await sb.setup(['--yes', '--no-mcp', '--no-link', '--no-skill'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('interrupted')
    expect(await exists(join(sb.data, SETUP_LOCK))).toBe(false)
  })
})

describe('setup: Claude Code MCP registration (ai-task-tracking)', () => {
  test('if the add fails nothing else changes and the exact command is printed', async () => {
    const sb = await sandbox()
    const r = await sb.setup(['--yes', '--binary', sb.binary, '--no-link', '--no-skill'], { CLAUDE_ADD_FAIL: '1' })
    expect(r.code).toBe(0)
    expect((await sb.calls()).filter((c) => c.includes('remove'))).toEqual([])
    expect(r.out).toContain(`claude mcp add -s user ai-task-tracking -e 'AITT_HOME=${sb.data}' -- '${sb.binary}' mcp`)
  })

  test('already registered with the same binary and folder: no re-add', async () => {
    const sb = await sandbox()
    await writeFile(join(sb.mcp, 'ai-task-tracking'), mcpGet('ai-task-tracking', sb.binary, 'mcp', [`AITT_HOME=${sb.data}`]))
    expect((await sb.setup(['--yes', '--binary', sb.binary, '--no-link', '--no-skill'])).code).toBe(0)
    expect((await sb.calls()).filter((c) => c.includes(' add '))).toEqual([])
  })

  test('re-running setup after registering does not add again', async () => {
    const sb = await sandbox()
    for (let i = 0; i < 2; i++) expect((await sb.setup(['--yes', '--binary', sb.binary, '--no-link', '--no-skill'])).code).toBe(0)
    expect((await sb.calls()).filter((c) => c.includes(' add '))).toHaveLength(1)
  })

  test("an ai-task-tracking entry that isn't this app is left alone", async () => {
    const sb = await sandbox()
    const foreign = mcpGet('ai-task-tracking', 'node', 'something.js')
    await writeFile(join(sb.mcp, 'ai-task-tracking'), foreign)
    const r = await sb.setup(['--yes', '--binary', sb.binary, '--no-link', '--no-skill'])
    expect(r.code).toBe(0)
    expect(await readFile(join(sb.mcp, 'ai-task-tracking'), 'utf8')).toBe(foreign)
    expect(r.out).toContain("isn't this app")
  })

  test('isOurMcp recognises the new binary name and AITT_HOME', () => {
    expect(isOurMcp(parseMcpGet(mcpGet('x', '/A/AI Task Tracking.app/Contents/Resources/aitt', 'mcp')))).toBe(true)
    expect(isOurMcp(parseMcpGet(mcpGet('x', '/opt/run', 'serve', ['AITT_HOME=/d'])))).toBe(true)
    expect(isOurMcp(parseMcpGet(mcpGet('x', '/opt/aittool', 'mcp')))).toBe(false)
  })

  test('default data folder: AITT_HOME, else ~/AITaskTracking', async () => {
    const sb = await sandbox()
    const a = join(sb.base, 'from-aitt')
    expect((await sb.setup(['--yes', '--no-mcp', '--no-link', '--no-skill'], { AITT_HOME: a })).code).toBe(0)
    expect(await exists(join(a, 'config.yml'))).toBe(true)
    expect((await sb.setup(['--yes', '--no-mcp', '--no-link', '--no-skill'])).code).toBe(0)
    expect(await exists(join(sb.home, 'AITaskTracking', 'config.yml'))).toBe(true)
  })

  test('parseMcpGet / isOurMcp on Claude Code output', () => {
    const app = '/Applications/AI Task Tracking.app/Contents/Resources/aitt'
    const e = parseMcpGet(mcpGet('ai-task-tracking', app, 'mcp', ['AITT_HOME=/x', 'OTHER=1']))
    expect(e).toEqual({ scope: 'user', command: app, args: 'mcp', env: ['AITT_HOME=/x', 'OTHER=1'] })
    expect(isOurMcp(e)).toBe(true)
    expect(isOurMcp(parseMcpGet(mcpGet('other-server', 'npx', '-y mcp-remote https://example.com/sse')))).toBe(false)
    expect(parseMcpGet(mcpGet('x', 'a', 'b', [], 'Project config (shared via .mcp.json)')).scope).toBe('project')
  })
})

describe('setup: interactive backup owner and prompts', () => {
  /** Answers by question pattern, each used once; anything else takes the default. */
  const scripted = (answers: [RegExp, string][], lines: string[]): SetupIO => ({
    interactive: true,
    log: (l) => lines.push(l),
    ask: async (q, def) => {
      const i = answers.findIndex(([re]) => re.test(q))
      if (i < 0) return def
      return answers.splice(i, 1)[0]![1]
    },
  })

  test("when gh can't tell the user, setup asks for the owner and re-asks for a valid owner/name", async () => {
    const sb = await sandbox()
    const lines: string[] = []
    const code = await runSetup({
      userHome: sb.home, project: 'Web', link: false, mcp: false, skill: false, claudeMd: false,
      env: { PATH: `${join(sb.base, 'stubs')}:/usr/bin:/bin`, STUB_LOG: join(sb.base, 'stub.log'), STUB_MCP_DIR: sb.mcp, GH_USER_FAIL: '1', HOME: sb.home },
    }, scripted([[/Back up/, 'y'], [/GitHub owner/, 'acme'], [/Repository/, 'not a repo'], [/Repository/, 'acme/data']], lines))
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('"not a repo" is not owner/name')
    expect((await sb.calls()).filter((c) => c.startsWith('gh repo create'))).toEqual([
      `gh repo create acme/data --private --source ${sb.data} --remote origin --push`,
    ])
  })

  test('Ctrl-C at a prompt runs the cleanup (no setup lock is left behind)', async () => {
    const sb = await sandbox()
    const io: SetupIO = {
      interactive: true, log: () => {},
      ask: async (q, def) => { if (/First project/.test(q)) throw new SetupInterrupted(); return def },
    }
    await expect(runSetup({ userHome: sb.home, env: { PATH: '/usr/bin:/bin' } }, io)).rejects.toBeInstanceOf(SetupInterrupted)
    expect(await exists(join(sb.data, 'config.yml'))).toBe(true)
    expect(await exists(join(sb.data, SETUP_LOCK))).toBe(false)
  })

  test('feedKeys: Enter, Ctrl-C, backspace; other control characters ignored', () => {
    expect(feedKeys('', 'ab\x1b[A\tc\r')).toEqual({ buf: 'ab[Ac', done: true, interrupted: false, echo: 'ab[Ac' })
    expect(feedKeys('abc', '\x7f\bd')).toMatchObject({ buf: 'ad', done: false })
    expect(feedKeys('', '\x7f')).toEqual({ buf: '', done: false, interrupted: false, echo: '' })
    expect(feedKeys('x', '\x03')).toMatchObject({ interrupted: true })
  })

  test('shellQuote', () => {
    expect(shellQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`)
  })
})

describe('parseSetupArgs', () => {
  test('flags for an installer', () => {
    expect(parseSetupArgs(['--yes', '--home', '/x', '--backup', 'me/repo', '--no-mcp'])).toEqual({
      yes: true, help: false, opts: { home: '/x', backup: 'me/repo', mcp: false },
    })
  })
  test('unknown or incomplete flags are errors', () => {
    expect(parseSetupArgs(['--frobnicate'])).toBe('unknown option --frobnicate')
    expect(parseSetupArgs(['--home'])).toBe('--home needs a value')
    expect(parseSetupArgs(['--backup', 'not a repo'])).toMatch(/owner\/name/)
  })
})

describe('setup: other agent tools (fake HOME; stub CLIs on PATH)', () => {
  test('--connect codex,cursor writes both configs in HOME; a second run reports them connected and writes nothing', async () => {
    const sb = await sandbox()
    const r = await sb.setup(['--yes', '--no-mcp', '--no-skill', '--connect', 'codex,cursor', '--binary', sb.binary])
    expect(r.code).toBe(0)
    const toml = Bun.TOML.parse(await readFile(join(sb.home, '.codex', 'config.toml'), 'utf8')) as any
    expect(toml.mcp_servers['ai-task-tracking']).toEqual({ command: sb.binary, args: ['mcp'], env: { AITT_HOME: sb.data } })
    expect(await readFile(join(sb.home, '.codex', 'AGENTS.md'), 'utf8')).toContain('## Issue tracking: AI Task Tracking')
    const cursor = JSON.parse(await readFile(join(sb.home, '.cursor', 'mcp.json'), 'utf8'))
    expect(cursor.mcpServers['ai-task-tracking'].command).toBe(sb.binary)
    expect(r.out).toContain('aitt guidance --cursor > .cursor/rules/ai-task-tracking.mdc')
    expect(r.out).toContain('~/.codex/config.toml')
    const again = await sb.setup(['--yes', '--no-mcp', '--no-skill', '--connect', 'codex,cursor', '--binary', sb.binary])
    expect(again.out).toMatch(/codex\s+~\/\.codex\/config\.toml\s+connected/)
    expect(again.out).toContain('Codex CLI: already connected')
    expect((await readdir(join(sb.home, '.codex'))).filter((f) => f.includes('.bak-aitt-'))).toEqual([])
  })

  test('--yes connects every detected tool (here: a codex CLI on PATH) and nothing else', async () => {
    const sb = await sandbox()
    await writeFile(join(sb.base, 'stubs', 'codex'), '#!/bin/sh\n')
    await chmod(join(sb.base, 'stubs', 'codex'), 0o755)
    const r = await sb.setup(['--yes', '--no-mcp', '--no-skill', '--binary', sb.binary])
    expect(r.code).toBe(0)
    expect(await exists(join(sb.home, '.codex', 'config.toml'))).toBe(true)
    expect(await exists(join(sb.home, '.cursor'))).toBe(false)
    expect(await exists(join(sb.home, '.gemini'))).toBe(false)
  })

  test('nothing detected and no --connect: no client config is touched, no section printed', async () => {
    const sb = await sandbox()
    const r = await sb.setup(['--yes', '--no-mcp', '--no-skill', '--binary', sb.binary])
    expect(r.out).not.toContain('Other agent tools')
    expect(await exists(join(sb.home, '.codex'))).toBe(false)
  })

  test('one client failing is reported; the others, the skill and CLAUDE.md still run; exit 1 at the end', async () => {
    const sb = await sandbox()
    await mkdir(join(sb.home, '.cursor', 'mcp.json'), { recursive: true }) // a folder where the file should be
    const r = await sb.setup(['--yes', '--no-mcp', '--claude-md', '--connect', 'cursor,codex', '--binary', sb.binary])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/✗ Cursor: could not connect: .*EISDIR|✗ Cursor: could not connect/)
    expect(await exists(join(sb.home, '.codex', 'config.toml'))).toBe(true)
    expect(await exists(join(sb.home, '.claude', 'skills', 'ai-task-tracking', 'SKILL.md'))).toBe(true)
    expect(await readFile(join(sb.home, '.claude', 'CLAUDE.md'), 'utf8')).toContain('Issue tracking: use AI Task Tracking')
    expect(r.out).toContain('Some agent tools could not be connected')
  })

  test('ChatGPT desktop (detected by its Application Support folder) shares the Codex file: written once, one line says so', async () => {
    const sb = await sandbox()
    await mkdir(join(sb.home, 'Library', 'Application Support', 'com.openai.chat'), { recursive: true })
    await mkdir(join(sb.home, '.codex'), { recursive: true })
    await writeFile(join(sb.home, '.codex', 'config.toml'), 'model = "m"\n')
    const r = await sb.setup(['--yes', '--no-mcp', '--no-skill', '--connect', 'codex,chatgpt', '--binary', sb.binary])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/✓ chatgpt\s+~\/\.codex\/config\.toml/)
    expect(r.out).toContain('ChatGPT desktop shares ~/.codex/config.toml with Codex CLI')
    expect(r.out.match(/connected \(~\/\.codex\/config\.toml/g)).toHaveLength(1)
    expect((await readdir(join(sb.home, '.codex'))).filter((f) => f.startsWith('config.toml.bak-aitt-'))).toHaveLength(1)
    const toml = await readFile(join(sb.home, '.codex', 'config.toml'), 'utf8')
    expect(toml.match(/^\[mcp_servers\.ai-task-tracking\]/gm)).toHaveLength(1)
    const yes = await sb.setup(['--yes', '--no-mcp', '--no-skill', '--binary', sb.binary]) // detected: chatgpt only
    expect(yes.out).toContain('ChatGPT desktop: already connected')
  })

  test('with $CODEX_HOME set elsewhere, --connect codex,chatgpt writes both files, each once', async () => {
    const sb = await sandbox()
    const codexHome = join(sb.base, 'codex-home')
    const r = await sb.setup(['--yes', '--no-mcp', '--no-skill', '--connect', 'codex,chatgpt', '--binary', sb.binary], { CODEX_HOME: codexHome })
    expect(r.code).toBe(0)
    for (const f of [join(codexHome, 'config.toml'), join(sb.home, '.codex', 'config.toml')]) {
      expect((await readFile(f, 'utf8')).match(/^\[mcp_servers\.ai-task-tracking\]/gm)).toHaveLength(1)
    }
    expect(r.out).toContain('Codex CLI: connected')
    expect(r.out).toContain('ChatGPT desktop: connected')
    expect(r.out).not.toContain('shares')
  })

  test('--connect validates tool names; --no-connect turns the step off', () => {
    expect(parseSetupArgs(['--connect', 'codex,emacs'])).toBe('--connect: unknown tool emacs (tools: codex, chatgpt, cursor, vscode, windsurf, gemini, claude-desktop)')
    expect(parseSetupArgs(['--connect', 'gemini, vscode'])).toEqual({ yes: false, help: false, opts: { connect: ['gemini', 'vscode'] } })
    expect(parseSetupArgs(['--no-connect'])).toEqual({ yes: false, help: false, opts: { connect: false } })
  })
})

describe('setup keeps file permissions (CLAUDE.md and the skill)', () => {
  const mode = async (p: string) => (await stat(p)).mode & 0o777
  test('a 0600 CLAUDE.md stays 0600 after the line is added; its backup is 0600', async () => {
    const sb = await sandbox()
    const md = join(sb.home, '.claude', 'CLAUDE.md')
    await mkdir(join(md, '..'), { recursive: true })
    await writeFile(md, '# mine\n')
    await chmod(md, 0o600)
    expect((await sb.setup(['--yes', '--no-mcp', '--no-link', '--no-skill', '--claude-md'])).code).toBe(0)
    expect(await readFile(md, 'utf8')).toContain('Issue tracking: use AI Task Tracking')
    expect(await mode(md)).toBe(0o600)
    const baks = (await readdir(join(md, '..'))).filter((f) => f.startsWith('CLAUDE.md.bak-aitt-'))
    expect(baks).toHaveLength(1)
    expect(await mode(join(md, '..', baks[0]!))).toBe(0o600)
  })
  test('a symlinked CLAUDE.md (relative link into a dotfiles folder): written through, link kept, target mode kept', async () => {
    const sb = await sandbox()
    const dot = join(sb.home, 'dotfiles', 'claude')
    await mkdir(dot, { recursive: true })
    await writeFile(join(dot, 'CLAUDE.md'), '# mine\n')
    await chmod(join(dot, 'CLAUDE.md'), 0o640)
    await mkdir(join(sb.home, '.claude'), { recursive: true })
    const md = join(sb.home, '.claude', 'CLAUDE.md')
    await symlink('../dotfiles/claude/CLAUDE.md', md)
    expect((await sb.setup(['--yes', '--no-mcp', '--no-link', '--no-skill', '--claude-md'])).code).toBe(0)
    expect((await lstat(md)).isSymbolicLink()).toBe(true)
    expect(await readlink(md)).toBe('../dotfiles/claude/CLAUDE.md')
    expect(await readFile(join(dot, 'CLAUDE.md'), 'utf8')).toBe('# mine\n\nIssue tracking: use AI Task Tracking (its MCP tools; see the `ai-task-tracking` skill). Track every piece of work as an issue; the rules arrive with the MCP server.\n')
    expect(await mode(join(dot, 'CLAUDE.md'))).toBe(0o640)
    expect((await readdir(join(sb.home, '.claude'))).filter((f) => f.includes('.bak-aitt-'))).toEqual([])
  })
  test('a CLAUDE.md link to a missing file is left alone (no file appears in place of the link)', async () => {
    const sb = await sandbox()
    await mkdir(join(sb.home, '.claude'), { recursive: true })
    const md = join(sb.home, '.claude', 'CLAUDE.md')
    const gone = join(sb.base, 'unmounted', 'CLAUDE.md')
    await symlink(gone, md)
    const r = await sb.setup(['--yes', '--no-mcp', '--no-link', '--no-skill', '--claude-md'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('the linked file is missing')
    expect((await lstat(md)).isSymbolicLink()).toBe(true)
    expect(await readlink(md)).toBe(gone)
    expect(await exists(gone)).toBe(false)
  })
  test('an edited 0600 skill: the replacement and the backup are 0600', async () => {
    const sb = await sandbox()
    const dir = join(sb.home, '.claude/skills/ai-task-tracking')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), 'my edits\n')
    await chmod(join(dir, 'SKILL.md'), 0o600)
    expect((await sb.setup(['--yes', '--no-mcp', '--no-link'])).code).toBe(0)
    expect(await mode(join(dir, 'SKILL.md'))).toBe(0o600)
    const baks = (await readdir(dir)).filter((f) => f.startsWith('SKILL.md.bak-aitt-'))
    expect(await mode(join(dir, baks[0]!))).toBe(0o600)
  })
})
