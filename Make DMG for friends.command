#!/bin/bash
# Double-click to make a .dmg installer of ProtoArt Press to share with friends.
# Builds a fresh app, checks it, and packs it with an Applications shortcut.
cd "$(dirname "$0")"
ROOT="$(pwd)"
APP_NAME="ProtoArt Press"
APP="$ROOT/$APP_NAME.app"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
mkdir -p "$ROOT/dist"
DMG="$ROOT/dist/ProtoArt-Press-${VERSION}.dmg"
LOG="$ROOT/dist/dmg-log.txt"
exec > >(tee "$LOG") 2>&1
step() { printf '\n== %s\n' "$*"; }
fail() { printf '\nSTATUS: FAILED (%s)\n' "$*"; read -r -p "Press Return to close this window." _; exit 1; }

step "Running tests"
if command -v node >/dev/null 2>&1; then
  node --test "$ROOT"/tests/*.test.js >/dev/null 2>&1 && echo "All tests passed." || fail "tests failed (run: npm test)"
else
  fail "Node.js is needed to run the tests"
fi

step "Building a fresh copy of the app"
bash "$ROOT/Build ProtoArt Press.command" --no-open < /dev/null || fail "the build didn't finish"
[ -d "$APP" ] || fail "the build didn't produce $APP_NAME.app"

step "Checking it"
codesign --verify --deep --strict "$APP" >/dev/null 2>&1 && echo "Signature OK." || fail "the signature didn't verify"
[ -f "$APP/Contents/Resources/Licenses/LICENSES.chromium.html" ] && echo "License notices included." || fail "license notices missing"
ARCH="$(lipo -archs "$APP/Contents/MacOS/Electron" 2>/dev/null || file "$APP/Contents/MacOS/Electron")"
echo "Runs on: $ARCH"

step "Packing the DMG"
STAGE="$(mktemp -d)/$APP_NAME"
mkdir -p "$STAGE"
cp -cR "$APP" "$STAGE/" 2>/dev/null || cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
echo "Compressing (a minute or two)…"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format ULFO -fs HFS+ "$DMG" >/dev/null ||
  hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null ||
  fail "hdiutil couldn't create the DMG"
rm -rf "$(dirname "$STAGE")"
hdiutil verify "$DMG" >/dev/null 2>&1 && echo "DMG checked OK."
(cd "$ROOT/dist" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")
echo "SHA-256: $(cut -d' ' -f1 "$DMG.sha256")"
echo "Size: $(du -h "$DMG" | cut -f1)"
echo
echo "STATUS: DONE"
open -R "$DMG"
