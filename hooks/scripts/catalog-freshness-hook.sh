#!/usr/bin/env sh
set -u
ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
sh "$ROOT/skills/shared/catalog-freshness/scripts/check-freshness.sh" "$@"
# One throttled line in the existing hook, never a second SessionStart hook.
[ -f "$ROOT/skills/shared/ado-board/scripts/ado-board.js" ] && node "$ROOT/skills/shared/ado-board/scripts/ado-board.js" reconcile --allow-unconfigured --throttle-hours 12 >/dev/null 2>&1 || true
