#!/usr/bin/env bash
# Started by Perf Tool.app. Installs perf-tool into ~/Library/Application Support/perf-tool (a git
# clone of the tool's repository when it can be reached, so it can update itself; otherwise the
# copy inside the app), links the app's built-in Node for it, and opens the setup page.
set -uo pipefail

RESOURCES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HOME/Library/Application Support/perf-tool"
LOG="$HOME/Library/Logs/perf-tool-app.log"
SETUP_URL="http://localhost:8098"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "=== $(date) Perf Tool $(cat "$RESOURCES/VERSION" 2>/dev/null)"

notify() { osascript -e "display notification \"$1\" with title \"Perf Tool\"" >/dev/null 2>&1 || true; }
alert() { osascript -e "display alert \"Perf Tool\" message \"$1\" as critical" >/dev/null 2>&1 || true; }

# Apps start with a minimal PATH; the login shell's one finds Xcode, adb, git, yarn, pod, nvm's node.
login_path="$("${SHELL:-/bin/zsh}" -lic 'printf "__PERF_PATH__%s__PERF_PATH__" "$PATH"' 2>/dev/null | sed -n 's/.*__PERF_PATH__\(.*\)__PERF_PATH__.*/\1/p')"
export PATH="${login_path:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"

# REMOTE and BRANCH of the tool's git repository (written by make-dmg.sh; may be empty).
REMOTE=""
BRANCH="main"
[[ -f "$RESOURCES/update.conf" ]] && source "$RESOURCES/update.conf"

with_timeout() { perl -e 'alarm shift; exec @ARGV' "$@"; }

# Swaps in a fresh clone, keeping the generated files and caches of the old copy.
install_from_git() {
  [[ -n "$REMOTE" ]] && command -v git >/dev/null || return 1
  local fresh="$TOOL.clone"
  rm -rf "$fresh"
  GIT_TERMINAL_PROMPT=0 with_timeout 120 git clone --quiet --branch "$BRANCH" "$REMOTE" "$fresh" || { rm -rf "$fresh"; return 1; }
  if [[ -d "$TOOL" ]]; then
    [[ -d "$TOOL/.generated" ]] && mv "$TOOL/.generated" "$fresh/"
    rm -rf "$TOOL"
  fi
  mv "$fresh" "$TOOL"
  echo "Installed from $REMOTE ($BRANCH)"
}

install_from_app() {
  local version
  version="$(cat "$RESOURCES/VERSION")"
  [[ -f "$TOOL/.app-version" && "$(cat "$TOOL/.app-version")" == "$version" ]] && return 0
  mkdir -p "$TOOL"
  tar -xzf "$RESOURCES/perf-tool.tar.gz" -C "$TOOL"
  echo "$version" >"$TOOL/.app-version"
  echo "Installed the copy inside the app ($version)"
}

if [[ ! -d "$TOOL/.git" ]]; then
  install_from_git || install_from_app || { alert "Could not install perf-tool (see $LOG)"; exit 1; }
fi

mkdir -p "$TOOL/runtime"
ln -sfn "$RESOURCES/node" "$TOOL/runtime/node"
chmod +x "$TOOL/perf" "$TOOL/install.sh" 2>/dev/null || true

# One setup page at a time: a second start only opens it again.
if ! curl -sf "$SETUP_URL/api/ping" -X POST >/dev/null 2>&1; then
  nohup "$TOOL/runtime/node" "$TOOL/lib/setup-server.mjs" --exit-when-idle >>"$LOG" 2>&1 &
  for _ in $(seq 1 40); do
    curl -sf "$SETUP_URL/api/ping" -X POST >/dev/null 2>&1 && break
    sleep 0.25
  done
fi
if curl -sf "$SETUP_URL/api/ping" -X POST >/dev/null 2>&1; then
  open "$SETUP_URL"
else
  alert "The setup page did not start (see $LOG)"
  exit 1
fi
