---
title: Contributing
description: Where to start when changing AI Task Tracking itself.
---

The full guides live in the repo:

- [CONTRIBUTING.md](https://github.com/altoption/ai-task-tracking/blob/main/CONTRIBUTING.md): workflow (issue
  first, branches, conventional commits, PRs and review), gates, and the rules that protect users' data.
- [docs/setup/development.md](https://github.com/altoption/ai-task-tracking/blob/main/docs/setup/development.md):
  prerequisites, repo layout, dev loop, releases, the MCP tool surface, portability and the agent eval.

## Setup

```sh
gh repo clone altoption/ai-task-tracking && cd ai-task-tracking
bun install
scripts/dev-setup.sh      # optional: a pre-push hook that runs bun run check
bun run check             # should pass before you change anything
```

You need macOS 13+, Xcode Command Line Tools, Bun 1.4.4 and `shellcheck` (`brew install shellcheck`).

## Gates

| Gate | Command |
|---|---|
| Typecheck, UI build, tests, shell lint | `bun run check` |
| Swift release build + Swift tests | `bun run check:app` |

## Your real data is off limits

Tests and manual runs use a scratch data folder and a free port, never your real folder or port 7477, which your
installed app is using:

```sh
export AITT_HOME="$(mktemp -d)" AITT_PORT=7499
bun src/cli.ts serve        # UI at http://127.0.0.1:7499
```

Stop it with Ctrl-C, or `kill` the PID you started. Never stop the engine or app by process name: other copies,
including your real one, match too.

## This docs site

The site is a separate [Starlight](https://starlight.astro.build/) package in `site/`. From the repo root:

| Command | |
|---|---|
| `bun run docs:dev` | serve it locally at `http://localhost:4321/docs/` with live reload |
| `bun run docs:build` | build static files into `site/dist/docs` (fails on a broken internal link) |
| `bun run docs:preview` | serve the build |

Pages are Markdown in `site/src/content/docs/`; the sidebar is in `site/astro.config.mjs`. Internal links start with
`/docs/`, the site's base. The engine serves the build at `/docs/`, and `bun run build` embeds it in the `aitt`
binary. The Reference pages are generated: `bun run docs:gen`.
