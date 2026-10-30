#!/bin/bash
# Opt-in developer setup: install a git pre-push hook that runs `bun run check` before every push.
#
#   scripts/dev-setup.sh            install (or refresh) the hook
#   scripts/dev-setup.sh --remove   remove the hook this script installed (a hook it didn't install is left alone)
#
# Safe to run again: our own hook is refreshed in place. A different pre-push hook already in place is moved to
# pre-push.bak-<timestamp> first, never overwritten. Skip the hook for one push with `git push --no-verify`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARK="# aitt-pre-push: installed by scripts/dev-setup.sh"

case "${1:-}" in
  "" | --remove) ;;
  -h | --help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "dev-setup.sh: unknown option $1 (see --help)" >&2; exit 2 ;;
esac

# The hooks folder git actually uses (honours core.hooksPath; shared by every worktree).
HOOKS="$(cd "$ROOT" && git rev-parse --path-format=absolute --git-path hooks)"
HOOK="$HOOKS/pre-push"

ours() { [ -f "$HOOK" ] && grep -qF "$MARK" "$HOOK"; }

if [ "${1:-}" = --remove ]; then
  if ours; then rm -f "$HOOK"; echo "✓ removed $HOOK"; else echo "• no pre-push hook from dev-setup.sh at $HOOK; nothing removed"; fi
  exit 0
fi

command -v bun >/dev/null 2>&1 || echo "! bun is not on PATH; the hook needs it (https://bun.sh)" >&2
command -v shellcheck >/dev/null 2>&1 || echo "! shellcheck is not on PATH; bun run check needs it (brew install shellcheck)" >&2

NEW="$(cat <<EOF
#!/bin/bash
$MARK
# Runs the deterministic gates before a push. Skip once with: git push --no-verify
set -euo pipefail
cd "\$(git rev-parse --show-toplevel)"
echo "pre-push: bun run check (skip once with git push --no-verify)…"
exec bun run check
EOF
)"

mkdir -p "$HOOKS"
if [ -e "$HOOK" ] || [ -L "$HOOK" ]; then
  if ours; then
    if [ "$(cat "$HOOK")" = "$NEW" ]; then echo "✓ pre-push hook already installed: $HOOK"; exit 0; fi
  else
    BAK="$HOOK.bak-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$HOOK" "$BAK"
    echo "• moved your existing pre-push hook to $BAK"
  fi
fi
printf '%s\n' "$NEW" >"$HOOK"
chmod +x "$HOOK"
echo "✓ pre-push hook installed: $HOOK (runs bun run check)"
