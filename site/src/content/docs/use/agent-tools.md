---
title: Using with agent tools
description: What setup gives Claude Code, and how Codex (also inside ChatGPT desktop), Cursor, VS Code, Windsurf, Gemini CLI and Claude Desktop connect.
sidebar:
  order: 2
---

## Claude Code

Setup gives Claude Code three things:

- the **MCP server** `ai-task-tracking` (tools `mcp__ai-task-tracking__save_issue`, `whats_next`, `get_tree`, …),
  registered at user scope; `claude mcp get ai-task-tracking` shows it;
- the **`ai-task-tracking` skill**, which teaches the workflow (orient, search before creating, epics with steps,
  hand back, finish with a comment);
- the **rules**: the data folder's `AGENTS.md`, which the MCP server sends as its instructions when a session
  starts. Edit it to change what every agent is told (labels, projects, conventions).

:::caution[Restart sessions after setup]
Exit and run `claude` again: a session only loads MCP servers when it starts.
:::

Then ask, for example, "what's next?" or "plan this as an epic with steps". More detail:
[Agent sessions](/docs/guides/agent-sessions/) and [Agent rules](/docs/guides/agent-rules/).

## These docs, for agents

The app serves these docs as plain text too, for an agent to read in one go:

| URL | What |
|---|---|
| `http://127.0.0.1:7477/docs/llms.txt` | the index ([llms.txt](https://llmstxt.org/) format), linking the two below |
| `http://127.0.0.1:7477/docs/llms-full.txt` | every page |
| `http://127.0.0.1:7477/docs/llms-small.txt` | every page, trimmed for small context windows |

Use your own port if you changed `port:` in `config.yml`. For example: "read
`http://127.0.0.1:7477/docs/llms-full.txt` and set up Cursor for AI Task Tracking".

## Other agent tools

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
the model, which is why setup also writes the guidance where a tool has a global instructions file; config files
with comments (JSONC) are left alone (add the entry by hand). Details, official docs links, how the repo of each
write is worked out, and the other limits: [Other agent tools](/docs/guides/other-agent-tools/).
