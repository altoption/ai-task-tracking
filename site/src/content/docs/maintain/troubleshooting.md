---
title: Troubleshooting
description: Common problems and their fixes.
sidebar:
  order: 3
---

| Problem | Fix |
|---|---|
| Menu shows "Another engine is using port 7477" | Another copy of the engine (e.g. a terminal `aitt serve`) holds the port. Stop it, or set a different `port:` in the data folder's `config.yml` and restart the app. |
| A tool says "AI Task Tracking isn't running" | Open the app from the menu bar, Launchpad or `open -a "AI Task Tracking"`. **Settings ▸ Launch at login** keeps it running. |
| No `ai-task-tracking` tools in a Claude Code session | Restart the session. `claude mcp get ai-task-tracking` shows the entry; a project-scope entry with the same name hides the user-scope one. Run `aitt setup` if it's missing. |
| Installer: "Could not download scripts/lib.sh" | The installer couldn't reach GitHub. Check that `curl -fsSI https://raw.githubusercontent.com/altoption/ai-task-tracking/HEAD/install.sh` works (a proxy or firewall may block it), then run it again. |
| No CI badges on issues with a PR link | `curl -s http://127.0.0.1:7477/api/health` shows the reason under `ci`. "gh not installed": `brew install gh` (the engine also looks in `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`). "gh not signed in": `gh auth login` (the engine checks `gh auth status` again within 10 minutes). A link that says *CI status: no access with gh* on its issue page: sign `gh` in to an account that can read that repo (`gh pr view <PR url>` should work in a terminal). Also check **Settings ▸ Show CI status** and `ci.enabled` in `config.yml`. |
| Backup fails | `gh auth status`; the backup repo must exist and your account must be able to push to it. **Back Up Now** retries. |
| Gatekeeper rejects the app | The installer checks the release's `.sha256`, `codesign` and `spctl` before installing and builds from source if any check fails. If a downloaded copy is blocked, run the installer again rather than opening the zip by hand. |
| `aitt: command not found` | Add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` and open a new terminal. |
| A connected tool doesn't show the server | Restart the tool. A config file with comments (JSONC) is left alone; add the entry by hand. See [Other agent tools](/docs/guides/other-agent-tools/#known-limits). |
