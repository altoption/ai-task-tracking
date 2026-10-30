#!/bin/bash
# Maintainer only: build, sign, notarize and publish a release of AI Task Tracking.
#
#   scripts/release.sh <version> [--skip-notarize] [--no-publish] [--out <dir>]
#
# 1. Checks first (before the long build): <version> is package.json's version, a signing identity, the notary
#    profile, and (when publishing) that release v<version> doesn't exist yet.
# 2. Builds the engine for Apple Silicon and Intel (bun --compile) and joins them into one universal binary
#    (lipo), then the universal app through app/build.sh --universal --no-register (never registered or installed).
# 3. Signs inside-out with the hardened runtime and a secure timestamp: the engine with app/engine.entitlements,
#    then the app. Identity: $AITT_SIGN_ID, default the first "Developer ID Application" identity in the keychain.
# 4. Notarizes (xcrun notarytool, keychain profile $AITT_NOTARY_PROFILE, default aitt-notary) and staples.
# 5. Zips as AI-Task-Tracking-<version>-macos.zip (+ .sha256) in --out (default dist/release/<version>) and
#    creates the GitHub release v<version> on altoption/ai-task-tracking with the zip attached, tagging the
#    commit that was built (publishing needs a clean tree whose HEAD is already pushed).
#
#   --skip-notarize   sign only (local testing). Such a build is never published, so it needs --no-publish.
#   --no-publish      stop after the zip.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib.sh
. "$ROOT/scripts/lib.sh"

usage() { sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

VERSION="" NOTARIZE=1 PUBLISH=1 OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-notarize) NOTARIZE=0 ;;
    --no-publish) PUBLISH=0 ;;
    --out) [ $# -ge 2 ] || { usage >&2; exit 2; }; OUT="$2"; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "release.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
    *) [ -z "$VERSION" ] || { usage >&2; exit 2; }; VERSION="${1#v}" ;;
  esac
  shift
done
[ -n "$VERSION" ] || { usage >&2; exit 2; }

# ---------- 1. checks ----------

PKG_VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/package.json")"
[ "$VERSION" = "$PKG_VERSION" ] ||
  aitt_die "version $VERSION isn't package.json's ($PKG_VERSION); set \"version\" in package.json first (the app shows it)"
if [ "$NOTARIZE" = 0 ] && [ "$PUBLISH" = 1 ]; then
  aitt_die "a build that isn't notarized is never published; add --no-publish (or drop --skip-notarize)"
fi

IDENTITY="${AITT_SIGN_ID:-$(security find-identity -v -p codesigning 2>/dev/null |
  sed -n 's/^ *[0-9][0-9]*) [0-9A-F]\{40\} "\(Developer ID Application: .*\)"$/\1/p' | head -n 1)}"
[ -n "$IDENTITY" ] ||
  aitt_die "no \"Developer ID Application\" signing identity in the keychain (security find-identity -v -p codesigning); install one or set AITT_SIGN_ID"
TEAM_ID="$(printf '%s' "$IDENTITY" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p')"

PROFILE="${AITT_NOTARY_PROFILE:-aitt-notary}"
if [ "$NOTARIZE" = 1 ] && ! xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  {
    echo "✗ No notarization credentials in the keychain profile \"$PROFILE\". Store them once with:"
    echo "    xcrun notarytool store-credentials \"$PROFILE\" --apple-id <your Apple ID email> --team-id ${TEAM_ID:-<your team ID>} --password <app-specific password>"
    echo "  (an app-specific password from account.apple.com ▸ Sign-In and Security), or use --skip-notarize --no-publish to test."
  } >&2
  exit 1
fi

TAG="v$VERSION"
if [ "$PUBLISH" = 1 ]; then
  gh auth status --hostname github.com >/dev/null 2>&1 || aitt_die "gh isn't signed in (gh auth login)"
  if gh release view "$TAG" --repo "$AITT_REPO" >/dev/null 2>&1; then aitt_die "release $TAG already exists on $AITT_REPO"; fi
  [ -z "$(git -C "$ROOT" status --porcelain)" ] || aitt_die "the working tree has changes; release from a clean checkout"
  git -C "$ROOT" fetch --quiet origin || aitt_die "git fetch origin failed; the release must tag a pushed commit"
  [ -n "$(git -C "$ROOT" branch -r --contains HEAD)" ] || aitt_die "HEAD isn't on any branch of origin; push it first"
  COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
fi

OUT="${OUT:-$ROOT/dist/release/$VERSION}"
mkdir -p "$OUT"
OUT="$(canon_dir "$OUT")"
APP="$OUT/$AITT_APP_NAME"
ZIP="$OUT/$(aitt_zip_name "$VERSION")"
echo "release $VERSION → $OUT"
echo "  signing as: $IDENTITY"

# ---------- 2. build ----------

cd "$ROOT"
echo "building the engine (arm64 + x86_64)…"
bun install --frozen-lockfile >/dev/null
bun run build:ui >/dev/null
bun run docs:build >/dev/null # the docs site the engine serves at /docs/; a release always ships it
for arch in arm64 x64; do
  bun build --compile --target="bun-darwin-$arch" src/cli.ts --asset ui/dist --asset site/dist/docs --outfile "dist/aitt-$arch" >/dev/null
done
lipo -create -output dist/aitt dist/aitt-arm64 dist/aitt-x64
echo "building the app (universal)…"
"$ROOT/app/build.sh" --no-register --universal "$OUT" >/dev/null

for f in "$APP/Contents/MacOS/AITaskTracking" "$APP/Contents/Resources/aitt"; do
  archs=" $(lipo -archs "$f") "
  case "$archs" in *" arm64 "*) ;; *) aitt_die "$f has no arm64 slice ($archs)" ;; esac
  case "$archs" in *" x86_64 "*) ;; *) aitt_die "$f has no x86_64 slice ($archs)" ;; esac
done

# ---------- 3. sign ----------

echo "signing…"
codesign --force --options runtime --timestamp --entitlements "$ROOT/app/engine.entitlements" --sign "$IDENTITY" "$APP/Contents/Resources/aitt"
codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

# ---------- 4. notarize ----------

if [ "$NOTARIZE" = 1 ]; then
  echo "notarizing (this takes a few minutes)…"
  ditto -c -k --keepParent "$APP" "$OUT/notarize.zip"
  # notarytool exits 0 for a rejected submission too, so read the status it reports.
  result="$(xcrun notarytool submit "$OUT/notarize.zip" --keychain-profile "$PROFILE" --wait --output-format json)" ||
    aitt_die "notarytool submit failed"
  rm -f "$OUT/notarize.zip"
  status="$(printf '%s' "$result" | plutil -extract status raw -o - - 2>/dev/null || true)"
  if [ "$status" != Accepted ]; then
    id="$(printf '%s' "$result" | plutil -extract id raw -o - - 2>/dev/null || true)"
    echo "✗ notarization status: ${status:-unknown}" >&2
    if [ -n "$id" ]; then xcrun notarytool log "$id" --keychain-profile "$PROFILE" >&2 || true; fi
    exit 1
  fi
  xcrun stapler staple "$APP"
  spctl -a -vv -t exec "$APP"
else
  echo "not notarized (--skip-notarize): Gatekeeper will reject this build on other Macs"
fi

# ---------- 5. zip and publish ----------

rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
(cd "$OUT" && shasum -a 256 "$(basename "$ZIP")" >"$(basename "$ZIP").sha256")
echo "✓ $ZIP"
echo "  app $(lipo -archs "$APP/Contents/MacOS/AITaskTracking"), engine $(lipo -archs "$APP/Contents/Resources/aitt")"

if [ "$PUBLISH" = 1 ]; then
  gh release create "$TAG" "$ZIP" "$ZIP.sha256" --repo "$AITT_REPO" --target "$COMMIT" --title "AI Task Tracking $VERSION" \
    --notes "Install or upgrade: curl -fsSL https://raw.githubusercontent.com/$AITT_REPO/HEAD/install.sh | bash"
  echo "✓ published $TAG on $AITT_REPO"
else
  echo "not published (--no-publish)"
fi
