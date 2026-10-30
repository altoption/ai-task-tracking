#!/bin/bash
# Install or upgrade AI Task Tracking on this Mac. Run with --help for the options.
#   gh api repos/altoption/ai-task-tracking/contents/install.sh --jq .content | base64 -d | bash
#   … | bash -s -- --yes        (options when piped)
#   ./install.sh [options]      (from a clone)
set -euo pipefail

REPO=altoption/ai-task-tracking
MIN_MACOS=13
MIN_BUN=1.4

YES=0 DRY=0 FROM_SOURCE=0 LAUNCH=1 VERSION="" CONNECT=""
CLONE="" TMP_DIRS=()

# The help text lives here (not only in comments) so --help also works when the script is piped into bash.
usage() {
  cat <<'USAGE'
Install AI Task Tracking on this Mac (macOS 13+, Apple Silicon or Intel). Re-running it upgrades: the app is
quit and replaced; your data folder and settings stay.

  gh api repos/altoption/ai-task-tracking/contents/install.sh --jq .content | base64 -d | bash
  … | bash -s -- [options]       (options when piped)
  ./install.sh [options]         (from a clone: builds that checkout when no release is used)

It checks what this Mac has, shows what it will do, and asks once. Then it installs the latest notarized
release (or builds from source when there is none, it fails verification, or --from-source; Bun is then
installed if missing), links ~/.local/bin/aitt, runs `aitt setup` and opens the app.

Options:
  --yes             don't ask; take the defaults
  --dry-run         only show what was found and what would happen
  --from-source     build from source even when a release is available
  --version <tag>   that release (or source tag) instead of the latest, e.g. v0.2.0
  --no-launch       don't open the app at the end
  --connect <tools> connect these other agent tools (comma-separated, as in aitt setup --connect); a scratch
                    install connects none otherwise
Environment:
  AITT_HOME=<dir>     data folder (default: the one the app already uses, else asked; ~/AITaskTracking)
  AITT_APP_DIR=<dir>  where the app goes (default ~/Applications). A folder other than ~/Applications or
                      /Applications is a scratch install: not registered with macOS, no app settings written,
                      no Claude Code MCP entry, no aitt link and no other agent tools (unless --connect).
USAGE
}
cleanup() { local d; for d in ${TMP_DIRS[@]+"${TMP_DIRS[@]}"}; do rm -rf "$d"; done; }
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

# scripts/lib.sh: from this checkout, else fetched from the repo with gh (when this script was piped into bash).
load_lib() {
  local src="${BASH_SOURCE[0]:-}" here="" lib
  if [ -n "$src" ] && [ -f "$src" ]; then here="$(cd "$(dirname "$src")" && pwd -P)"; fi
  if [ -n "$here" ] && [ -f "$here/scripts/lib.sh" ] && [ -x "$here/app/build.sh" ]; then
    CLONE="$here"
    # shellcheck source=scripts/lib.sh
    . "$here/scripts/lib.sh"
    return
  fi
  command -v gh >/dev/null 2>&1 || {
    echo "✗ The installer needs the GitHub CLI: brew install gh && gh auth login, then run it again." >&2
    exit 1
  }
  new_tmp
  lib="$NEW_TMP/lib.sh"
  # The same ref as the release asked for, so the functions match the version being installed.
  gh api "repos/$REPO/contents/scripts/lib.sh${VERSION:+?ref=$VERSION}" --jq .content | base64 -d >"$lib" ||
    { echo "✗ Could not read scripts/lib.sh from $REPO (gh auth status; do you have access?)" >&2; exit 1; }
  # shellcheck source=scripts/lib.sh
  . "$lib"
}

have_tty() { (: </dev/tty) 2>/dev/null; }

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
  HAS_BREW=0; command -v brew >/dev/null 2>&1 && HAS_BREW=1
  HAS_CLAUDE=0; command -v claude >/dev/null 2>&1 && HAS_CLAUDE=1
  HAS_GH=0 GH_AUTH=0 GH_REPO=0
  if command -v gh >/dev/null 2>&1; then
    HAS_GH=1
    gh auth status --hostname github.com >/dev/null 2>&1 && GH_AUTH=1
    if [ "$GH_AUTH" = 1 ] && gh api "repos/$REPO" --jq .full_name >/dev/null 2>&1; then GH_REPO=1; fi
  fi
  RELEASE_TAG="" RELEASE_ZIP=""
  if [ "$FROM_SOURCE" = 0 ] && [ "$GH_REPO" = 1 ]; then
    local out
    out="$(gh release view ${VERSION:+"$VERSION"} --repo "$REPO" --json tagName,assets \
      --jq '.tagName + " " + ([.assets[].name | select(test("^AI-Task-Tracking-.*-macos[.]zip$"))] | first // "")' 2>/dev/null || true)"
    if [ -n "$out" ]; then
      RELEASE_TAG="${out%% *}"
      RELEASE_ZIP="${out#* }"
      [ "$RELEASE_ZIP" = "$out" ] && RELEASE_ZIP=""
    fi
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
  NEED_GH=0
  if [ "$METHOD" = release ] || [ -z "$CLONE" ]; then NEED_GH=1; fi
  BLOCKERS=()
  version_ge "$OS_VER" "$MIN_MACOS" || BLOCKERS+=("macOS $MIN_MACOS or later is required (this Mac has $OS_VER)")
  if [ "$NEED_GH" = 1 ]; then
    if [ "$HAS_GH" = 0 ] && [ "$HAS_BREW" = 0 ]; then
      BLOCKERS+=("Install the GitHub CLI (https://cli.github.com), run gh auth login, then run this again")
    elif [ "$HAS_GH" = 1 ] && [ "$GH_AUTH" = 0 ]; then
      BLOCKERS+=("Sign the GitHub CLI in: gh auth login, then run this again")
    elif [ "$GH_AUTH" = 1 ] && [ "$GH_REPO" = 0 ]; then
      BLOCKERS+=("Your GitHub account can't read $REPO; ask for access, then run this again")
    fi
  fi
}

row() { printf '  %-28s %-34s %s\n' "$1" "$2" "$3"; }

print_table() {
  local gh_found gh_do src
  if [ "$HAS_GH" = 0 ]; then gh_found="missing"
  elif [ "$GH_AUTH" = 0 ]; then gh_found="found, not signed in"
  elif [ "$GH_REPO" = 0 ]; then gh_found="signed in, no access to repo"
  else gh_found="signed in, repo readable"; fi
  if [ "$NEED_GH" = 0 ]; then gh_do="not needed (building this checkout)"
  elif [ "$HAS_GH" = 0 ] && [ "$HAS_BREW" = 1 ]; then gh_do="install with Homebrew, then gh auth login"
  elif [ "$GH_REPO" = 1 ]; then gh_do="—"
  else gh_do="see below"; fi
  echo "AI Task Tracking installer"
  echo
  row "Requirement" "Found" "What happens"
  row "macOS $MIN_MACOS+" "$OS_VER ($ARCH)" "$(version_ge "$OS_VER" "$MIN_MACOS" && echo — || echo 'not supported')"
  row "GitHub CLI (gh)" "$gh_found" "$gh_do"
  row "Homebrew (optional)" "$([ "$HAS_BREW" = 1 ] && echo found || echo missing)" "only used to install gh"
  if [ "$METHOD" = release ]; then
    row "Release" "$RELEASE_TAG ($RELEASE_ZIP)" "download, verify signature + notarization"
    row "" "" "(builds from source if verification fails)"
    row "Bun $MIN_BUN+ (for that case)" "${BUN_VER:-missing}" "$([ "$BUN_OK" = 1 ] && echo — || echo 'installed from bun.sh only if a source build is needed (asks first)')"
  else
    if [ "$FROM_SOURCE" = 1 ]; then src="--from-source"; elif [ "$GH_REPO" = 1 ]; then src="no release${VERSION:+ $VERSION}"; else src="not checked"; fi
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
  row "Then" "" "link ~/.local/bin/aitt, run aitt setup$([ "$LAUNCH" = 1 ] && echo ', open the app')"
  should_register "$APP_DIR" || row "" "" "(scratch folder: not registered with macOS or agent tools, no app settings)"
  if [ ${#BLOCKERS[@]} -gt 0 ]; then
    echo
    local b
    for b in "${BLOCKERS[@]}"; do echo "✗ $b"; done
  fi
  echo
}

# ---------- doing it ----------

install_gh() {
  [ "$NEED_GH" = 1 ] && [ "$HAS_GH" = 0 ] || return 0
  echo "installing the GitHub CLI with Homebrew…"
  brew install gh
  if ! gh auth status --hostname github.com >/dev/null 2>&1; then
    echo "Now sign it in (gh auth login), then run this installer again."
    exit 1
  fi
}

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

# swap_in NEW_APP: NEW_APP is a complete bundle in a stage folder inside APP_DIR. Quit only the copies in APP_DIR,
# then rename: the old app aside, the new one in place (the old one comes back if that fails), the old one removed.
swap_in() {
  local new="$1" old
  quit_app "$APP" || exit 1
  old="$(dirname "$new")/previous.app"
  if [ -e "$APP" ]; then mv "$APP" "$old" || aitt_die "could not move the old app aside; it was kept"; fi
  if ! mv "$new" "$APP"; then
    if [ -e "$old" ]; then mv "$old" "$APP"; fi
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
  gh release download "$RELEASE_TAG" --repo "$REPO" --pattern "$RELEASE_ZIP" --dir "$dl" >/dev/null || return 1
  # The checksum file is published next to the zip; older releases may not have one.
  if gh release download "$RELEASE_TAG" --repo "$REPO" --pattern "$RELEASE_ZIP.sha256" --dir "$dl" >/dev/null 2>&1; then
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
      gh repo clone "$REPO" "$src" -- --quiet
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
    defaults write "$AITT_BUNDLE_ID" enableLoginItemOnLaunch -bool true
  fi
  if [ "$LAUNCH" = 1 ]; then open "$APP"; fi
  echo
  echo "✓ AI Task Tracking $(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist" 2>/dev/null || true) is installed: $APP"
  echo "  data: $home"
  echo "  menu bar: the AI Task Tracking icon; ⌥⌘I opens it. Terminal: aitt (aitt setup to change settings)."
  [ "$LAUNCH" = 1 ] || echo "  Not opened (--no-launch): open \"$APP\""
}

main() {
  trap cleanup EXIT
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
  install_gh
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
