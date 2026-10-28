#!/bin/bash
# Double-click to build "ProtoArt Press.app" next to this file and open it.
#   --no-open   build only (used by "Make DMG for friends.command")
# Electron comes from ./node_modules (npm ci && npx install-electron). As a local
# fallback it can reuse a copy from $PRESS_ELECTRON_APP or ../app/node_modules,
# but only if it is exactly the version pinned in package.json.
cd "$(dirname "$0")"
ROOT="$(pwd)"
exec > >(tee "$ROOT/build-log.txt") 2>&1

APP_NAME="ProtoArt Press"
BUNDLE_ID="local.protoart.press"
APP="$ROOT/$APP_NAME.app"
RES="$APP/Contents/Resources"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
ELECTRON_VERSION="$(sed -n 's/.*"electron": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
step() { printf '\n== %s\n' "$*"; }
fail() { printf '\nSTATUS: FAILED (%s)\n' "$*"; [ -t 0 ] && read -r -p "Press Return to close this window." _; exit 1; }
clone() { cp -cR "$1" "$2" 2>/dev/null || cp -R "$1" "$2"; }

step "1/6 Checking"
[ "$(uname -s)" = "Darwin" ] || fail "this builds a Mac app, so it has to run on a Mac"
[ -f "$ROOT/app/main.js" ] || fail "app files missing"
ELECTRON_APP=""
for candidate in "$ROOT/node_modules/electron/dist/Electron.app" "${PRESS_ELECTRON_APP:-}" "$ROOT/../app/node_modules/electron/dist/Electron.app"; do
  [ -n "$candidate" ] && [ -d "$candidate" ] && { ELECTRON_APP="$candidate"; break; }
done
[ -n "$ELECTRON_APP" ] || fail "Electron not found. Run: npm ci && npx install-electron"
FOUND_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ELECTRON_APP/Contents/Info.plist" 2>/dev/null)"
[ "$FOUND_VERSION" = "$ELECTRON_VERSION" ] || fail "Electron $FOUND_VERSION found, but package.json pins $ELECTRON_VERSION"
ELECTRON_DIST="$(dirname "$ELECTRON_APP")"
echo "Electron $FOUND_VERSION from ${ELECTRON_APP/#$HOME/~}"
FUSES=""
for candidate in "$ROOT/node_modules/@electron/fuses/dist/bin.js" "$(dirname "$(dirname "$ELECTRON_DIST")")/@electron/fuses/dist/bin.js"; do
  [ -f "$candidate" ] && { FUSES="$candidate"; break; }
done
[ -n "$FUSES" ] || fail "@electron/fuses not found. Run: npm ci"
command -v node >/dev/null 2>&1 || fail "Node.js is needed to set Electron fuses"

step "2/6 App shell"
osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
rm -rf "$APP"
clone "$ELECTRON_APP" "$APP" || fail "couldn't copy Electron"
rm -f "$RES/default_app.asar"

step "3/6 App files"
mkdir -p "$RES/app"
cp "$ROOT/app/main.js" "$ROOT/app/preload.js" "$ROOT/app/fsafe.js" "$ROOT/app/validate.js" "$ROOT/app/package.json" "$RES/app/"
cp -R "$ROOT/app/engine" "$ROOT/app/renderer" "$RES/app/"

step "4/6 Licenses"
mkdir -p "$RES/Licenses"
cp "$ROOT/LICENSE" "$RES/Licenses/ProtoArt-Press-LICENSE.txt"
cp "$ROOT/NOTICE" "$RES/Licenses/ProtoArt-Press-NOTICE.txt"
cp "$ROOT/THIRD_PARTY_NOTICES.md" "$RES/Licenses/THIRD_PARTY_NOTICES.md"
cp "$ELECTRON_DIST/LICENSE" "$RES/Licenses/Electron-LICENSE.txt" || fail "Electron LICENSE missing"
cp "$ELECTRON_DIST/LICENSES.chromium.html" "$RES/Licenses/LICENSES.chromium.html" || fail "Chromium licenses missing"
echo "Copied 5 license files."

step "5/6 Name, icon, file types, permissions"
PL="$APP/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy
plset() { "$PB" -c "Set :$1 $3" "$PL" 2>/dev/null || "$PB" -c "Add :$1 $2 $3" "$PL"; }
pldel() { "$PB" -c "Delete :$1" "$PL" >/dev/null 2>&1 || true; }
plset CFBundleName string "\"$APP_NAME\""
plset CFBundleDisplayName string "\"$APP_NAME\""
plset CFBundleIdentifier string "$BUNDLE_ID"
plset CFBundleShortVersionString string "$VERSION"
plset CFBundleVersion string "$VERSION"
plset CFBundleIconFile string "icon.icns"
plset LSApplicationCategoryType string "public.app-category.utilities"
plset NSHumanReadableCopyright string "\"Apache-2.0 · ProtoArt Press contributors\""
# Electron's template asks for hardware and network allowances this app never uses.
for key in NSCameraUsageDescription NSMicrophoneUsageDescription NSAudioCaptureUsageDescription \
           NSBluetoothAlwaysUsageDescription NSBluetoothPeripheralUsageDescription \
           NSAppTransportSecurity ElectronAsarIntegrity; do
  pldel "$key"
done
pldel CFBundleDocumentTypes
"$PB" -c "Add :CFBundleDocumentTypes array" "$PL"
"$PB" -c "Add :CFBundleDocumentTypes:0 dict" "$PL"
"$PB" -c "Add :CFBundleDocumentTypes:0:CFBundleTypeName string Media" "$PL"
"$PB" -c "Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Editor" "$PL"
"$PB" -c "Add :CFBundleDocumentTypes:0:LSHandlerRank string Alternate" "$PL"
"$PB" -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes array" "$PL"
"$PB" -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes:0 string public.jpeg" "$PL"
"$PB" -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes:1 string public.png" "$PL"
"$PB" -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes:2 string com.adobe.pdf" "$PL"
"$PB" -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes:3 string public.movie" "$PL"
"$PB" -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes:4 string public.audio" "$PL"
"$PB" -c "Add :CFBundleDocumentTypes:1 dict" "$PL"
"$PB" -c "Add :CFBundleDocumentTypes:1:CFBundleTypeName string Folder" "$PL"
"$PB" -c "Add :CFBundleDocumentTypes:1:CFBundleTypeRole string Viewer" "$PL"
"$PB" -c "Add :CFBundleDocumentTypes:1:LSHandlerRank string None" "$PL"
"$PB" -c "Add :CFBundleDocumentTypes:1:LSItemContentTypes array" "$PL"
"$PB" -c "Add :CFBundleDocumentTypes:1:LSItemContentTypes:0 string public.folder" "$PL"
if [ -f "$ROOT/app/build/icon.png" ]; then
  ICONSET="$(mktemp -d)/icon.iconset"
  mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ROOT/app/build/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$ROOT/app/build/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns -o "$RES/icon.icns" "$ICONSET" && rm -f "$RES/electron.icns" && echo "Icon set."
fi

step "6/6 Hardening and signing"
# Fuses: no running the engine as plain Node, no NODE_OPTIONS / inspector, no
# extra file:// privileges (the panel is served from app://), encrypted cookies.
node "$FUSES" write --app "$APP" RunAsNode=off EnableNodeOptionsEnvironmentVariable=off \
  EnableNodeCliInspectArguments=off GrantFileProtocolExtraPrivileges=off EnableCookieEncryption=on >/dev/null \
  || fail "couldn't set Electron fuses"
node "$FUSES" read --app "$APP" | grep -E "RunAsNode|NodeOptions|Inspect|FileProtocol|Cookie" | sed 's/^/  /'
xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep --sign - "$APP" >"$ROOT/codesign-log.txt" 2>&1 || fail "couldn't sign the app (see codesign-log.txt)"
codesign --verify --deep --strict "$APP" >/dev/null 2>&1 || fail "the signature didn't verify"
echo "Signed (ad hoc) and verified."
touch "$APP"
echo
echo "STATUS: DONE"
[ "${1:-}" = "--no-open" ] || open "$APP"
