#!/usr/bin/env bash
# Builds perf-replay.dex from PerfReplay.java. The .dex is committed, so users need no Android
# build tools for it; run this only after changing the Java file.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
PLATFORM="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)"
D8="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)/d8"

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
javac -source 11 -target 11 -Xlint:-options -cp "$PLATFORM/android.jar" -d "$OUT/classes" PerfReplay.java
"$D8" --min-api 26 --lib "$PLATFORM/android.jar" --output "$OUT" "$OUT"/classes/*.class
mv "$OUT/classes.dex" perf-replay.dex
echo "Built $(pwd)/perf-replay.dex"
