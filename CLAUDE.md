# AI Task Tracking
<!-- AGENTS.md mirrors this file for Codex and Cursor; change both. -->

A local issue tracker for agents: Bun/TypeScript engine, MCP proxy and CLI (`src/`, `aitt`), React UI (`ui/`),
Swift menu-bar app (`app/`). Workflow and review rules: [CONTRIBUTING.md](CONTRIBUTING.md). Repo layout, dev
loop, releases: [docs/setup/development.md](docs/setup/development.md).

Bringing issues over from another tool (Jira, GitHub Issues, Trello, a spreadsheet, …): read
[Data model and importing](site/src/content/docs/use/data-model.md) first. It describes the data folder, the issue
file format and `config.yml`, and the safe way to import (`save_issues` in batches, or files written with the app
stopped).

## Who decides
The agent working here is the product owner: it finds gaps, checks the need, sets priority, builds and ships, within
the rules in this file. The repo owner directs and is kept informed: say what you decided and why, and ask only
when the answer changes scope or is hard to undo.

## Gates
Run what the change can break, once, before the commit. CI runs everything on every PR, and `main` only takes a PR
with `check` and `check-app` green.
- Styles (`ui/styles.css`) or docs only: `bun run typecheck && bun run build:ui`.
- Other `ui/` changes: the above, plus `bun test tests/ui`.
- Anything in `src/`, `scripts/` or `tests/`: `bun run check` (typecheck, UI build, `bun test`, `bash -n` + shellcheck).
- Anything in `app/`: `bun run check:app` (Swift build + tests).
- One suite: `bun test tests/<path>.test.ts`. Accepting a deliberate MCP surface change:
  `bun test tests/mcp/surface.test.ts -u`, then review the snapshot diff.

## Safety: the owner's real install runs on this Mac
- Everything you start runs on a scratch data folder and port: `AITT_HOME="$(mktemp -d)" AITT_PORT=7499`. The real
  data folder (`~/AITaskTracking` by default) and port 7477 belong to the installed app.
- Stop only processes you started, by the PID you captured (`cmd & pid=$!` … `kill "$pid"`).
- These change the real install and agent configs: `scripts/install.sh` and `./install.sh` (without `--dry-run`)
  into `~/Applications`, `aitt setup`, `aitt uninstall`, `app/build.sh` without `--no-register`, and launching a
  dev app build (it saves its `AITT_HOME` as the app's data folder). One use is routine: after a merge to `main`,
  update the owner's app from `main` with `SKIP_MCP=1 SKIP_LOGIN_ITEM=1 scripts/install.sh`, then confirm
  `/api/health` answers. Any other run is for testing them, with a scratch `AITT_APP_DIR` and `AITT_HOME`. Learn
  their flags from the source (`usage()` in each script, `SETUP_USAGE`/`UNINSTALL_USAGE` in `src/setup/`).

## Docs ship with every change
Docs are part of the build, not a follow-up. In the same branch as the change:
- User-visible behaviour (commands, flags, settings, UI, agent tools, install): update the hand-written pages in
  `site/src/content/docs/` and `README.md`.
- CLI usage, MCP tools, Settings or `config.yml` changed: `bun run docs:gen` (the drift test in `bun run check`
  fails otherwise).
- A screenshot's subject changed: `bun run docs:shots`, then restore the shots of pages you didn't change (it
  rewrites all of them).
- `bun run docs:build` must pass (link check, `llms.txt`) before the PR.

## Conventions
- Conventional commits (`feat(setup): …`, `fix(engine): …`); commit messages and PRs carry no attribution or
  co-author lines.
- Linear history (no merge commits): feature branch from `main`, PR, squash or rebase merge. Commit only your own paths
  (`git commit -m … -- <paths>`); others may share this checkout.
- An agent merges its own PR once CI is green. Changes to the engine, the tool rules or the data format get a
  review from a fresh context first.
- Product code stays portable (`tests/portability.test.ts`): no absolute user paths or owner names.
- Agent-facing text has one source: the skill's workflow section (`skills/ai-task-tracking/SKILL.md`) feeds every
  tool's guidance; tool descriptions live in `src/tools/schemas.ts`.
