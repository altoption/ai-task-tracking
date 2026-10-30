---
title: Other agent tools
description: Official docs per tool, where the instructions come from, how a write's repo is worked out, and known limits.
sidebar:
  order: 3
---

The summary and the per-tool table are in [Using with agent tools](/docs/use/agent-tools/#other-agent-tools). This page
has the details.

## Official docs per tool

| Tool | Config location and format | Instructions file |
|---|---|---|
| Claude Code | `claude mcp --help` | skill: `~/.claude/skills/ai-task-tracking` |
| Codex CLI | [MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) | [AGENTS.md](https://developers.openai.com/codex/guides/agents-md) |
| ChatGPT desktop (Work only; plain chats don't get the tools) | Always `~/.codex/config.toml` (the app doesn't see `$CODEX_HOME`); by hand: Settings → Plugins → MCPs → Add (STDIO: command, args `mcp`, env `AITT_HOME`, optional working directory = default project) | Codex's `AGENTS.md` |
| Cursor | [MCP](https://cursor.com/docs/context/mcp) | [rules](https://cursor.com/docs/context/rules) |
| VS Code (Copilot agent mode) | [MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration), [profiles](https://code.visualstudio.com/docs/configure/profiles) | `.github/copilot-instructions.md` per repo |
| Windsurf | [MCP](https://docs.windsurf.com/windsurf/cascade/mcp) | Windsurf rules |
| Gemini CLI | [MCP](https://geminicli.com/docs/tools/mcp-server/) | [GEMINI.md](https://geminicli.com/docs/cli/gemini-md/) |
| Claude Desktop | [connect local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers) | a Claude project's instructions |

## One source for the instructions

The instructions for every tool are generated from one text: the workflow section of
`skills/ai-task-tracking/SKILL.md` (between the `aitt:guidance` markers). `aitt guidance` prints it;
`aitt guidance --cursor` prints it as a Cursor rule file. The blocks setup writes into `AGENTS.md` and
`GEMINI.md` are the same text, and re-running setup refreshes them. Don't edit a copy; edit the skill.

## Which repo a write belongs to

Each write records the agent's workspace (repo), branch and tool. The server works it out in this order:

1. Its working folder, when that is a project. Command-line tools such as Claude Code start servers in the
   folder you run them in.
2. Otherwise (desktop apps start servers in `/` or your home folder): the first folder the tool shares as an
   MCP root that names a folder (`file:///` doesn't) (`roots/list`; Cursor's docs list roots support).
3. Otherwise `AITT_WORKSPACE`: a folder path or a workspace name, set in the server's `env` in that tool's config.
   Names from roots and `AITT_WORKSPACE` are reduced to their last path segment without control characters.
4. Otherwise the working folder's name (empty when the server runs in `/`).

The tool (`claude-code`, `codex`, `cursor`, `vscode`, `windsurf`, `gemini`, `claude-desktop`) is found from
the server's parent processes and recorded as `client` in the issue's `touched_by`. For an unknown tool,
moving an issue to Done, Waiting, Canceled or Duplicate needs a `comment` in the same call (a recent
`save_comment` doesn't count, because the session can't be identified).

## Known limits

- ChatGPT desktop runs MCP servers only through its bundled Codex agent
  (`/Applications/ChatGPT.app/Contents/Resources/codex-cli/…/codex`), so its writes are recorded as client `codex`.
  Regular ChatGPT chats don't get these tools; ChatGPT says "tools aren't exposed in this session". Switch ChatGPT to
  **Work** and use the tracker there, not in a plain chat.
- Claude Code shows the server's MCP instructions to the model. Other tools may not; that's why setup also
  writes the instructions file where the tool has a global one.
- Windsurf's docs site now redirects to Devin's docs, which describe `~/.config/devin/mcp_config.json` for
  the Devin desktop app. Setup writes `~/.codeium/windsurf/mcp_config.json`, the path Windsurf has used (confirmed
  only by third-party guides); if the server doesn't appear, open **Cascade ▸ Manage MCPs ▸ View raw config** to see
  which file Windsurf reads.
- The Gemini CLI docs note that the CLI was replaced by Antigravity CLI for unpaid and Google One users
  (2026-06-18). Setup only configures the Gemini CLI.
- VS Code's guided flow offers a portable `~/.copilot/mcp-config.json`; setup writes the VS Code user profile
  file, which the docs still list. A non-default VS Code profile has its own `mcp.json` under `User/profiles/`.
- A config file that is a symlink to a missing file (say, a dotfiles repo on an unmounted volume) is skipped;
  setup never replaces the link. A symlink to an existing file is edited at its target, keeping its permissions.
- JSON is rewritten with the file's own indent (tabs or spaces). Integers too large for JavaScript would lose
  precision on a rewrite; no MCP config is known to hold one.
- Config files with comments (JSONC) are not edited; setup says so and leaves them alone. Add the entry
  by hand (copy it from a tool setup did write, or from the [per-tool table](/docs/use/agent-tools/#other-agent-tools)).

## Opening issues from links

Tool results carry `url` (the browser link) and `appUrl` (`aitt://issue/ATT-1`). Agents print issues as
`[ATT-1 Title](http://127.0.0.1:7477/#/issue/ATT-1) · aitt://issue/ATT-1`. From a terminal,
`aitt open ATT-1` (or a project slug, or either link) shows it in the app, or in the browser when the app
isn't installed.
