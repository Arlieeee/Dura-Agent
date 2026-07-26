#!/usr/bin/env bash
# Sync code from the upstream working repo into this open-source repo.
#
# Docs are handled asymmetrically on purpose:
#   - upstream keeps a single Chinese copy (README.md, BENCHMARK.md, ...)
#   - this repo serves English as the default and Chinese as *.zh-CN.md
# So Chinese docs are synced *under their translated names*, and the English
# ones are never touched by this script — they are maintained here.
#
# Usage:  scripts/sync-from-upstream.sh [path-to-upstream]     (default: ../agent-learning/my-agent)
set -euo pipefail

SRC="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../agent-learning/my-agent" && pwd)}"
DST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[ -d "$SRC" ] || { echo "upstream not found: $SRC" >&2; exit 1; }
echo "sync: $SRC  ->  $DST"

# Root-level docs that exist in both languages. Anything listed here is copied
# to its .zh-CN.md counterpart instead of overwriting the English original.
TRANSLATED=(README.md BENCHMARK.md ROADMAP.md CONTRIBUTING.md)

is_translated() {
  local f="$1"
  for t in "${TRANSLATED[@]}"; do [ "$f" = "$t" ] && return 0; done
  return 1
}

# Exclusions use -path, not -name.
# Lesson learned the hard way: `-not -name 'report-*.md'` (meant for the bench's
# timestamped reports) also swallowed apps/server/skills/report-writing.md, and the
# missing frontmatter only surfaced as a failing unit test much later.
cd "$SRC"
mapfile -t FILES < <(find . -type f \
  -not -path './.git/*' \
  -not -path './node_modules/*' -not -path '*/node_modules/*' \
  -not -path './apps/web/.next/*' \
  -not -name '.env.local' \
  -not -path './packages/bench/data/*' \
  -not -path './packages/bench/results/run-*' \
  -not -path './packages/bench/results/report-*' \
  | sed 's|^\./||')

copied=0 translated=0
for f in "${FILES[@]}"; do
  if is_translated "$f"; then
    dest="${f%.md}.zh-CN.md"
    translated=$((translated + 1))
  else
    dest="$f"
    copied=$((copied + 1))
  fi
  mkdir -p "$DST/$(dirname "$dest")"
  cp "$SRC/$f" "$DST/$dest"
done

echo "copied $copied files, $translated docs routed to *.zh-CN.md"
echo
echo "Next: the Chinese docs just overwritten still carry upstream's title and no"
echo "language switcher. Re-add the header line before committing:"
echo "    [English](./README.md) | **中文**"
echo

# The upstream repo is private and describes the architecture in employer-specific
# terms. Syncing drags those terms into a public repo — this already happened once
# and reached a published commit. Fail loudly here rather than at review time.
"$DST/scripts/check-no-internal-refs.sh"
