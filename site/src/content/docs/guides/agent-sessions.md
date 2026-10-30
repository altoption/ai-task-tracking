---
title: Agent sessions
description: How an agent session connects, which repo its writes belong to, and how to start in a repo.
sidebar:
  order: 1
---

This page uses Claude Code as the example; other tools connect the same way (see
[Using with agent tools](/docs/use/agent-tools/#other-agent-tools)).

## How a session connects

- `aitt setup` registers the MCP server once at **user scope** as `ai-task-tracking` (stdio):
  `~/Applications/AI Task Tracking.app/Contents/Resources/aitt mcp` with `AITT_HOME=<your data folder>`. Every repo
  gets it; there is no per-repo setup. `claude mcp get ai-task-tracking` shows the entry.
- The tools are `mcp__ai-task-tracking__save_issue`, `…__whats_next` and so on.
- The server learns the session's **workspace** from its working folder: the git repo's name (worktrees resolve to
  the main repo, submodules to their own name), or the folder name outside git. The branch and the agent tool are
  recorded too. Agents never pass these.
- The app must be running (menu bar; **Settings ▸ Launch at login**). If it isn't, tools return "AI Task Tracking
  isn't running — open it from the menu bar".
- A session loads MCP servers only when it starts: **restart sessions** that were open before setup (exit, then
  `claude` again).

## Repo → project mapping

In the data folder's `config.yml` under `workspaces:`, e.g.

```yaml
workspaces:
  web-app: website
  api-server: website
```

The mapping is only the default when an agent omits `project`; agents can file into any project by name.

## Starting in a repo

1. Make sure AI Task Tracking is running (menu-bar icon).
2. Start a fresh session in the repo (`cd ~/code/web-app && claude`). `/mcp` should list `ai-task-tracking` as
   connected.
3. Say what you want tracked, e.g. "pick up ENG-12" or "plan the next step of ENG-9 as child issues".
4. Watch Home: the live feed shows each change tagged with the repo.

Optional: setup can add one line to `~/.claude/CLAUDE.md` (`aitt setup --claude-md`) so every session tracks its
work. For one repo only, add a line to that repo's `CLAUDE.md`, e.g. "Track all work in AI Task Tracking
(`ai-task-tracking` tools, project Website)".

## Picking up where a session stopped

Agent sessions end mid-task. Two things help the next one, in `get_issue`:

- **`handoff`**, first in the result when the issue is *In Progress*: who worked on it last (`last`: tool, branch,
  when), that session's own latest comment (`note`, under 200 characters; a comment from an older session on the
  same branch doesn't count), how much of the checklist is open (`open`: the count and the first three titles), open
  `blockers`, and the [stalled](/docs/use/daily-use/#stalled-work) and
  [CI](/docs/use/daily-use/#ci-status-on-pull-requests) reasons when they apply. It is left out when there's nothing
  useful in it, and for the session that worked on the issue last (it knows where it stopped).

  ```json
  "handoff": {
    "last": { "client": "codex", "branch": "feat/pricing-table", "at": "2026-03-11T22:30:00.000Z" },
    "note": "Done: rows from the plans config. Next: sticky header. Blocking: lint fails on PR #57.",
    "open": { "count": 2, "items": ["Sticky header while scrolling", "Tooltips for the less obvious limits"] },
    "ci": "CI failing on PR #57"
  }
  ```

- **`attempts`**: `{ count, tools, last: { client, branch, at, leftStatus } }`, one attempt per agent session that
  wrote to the issue; `leftStatus` is the status it left the issue in. The issue page shows the same as
  "3 attempts · 2 tools", which opens into one line per attempt.

The default rules ask agents to leave a one-line handoff comment when they pause (what's done, what's next, what's
blocking), which is what `note` then shows. If your data folder's `AGENTS.md` predates this, add the line
under *While working*:

```
- Pausing (ending the session or switching issues): leave a one-line handoff comment: what's done, what's next, what's blocking.
```

Attempts come from this Mac's activity log (`.tracker/events.jsonl`), so they start when that log does: on a fresh
clone, or for work from before it, the only attempt known is the issue's last agent writer (`touched_by`).

## Tool reference (short)

`save_issue`, `save_issues` (batch with `ref`), `get_issue`, `get_tree`, `list_issues`, `search`, `whats_next`,
`save_comment`, `list_comments`, `toggle_task`, `set_plan` (now only), `list_projects`, `get_project`,
`save_project`, `list_milestones`, `save_milestone`, `save_document`, `get_document`, `list_issue_statuses`,
`list_issue_labels`, `save_issue_label`, `list_teams`. Each tool's description (what agents see) lives in
`src/tools/schemas.ts`.
