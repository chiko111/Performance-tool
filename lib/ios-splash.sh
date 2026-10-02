#!/usr/bin/env bash
# Puts a domain's boot splash into an already built .app, without touching the project. For
# projects whose domains share one BootSplash.storyboard + asset and switch it with a
# react-native-bootsplash script (e.g. `yarn bootsplash:<domain>:ios`): that script runs here on a
# throwaway copy, its storyboard is compiled with a plain bundle image instead of the asset
# catalog, and the app is signed again.
#   ios-splash.sh <repo> <package.json script> <path/to/App.app> <minimum iOS version>
set -euo pipefail

REPO="$1"
SCRIPT="$2"
APP="$3"
MIN_IOS="$4"
NODE="${PERF_NODE:-node}"
LOGO="PerfBootSplashLogo"

"$NODE" -e 'process.exit(require(process.argv[1]).scripts?.[process.argv[2]] ? 0 : 1)' "$REPO/package.json" "$SCRIPT" ||
  { echo "perf: no '$SCRIPT' script in package.json, keeping the splash of the build" >&2; exit 0; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# The script may read images from anywhere in the project; the heavy folders are left out.
rsync -a --exclude node_modules --exclude .git --exclude Pods --exclude build --exclude android "$REPO/" "$WORK/"
ln -s "$REPO/node_modules" "$WORK/node_modules"
(cd "$WORK" && yarn -s run "$SCRIPT" >"$WORK/generate.log" 2>&1) ||
  { cat "$WORK/generate.log" >&2; echo "perf: '$SCRIPT' failed" >&2; exit 1; }

storyboard="$(find "$WORK/ios" -maxdepth 2 -name BootSplash.storyboard | head -1)"
imageset="$(find "$WORK/ios" -maxdepth 3 -type d -name 'BootSplashLogo-*.imageset' | head -1)"
[[ -f "$storyboard" && -d "$imageset" ]] || { echo "perf: generated splash not found" >&2; exit 1; }

# Asset catalog image → loose bundle image; named color → the same color inline.
"$NODE" - "$storyboard" "$WORK/BootSplash.storyboard" "$LOGO" <<'EOF'
const fs = require('fs');
const [source, target, logo] = process.argv.slice(2);
let xml = fs.readFileSync(source, 'utf8');
const imageName = xml.match(/image="(BootSplashLogo-[^"]+)"/)[1];
const colorMatch = xml.match(/<namedColor name="([^"]+)">\s*(<color [^>]*\/>)\s*<\/namedColor>/);
xml = xml.split(imageName).join(logo);
if (colorMatch) {
  const [block, colorName, color] = colorMatch;
  xml = xml
    .replace(`<color key="backgroundColor" name="${colorName}"/>`, color.replace('<color ', '<color key="backgroundColor" '))
    .replace(block, '');
}
fs.writeFileSync(target, xml);
EOF

rm -rf "$APP/BootSplash.storyboardc"
xcrun ibtool --compile "$APP/BootSplash.storyboardc" "$WORK/BootSplash.storyboard" \
  --target-device iphone --target-device ipad --minimum-deployment-target "$MIN_IOS" >/dev/null
for png in "$imageset"/*.png; do
  scale="$(basename "$png" .png | grep -oE '@[23]x$' || true)"
  cp "$png" "$APP/$LOGO$scale.png"
done

# Same certificate and entitlements as the build signed it with (ad hoc on simulators). The
# certificate is picked by its SHA-1, since a renewed one can share the name of an expired one.
identity="-"
if (cd "$WORK" && codesign -d --extract-certificates=cert "$APP" 2>/dev/null) && [[ -f "$WORK/cert0" ]]; then
  identity="$(shasum -a 1 "$WORK/cert0" | cut -d' ' -f1 | tr '[:lower:]' '[:upper:]')"
fi
codesign -d --entitlements - --xml "$APP" >"$WORK/entitlements.plist" 2>/dev/null || true
sign_args=(--force --sign "$identity")
[[ -s "$WORK/entitlements.plist" ]] && sign_args+=(--entitlements "$WORK/entitlements.plist")
codesign "${sign_args[@]}" "$APP"
echo "Boot splash: $SCRIPT"
