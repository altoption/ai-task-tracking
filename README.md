# AI Task Tracking

AI Task Tracking is a local issue tracker for working with AI agents on a Mac. It runs as a menu-bar app with
a window of Home, lists, boards and projects, and agents reach it through an MCP server named
`ai-task-tracking`: Claude Code, Codex CLI, Cursor, VS Code, Windsurf, Gemini CLI and Claude Desktop. Agents file
issues, plan epics with steps, comment as they work and hand decisions back to you; Home shows what needs you
and what your agents got done, one card per agent session with its tool, repo and branch. Everything is plain Markdown and
YAML files in a folder on your Mac (a git repo), optionally backed up to a private GitHub repo.

![Home in AI Task Tracking, a daily overview: the requests that need you and how long they have waited, what's in progress and ready next, and Agent activity: today's counts, the live session and what finished](site/src/assets/screenshots/home.png)

## Requirements

| | |
|---|---|
| macOS | 13 (Ventura) or later, Apple Silicon or Intel |
| To build from source | Xcode Command Line Tools and Bun 1.4 or later. Only needed when no release is available, it fails verification, or with `--from-source`. The installer shows what's missing; it starts the Command Line Tools install and installs Bun from bun.sh (asking first unless `--yes`). The build includes these docs (their packages are downloaded too); if the docs fail to build, the installer warns and installs the app without them. |
| Backup (optional) | `gh` signed in to the GitHub account that will own the private backup repo |

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/altoption/ai-task-tracking/HEAD/install.sh | bash
```

The installer checks this Mac, shows what it will do and asks once. It installs the latest notarized release into
`~/Applications` (it checks the download's `.sha256`, the signature and the notarization first, and builds from
source if any check fails or there is no release), links `~/.local/bin/aitt`, runs `aitt setup` and opens the app.
The new app is prepared next to the old one and swapped in only when it is complete, so a failed download or build
leaves the installed app as it was. From a clone, run `./install.sh`.

Options go after `bash -s --` when the script is piped, e.g. `… | bash -s -- --yes`:

| Option | |
|---|---|
| `--yes`, `-y` | no questions; take the defaults |
| `--dry-run` | only show what was found and what would happen |
| `--from-source` | build from source even when a release is available |
| `--version <tag>` | that release (or source tag) instead of the latest, e.g. `v0.2.0` |
| `--no-launch` | don't open the app at the end |
| `--connect <tools>` | connect these other agent tools, comma-separated (as in `aitt setup --connect`) |
| `--help` | the options and environment (also works piped: `… \| bash -s -- --help`) |

Environment: `AITT_HOME=<dir>` sets the data folder. `AITT_APP_DIR=<dir>` installs somewhere other than
`~/Applications`; any folder other than `~/Applications` or `/Applications` is a *scratch install*: it isn't
registered with macOS, writes no app settings, and gets no Claude Code entry, no `aitt` link and no other agent
tools unless `--connect` names them.

## First run

The installer runs `aitt setup` for you; run it again any time to change something (it is safe to re-run). It walks
through:

1. **Data folder**: default `~/AITaskTracking`. An existing folder is kept as it is.
2. **First project**, e.g. your team's name.
3. **Backup** to a new private GitHub repo (optional).
4. **`aitt` on your PATH** (`~/.local/bin/aitt`). If `~/.local/bin` isn't on your PATH, setup prints the line to
   add to `~/.zshrc`.
5. **Claude Code**: registers the `ai-task-tracking` MCP server at user scope (every repo gets it).
6. **Other agent tools** it finds: see [Use with other agent tools](#use-with-other-agent-tools).
7. **Agent skill** in `~/.claude/skills/ai-task-tracking`, and optionally one line in `~/.claude/CLAUDE.md`.

Every step has a flag (`aitt setup --help`): `--home <dir>`, `--project <name>`, `--backup <owner/name>` /
`--no-backup`, `--no-link`, `--no-mcp`, `--no-skill`, `--connect codex,cursor` / `--no-connect`,
`--claude-md` / `--no-claude-md`, `--binary <path>`, `--yes`. All flags:
[the CLI reference](site/src/content/docs/reference/cli.md).

## Daily use

- **Menu bar.** The AI Task Tracking icon: Open AI Task Tracking, New Issue, Quick Capture…, the engine and backup
  status, Back Up Now, Settings… (⌘,), Help, Launch at Login, Quit. It also lists the issues that need you (Settings can hide them).
- **Dock.** The app also shows in the Dock and the app switcher (Settings ▸ Show in the Dock, on by default).
  Clicking the Dock icon with no window open opens the window.
- **Shortcuts (system-wide).** ⌥⌘I opens the window (or ⌃⌥⌘I, ⌥⌘T); ⌥⌘N opens Quick Capture (or ⌃⌥⌘N, ⌥⇧⌘N).
  Pick one or turn them off in Settings.
- **In the window.** **Home** is a daily overview: today's summary, then *Needs you* first (issues waiting for your
  decision or review, each with what it asks and how long it has waited; work that has stalled: idle in In Progress
  for a day, or reopened again and again, tuned under `stalled:` in `config.yml`; and work whose linked PR's checks
  fail), *In progress*, *Ready next* with *Blocked work* as dependency chains, and Agent activity beside them (today's
  counts, the live session and what it is working on, what finished, and Session details with a card per agent
  session; see [Home](site/src/content/docs/use/daily-use.md#in-the-window)). All issues, projects and saved views are
  in the sidebar, as lists or boards. Keys: `c` new issue, `/` or ⌘K search, `g h` Home, `g i` all issues, ⌘[ / ⌘] back and
  forward (also the ← → buttons at the top of the sidebar, beside ⌂ Home), ⌘\ collapses the sidebar to icons and
  back.
- **CI status.** Issues that link a GitHub PR show its state and checks (fetched in the background with your `gh`):
  a badge on the issue page, a dot on rows, and failing checks in Needs you. Without `gh` nothing shows.
- **Themes.** Graphite (the default), Dark, Light, Match macOS, Midnight, Plum, Paper and High contrast, or your own theme file
  (`themes/<name>.yml` in the data folder). Pick one in Settings ▸ Theme or with ⌘K ▸ "Theme: …"; the browser and the
  app window switch together. See [Themes](site/src/content/docs/guides/themes.md).
- **Hidden projects.** Hide a project you don't want to see (Settings ▸ Hidden projects, or Hide project on its page):
  it leaves the sidebar, lists, Home, search, the board and the menu bar. Its links still open it, with Unhide, and
  agents see no change. See [Hidden projects](site/src/content/docs/use/daily-use.md#hidden-projects).
- **Attempts and handoff.** The issue page counts the agent sessions that worked on an issue ("3 attempts · 2
  tools"); when an agent opens In Progress work, `get_issue` leads with where the last session stopped.
- **Settings** (⌘,): launch at login; show in the Dock; show Needs-you issues in the menu; show stalled work in
  Needs you (the menu-bar number, menu and notifications); show CI status; the theme; hidden projects; notify me about agent activity, and for which events: an agent needs you, finishes an issue, or creates one (off by default); the two
  shortcuts; back up to GitHub before quitting. Every setting and its default:
  [the Settings reference](site/src/content/docs/reference/settings.md).
- **Docs.** The app serves these docs at `http://127.0.0.1:7477/docs/`: Docs in the sidebar, Help in the menus
  (⌘?), or `aitt docs` from a terminal.
- **Links.** Agents print issues as `[ATT-1 Title](http://127.0.0.1:7477/#/issue/ATT-1) · aitt://issue/ATT-1`.
  The `aitt://` link opens the app; from a terminal, `aitt open ATT-1` (or a project slug, or either link) does the
  same, falling back to the browser when the app isn't installed.

## Using with Claude Code

Setup gives Claude Code three things:

- the **MCP server** `ai-task-tracking` (tools `mcp__ai-task-tracking__save_issue`, `whats_next`, `get_tree`, …),
  registered at user scope; `claude mcp get ai-task-tracking` shows it;
- the **`ai-task-tracking` skill**, which teaches the workflow (orient, search before creating, epics with steps,
  hand back, finish with a comment);
- the **rules**: the data folder's `AGENTS.md`, which the MCP server sends as its instructions when a session
  starts. Edit it to change what every agent is told (labels, projects, conventions).

**Restart Claude Code sessions after setup** (exit and run `claude` again): a session only loads MCP servers when it
starts. Then ask, for example, "what's next?" or "plan this as an epic with steps". More detail:
[docs/setup/agent-usage.md](docs/setup/agent-usage.md).

## Use with other agent tools

AI Task Tracking is an MCP server, so any MCP-capable agent tool on the Mac can use it. `aitt setup` finds the tools
you have and offers to connect them; `aitt setup --connect codex,cursor` does it without questions (tool names:
`codex`, `chatgpt`, `cursor`, `vscode`, `windsurf`, `gemini`, `claude-desktop`). Every tool gets the same server, named
`ai-task-tracking`, running `<app>/Contents/Resources/aitt mcp` with `AITT_HOME` set to your data folder.

Setup edits each config file carefully: other servers and settings stay as they are, the file is backed up first
(`<file>.bak-aitt-<timestamp>`), running setup again changes nothing, and an `ai-task-tracking` entry that isn't this
app is left alone. Updating an existing entry of this app's sets only `command`, `args` (and `type` where the tool
requires it) and `env.AITT_HOME`; any other key or env var you added (`enabled`, `cwd`, …) stays where it is.
Uninstalling removes only what setup added (our whole entry).

| Tool | Config file setup writes | Server entry | Agent instructions |
|---|---|---|---|
| Claude Code | `claude mcp add -s user` | `ai-task-tracking` | The `ai-task-tracking` skill and the server's MCP instructions |
| Codex CLI | `~/.codex/config.toml` (`$CODEX_HOME` if set) | `[mcp_servers.ai-task-tracking]` | A marked block in `~/.codex/AGENTS.md` |
| ChatGPT desktop (Work only) | `~/.codex/config.toml`, never `$CODEX_HOME` | `[mcp_servers.ai-task-tracking]` | The Codex block in `~/.codex/AGENTS.md` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` (`type: "stdio"`) | Per repo: `aitt guidance --cursor > .cursor/rules/ai-task-tracking.mdc` |
| VS Code (Copilot agent mode) | `~/Library/Application Support/Code/User/mcp.json` | `servers` (`type: "stdio"`) | Per repo: add `aitt guidance` to `.github/copilot-instructions.md` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | Add `aitt guidance` to your Windsurf rules |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` | A marked block in `~/.gemini/GEMINI.md` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers` | Add `aitt guidance` to a Claude project's instructions |

ChatGPT desktop runs MCP servers only through its bundled Codex agent
(`ChatGPT.app/Contents/Resources/codex-cli/…/codex`), and its writes are recorded as client `codex`. Regular ChatGPT
chats don't get these tools (ChatGPT says "tools aren't exposed in this session"): switch ChatGPT to
**Work** and use the tracker there, not in a plain chat. That agent reads `~/.codex/config.toml`, always that path, because the app
doesn't see a shell's `$CODEX_HOME`. Setup detects the app (`/Applications/ChatGPT.app` or
`~/Library/Application Support/com.openai.chat`) and writes that file once, together with Codex when they share it;
with `$CODEX_HOME` set elsewhere, `--connect codex,chatgpt` writes both files. To add it by hand instead: Settings →
Plugins → MCPs → Add, STDIO, with command `<app>/Contents/Resources/aitt`, args `mcp`, env `AITT_HOME` set to your
data folder, and optionally a working directory, which sets the default project.

Restart a tool after connecting it. Known limits: only Claude Code is known to show the server's MCP instructions to
the model, which is why setup also writes the guidance where a tool has a global instructions file; config files with
comments (JSONC) are left alone (add the entry by hand). Details, official docs links, how the repo of each write is
worked out, and the other limits: [docs/setup/other-agent-tools.md](docs/setup/other-agent-tools.md).

## Backup

The data folder is a git repo. The app commits every change a couple of seconds after it happens. With a backup
repo (setup step 3, or `aitt setup --backup <owner/name>`), it also pushes five minutes after the last change, on Back Up Now, and
before quitting (Settings ▸ Back up to GitHub before quitting). The menu shows the backup status (backed up, changes waiting, or a problem).

To restore on another Mac: clone the backup repo, then install with the clone as the data folder:
`git clone <backup repo> ~/AITaskTracking`, then run the installer with `AITT_HOME=~/AITaskTracking`.

## Bringing issues over from another tool

There is no built-in importer. Instead, your own AI agent moves the issues: export them from the old tool (CSV,
JSON, an API, or that tool's MCP server) and ask the agent to bring them over. The
[Data model and importing](site/src/content/docs/use/data-model.md) guide tells it everything it needs: the folder
layout, the issue file format, `config.yml`, and the safe way to import (`save_issues` in batches while the app runs,
or writing the files directly with the app stopped). Point the agent at that page, or at the repo's `AGENTS.md`,
which links it.

## Upgrade

Run the install command again. It quits the app, replaces it and runs setup; your data folder and settings stay.
`--version <tag>` installs a specific release. Restart agent sessions afterwards.

## Uninstall

```sh
curl -fsSL https://raw.githubusercontent.com/altoption/ai-task-tracking/HEAD/uninstall.sh | bash
```

Add `bash -s -- --yes` instead of `bash` to skip the question; from a clone, `./uninstall.sh [--yes]`; or run
`aitt uninstall [--yes]` directly. It quits the app, then removes the app, its login item, and the MCP entries
(Claude Code and the other agent tools) and `~/.local/bin/aitt` link that run *this* app. The agent skill and the
`CLAUDE.md` line go too, unless another install of AI Task Tracking stays registered. `AITT_APP_DIR=<dir>` picks an
app installed elsewhere. **Your data folder is kept**; the output says where it is so you can delete it yourself.

## Troubleshooting

| Problem | Fix |
|---|---|
| Menu shows "Another engine is using port 7477" | Another copy of the engine (e.g. a terminal `aitt serve`) holds the port. Stop it, or set a different `port:` in the data folder's `config.yml` and restart the app. |
| A tool says "AI Task Tracking isn't running" | Open the app from the menu bar, Launchpad or `open -a "AI Task Tracking"`. Settings ▸ Launch at login keeps it running. |
| No `ai-task-tracking` tools in a Claude Code session | Restart the session. `claude mcp get ai-task-tracking` shows the entry; a project-scope entry with the same name hides the user-scope one. Run `aitt setup` if it's missing. |
| Installer: "Could not download scripts/lib.sh" | The installer couldn't reach GitHub. Check that `curl -fsSI https://raw.githubusercontent.com/altoption/ai-task-tracking/HEAD/install.sh` works (a proxy or firewall may block it), then run it again. |
| Backup fails | `gh auth status`; the backup repo must exist and your account must be able to push to it. Back Up Now retries. |
| Gatekeeper rejects the app | The installer checks the release's `.sha256`, `codesign` and `spctl` before installing and builds from source if any check fails. If a downloaded copy is blocked, run the installer again rather than opening the zip by hand. |
| `aitt: command not found` | Add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` and open a new terminal. |

## Where your data lives

- **Data folder** (default `~/AITaskTracking`):
  `config.yml` (port, statuses, which statuses and labels count as *Needs you* under `needsYou:`, when work counts
  as stalled under `stalled:`, repo → project mapping under `workspaces:`), `labels.yml`, `AGENTS.md` (the rules
  agents get), `projects/<slug>/project.md` and `projects/<slug>/issues/*.md`, `views/`, `themes/` (your own themes). Plain text, a git
  repo; you can read and edit it with any editor, and the app picks up changes. The file format:
  [Data model and importing](site/src/content/docs/use/data-model.md).
- **App**: `~/Applications/AI Task Tracking.app`; the CLI is `~/.local/bin/aitt`, a link into it.
- **App settings**: `defaults read io.github.altoption.ai-task-tracking`.
- **Agent configs**: the files in the table above, plus `~/.claude/skills/ai-task-tracking`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/setup/development.md](docs/setup/development.md).

## License

[MIT](LICENSE) © 2026 Nick Tulip
