---
name: ai-task-tracking
description: Track work as issues in AI Task Tracking, the local issue tracker on this Mac (MCP tools `mcp__ai-task-tracking__*`). Use when those tools are present and the user asks to track, file or log work ("track this", "make a ticket"), plan an epic with steps, asks "what's next", or names one of its issue ids (ENG-12).
---

# AI Task Tracking

AI Task Tracking is a local issue tracker that runs as a menu-bar app on the user's Mac. Claude Code
reaches it through the AI Task Tracking MCP tools (server `ai-task-tracking`, so
`mcp__ai-task-tracking__save_issue` and friends). The session's repo, branch and session id
are recorded on every write automatically; pass none of them.

The live rules for this user are the data folder's `AGENTS.md`, which arrive as the MCP server's
instructions at session start. Where they differ from this skill, they win (labels, scopes, projects).

## Workflow
<!-- aitt:guidance:start (setup copies this section into other agent tools' instructions) -->

1. **Orient.** A named issue → `get_issue({ id })` (`get_tree({ id })` for an epic). Otherwise
   `whats_next()` and propose what to pick up.
2. **Search before creating.** `search({ query })`; reuse an existing issue over filing a duplicate.
3. **Create.** One issue per piece of work, before writing code. Every issue gets a project (omit it
   and the repo's mapped project is used) and one type label (Bug, Feature, Improvement, Task), plus a
   scope label if the workspace uses scope labels (`list_issue_labels`). Multi-step work is an epic with
   one child per step, all in **one** `save_issues` call, steps chained with `blockedBy`:
   ```
   save_issues({ issues: [
     { ref: "epic", title: "Epic: CSV export", labels: ["Feature"] },
     { ref: "s1", parentId: "ref:epic", title: "Step 1: export endpoint", labels: ["Task"] },
     { parentId: "ref:epic", title: "Step 2: download button", labels: ["Task"], blockedBy: ["ref:s1"] }
   ] })
   ```
   Description: the ask, context, acceptance criteria; decisions under a dated `## Decided` heading.
4. **Start.** `save_issue({ id, state: "In Progress" })`.
5. **Narrate.** `save_comment({ issueId, body })` for findings, decisions, PR and commit links: dated,
   short. Dependencies go in `addBlockedBy` / `removeBlockedBy`, never only in prose. Pausing (ending
   the session or switching issues): leave a one-line handoff comment: what's done, what's next, what's
   blocking.
6. **Hand back.** Need a decision, review or access → `save_issue({ id, state: "Waiting", comment:
   "Needs: …" })`, or the label "Needs decision" / "Needs review". These land in the user's *Needs you*.
7. **Finish.** `save_issue({ id, state: "Done", comment: "Shipped in PR #123: …" })`. Done, Waiting,
   Canceled and Duplicate all require a `comment`. Work you drop is `Canceled` with a reason; issues are
   never deleted.

**Milestones.** Use one only for a set of issues in ONE project that must ship together toward a dated
or named outcome (a release "v0.2", a pilot, a demo or customer date). Create it with `save_milestone`
(`targetDate` when known) only when the user names that outcome or asks for one; assign issues with
`milestone` — the children, not just the epic, so progress counts them. Don't use milestones to break
work down (that's an epic), to categorise (labels) or across projects; never invent one — ask.

**Mentioning an issue.** Print it as a markdown link to the tool result's `url`, then its `appUrl`:
`[ENG-1 Epic: CSV export](http://127.0.0.1:7477/#/issue/ENG-1) · aitt://issue/ENG-1`.
<!-- aitt:guidance:end -->

## Tools

| Need | Tool |
|---|---|
| Next work, overview | `whats_next`, `list_issues({ project, state, label })`, `search({ query })` |
| One issue / an epic | `get_issue({ id })`, `get_tree({ id })`, `list_comments({ issueId })` |
| Create or update | `save_issue`, `save_issues` (batch, `ref:` links inside the batch) |
| Comment | `save_comment({ issueId, body })` |
| Checklist item | `toggle_task({ id, index, line })` |
| Safe description edit | `save_issue({ id, description, baseDescription })`; if refused, re-read and re-apply |
| Projects | `list_projects`, `get_project`, `save_project`, `list_milestones`, `save_milestone` |
| Docs | `save_document`, `get_document` |
| Vocabulary | `list_issue_statuses`, `list_issue_labels`, `save_issue_label`, `list_teams` |
| Plan for today | `set_plan({ id, plan: "now" })` (Next/Later belong to the user) |

Each tool's own description carries its full arguments.

## When a tool fails

- **"AI Task Tracking isn't running"** → ask the user to open AI Task Tracking (menu bar, or `open -a "AI Task Tracking"`), then retry.
- **"didn't reply… may have been applied"** → check with `get_issue` / `list_issues` before retrying,
  so the write isn't applied twice.
- **A rule error** (missing label, unknown project, missing comment, cycle) → the message names the fix
  and the valid values; apply it and retry once.
- **No `mcp__ai-task-tracking__*` tools in this session** → either this session started before setup
  registered the server (restart the session after `aitt setup`), a project-scope MCP entry named
  `ai-task-tracking` is hiding the user-scope one (`claude mcp get ai-task-tracking` shows which), or the
  app isn't installed. `claude mcp list` shows what this session sees.

## When AI Task Tracking isn't installed

Tell the user, then offer the install command (macOS 13+, needs the GitHub CLI `gh` signed in with
access to the repo):

```
gh api repos/altoption/ai-task-tracking/contents/install.sh --jq .content | base64 -d | bash
```

It installs the app, puts `aitt` on the PATH and runs `aitt setup`, which registers the MCP server
for Claude Code. If the app is installed but setup never ran, the user runs `aitt setup` in Terminal.
Either way, the user restarts their Claude Code session afterwards to pick up the tools. Until then,
keep a short task list in the conversation instead.
