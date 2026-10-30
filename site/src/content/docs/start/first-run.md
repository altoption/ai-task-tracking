---
title: First run
description: What aitt setup does, step by step, and its flags.
sidebar:
  order: 2
---

The installer runs `aitt setup` for you; run it again any time to change something (it is safe to re-run). It walks
through:

1. **Data folder**: default `~/AITaskTracking`. An existing folder is kept as it is.
2. **First project**, e.g. your team's name.
3. **Backup** to a new private GitHub repo (optional). See [Backup](/docs/use/backup/).
4. **`aitt` on your PATH** (`~/.local/bin/aitt`). If `~/.local/bin` isn't on your PATH, setup prints the line to
   add to `~/.zshrc`.
5. **Claude Code**: registers the `ai-task-tracking` MCP server at user scope (every repo gets it).
6. **Other agent tools** it finds: see [Using with agent tools](/docs/use/agent-tools/#other-agent-tools).
7. **Agent skill** in `~/.claude/skills/ai-task-tracking`, and optionally one line in `~/.claude/CLAUDE.md`.

On a terminal it asks; with `--yes` (or without a terminal) every question takes its default.

## Flags

Every step has a flag. `aitt setup --help` prints this list:

| Flag | |
|---|---|
| `--yes`, `-y` | no questions (defaults: no backup, no `CLAUDE.md` line) |
| `--home <dir>` | data folder (default: `$AITT_HOME` or `~/AITaskTracking`) |
| `--project <name>` | first project, e.g. your team (only when the folder has no projects) |
| `--backup <owner/name>` | back up to a new private GitHub repo (needs `gh`); `--no-backup` to skip |
| `--no-link` | don't link `~/.local/bin/aitt` to the app's binary |
| `--no-mcp` | don't register the `ai-task-tracking` MCP server with Claude Code |
| `--no-skill` | don't install the agent skill into `~/.claude/skills/ai-task-tracking` |
| `--connect <tools>` | connect other agent tools, comma-separated: `codex`, `chatgpt`, `cursor`, `vscode`, `windsurf`, `gemini`, `claude-desktop` (default: every detected one); `--no-connect` to skip |
| `--claude-md` | add the AI Task Tracking line to `~/.claude/CLAUDE.md`; `--no-claude-md` to skip |
| `--binary <path>` | `aitt` binary to register (default: this one, when it is the app's) |

After setup, **restart your agent sessions**: a session only loads MCP servers when it starts. Then see
[Daily use](/docs/use/daily-use/).
