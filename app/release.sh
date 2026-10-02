#!/usr/bin/env bash
# Publishes a new Perf Tool.dmg as a GitHub release of this repository (origin):
#   app/release.sh <version> ["release notes"] [make-dmg options…]
#   app/release.sh 1.1.0 "Faster setup scan"
# Needs a clean, pushed main. Uses the GitHub credentials git already has (the ones `git push` uses).
set -euo pipefail

TOOL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:?usage: app/release.sh <version> [\"notes\"] [make-dmg options]}"
NOTES="${2:-}"
shift $(( $# >= 2 ? 2 : 1 ))
TAG="v${VERSION#v}"
fail() { echo "release: $*" >&2; exit 1; }
cd "$TOOL"

[[ -z "$(git status --porcelain)" ]] || fail "uncommitted changes — commit them first"
git fetch -q origin
[[ "$(git rev-parse HEAD)" == "$(git rev-parse @{u})" ]] || fail "main is not pushed (or not up to date): git pull / git push first"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && fail "tag $TAG already exists"

REPO="$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
[[ "$REPO" == */* ]] || fail "origin is not a GitHub repository"
TOKEN="$(printf 'protocol=https\nhost=github.com\n\n' | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null | sed -n 's/^password=//p')"
[[ -n "$TOKEN" ]] || fail "no GitHub credentials stored for git (push once over https first)"

"$TOOL/app/make-dmg.sh" "$@"
DMG="$TOOL/dist/Perf Tool.dmg"

git tag "$TAG"
git push -q origin "$TAG"

api() { curl -fsS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$@"; }
body="$(TAG="$TAG" NOTES="$NOTES" node -e '
  const notes = process.env.NOTES ? `${process.env.NOTES}\n\n` : "";
  console.log(JSON.stringify({
    tag_name: process.env.TAG,
    name: `Perf Tool ${process.env.TAG.slice(1)}`,
    body: `${notes}Download **Perf-Tool.dmg**, drag Perf Tool to Applications and open it. On first launch macOS may block it: System Settings → Privacy & Security → Open Anyway. Installed apps update perf-tool from this repository by themselves.`
  }));')"
release="$(api -X POST "https://api.github.com/repos/$REPO/releases" -d "$body")"
id="$(node -e 'console.log(JSON.parse(process.argv[1]).id)' "$release")"
api -X POST "https://uploads.github.com/repos/$REPO/releases/$id/assets?name=Perf-Tool.dmg" \
  -H "Content-Type: application/x-apple-diskimage" --data-binary @"$DMG" >/dev/null
echo "Released $TAG: https://github.com/$REPO/releases/tag/$TAG"
