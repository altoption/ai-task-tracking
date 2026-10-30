#!/bin/bash
# Uninstall AI Task Tracking from this Mac. Your data folder is kept (the output says where it is).
#
#   gh api repos/altoption/ai-task-tracking/contents/uninstall.sh --jq .content | base64 -d | bash
#   ./uninstall.sh [--yes]            (from a clone)
#
# Runs `aitt uninstall` from the installed app (it keeps your data folder). See --help.
#
# Environment: AITT_APP_DIR=<dir>  where the app is installed (default ~/Applications, then /Applications)
set -euo pipefail

# The help text lives here (not only in comments) so --help also works when the script is piped into bash.
usage() {
  cat <<'USAGE'
Uninstall AI Task Tracking from this Mac. Your data folder is kept (the output says where it is).

  gh api repos/altoption/ai-task-tracking/contents/uninstall.sh --jq .content | base64 -d | bash
  … | bash -s -- --yes              (options when piped)
  ./uninstall.sh [--yes]            (from a clone)

Runs `aitt uninstall` from the installed app: it quits the app, then removes the app, its login item, and the MCP
entries (Claude Code and other agent tools) and ~/.local/bin/aitt link that run this app; also the agent skill and
the CLAUDE.md line, unless another install stays registered. It asks first; --yes doesn't.

Environment: AITT_APP_DIR=<dir>  where the app is installed (default ~/Applications, then /Applications)
USAGE
}

main() {
  local yes=0 app="" dir i=1
  # Arguments first: --help or a mistake must never quit or remove anything.
  while [ "$i" -le $# ]; do
    case "${!i}" in
      --yes | -y) yes=1 ;;
      -h | --help) usage; return 0 ;;
      --lsregister) i=$((i + 1)) ;; # test hook, passed on to aitt uninstall
      *) echo "uninstall.sh: unknown argument ${!i} (see --help)" >&2; return 2 ;;
    esac
    i=$((i + 1))
  done
  for dir in "${AITT_APP_DIR:-$HOME/Applications}" /Applications; do
    if [ -x "$dir/AI Task Tracking.app/Contents/Resources/aitt" ]; then app="$dir/AI Task Tracking.app"; break; fi
    [ -n "${AITT_APP_DIR:-}" ] && break # an explicit folder only
  done
  if [ -z "$app" ]; then
    echo "AI Task Tracking.app isn't installed in ${AITT_APP_DIR:-~/Applications or /Applications}; nothing to uninstall." >&2
    echo "If you installed it somewhere else, run: AITT_APP_DIR=<that folder> ./uninstall.sh" >&2
    return 1
  fi
  local aitt="$app/Contents/Resources/aitt"
  if [ "$yes" = 1 ]; then
    "$aitt" uninstall --app "$app" "$@"
  elif (: </dev/tty) 2>/dev/null; then
    # Piped into bash, stdin is this script: answer the question on the terminal.
    "$aitt" uninstall --app "$app" "$@" </dev/tty
  else
    echo "No terminal to ask on; run it again with --yes to uninstall without asking." >&2
    return 2
  fi
}

# Everything runs from main, so a partly downloaded script does nothing.
main "$@"
