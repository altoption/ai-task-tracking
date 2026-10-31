#!/bin/bash
# Developer installer (builds this checkout). Run scripts/install.sh --help for what it does and its options.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/install.sh [--connect <tools>]
Developer installer: build the engine (UI embedded) and "AI Task Tracking.app" from this checkout, install it,
register the MCP server, put `aitt` on PATH and open the app.
Users run ./install.sh at the repo root instead (prebuilt release, or a build through the same functions).

  --connect <tools>   connect these other agent tools (comma-separated, as in aitt setup --connect);
                      without it, no other agent tool is connected or changed
  -h, --help          show this and exit

Environment:
  AITT_HOME=<dir>      data folder the app runs the engine on (default: the folder the app already uses,
                       else ~/AITaskTracking); remembered by the app
  AITT_APP_DIR=<dir>   where the app is installed (default ~/Applications). Any folder other than
                       ~/Applications or /Applications is a scratch install: no Launch Services registration, no
                       app settings, no Claude Code MCP entry, no aitt link and no other agent tools (unless
                       --connect names them).
  SKIP_MCP=1           don't register the user-scope `ai-task-tracking` MCP entry or link `aitt`
  SKIP_LOGIN_ITEM=1    don't turn on Launch at Login (otherwise a first install turns it on; later runs leave it)
  NO_LAUNCH=1          don't open the app at the end
USAGE
}

# Arguments first: --help or a mistake must never build, install or relaunch anything.
CONNECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --connect)
      [ $# -ge 2 ] || { echo "scripts/install.sh: --connect needs a list of tools" >&2; exit 2; }
      CONNECT="$2"; shift ;;
    *) echo "scripts/install.sh: unknown argument $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib.sh
. "$ROOT/scripts/lib.sh"
APP_DIR="${AITT_APP_DIR:-$HOME/Applications}"
mkdir -p "$APP_DIR"
APP_DIR="$(canon_dir "$APP_DIR")"
APP="$APP_DIR/$AITT_APP_NAME"
# Before the build, which puts the app there.
FIRST_INSTALL=0
[ -d "$APP" ] || FIRST_INSTALL=1

echo "building engine…"
build_engine "$ROOT"
# A running app holds the engine; quit it (it stops the engine and commits) before replacing the bundle.
# Only the copies in APP_DIR are asked, by process id; another copy elsewhere keeps running.
quit_app "$APP" || exit 1
echo "building app…"
build_app "$ROOT" "$APP_DIR"
AITT="$APP/Contents/Resources/aitt"

HOME_DIR="$(abs_path "${AITT_HOME:-$(defaults read "$AITT_BUNDLE_ID" trackerHome 2>/dev/null || echo "$HOME/AITaskTracking")}")"
if should_register "$APP_DIR"; then
  defaults write "$AITT_BUNDLE_ID" trackerHome -string "$HOME_DIR"
  # A first install only: the user may have turned Launch at Login off since.
  if [ "${SKIP_LOGIN_ITEM:-}" != 1 ] && [ "$FIRST_INSTALL" = 1 ]; then
    defaults write "$AITT_BUNDLE_ID" enableLoginItemOnLaunch -bool true
  fi
fi

if [ "${SKIP_MCP:-}" = 1 ]; then
  echo "SKIP_MCP=1: not registering the ai-task-tracking MCP entry"
else
  # Same rules as a user's install: registers `ai-task-tracking` (AITT_HOME) and links
  # ~/.local/bin/aitt. A failure is reported; the app is still opened.
  # A scratch install never points the user's agent tools (Claude Code, the aitt link, others) at a scratch build.
  SETUP_ARGS=(setup --yes --home "$HOME_DIR" --binary "$AITT" --no-backup --no-skill --no-claude-md)
  if ! should_register "$APP_DIR"; then SETUP_ARGS+=(--no-mcp --no-link); fi
  # A rebuild never changes which other agent tools are connected; --connect names any to add.
  if [ -n "$CONNECT" ]; then SETUP_ARGS+=(--connect "$CONNECT"); else SETUP_ARGS+=(--no-connect); fi
  run_setup "$AITT" "${SETUP_ARGS[@]}"
fi

if [ "${NO_LAUNCH:-}" != 1 ]; then open "$APP"; fi
echo "installed $APP (data: $HOME_DIR)"
