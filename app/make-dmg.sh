#!/usr/bin/env bash
# Builds dist/Perf Tool.dmg: Perf Tool.app with a built-in Node (Apple silicon + Intel), a copy of
# perf-tool, and the git remote it updates from.
#
#   app/make-dmg.sh [--identity "<signing identity>"] [--notary-profile <notarytool profile>]
#                   [--node 22] [--remote <git url>] [--branch main] [--bundle-id dev.perftool.app]
#                   [--unsigned]
set -euo pipefail

TOOL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Perf Tool"
IDENTITY=""
NOTARY_PROFILE="perf-tool"
NODE_MAJOR="22"
REMOTE=""
BRANCH=""
BUNDLE_ID="dev.perftool.app"
UNSIGNED=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --identity) IDENTITY="$2"; shift 2 ;;
    --notary-profile) NOTARY_PROFILE="$2"; shift 2 ;;
    --node) NODE_MAJOR="$2"; shift 2 ;;
    --remote) REMOTE="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --bundle-id) BUNDLE_ID="$2"; shift 2 ;;
    --unsigned) UNSIGNED=1; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done
fail() { echo "make-dmg: $*" >&2; exit 1; }

DIST="$TOOL/dist"
WORK="$DIST/work"
CACHE="$HOME/Library/Caches/perf-tool/make-dmg"
APP="$WORK/$APP_NAME.app"
rm -rf "$WORK"
mkdir -p "$WORK" "$CACHE" "$APP/Contents/MacOS" "$APP/Contents/Resources"

# ------------------------------------------------------------ signing identity (checked first)
if [[ $UNSIGNED == 0 ]]; then
  if [[ -z "$IDENTITY" ]]; then
    IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
  fi
  if [[ -z "$IDENTITY" ]]; then
    echo "No signing identity found: building an unsigned DMG (see 'How to open.txt' in it)."
    UNSIGNED=1
  fi
fi
if [[ $UNSIGNED == 0 ]]; then
  xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 || fail "no notarytool credentials named '$NOTARY_PROFILE' (xcrun notarytool store-credentials)"
  echo "Signing with: $IDENTITY"
fi

# ------------------------------------------------------------ version and update source
cd "$TOOL"
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  VERSION="$(git describe --tags --always --dirty 2>/dev/null)"
  REMOTE="${REMOTE:-$(git remote get-url origin 2>/dev/null || true)}"
  BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
else
  VERSION="$(date +%Y.%m.%d-%H%M)"
fi
BRANCH="${BRANCH:-main}"
[[ -n "$REMOTE" ]] || echo "Note: no git remote (git remote add origin <url>, or --remote): the installed tool will not update itself."

# ------------------------------------------------------------ Node (universal)
NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json | "${NODE:-node}" -e '
  let data = ""; process.stdin.on("data", c => (data += c)).on("end", () => {
    const major = process.argv[1];
    const release = JSON.parse(data).find(item => item.version.startsWith(`v${major}.`));
    if (!release) process.exit(1);
    console.log(release.version);
  });' "$NODE_MAJOR")" || fail "could not find Node $NODE_MAJOR on nodejs.org"
echo "Node $NODE_VERSION"
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$CACHE/SHASUMS256-$NODE_VERSION.txt"
binaries=()
for arch in arm64 x64; do
  archive="node-$NODE_VERSION-darwin-$arch.tar.gz"
  [[ -f "$CACHE/$archive" ]] || curl -fL --progress-bar "https://nodejs.org/dist/$NODE_VERSION/$archive" -o "$CACHE/$archive"
  (cd "$CACHE" && grep " $archive\$" "SHASUMS256-$NODE_VERSION.txt" | shasum -a 256 -c - >/dev/null) || { rm -f "$CACHE/$archive"; fail "checksum mismatch for $archive"; }
  tar -xzf "$CACHE/$archive" -C "$WORK" "node-$NODE_VERSION-darwin-$arch/bin/node"
  binaries+=("$WORK/node-$NODE_VERSION-darwin-$arch/bin/node")
done
lipo -create "${binaries[@]}" -output "$APP/Contents/Resources/node"
chmod 755 "$APP/Contents/Resources/node"

# ------------------------------------------------------------ app contents
clang -O2 -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 -o "$APP/Contents/MacOS/PerfTool" "$TOOL/app/launcher.c"
cp "$TOOL/app/launch.sh" "$APP/Contents/Resources/launch.sh"
chmod 755 "$APP/Contents/Resources/launch.sh"
echo "$VERSION" >"$APP/Contents/Resources/VERSION"
printf 'REMOTE=%q\nBRANCH=%q\n' "$REMOTE" "$BRANCH" >"$APP/Contents/Resources/update.conf"

# The tool's own files: tracked + new, never generated output or local caches.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git ls-files --cached --others --exclude-standard -z | grep -zv '^dist/' | xargs -0 tar -czf "$APP/Contents/Resources/perf-tool.tar.gz"
else
  tar -czf "$APP/Contents/Resources/perf-tool.tar.gz" --exclude .generated --exclude runtime --exclude dist --exclude .DS_Store --exclude .git .
fi

cat >"$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>PerfTool</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION//[^0-9.]/}</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <!-- No window or Dock icon: the app opens the setup page in the browser. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# ------------------------------------------------------------ sign, package, notarize
if [[ $UNSIGNED == 1 ]]; then
  # Ad hoc: a consistent signature without an identity. A quarantined app without one is shown as
  # "damaged" (no Open Anyway); with it macOS offers Open Anyway.
  codesign --force --sign - "$APP/Contents/Resources/node"
  codesign --force --sign - "$APP"
  codesign --verify --deep --strict "$APP"
else
  codesign --force --timestamp --options runtime --entitlements "$TOOL/app/node.entitlements" --sign "$IDENTITY" "$APP/Contents/Resources/node"
  codesign --force --timestamp --options runtime --sign "$IDENTITY" "$APP"
  codesign --verify --deep --strict "$APP"
fi

STAGE="$WORK/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
if [[ $UNSIGNED == 1 ]]; then
  cat >"$STAGE/How to open.txt" <<'TEXT'
Perf Tool is not signed by Apple, so macOS blocks it the first time.

1. Drag "Perf Tool" to Applications.
2. Open it. macOS says it cannot be opened — press Done (or Cancel).
3. System Settings → Privacy & Security → scroll down → "Perf Tool was blocked" → Open Anyway,
   then confirm with your password. From now on it opens normally.

Or, in Terminal, once:
   xattr -dr com.apple.quarantine "/Applications/Perf Tool.app"

TEXT
fi
DMG="$DIST/$APP_NAME.dmg"
rm -f "$DMG"
hdiutil create -quiet -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG"

if [[ $UNSIGNED == 0 ]]; then
  codesign --force --timestamp --sign "$IDENTITY" "$DMG"
  echo "Notarizing (usually a few minutes)…"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
  spctl --assess --type open --context context:primary-signature -v "$DMG"
fi

rm -rf "$WORK"
echo "Built $DMG ($VERSION$([[ $UNSIGNED == 1 ]] && echo ', unsigned'))"
