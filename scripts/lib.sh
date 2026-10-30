# shellcheck shell=bash disable=SC2034  # the constants are used by the scripts that source this file
# Shared shell functions for install.sh, uninstall.sh (repo root), scripts/install.sh, scripts/release.sh and
# app/build.sh. Source it; it defines functions and constants only and changes nothing on its own.
#
# One build path: build_engine (bun) + app/build.sh (Swift + bundle). Installers and the release script call these.

AITT_BUNDLE_ID=io.github.altoption.ai-task-tracking
AITT_APP_NAME="AI Task Tracking.app"
AITT_REPO=altoption/ai-task-tracking
# Overridable so tests can stub Launch Services.
AITT_LSREGISTER="${AITT_LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}"
# Release asset name: AI-Task-Tracking-<version>-macos.zip
AITT_ZIP_GLOB='AI-Task-Tracking-*-macos.zip'

aitt_zip_name() { printf 'AI-Task-Tracking-%s-macos.zip' "$1"; }
aitt_warn() { printf '! %s\n' "$*" >&2; }
aitt_die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# version_ge A B: true when dotted version A >= B (numeric parts; missing parts count as 0; "v" prefix ignored).
version_ge() {
  local a="${1#v}" b="${2#v}" i x y
  local -a pa pb
  IFS=. read -r -a pa <<<"$a"
  IFS=. read -r -a pb <<<"$b"
  for ((i = 0; i < 3; i++)); do
    x="${pa[i]:-0}"; y="${pb[i]:-0}"
    x="${x%%[!0-9]*}"; y="${y%%[!0-9]*}"
    x="${x:-0}"; y="${y:-0}"
    if ((10#$x > 10#$y)); then return 0; fi
    if ((10#$x < 10#$y)); then return 1; fi
  done
  return 0
}

# canon_dir DIR: the physical absolute path of DIR when it exists (so it matches what ps and Launch Services
# report: /tmp → /private/tmp), else DIR unchanged.
canon_dir() {
  if [ -d "$1" ]; then (cd "$1" && pwd -P); else printf '%s\n' "$1"; fi
}

# abs_path PATH: PATH with a leading ~ expanded and made absolute (relative to the current folder), without a
# trailing slash. App settings store it, so it must not depend on where the installer ran.
# shellcheck disable=SC2088  # "~" is the text a user typed
abs_path() {
  local p="$1"
  case "$p" in
    "~") p="$HOME" ;;
    "~/"*) p="$HOME/${p#\~/}" ;;
  esac
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  [ "$p" = / ] || p="${p%/}"
  printf '%s\n' "$p"
}

# should_register DIR: an install into ~/Applications or /Applications registers with Launch Services and seeds the
# app's defaults; any other folder (scratch, verify, release builds) never touches them. Both sides are compared
# as canonical paths, so a symlink or a trailing slash doesn't change the answer.
should_register() {
  local d
  d="$(canon_dir "${1%/}")"
  [ "$d" = "$(canon_dir "$HOME/Applications")" ] || [ "$d" = "$(canon_dir /Applications)" ]
}

# Ask one process to quit (like the Dock's Quit) by process id: argv = pid, app bundle path, optional "check".
# It quits only when that process's bundle is exactly the given path, so another copy of the app (same bundle id,
# another folder) is never asked. Prints none | other:<path> | ok. Keep identical to QUIT_APP_JXA in
# src/setup/uninstall.ts (tests/setup/uninstall.test.ts compares them).
QUIT_APP_JXA="$(cat <<'JXA'
ObjC.import('AppKit');
function run(argv) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
  if (!app || app.isNil()) return 'none';
  const url = app.bundleURL;
  const path = !url || url.isNil() ? '' : url.path.js;
  if (path !== argv[1]) return 'other:' + path;
  if (argv[2] !== 'check') app.terminate;
  return 'ok';
}
JXA
)"

# app_pids APP: ids of the processes whose executable is inside APP/Contents/MacOS/ (an exact path prefix, never a
# name pattern). APP must be canonical (canon_dir) to match.
app_pids() {
  local prefix="${1%/}/Contents/MacOS/" pid comm
  /bin/ps -axo pid=,comm= | while read -r pid comm; do
    case "$comm" in "$prefix"*) printf '%s\n' "$pid" ;; esac
  done
}

# quit_app APP [timeout_s]: quit the app running from APP (only that copy) and wait for it to exit. Quitting may
# first back up to GitHub (a "Syncing before quit…" window), so the default wait is 90 s. Returns 1 if it is still
# running then.
quit_app() {
  local app="${1%/}" timeout="${2:-90}" pids pid i
  pids="$(app_pids "$app")"
  [ -n "$pids" ] || return 0
  echo "quitting the running $(basename "$app" .app)…"
  for pid in $pids; do
    osascript -l JavaScript -e "$QUIT_APP_JXA" "$pid" "$app" >/dev/null 2>&1 || true
  done
  for ((i = 0; i < timeout * 4; i++)); do
    [ -z "$(app_pids "$app")" ] && return 0
    sleep 0.25
  done
  aitt_warn "$app is still running after ${timeout} s (a backup prompt may be waiting); answer it or quit from the menu bar, then run the installer again"
  return 1
}

# build_engine ROOT: the compiled engine (ROOT/dist/aitt) for this Mac's architecture, with the UI and the docs site
# embedded. `bun run build` builds the docs first; if that fails it warns ("docs not built: …", on stderr) and builds
# the engine without them, so an install never fails over the docs (the engine's /docs/ then says how to build them).
build_engine() {
  (cd "$1" && bun install --frozen-lockfile >/dev/null && bun run build >/dev/null)
}

# build_app ROOT DEST_DIR [extra app/build.sh flags…]: build "AI Task Tracking.app" into DEST_DIR, registering it
# only when should_register DEST_DIR.
build_app() {
  local root="$1" dest="$2" reg=--no-register
  shift 2
  should_register "$dest" && reg=--register
  "$root/app/build.sh" "$reg" "$@" "$dest" >/dev/null
}

# register_app APP: what an install into ~/Applications does besides copying the bundle: start the menu bar item
# near the right (new items go to the far left, hidden behind the notch on a full bar) and register the aitt://
# scheme with Launch Services.
register_app() {
  local pos="NSStatusItem Preferred Position Item-0"
  if ! defaults read "$AITT_BUNDLE_ID" "$pos" >/dev/null 2>&1; then
    defaults write "$AITT_BUNDLE_ID" "$pos" -float 520
  fi
  "$AITT_LSREGISTER" -f "$1" >/dev/null 2>&1 || true
}

# verify_app APP: the bundle's signature is intact and Gatekeeper accepts it (Developer ID + notarized).
verify_app() {
  codesign --verify --deep --strict "$1" >/dev/null 2>&1 || { aitt_warn "codesign rejects $1"; return 1; }
  spctl -a -vv -t exec "$1" >/dev/null 2>&1 || { aitt_warn "Gatekeeper (spctl) rejects $1"; return 1; }
}

# run_setup AITT [args…]: run `aitt setup`. A failure (e.g. one agent tool couldn't be connected) is reported but
# doesn't stop the install, so the app is still launched; only an interrupt (exit 130) stops it.
run_setup() {
  local rc=0
  "$@" || rc=$?
  if [ "$rc" -eq 130 ]; then return 130; fi
  if [ "$rc" -ne 0 ]; then aitt_warn "aitt setup exited with $rc (see ✗ above); fix that and run: aitt setup"; fi
  return 0
}
