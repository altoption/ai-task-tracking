# Using AI Task Tracking from agent sessions

How agent sessions connect to AI Task Tracking, what they are told, and how to start using it in a repo. This page
uses Claude Code as the example; other tools connect the same way (see
[Use with other agent tools](../../README.md#use-with-other-agent-tools)).

## How a session connects
- `aitt setup` registers the MCP server once at **user scope** as `ai-task-tracking` (stdio):
  `~/Applications/AI Task Tracking.app/Contents/Resources/aitt mcp` with `AITT_HOME=<your data folder>`. Every repo
  gets it; there is no per-repo setup. `claude mcp get ai-task-tracking` shows the entry.
- The tools are `mcp__ai-task-tracking__save_issue`, `…__whats_next` and so on.
- The server learns the session's **workspace** from its working folder: the git repo's name (worktrees resolve to
  the main repo, submodules to their own name), or the folder name outside git. The branch and the agent tool are
  recorded too. Agents never pass these.
- The app must be running (menu bar; Settings ▸ Launch at login). If it isn't, tools return "AI Task Tracking isn't
  running — open it from the menu bar".
- A session loads MCP servers only when it starts: **restart sessions** that were open before setup (exit, then
  `claude` again).

## What agents are told
Two sources, which agree:
- **The `ai-task-tracking` skill** (`~/.claude/skills/ai-task-tracking/SKILL.md`, installed by setup): the
  workflow, the tool table and what to do when a tool fails. Its workflow section is also what setup writes into
  other tools' instruction files (`aitt guidance` prints it).
- **The data folder's `AGENTS.md`**: the MCP server sends it as its instructions when a session starts, and where
  it differs from the skill, it wins. Edit it to change every agent's behaviour, e.g. to require a scope label or
  name your projects; new sessions pick it up.

The default rules, in short:
1. Start with `get_issue` (a named issue) or `whats_next`; `search` before creating.
2. Every issue: a project and one type label (Bug, Feature, Improvement, Task), plus a scope label if your labels
   use scopes.
3. Multi-step work = an epic and its children in one `save_issues` call, steps chained with `blockedBy`.
4. Comment on findings, decisions and PRs; decisions go under a dated `## Decided` heading in the description.
5. Needing you → `Waiting` with a comment, or the label "Needs decision" / "Needs review" → it appears in
   Home ▸ Needs you.
6. Moving to Done, Waiting, Canceled or Duplicate needs a comment. Agents never delete; Next/Later is yours.
7. Milestones only for issues in one project that ship together toward a named or dated outcome.

## Enforced by the tools (not just guidance)
| Rule | What the agent sees |
|---|---|
| A new issue needs a label | an error listing the existing labels; an unknown label is created |
| A new issue without a project | the project mapped to its repo is used; an unmapped repo gets its own project (own id prefix) |
| Done/Waiting/Canceled/Duplicate without an explanation | an error asking for `comment` |
| Parent/blocker cycles, unknown ids | an error naming the cycle or the ids |
| Delete, save_view, set_plan next/later | refused (yours, from the app) |
| A stale description edit with `baseDescription` | refused; re-read and re-apply |

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

## Tool reference (short)
`save_issue`, `save_issues` (batch with `ref`), `get_issue`, `get_tree`, `list_issues`, `search`, `whats_next`,
`save_comment`, `list_comments`, `toggle_task`, `set_plan` (now only), `list_projects`, `get_project`,
`save_project`, `list_milestones`, `save_milestone`, `save_document`, `get_document`, `list_issue_statuses`,
`list_issue_labels`, `save_issue_label`, `list_teams`. Each tool's description (what agents see) lives in
`src/tools/schemas.ts`.
