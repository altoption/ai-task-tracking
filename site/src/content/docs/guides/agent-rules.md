---
title: Agent rules
description: What agents are told, the default rules in AGENTS.md, and what the tools enforce.
sidebar:
  order: 2
---

## What agents are told

Two sources, which agree:

- **The `ai-task-tracking` skill** (`~/.claude/skills/ai-task-tracking/SKILL.md`, installed by setup): the
  workflow, the tool table and what to do when a tool fails. Its workflow section is also what setup writes into
  other tools' instruction files (`aitt guidance` prints it).
- **The data folder's `AGENTS.md`**: the MCP server sends it as its instructions when a session starts, and where
  it differs from the skill, it wins. Edit it to change every agent's behaviour, e.g. to require a scope label or
  name your projects; new sessions pick it up.

## The default rules

1. Start with `get_issue` (a named issue) or `whats_next`; `search` before creating.
2. Every issue: a project and one type label (Bug, Feature, Improvement, Task), plus a scope label if your labels
   use scopes.
3. Multi-step work = an epic and its children in one `save_issues` call, steps chained with `blockedBy`.
4. Comment on findings, decisions and PRs; decisions go under a dated `## Decided` heading in the description.
   Pausing (ending the session or switching issues): leave a one-line handoff comment: what's done, what's next,
   what's blocking. The next session sees it first (see [Picking up where a session stopped](/docs/guides/agent-sessions/#picking-up-where-a-session-stopped)).
5. Needing you → `Waiting` with a comment, or the label "Needs decision" / "Needs review" → it appears in
   **Home ▸ Needs you**.
6. Moving to Done, Waiting, Canceled or Duplicate needs a comment. Agents never delete; Next/Later is yours.
7. Milestones only for issues in one project that ship together toward a named or dated outcome.

## Enforced by the tools

These are not just guidance; the tools refuse or correct:

| Rule | What the agent sees |
|---|---|
| A new issue needs a label | an error listing the existing labels; an unknown label is created |
| A new issue without a project | the project mapped to its repo is used; an unmapped repo gets its own project (own id prefix) |
| Done/Waiting/Canceled/Duplicate without an explanation | an error asking for `comment` |
| Parent/blocker cycles, unknown ids | an error naming the cycle or the ids |
| Delete, `save_view`, `set_plan` next/later | refused (yours, from the app) |
| A stale description edit with `baseDescription` | refused; re-read and re-apply |
