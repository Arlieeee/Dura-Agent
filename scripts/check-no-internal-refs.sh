#!/usr/bin/env bash
# Guard against internal / employer-specific references leaking into this public repo.
#
# This exists because it already happened once: a sync from the upstream private repo
# overwrote a clean README with one that described the architecture as "modelled on
# <employer>'s event-driven architecture", and it reached a public commit. Cleaning the
# working tree wasn't enough — the commit object stayed reachable by SHA.
#
# So the rule is enforced by a script, not by memory. Runs in CI and at the end of a sync.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Terms that must never appear in a public artefact. Extend as needed.
#
# Written as character classes on purpose: a plain literal would make this file
# itself a match, and `git grep` over history doesn't honour the --exclude below.
# The pattern still matches the term; the file just doesn't contain it verbatim.
PATTERNS='m[e]shy'

hits=$(grep -rniIE "$PATTERNS" . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next \
  --exclude-dir=data 2>/dev/null || true)

if [ -n "$hits" ]; then
  echo "✖ internal references found in a public repo:" >&2
  echo "$hits" >&2
  echo >&2
  echo "Remove them before committing. If one already reached a published commit," >&2
  echo "rewriting history is not sufficient on its own — the old object stays" >&2
  echo "reachable by SHA until GitHub garbage-collects it." >&2
  exit 1
fi

echo "✓ no internal references"
