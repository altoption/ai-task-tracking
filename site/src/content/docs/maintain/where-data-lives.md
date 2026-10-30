---
title: Where data lives
description: The data folder, the app, its settings and the agent configs.
sidebar:
  order: 4
---

## Data folder

Default `~/AITaskTracking`. Plain text and a git repo: you can read and edit it with any editor, and the app picks up
changes. Every file and key is described in [Data model and importing](/docs/use/data-model/).

| Path | What |
|---|---|
| `config.yml` | port, statuses, which statuses and labels count as *Needs you* (`needsYou:`), when work counts as stalled (`stalled:`), CI status of linked PRs (`ci:`), repo → project mapping (`workspaces:`) |
| `labels.yml` | labels |
| `AGENTS.md` | the rules agents get; see [Agent rules](/docs/guides/agent-rules/) |
| `projects/<slug>/project.md` | a project |
| `projects/<slug>/issues/*.md` | its issues |
| `views/` | saved views |
| `.tracker/` | this Mac's caches, never backed up (git-ignored): the activity log `events.jsonl` and the PR CI status `ci.json` |

## App and CLI

- **App**: `~/Applications/AI Task Tracking.app`.
- **CLI**: `~/.local/bin/aitt`, a link into the app.
- **App settings**: `defaults read io.github.altoption.ai-task-tracking`.

## Agent configs

The files in the [per-tool table](/docs/use/agent-tools/#other-agent-tools), plus `~/.claude/skills/ai-task-tracking`.
