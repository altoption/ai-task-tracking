#!/bin/bash
# Install or upgrade AI Task Tracking on this Mac. Run with --help for the options.
#   curl -fsSL https://raw.githubusercontent.com/altoption/ai-task-tracking/HEAD/install.sh | bash
#   … | bash -s -- --yes        (options when piped)
#   ./install.sh [options]      (from a clone)
set -euo pipefail

REPO=altoption/ai-task-tracking
# The repo is public: everything is fetched with curl and git, no GitHub account or CLI needed.
RAW_URL="https://raw.githubusercontent.com/$REPO"
API_URL="https://api.github.com/repos/$REPO"
DOWNLOAD_URL="https://github.com/$REPO/releases/download"
MIN_MACOS=13
MIN_BUN=1.4

YES=0 DRY=0 FROM_SOURCE=0 LAUNCH=1 VERSION="" CONNECT=""
CLONE="" TMP_DIRS=() APP="" SWAP_OLD="" WAS_RUNNING="" INSTALL_LOCK=""

# The help text lives here (not only in comments) so --help also works when the script is piped into bash.
usage() {
  cat <<'USAGE'
Install AI Task Tracking on this Mac (macOS 13+, Apple Silicon or Intel). Re-running it upgrades: the app is
quit and replaced, and reopened only if it was running; your data folder and settings stay.

  curl -fsSL https://raw.githubusercontent.com/altoption/ai-task-tracking/HEAD/install.sh | bash
  … | bash -s -- [options]       (options when piped)
  ./install.sh [options]         (from a clone: builds that checkout when no release is used)

It checks what this Mac has, shows what it will do, and asks once. Then it installs the latest notarized
release (or builds from source when there is none, it fails verification, or --from-source; Bun is then
installed if missing), links ~/.local/bin/aitt, runs `aitt setup` and, on a first install, opens the app.

Options:
  --yes             don't ask; take the defaults
  --dry-run         only show what was found and what would happen
  --from-source     build from source even when a release is available
  --version <tag>   that release (or source tag) instead of the latest, e.g. v0.2.0
  --no-launch       don't open the app, at the end or after a failure
  --connect <tools> connect these other agent tools (comma-separated, as in aitt setup --connect); a scratch
                    install connects none otherwise
Environment:
  AITT_HOME=<dir>     data folder (default: the one the app already uses, else asked; ~/AITaskTracking)
  AITT_APP_DIR=<dir>  where the app goes (default ~/Applications). A folder other than ~/Applications or
                      /Applications is a scratch install: not registered with macOS, no app settings written,
                      no Claude Code MCP entry, no aitt link and no other agent tools (unless --connect).
USAGE
}
# On every exit, signals included. Between the swap's two renames the old app sits in the stage folder: it goes back
# before that folder is removed, and if it can't, the folder stays so the old app isn't lost. /bin/mv: nothing on PATH
# gets a say in the last rename.
cleanup() {
  local d keep=""
  if [ -n "$SWAP_OLD" ] && [ -e "$SWAP_OLD" ] && [ ! -e "$APP" ]; then
    if /bin/mv "$SWAP_OLD" "$APP"; then
      reopen_kept
    else
      keep="$(dirname "$SWAP_OLD")"
      aitt_warn "the old app could not be put back; it is at $SWAP_OLD. Move it to $APP."
    fi
  fi
  for d in ${TMP_DIRS[@]+"${TMP_DIRS[@]}"}; do
    if [ "$d" != "$keep" ]; then rm -rf "$d"; fi
  done
  if [ -n "$INSTALL_LOCK" ]; then rm -rf "$INSTALL_LOCK"; fi
}
# new_tmp: a temp folder in $NEW_TMP, removed on exit. (Not through $(…): the list must live in this shell.)
new_tmp() {
  local t="${TMPDIR:-/tmp}"
  NEW_TMP="$(mktemp -d "${t%/}/aitt-install.XXXXXX")"
  TMP_DIRS+=("$NEW_TMP")
}
# new_stage: a temp folder inside APP_DIR in $NEW_TMP (same volume, so moving the new app in is a rename),
# removed on exit. The new app is built or unpacked there and moved into place only when it is complete.
new_stage() {
  NEW_TMP="$(mktemp -d "$APP_DIR/.aitt-install.XXXXXX")"
  TMP_DIRS+=("$NEW_TMP")
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes | -y) YES=1 ;;
      --dry-run) DRY=1 ;;
      --from-source) FROM_SOURCE=1 ;;
      --no-launch) LAUNCH=0 ;;
      --connect)
        [ $# -ge 2 ] || { echo "✗ --connect needs a list of tools, e.g. codex,cursor" >&2; exit 2; }
        CONNECT="$2"; shift ;;
      --version)
        [ $# -ge 2 ] || { echo "✗ --version needs a tag, e.g. v0.2.0" >&2; exit 2; }
        VERSION="$2"; shift ;;
      -h | --help) usage; exit 0 ;;
      *) echo "✗ unknown option $1 (see --help)" >&2; exit 2 ;;
    esac
    shift
  done
  case "$VERSION" in [0-9]*) VERSION="v$VERSION" ;; esac
}

# scripts/lib.sh: from this checkout, else downloaded from the repo (when this script was piped into bash).
load_lib() {
  local src="${BASH_SOURCE[0]:-}" here="" lib
  if [ -n "$src" ] && [ -f "$src" ]; then here="$(cd "$(dirname "$src")" && pwd -P)"; fi
  if [ -n "$here" ] && [ -f "$here/scripts/lib.sh" ] && [ -x "$here/app/build.sh" ]; then
    CLONE="$here"
    # shellcheck source=scripts/lib.sh
    . "$here/scripts/lib.sh"
    return
  fi
  new_tmp
  lib="$NEW_TMP/lib.sh"
  # The same ref as the release asked for, so the functions match the version being installed.
  curl -fsSL "$RAW_URL/${VERSION:-HEAD}/scripts/lib.sh" -o "$lib" ||
    { echo "✗ Could not download scripts/lib.sh from github.com/$REPO${VERSION:+ at $VERSION}; check your connection, then run this again." >&2; exit 1; }
  # shellcheck source=scripts/lib.sh
  . "$lib"
}

have_tty() { (: </dev/tty) 2>/dev/null; }

# json_str JSON KEY VALUE_PATTERN: the first string value of KEY that matches VALUE_PATTERN (grep BRE), else "".
json_str() {
  printf '%s' "$1" | grep -o "\"$2\": *\"$3\"" | head -n 1 | sed 's/^"[^"]*": *"//; s/"$//' || true
}

# ask QUESTION DEFAULT: the answer from the terminal (stdin may be this script), else the default.
ask() {
  local a=""
  if [ "$YES" = 1 ] || ! have_tty; then printf '%s\n' "$2"; return; fi
  printf '%s ' "$1" >/dev/tty
  IFS= read -r a </dev/tty || a=""
  printf '%s\n' "${a:-$2}"
}

# ---------- what this Mac has ----------

detect() {
  OS_VER="$(sw_vers -productVersion 2>/dev/null || echo 0)"
  ARCH="$(uname -m)"
  HAS_CLT=0; xcode-select -p >/dev/null 2>&1 && HAS_CLT=1
  # /usr/bin/git is only a stub that offers to install the Command Line Tools.
  HAS_GIT=0
  if command -v git >/dev/null 2>&1 && { [ "$HAS_CLT" = 1 ] || [ "$(command -v git)" != /usr/bin/git ]; }; then HAS_GIT=1; fi
  BUN="$(command -v bun 2>/dev/null || true)"
  if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"; fi
  BUN_VER=""; [ -n "$BUN" ] && BUN_VER="$("$BUN" --version 2>/dev/null || true)"
  BUN_OK=0; if [ -n "$BUN_VER" ] && version_ge "$BUN_VER" "$MIN_BUN"; then BUN_OK=1; fi
  HAS_CLAUDE=0; command -v claude >/dev/null 2>&1 && HAS_CLAUDE=1
  RELEASE_TAG="" RELEASE_ZIP=""
  if [ "$FROM_SOURCE" = 0 ]; then
    # The release's JSON from the GitHub API; no release (404) or no connection leaves both empty: a source build.
    local json
    json="$(curl -fsSL -H 'Accept: application/vnd.github+json' \
      "$API_URL/releases/${VERSION:+tags/}${VERSION:-latest}" 2>/dev/null || true)"
    RELEASE_TAG="$(json_str "$json" tag_name '[^"]*')"
    if [ -n "$RELEASE_TAG" ]; then RELEASE_ZIP="$(json_str "$json" name 'AI-Task-Tracking-[^"/]*-macos[.]zip')"; fi
  fi
  INSTALLED_VER=""
  if [ -f "$APP/Contents/Info.plist" ]; then
    INSTALLED_VER="$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist" 2>/dev/null || echo '?')"
  fi
}

# ---------- the plan ----------

plan() {
  METHOD=source
  if [ -n "$RELEASE_ZIP" ]; then METHOD=release; fi
  BLOCKERS=()
  version_ge "$OS_VER" "$MIN_MACOS" || BLOCKERS+=("macOS $MIN_MACOS or later is required (this Mac has $OS_VER)")
}

row() { printf '  %-28s %-34s %s\n' "$1" "$2" "$3"; }

print_table() {
  local src
  echo "AI Task Tracking installer"
  echo
  row "Requirement" "Found" "What happens"
  row "macOS $MIN_MACOS+" "$OS_VER ($ARCH)" "$(version_ge "$OS_VER" "$MIN_MACOS" && echo — || echo 'not supported')"
  if [ "$METHOD" = release ]; then
    row "Release" "$RELEASE_TAG ($RELEASE_ZIP)" "download, verify signature + notarization"
    row "" "" "(builds from source if verification fails)"
    row "Bun $MIN_BUN+ (for that case)" "${BUN_VER:-missing}" "$([ "$BUN_OK" = 1 ] && echo — || echo 'installed from bun.sh only if a source build is needed (asks first)')"
  else
    if [ "$FROM_SOURCE" = 1 ]; then src="--from-source"; else src="no release${VERSION:+ $VERSION}"; fi
    row "Release" "$src" "build from source"
    row "Xcode Command Line Tools" "$([ "$HAS_CLT" = 1 ] && echo found || echo missing)" "$([ "$HAS_CLT" = 1 ] && echo — || echo 'install (xcode-select --install), then run this again')"
    row "git" "$([ "$HAS_GIT" = 1 ] && echo found || echo missing)" "$([ "$HAS_GIT" = 1 ] && echo — || echo 'comes with the Command Line Tools')"
    row "Bun $MIN_BUN+" "${BUN_VER:-missing}" "$([ "$BUN_OK" = 1 ] && echo — || echo 'install from bun.sh (curl | bash)')"
    # shellcheck disable=SC2088  # display text
    if [ -n "$CLONE" ]; then row "Source" "this checkout" "$CLONE"
    elif [ -d "$HOME/.aitt/src/.git" ]; then row "Source" "~/.aitt/src" "update${VERSION:+ to $VERSION}"
    else row "Source" "—" "clone $REPO to ~/.aitt/src"; fi
  fi
  row "Claude Code (optional)" "$([ "$HAS_CLAUDE" = 1 ] && echo found || echo missing)" "$([ "$HAS_CLAUDE" = 1 ] && echo 'register the ai-task-tracking MCP server' || echo 'skipped; aitt setup later')"
  if [ -n "$INSTALLED_VER" ]; then
    row "AI Task Tracking" "$INSTALLED_VER installed" "upgrade: quit, replace (data and settings kept)"
  else
    row "AI Task Tracking" "not installed" "install to $APP_DIR"
  fi
  local opening=""
  if [ "$LAUNCH" = 1 ]; then
    if [ -n "$INSTALLED_VER" ]; then opening=', reopen the app if it was running'; else opening=', open the app'; fi
  fi
  row "Then" "" "link ~/.local/bin/aitt, run aitt setup$opening"
  should_register "$APP_DIR" || row "" "" "(scratch folder: not registered with macOS or agent tools, no app settings)"
  if [ ${#BLOCKERS[@]} -gt 0 ]; then
    echo
    local b
    for b in "${BLOCKERS[@]}"; do echo "✗ $b"; done
  fi
  echo
}

# ---------- doing it ----------

ensure_source_prereqs() {
  if [ "$HAS_CLT" = 0 ]; then
    echo "installing the Xcode Command Line Tools (a macOS dialog opens)…"
    xcode-select --install >/dev/null 2>&1 || true
    echo "When that installation has finished, run this installer again."
    exit 1
  fi
  if [ "$BUN_OK" = 0 ]; then
    # Planned (source build): the table said so. Falling back from a release: ask, since the table only said "may".
    if [ "$METHOD" = release ] && [ "$YES" = 0 ]; then
      case "$(ask "Building from source needs Bun. Install it from bun.sh? [Y/n]" y)" in
        [Yy]* | "") ;;
        *) aitt_die "Not installing Bun; nothing was replaced. Install Bun $MIN_BUN+ yourself, then run this again." ;;
      esac
    fi
    echo "installing Bun (https://bun.sh/install)…"
    curl -fsSL https://bun.sh/install | bash
    BUN="$HOME/.bun/bin/bun"
    version_ge "$("$BUN" --version)" "$MIN_BUN" || aitt_die "Bun $MIN_BUN or later is needed"
  fi
  PATH="$(dirname "$BUN"):$PATH"
  export PATH
}

# reopen_kept: a failure after quitting: the kept app goes back to running, unless --no-launch.
reopen_kept() {
  if [ -n "$WAS_RUNNING" ] && [ "$LAUNCH" = 1 ] && [ -d "$APP" ]; then open "$APP" || true; fi
}

# take_lock: one install at a time into a folder. A lock whose process is gone is taken over.
take_lock() {
  local lock="$APP_DIR/.aitt-install.lock" pid attempt
  for attempt in 1 2 3; do
    if mkdir "$lock" 2>/dev/null; then
      echo "$$" >"$lock/pid"
      INSTALL_LOCK="$lock"
      return 0
    fi
    pid="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      aitt_die "another install is running (pid $pid); try again when it is done. Nothing was replaced."
    fi
    # No pid yet may be another installer between its mkdir and its write: give it a moment before calling it stale.
    if [ -z "$pid" ] && [ "$attempt" = 1 ]; then sleep 1; continue; fi
    rm -rf "$lock"
  done
  aitt_die "could not take the install lock $lock. Nothing was replaced."
}

# swap_in NEW_APP: NEW_APP is a complete bundle in a stage folder inside APP_DIR. Check that it runs, then quit only
# the copies in APP_DIR and rename: the old app aside, the new one in place (the old one comes back if that fails),
# the old one removed.
swap_in() {
  local new="$1" old
  "$new/Contents/Resources/aitt" --version >/dev/null 2>&1 </dev/null || aitt_die "the new app doesn't run; nothing was replaced"
  WAS_RUNNING="$(app_pids "$APP")"
  quit_app "$APP" || exit 1
  old="$(dirname "$new")/previous.app"
  SWAP_OLD="$old"
  if [ -e "$APP" ] && ! mv "$APP" "$old"; then
    reopen_kept
    aitt_die "could not move the old app aside; it was kept"
  fi
  if ! mv "$new" "$APP"; then
    if [ -e "$old" ]; then mv "$old" "$APP"; fi
    reopen_kept
    aitt_die "could not move the new app into place; the old one was kept"
  fi
  rm -rf "$old"
  if should_register "$APP_DIR"; then register_app "$APP"; fi
}

install_release() {
  local dl app
  new_tmp
  dl="$NEW_TMP"
  echo "downloading $RELEASE_ZIP ($RELEASE_TAG)…"
  curl -fsSL "$DOWNLOAD_URL/$RELEASE_TAG/$RELEASE_ZIP" -o "$dl/$RELEASE_ZIP" || return 1
  # The checksum file is published next to the zip; older releases may not have one.
  if curl -fsSL "$DOWNLOAD_URL/$RELEASE_TAG/$RELEASE_ZIP.sha256" -o "$dl/$RELEASE_ZIP.sha256" 2>/dev/null; then
    (cd "$dl" && shasum -a 256 -c "$RELEASE_ZIP.sha256" >/dev/null 2>&1) || { aitt_warn "$RELEASE_ZIP doesn't match its .sha256"; return 1; }
  fi
  new_stage
  ditto -x -k "$dl/$RELEASE_ZIP" "$NEW_TMP" || return 1
  app="$NEW_TMP/$AITT_APP_NAME"
  [ -d "$app" ] || { aitt_warn "$RELEASE_ZIP has no $AITT_APP_NAME"; return 1; }
  verify_app "$app" || return 1
  echo "✓ signature and notarization verified"
  swap_in "$app"
}

install_source() {
  local src
  ensure_source_prereqs
  if [ -n "$CLONE" ]; then
    src="$CLONE"
    [ -n "$VERSION" ] && aitt_warn "--version is ignored when building a checkout; building $src as it is"
  else
    src="$HOME/.aitt/src"
    if [ -d "$src/.git" ]; then
      echo "updating $src…"
      git -C "$src" fetch --quiet --tags origin
      git -C "$src" checkout --quiet --detach "${VERSION:-origin/HEAD}"
    else
      echo "cloning $REPO to $src…"
      mkdir -p "$(dirname "$src")"
      git clone --quiet "https://github.com/$REPO.git" "$src"
      if [ -n "$VERSION" ]; then git -C "$src" checkout --quiet --detach "$VERSION"; fi
    fi
  fi
  echo "building the engine…"
  build_engine "$src"
  echo "building the app (this takes a few minutes the first time)…"
  new_stage
  "$src/app/build.sh" --no-register "$NEW_TMP" >/dev/null
  swap_in "$NEW_TMP/$AITT_APP_NAME"
}

post_install() {
  local aitt="$APP/Contents/Resources/aitt" home
  home="${AITT_HOME:-}"
  if [ -z "$home" ] && should_register "$APP_DIR"; then home="$(defaults read "$AITT_BUNDLE_ID" trackerHome 2>/dev/null || true)"; fi
  # shellcheck disable=SC2088  # the default as the user sees it; abs_path turns it into a path
  if [ -z "$home" ]; then home="$(ask "Data folder [~/AITaskTracking]" "~/AITaskTracking")"; fi
  home="$(abs_path "$home")" # the app stores it, so never relative
  # A scratch install never points the user's agent tools (Claude Code, the aitt link, others) at a scratch build.
  local args=(setup --home "$home" --binary "$aitt")
  if ! should_register "$APP_DIR"; then args+=(--no-mcp --no-link --no-skill --no-claude-md); fi
  if [ -n "$CONNECT" ]; then args+=(--connect "$CONNECT")
  elif ! should_register "$APP_DIR"; then args+=(--no-connect); fi
  if [ "$YES" = 1 ] || ! have_tty; then
    run_setup "$aitt" "${args[@]}" --yes
  else
    run_setup "$aitt" "${args[@]}" </dev/tty
  fi
  if should_register "$APP_DIR"; then
    defaults write "$AITT_BUNDLE_ID" trackerHome -string "$home"
    # A first install only: the user may have turned Launch at Login off since.
    if [ -z "$INSTALLED_VER" ]; then defaults write "$AITT_BUNDLE_ID" enableLoginItemOnLaunch -bool true; fi
  fi
  # An upgrade reopens the app only if it was running.
  local opened=0
  if [ "$LAUNCH" = 1 ] && { [ -z "$INSTALLED_VER" ] || [ -n "$WAS_RUNNING" ]; }; then open "$APP"; opened=1; fi
  echo
  echo "✓ AI Task Tracking $(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist" 2>/dev/null || true) is installed: $APP"
  echo "  data: $home"
  echo "  menu bar: the AI Task Tracking icon; ⌥⌘I opens it. Terminal: aitt (aitt setup to change settings)."
  [ "$opened" = 1 ] || echo "  Not opened: open \"$APP\""
}

main() {
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  parse_args "$@"
  load_lib
  APP_DIR="${AITT_APP_DIR:-$HOME/Applications}"
  APP_DIR="$(canon_dir "$APP_DIR")"
  APP="$APP_DIR/$AITT_APP_NAME"
  detect
  plan
  print_table
  if [ "$DRY" = 1 ]; then echo "Dry run: nothing was changed."; return 0; fi
  [ ${#BLOCKERS[@]} -eq 0 ] || exit 1
  if [ "$YES" = 0 ]; then
    have_tty || aitt_die "No terminal to ask on; run it again with --yes to install without asking."
    case "$(ask "Install missing items and AI Task Tracking? [Y/n]" y)" in [Yy]* | "") ;; *) echo "Nothing was changed."; exit 1 ;; esac
  fi
  mkdir -p "$APP_DIR"
  APP_DIR="$(canon_dir "$APP_DIR")"
  APP="$APP_DIR/$AITT_APP_NAME"
  take_lock
  if [ "$METHOD" = release ] && ! install_release; then
    aitt_warn "the release couldn't be installed; building from source instead"
    install_source
  elif [ "$METHOD" = source ]; then
    install_source
  fi
  post_install
}

# Everything runs from main, so a partly downloaded script does nothing.
main "$@"
