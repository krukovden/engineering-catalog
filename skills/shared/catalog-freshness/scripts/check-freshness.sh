#!/usr/bin/env sh
# check-freshness.sh — "check every N days, last checked on D" (DESIGN §7.4).
# Reads the install receipt, asks the remote for its tags, prints a one-line hint when a
# newer catalog exists. Exit 0 always: a hint must never break a session.
set -u
HOME_DIR="${ENGCAT_HOME:-$HOME}"
DAYS=7; QUIET=0; FORCE=0; JSON=0
for a in "$@"; do case "$a" in --quiet) QUIET=1;; --force) FORCE=1;; --json) JSON=1;; --days=*) DAYS="${a#--days=}";; --days) ;; [0-9]*) DAYS="$a";; esac; done
# One message, two shapes. Claude adds a SessionStart hook's plain stdout to the session as
# context; Copilot reads the same stdout as JSON and takes the line from `additionalContext`,
# dropping plain text without a word. `--json` picks the second (copilot-facts.md §6).
emit() {
  if [ "$JSON" -eq 1 ]; then
    printf '{"additionalContext":"%s"}\n' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  else
    printf '%s\n' "$1"
  fi
}
say() { [ "$QUIET" -eq 1 ] || emit "$1"; }
RECEIPT=""
for cand in "./.engineering-catalog/receipt.json" "$HOME_DIR/.engineering-catalog/receipt.json"; do [ -f "$cand" ] && RECEIPT="$cand" && break; done
[ -n "$RECEIPT" ] || { say "engineering-catalog is not installed here (no receipt)."; exit 0; }
STATE="$HOME_DIR/.engineering-catalog/freshness.json"
field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$2" | head -1; }
# The receipt may hold several installs; use the FIRST one. Cut the text down to that
# object (up to the first "}" after "installs") before extracting, whatever the layout.
FIRST="$(tr -d '\n' < "$RECEIPT" | sed -n 's/.*"installs"[[:space:]]*:[[:space:]]*\[[[:space:]]*\({[^}]*}\).*/\1/p')"
[ -n "$FIRST" ] || { say "engineering-catalog is not installed here (no receipt)."; exit 0; }
SOURCE="$(printf '%s' "$FIRST" | field source /dev/stdin)"; INSTALLED="$(printf '%s' "$FIRST" | field catalogVersion /dev/stdin)"
if [ "$FORCE" -eq 0 ] && [ -f "$STATE" ]; then
  LAST="$(field lastChecked "$STATE")"
  LAST_EPOCH="$(date -u -j -f '%Y-%m-%dT%H:%M:%S' "$(printf '%s' "$LAST" | cut -c1-19)" +%s 2>/dev/null || date -u -d "$LAST" +%s 2>/dev/null || echo 0)"
  NOW="$(date -u +%s)"
  [ $(( NOW - LAST_EPOCH )) -lt $(( DAYS * 86400 )) ] && exit 0
fi
# Never prompt for credentials: under a hook there is nobody to answer, and on Windows a
# credential-manager dialog would hang the session.
TAGS="$(GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never git -c credential.interactive=false ls-remote --tags "$SOURCE" 2>/dev/null | sed -n 's/.*refs\/tags\/v\([0-9][0-9.]*\)$/\1/p')" || TAGS=""
LATEST="$(printf '%s\n' "$TAGS" | grep . | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
mkdir -p "$(dirname "$STATE")"
printf '{ "lastChecked": "%s", "latest": "%s" }\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${LATEST:-$INSTALLED}" > "$STATE"
[ -n "$LATEST" ] || { say "engineering-catalog $INSTALLED — could not read tags from $SOURCE."; exit 0; }
NEWEST="$(printf '%s\n%s\n' "$INSTALLED" "$LATEST" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
if [ "$NEWEST" != "$INSTALLED" ]; then
  emit "$(printf 'engineering-catalog %s → %s available. Update: npx git+%s update' "$INSTALLED" "$LATEST" "$SOURCE")"
else
  say "engineering-catalog $INSTALLED is current."
fi
exit 0
