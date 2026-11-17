# Contributing to AI Task Tracking

For engineers, and the agents working with them, adding features or fixing bugs. Build and test details are in
[docs/setup/development.md](docs/setup/development.md); agents also read [CLAUDE.md](CLAUDE.md).

## Setup

```sh
git clone https://github.com/altoption/ai-task-tracking.git && cd ai-task-tracking
bun install
scripts/dev-setup.sh      # optional: a pre-push hook that runs bun run check
bun run check             # should pass before you change anything
```

You need macOS 13+, Xcode Command Line Tools, Bun 1.4.4 and `shellcheck` (`brew install shellcheck`).

## Workflow

1. **Issue first.** Pick or create an issue in your AI Task Tracking (project AI Task Tracking, ids `ATT-…`).
   Move it to In Progress when you start.
2. **Branch from `main`:** `feat/<short-name>` or `fix/<short-name>` (also `docs/`, `chore/`, `ci/` for those).
3. **Small commits** with [conventional](https://www.conventionalcommits.org/) messages: `feat(setup): …`,
   `fix(engine): …`, `docs: …`, `test: …`, `ci: …`. One logical change per commit, with the gates for what it
   touches green (see Gates).
4. **Open a PR** and fill in the template: the issue link, what and why, how you tested it (commands and results),
   risk and rollback, screenshots for UI.
5. **CI must pass** (`check` and `check-app`).
6. **Review.** Read the diff yourself. A change to the engine, the tool rules or the data format also gets a fresh
   reviewer (a person, or an agent with a clean context). When branch protection requires approvals, address
   comments with new commits and ask again after a push.
7. **Squash or rebase merge** only; `main` has a linear history and no merge commits. Delete the branch.
8. Comment the PR link on the issue and move it to Done.

Nobody pushes to `main` directly, and nobody force-pushes `main`. Branch protection enforces both
([docs/setup/repo-settings.md](docs/setup/repo-settings.md)). Rebase your branch on `main` when it falls behind
(`git fetch && git rebase origin/main`); force-pushing *your own* feature branch afterwards is fine
(`git push --force-with-lease`).

## Gates

Small, fast, and the same result every run. CI runs all of them on every PR, and branch protection keeps a PR out of
`main` until `check` and `check-app` pass. Locally, run what your change can break, once, before the commit:

| You changed | Run locally |
|---|---|
| Styles (`ui/styles.css`) or docs only | `bun run typecheck && bun run build:ui` |
| Other files in `ui/`, and their tests in `tests/ui/` | the above, plus `bun test tests/ui` |
| `src/` or `scripts/`, or tests outside `tests/ui/` | `bun run check` (typecheck, UI build, tests, `bash -n` + shellcheck) |
| `app/` | `bun run check:app` (Swift release build + tests) |

Approvals are not required while the project has one maintainer (`required_approving_review_count` is 0 in
[repo-settings.md](docs/setup/repo-settings.md)).

A red gate is the stopping point: fix the cause, rather than skipping a test or the hook. `git push --no-verify`
exists for a broken hook, not for failing checks.

## Rules that protect users' data

- **Never run against a real data folder.** Tests and manual runs use a scratch `AITT_HOME` and a free `AITT_PORT`
  (not 7477, which the installed app uses). See "Your real data is off limits" in
  [development.md](docs/setup/development.md).
- **Never stop processes by name.** Stop the process you started, by its PID. A name pattern also matches the
  installed app, its engine, and other people's tools.
- **Setup and uninstall edit other tools' config files.** Changes there keep the existing contract: back up before
  editing, never touch entries that aren't ours, idempotent second runs. Test against fixture files in a temp HOME
  (`tests/setup/`).
- **The MCP tool surface is product UI.** Descriptions, results and the default `AGENTS.md` are what agents read.
  A change there updates the surface snapshot deliberately (`bun test tests/mcp/surface.test.ts -u`, then review the
  diff) and is worth an agent eval run (`scripts/agent-eval.sh`).
- **No machine- or owner-specific strings** in product code; `tests/portability.test.ts` checks.

## How the agents work here

AI Task Tracking was built by agents working through a written loop. Epics and changes to the engine, the tool rules
or the data format still go through all of it. A small fix or a UI change goes issue → branch → PR. The same branch
and PR rules apply to agents as to people.

1. **Brainstorm** the change with the person asking for it until the goal and constraints are clear.
2. **Spec**: write it down in the issue description, or for a larger change in `docs/architecture/<date>-<topic>.md`.
   Small fixes go straight to the issue description.
3. **Plan**: split the spec into small tasks, each with its tests and gates (child issues of an epic work well).
4. **Implement per task**: test first where it fits, then the code, then the gates, then a commit.
5. **Review**: a fresh reviewer (a person, or an agent with a clean context) reads the diff against the spec.
6. **Fix** what the review found, re-run the gates, and repeat review until it is clean. Then open the PR.

With Claude Code: if the superpowers skills are installed, they run this loop (`superpowers:brainstorming`,
`superpowers:writing-plans`, `superpowers:executing-plans` or `superpowers:subagent-driven-development`,
`superpowers:requesting-code-review`). Without them, follow the same steps by hand: ask the agent for each step
explicitly and review its output before moving on.

Rules for agents (also in [CLAUDE.md](CLAUDE.md)):
- Work on a feature branch and open a PR; an agent merges its own PR once CI is green, and never pushes to `main`.
- The agent acts as product owner: it decides product questions and priority, and tells the maintainer what it
  decided and why.
- Track the work in AI Task Tracking: the issue at the start, comments with findings and PR links, Done with a
  comment at the end. Put the issue link in the PR.
- Run the gates for what the change touches before every commit and say in the PR what ran and what it showed.
- Use a scratch `AITT_HOME`/`AITT_PORT` for anything that starts the engine.

## Where things are

- Product and user docs: [README.md](README.md).
- Agent connection and rules: [docs/setup/agent-usage.md](docs/setup/agent-usage.md),
  [docs/setup/other-agent-tools.md](docs/setup/other-agent-tools.md).
- Build, dev loop, releases: [docs/setup/development.md](docs/setup/development.md).
- The data folder and issue file format: [site/src/content/docs/use/data-model.md](site/src/content/docs/use/data-model.md).
