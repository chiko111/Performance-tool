#!/usr/bin/env bash
# Installs the `perf` command by linking it into a folder that is already on PATH.
#   ./install.sh [project]            install (then `perf init` in the project sets it up)
#   ./install.sh --uninstall
set -euo pipefail

TOOL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chmod +x "$TOOL/perf" "$TOOL/install.sh"

on_path() { [[ ":$PATH:" == *":$1:"* ]]; }

if [[ "${1:-}" == "--uninstall" ]]; then
  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
    if [[ -L "$dir/perf" && "$(readlink "$dir/perf")" == "$TOOL/perf" ]]; then
      rm "$dir/perf" && echo "Removed $dir/perf"
    fi
  done
  exit 0
fi

[[ "$(uname)" == "Darwin" ]] || { echo "perf-tool needs macOS (Xcode tools)." >&2; exit 1; }

missing=0
check() {
  if command -v "$1" >/dev/null 2>&1; then
    echo "  ✓ $1"
  else
    echo "  ✗ $1 — $2"
    missing=1
  fi
}
echo "Checking requirements:"
check node "install Node.js 18+ (the project uses nvm / Node 22)"
check git "install Xcode Command Line Tools: xcode-select --install"
check xcrun "install Xcode (needed for iOS)"
check adb "install Android platform-tools and add them to PATH (needed for Android)"
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" -ge 18 ]] || { echo "  ✗ Node $major is too old, 18+ required"; missing=1; }
fi

target=""
for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
  if [[ -d "$dir" && -w "$dir" ]] && on_path "$dir"; then target="$dir"; break; fi
done

if [[ -z "$target" ]]; then
  mkdir -p "$HOME/.local/bin"
  target="$HOME/.local/bin"
  echo
  echo "Add this line to ~/.zshrc, then open a new terminal:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

if [[ -e "$target/perf" && ! -L "$target/perf" ]]; then
  echo "$target/perf already exists and is not perf-tool; not overwriting it." >&2
  exit 1
fi
ln -sf "$TOOL/perf" "$target/perf"
echo
echo "Installed: $target/perf → $TOOL/perf"
[[ $missing == 0 ]] || echo "Some requirements are missing (see above); the related platform will not work until installed."
if [[ -n "${1:-}" ]]; then
  echo "Open a new terminal (or run 'rehash'), then: cd $1 && perf init   (setup page: scan and review the project)"
else
  echo "Open a new terminal (or run 'rehash'), cd into the project and run: perf init (setup page) or perf help"
fi
