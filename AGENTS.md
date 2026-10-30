# AI Task Tracking
<!-- Mirrors CLAUDE.md for Codex, Cursor and other agents; change both. -->

A local issue tracker for agents: Bun/TypeScript engine, MCP proxy and CLI (`src/`, `aitt`), React UI (`ui/`),
Swift menu-bar app (`app/`). Workflow and review rules: [CONTRIBUTING.md](CONTRIBUTING.md). Repo layout, dev
loop, releases: [docs/setup/development.md](docs/setup/development.md).

## Gates
- `bun run check`: typecheck, UI build, `bun test`, `bash -n` + shellcheck. Green before every commit.
- `bun run check:app`: Swift build + tests. Green before every commit that touches `app/`.
- One suite: `bun test tests/<path>.test.ts`. Accepting a deliberate MCP surface change:
  `bun test tests/mcp/surface.test.ts -u`, then review the snapshot diff.

## Safety: the owner's real install runs on this Mac
- Everything you start runs on a scratch data folder and port: `AITT_HOME="$(mktemp -d)" AITT_PORT=7499`. The real
  data folder (`~/AITaskTracking` by default) and port 7477 belong to the installed app.
- Stop only processes you started, by the PID you captured (`cmd & pid=$!` … `kill "$pid"`).
- These change the real install and agent configs: `scripts/install.sh` and `./install.sh` (without `--dry-run`)
  into `~/Applications`, `aitt setup`, `aitt uninstall`, `app/build.sh` without `--no-register`, and launching a
  dev app build (it saves its `AITT_HOME` as the app's data folder). Run them only when the task is to test them,
  with the owner's go-ahead, and then with a scratch `AITT_APP_DIR` and `AITT_HOME`. Learn their flags from the
  source (`usage()` in each script, `SETUP_USAGE`/`UNINSTALL_USAGE` in `src/setup/`).

## Docs ship with every change
Docs are part of the build, not a follow-up. In the same branch as the change:
- User-visible behaviour (commands, flags, settings, UI, agent tools, install): update the hand-written pages in
  `site/src/content/docs/` and `README.md`.
- CLI usage, MCP tools, Settings or `config.yml` changed: `bun run docs:gen` (the drift test in `bun run check`
  fails otherwise).
- UI changed: `bun run docs:shots` to retake the screenshots.
- `bun run docs:build` must pass (link check, `llms.txt`) before the PR.

## Conventions
- Conventional commits (`feat(setup): …`, `fix(engine): …`); commit messages and PRs carry no attribution or
  co-author lines.
- Linear history (no merge commits): feature branch from `main`, PR, squash or rebase merge. Commit only your own paths
  (`git commit -m … -- <paths>`); others may share this checkout.
- An agent opens PRs and never merges its own.
- Product code stays portable (`tests/portability.test.ts`): no absolute user paths or owner names.
- Agent-facing text has one source: the skill's workflow section (`skills/ai-task-tracking/SKILL.md`) feeds every
  tool's guidance; tool descriptions live in `src/tools/schemas.ts`.
