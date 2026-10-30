---
title: Install
description: Requirements, the one-line installer, its options, and installing from a clone.
sidebar:
  order: 1
---

## Requirements

| | |
|---|---|
| macOS | 13 (Ventura) or later, Apple Silicon or Intel |
| GitHub CLI | `gh`, signed in (`gh auth login`) with access to `altoption/ai-task-tracking`. The installer offers to install it with Homebrew. |
| To build from source | Xcode Command Line Tools and Bun 1.4 or later. Only needed when no release is available, it fails verification, or with `--from-source`. The installer shows what's missing; it starts the Command Line Tools install and installs Bun from bun.sh (asking first unless `--yes`). The build includes these docs (their packages are downloaded too); if the docs fail to build, the installer warns and installs the app without them. |
| Backup (optional) | `gh` signed in to the GitHub account that will own the private backup repo |
| CI status (optional) | `gh` signed in with read access to the repos whose PRs your issues link. Without it, issues simply show no [CI status](/docs/use/daily-use/#ci-status-on-pull-requests). |

## One-line install

```sh
gh api repos/altoption/ai-task-tracking/contents/install.sh --jq .content | base64 -d | bash
```

The installer checks this Mac, shows what it will do and asks once. It installs the latest notarized release into
`~/Applications` (it checks the download's `.sha256`, the signature and the notarization first, and builds from
source if any check fails or there is no release), links `~/.local/bin/aitt`, runs [`aitt setup`](/docs/start/first-run/)
and opens the app. The new app is prepared next to the old one and swapped in only when it is complete, so a failed
download or build leaves the installed app as it was.

## Options

Options go after `bash -s --` when the script is piped, e.g. `… | base64 -d | bash -s -- --yes`:

| Option | |
|---|---|
| `--yes`, `-y` | no questions; take the defaults |
| `--dry-run` | only show what was found and what would happen |
| `--from-source` | build from source even when a release is available |
| `--version <tag>` | that release (or source tag) instead of the latest, e.g. `v0.2.0` |
| `--no-launch` | don't open the app at the end |
| `--connect <tools>` | connect these other agent tools, comma-separated (as in `aitt setup --connect`) |
| `--help` | the options and environment (also works piped: `… \| bash -s -- --help`) |

## Environment

- `AITT_HOME=<dir>` sets the data folder (default: the one the app already uses, else asked; `~/AITaskTracking`).
- `AITT_APP_DIR=<dir>` installs somewhere other than `~/Applications`. Any folder other than `~/Applications` or
  `/Applications` is a *scratch install*: it isn't registered with macOS, writes no app settings, and gets no Claude
  Code entry, no `aitt` link and no other agent tools unless `--connect` names them.

## From source

From a clone of the repo, run the same installer:

```sh
gh repo clone altoption/ai-task-tracking && cd ai-task-tracking
./install.sh
```

It takes the same options. It builds that checkout when no release is used (or with `--from-source`).

Next: [First run](/docs/start/first-run/).
