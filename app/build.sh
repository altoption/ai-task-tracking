#!/bin/bash
# Build "AI Task Tracking.app" (menu bar) around the compiled engine into dest-dir (replacing any copy there).
# Usage: app/build.sh [--register | --no-register] [--universal] <dest-dir>   (expects dist/aitt from `bun run build`)
#   dest-dir is required: an install into ~/Applications goes through scripts/install.sh, which quits the app first.
#   Registers the aitt:// scheme with Launch Services and seeds the app's defaults only for an install into
#   ~/Applications or /Applications (or with --register). Scratch, verify and release builds pass --no-register
#   so they never touch the real defaults domain or claim the URL scheme.
#   --universal builds the Swift app for arm64 and x86_64 (scripts/release.sh; it also makes dist/aitt universal).
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$APP_DIR/.." && pwd)"
# shellcheck source=scripts/lib.sh
. "$ROOT/scripts/lib.sh"
REGISTER=""
ARCHS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --register) REGISTER=1; shift ;;
    --no-register) REGISTER=0; shift ;;
    --universal) ARCHS=(--arch arm64 --arch x86_64); shift ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "app/build.sh: unknown option $1 (see --help)" >&2; exit 2 ;;
    *) break ;;
  esac
done
[ $# -eq 1 ] || { echo "app/build.sh: give exactly one destination folder (see --help)" >&2; exit 2; }
DEST_DIR="$1"
DEST="$DEST_DIR/AI Task Tracking.app"
if [ -z "$REGISTER" ]; then
  if should_register "$DEST_DIR"; then REGISTER=1; else REGISTER=0; fi
fi
ENGINE="$ROOT/dist/aitt"
BUNDLE_ID="$AITT_BUNDLE_ID"
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/package.json")"

[ -x "$ENGINE" ] || { echo "app/build.sh: $ENGINE missing; run 'bun run build' first" >&2; exit 1; }

cd "$APP_DIR"
swift build -c release ${ARCHS[@]+"${ARCHS[@]}"} --product AITaskTracking >/dev/null
BIN="$(swift build -c release ${ARCHS[@]+"${ARCHS[@]}"} --show-bin-path)/AITaskTracking"

rm -rf "$DEST"
mkdir -p "$DEST/Contents/MacOS" "$DEST/Contents/Resources"
cp "$BIN" "$DEST/Contents/MacOS/AITaskTracking"
cp "$ENGINE" "$DEST/Contents/Resources/aitt"
cp "$APP_DIR/Resources/AppIcon.icns" "$DEST/Contents/Resources/"
# Optional menu-bar template image (monochrome; MenuBarIcon.png + @2x, or a PDF). Without it the app uses an SF Symbol.
for f in "$APP_DIR"/Resources/MenuBarIcon*; do [ -e "$f" ] && cp "$f" "$DEST/Contents/Resources/"; done
cat > "$DEST/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>AI Task Tracking</string>
  <key>CFBundleDisplayName</key><string>AI Task Tracking</string>
  <key>CFBundleExecutable</key><string>AITaskTracking</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>$BUNDLE_ID.link</string>
    <key>CFBundleURLSchemes</key><array><string>aitt</string></array>
  </dict></array>
</dict></plist>
PLIST
# Sign the nested engine first, then the bundle (ad hoc; local use only).
codesign --force --sign - "$DEST/Contents/Resources/aitt" >/dev/null 2>&1
codesign --force --sign - "$DEST" >/dev/null 2>&1
if [ "$REGISTER" != 1 ]; then echo "$DEST"; exit 0; fi
register_app "$DEST"
echo "$DEST"
