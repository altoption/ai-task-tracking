# Development

Build and test details for engineers working on AI Task Tracking. The workflow (branches, PRs, reviews) is in
[CONTRIBUTING.md](../../CONTRIBUTING.md).

## Prerequisites
- macOS 13+, Xcode Command Line Tools (Swift 5.9+), Bun 1.4.4 (the version CI pins), `shellcheck`
  (`brew install shellcheck`), `gh` for anything touching releases.
- `bun install`, then optionally `scripts/dev-setup.sh` to install the pre-push hook (runs `bun run check`;
  `scripts/dev-setup.sh --remove` takes it out).

## Repo layout
| Path | What |
|---|---|
| `src/cli.ts` | the `aitt` CLI (`serve`, `mcp`, `setup`, `open`, `guidance`, `uninstall`, `bench`) |
| `src/engine/` | the store (issues as Markdown files), queries, search, folder watcher, git commit/push |
| `src/server/` | the HTTP server: the UI, `/api/tool/<name>`, the live event stream |
| `src/mcp/` | the stdio MCP proxy agents talk to (`surface.ts`: tool list, instructions, result shaping; `workspace.ts`: repo/branch/client detection) |
| `src/tools/` | tool schemas and descriptions (`schemas.ts`), rules, handlers |
| `src/store/` | file formats: issue files, `config.yml`, `labels.yml`, the default `AGENTS.md`, atomic writes |
| `src/setup/` | `aitt setup`, other agent tools (`clients.ts`), uninstall |
| `ui/` | the web UI (React), built to `ui/dist` and embedded in the compiled binary |
| `app/` | the menu-bar app (Swift package): `Sources/Tracker` (AppKit), `Sources/TrackerCore` (pure, tested), `build.sh` |
| `skills/ai-task-tracking/` | the agent skill; its workflow section is the guidance for every agent tool |
| `install.sh`, `uninstall.sh` | the user installer and uninstaller (repo root, fetched with `curl` from raw.githubusercontent.com) |
| `scripts/` | `lib.sh` (shared build/install functions), `install.sh` (developer installer), `release.sh`, `agent-eval.sh`, `dev-setup.sh` |
| `tests/` | `bun test` suites, mirroring `src/` |

## Gates
- `bun run check`: typecheck, UI build, `bun test`, `bash -n` + `shellcheck` on every shell script. CI runs it.
- `bun run check:app`: Swift release build + `swift test` in `app/`. CI runs it.
- One test file: `bun test tests/engine/store.test.ts`.

## Your real data is off limits
Tests and manual runs use a scratch data folder and a free port, never your real folder (`~/AITaskTracking` by
default) or port 7477, which your installed app is using:

```sh
export AITT_HOME="$(mktemp -d)" AITT_PORT=7499
bun src/cli.ts serve        # creates the folder skeleton on first run; UI at http://127.0.0.1:7499
```

Stop it with Ctrl-C (or `kill <the pid you started>`). Never stop the engine or app by process name: other copies,
including your real one, match too.

## Dev loop
- **Engine + UI:** `bun run build:ui` once (or `bun run dev:ui` to rebuild on change), then the `serve` command
  above; the dev server reads `ui/dist` from disk. Reload the browser after a rebuild.
- **MCP proxy:** `AITT_HOME=… AITT_PORT=7499 bun src/cli.ts mcp` speaks stdio MCP to that engine. To try it from
  an agent, point a scratch MCP config at it; `scripts/agent-eval.sh` shows how without touching your real config.
- **Guidance text:** `bun src/cli.ts guidance` prints what setup writes into other tools' instruction files.
- **Compiled binary:** `bun run build` → `dist/aitt` (UI embedded).
- **App:** `bun run build`, then `app/build.sh --no-register <scratch dir>` builds `AI Task Tracking.app` there
  without registering the `aitt://` scheme or writing the app's settings. Most app logic lives in
  `Sources/TrackerCore` and is covered by `bun run check:app`. Launching a dev build is the exception: it shares
  the settings domain `io.github.altoption.ai-task-tracking` with your installed app, and an `AITT_HOME` in its environment
  is saved there as the data folder (`trackerHome`). Quit your installed app first, note
  `defaults read io.github.altoption.ai-task-tracking trackerHome`, and write it back afterwards.
- **Installers:** `./install.sh --dry-run` shows the plan without changing anything. For a real test install use a
  scratch app folder and data folder: `AITT_APP_DIR=<scratch> AITT_HOME=<scratch> ./install.sh --yes --no-launch`.
  A scratch app folder (anything but `~/Applications` or `/Applications`) is not registered with macOS, writes no
  app settings, and gets no Claude Code entry, no `aitt` link, no agent skill, no CLAUDE.md line and no other
  agent tools unless `--connect` names them.
- **`scripts/install.sh [--connect <tools>]`** (developer installer; `--help` lists its environment switches)
  rebuilds this checkout into `$AITT_APP_DIR` (default `~/Applications`) and runs setup with `--no-skill
  --no-claude-md`, connecting no other agent tool unless `--connect` names it. Into `~/Applications` it quits and
  replaces your installed app and registers Claude Code against your real data folder; use a scratch `AITT_APP_DIR` (and `AITT_HOME`) unless
  you mean to upgrade your own install. Unlike `./install.sh`, it replaces the bundle in place rather than
  staging it and swapping it in.

## Docs site
The user docs are a Starlight site in `site/` (its own package; `bun run docs:install` installs it). The engine
serves the build at `/docs/`, and `bun run build` embeds it in the binary.
- `bun run docs:dev` serves it with live reload at `http://localhost:4321/docs/`; `bun run docs:build` builds
  `site/dist/docs` and fails on a broken internal link; `bun run docs:preview` serves the build.
- `bun run docs:gen` regenerates the Reference pages from source; `tests/docs-reference.test.ts` fails when they
  are stale.
- `bun run docs:shots` retakes the screenshots in `site/src/assets/screenshots/` (used by the docs and the README).
  It starts a scratch engine on a temp data folder and a free port, seeds fictional sample data through the tool
  API, and captures Home, an issue, a project and the ⌘K bar at 1440×900 @2x with Playwright (`playwright-core`, a
  dev dependency; it uses Playwright's Chromium if installed, else Google Chrome). The engine runs on a virtual
  clock and the browser's clock, time zone and locale are fixed, so a rerun gives the same PNGs. It stops only the
  engine it started. It isn't part of `bun run check`; run it after a UI change and commit the images.

## Releases (maintainer)
`scripts/release.sh <version> [--skip-notarize] [--no-publish] [--out <dir>]`; `--help` lists the steps.
1. Bump `version` in `package.json` on a release PR and merge it.
2. One-time: store notary credentials as the keychain profile `aitt-notary`
   (`xcrun notarytool store-credentials aitt-notary --apple-id … --team-id … --password <app-specific password>`;
   the script prints the exact command when the profile is missing). Signing uses `$AITT_SIGN_ID`, default the
   first "Developer ID Application" identity in the keychain.
3. Dry run: `scripts/release.sh <version> --skip-notarize --no-publish` builds the universal app, signs it and
   zips it into `dist/release/<version>`.
4. Release, from a clean checkout of `main` that is pushed (the release tags the commit it built):
   `scripts/release.sh <version>` builds, signs, notarizes, staples, zips
   `AI-Task-Tracking-<version>-macos.zip` (+ `.sha256`) and creates GitHub release `v<version>` on
   `altoption/ai-task-tracking`. The installer picks up the latest release.
   A notarization status other than Accepted stops the release before stapling and prints `notarytool log`.
   Publishing is refused up front when the tree is dirty or HEAD isn't on a branch of `origin`.

Signing and notarizing never run in CI.

## The MCP tool surface
What agents see (tool descriptions, argument descriptions, annotations, server instructions and result shapes) is product UI. It lives in `src/tools/schemas.ts` (descriptions) and `src/mcp/surface.ts` (tool list, instructions preamble, result shaping). `tests/mcp/surface.test.ts` guards it:
- every tool has a title and one example call, and every argument a description;
- a token budget for all tool definitions plus the default instructions (chars / 4);
- a snapshot of the tool list: after a deliberate change, review the diff and accept it with `bun test tests/mcp/surface.test.ts -u`;
- the shapes of write, batch, tree and get_issue results.

The engine's HTTP tool API (`/api/tool/<name>`, used by the app's UI and menu bar) keeps its full result shapes; results are trimmed for agents in the MCP proxy only.

## Portability
`tests/portability.test.ts` fails on machine- or owner-specific strings in product code (`src`, `ui`, `app/Sources`,
`scripts`, `skills`, the installers): absolute `/Users` or `/Volumes` paths, an employer name, and the old product
name `Tracker` (it survives only as the Swift target folder `app/Sources/Tracker`).

## Agent eval
`scripts/agent-eval.sh [--model <model>] [--keep] [--user-context]` runs `claude -p` (default model `haiku`) through five tasks against a throwaway data folder and engine on a free port: create an epic with three steps, ask what's next, mark a step done with a PR link, hand a step back to the owner (Waiting), and find an older issue and link it as related. It prints, per task, the tool calls in order and any tool errors, then state checks (epic with 3 chained children, a Done step with the PR link, a Waiting step, the related link, no duplicate epic).

It never touches your MCP config, data folder or running app: it uses `--mcp-config <scratch json> --strict-mcp-config`, `--tools ""` and no session persistence, and checks that the engine answering on its port serves its own scratch folder (it retries on another port if not). By default the agent gets no user context: `--setting-sources project` from a scratch folder (no user CLAUDE.md, hooks or plugins), CLAUDE.md files and auto-memory disabled, and `--bare` when `ANTHROPIC_API_KEY` is set. `--user-context` loads your user settings, CLAUDE.md and memory instead (your user hooks then run too). `--keep` keeps the scratch folder (transcripts in `task<N>.jsonl`). Run it after changing descriptions, result shapes or the default AGENTS.md; the target is no tool errors and as few calls as the task needs.
