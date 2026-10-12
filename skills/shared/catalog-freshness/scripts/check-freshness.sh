#!/usr/bin/env sh
# check-freshness.sh — "check every N days, last checked on D" (DESIGN §7.4).
# Reads the install receipt, asks the remote for its tags, prints a one-line hint when a
# newer catalog exists. Exit 0 always: a hint must never break a session.
set -u
HOME_DIR="${ENGCAT_HOME:-$HOME}"
DAYS=7; QUIET=0; FORCE=0; JSON=0; VERSION=0
for a in "$@"; do case "$a" in --quiet) QUIET=1;; --force) FORCE=1;; --json) JSON=1;; --version) VERSION=1;; --days=*) DAYS="${a#--days=}";; --days) ;; [0-9]*) DAYS="$a";; esac; done
# One message, two shapes. Claude adds a SessionStart hook's plain stdout to the session as
# context; Copilot reads the same stdout as JSON and takes the line from `additionalContext`,
# dropping plain text without a word. `--json` picks the second (copilot-facts.md §6).
# Messages are collected and printed once, on exit: Copilot reads exactly one JSON object.
OUT=""
emit() { if [ -n "$OUT" ]; then OUT="$OUT
$1"; else OUT="$1"; fi; }
flush() {
  [ -n "$OUT" ] || return 0
  if [ "$JSON" -eq 1 ]; then
    printf '{"additionalContext":"%s"}\n' "$(printf '%s' "$OUT" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk 'NR>1{printf "\\n"}{printf "%s",$0}')"
  else
    printf '%s\n' "$OUT"
  fi
}
trap flush EXIT
say() { [ "$QUIET" -eq 1 ] || emit "$1"; }
# Not about freshness, but this is the one script every session runs first. When the QA
# skill is installed beside this one on Windows and no Azure DevOps project is configured,
# say so every session, so the first conversation sets one up instead of the first work
# item failing. Located without a relative path: the skills root is two levels up.
SKILLS_ROOT="$(dirname "$(dirname "$(cd "$(dirname "$0")" && pwd)")")"
case "${OS:-}:$(uname -s 2>/dev/null)" in *Windows_NT*|*MINGW*|*MSYS*|*CYGWIN*) ON_WINDOWS=1;; *) ON_WINDOWS=0;; esac
if [ "$VERSION" -eq 0 ] && [ "$ON_WINDOWS" -eq 1 ] && [ -f "$SKILLS_ROOT/qa-ado-work-item/SKILL.md" ]; then
  ADO_CONFIG="$HOME_DIR/.ado-credentials/config.json"
  if [ ! -f "$ADO_CONFIG" ] || ! grep -q '"organization"' "$ADO_CONFIG"; then
    emit "No Azure DevOps project is connected yet, so bugs cannot be filed here. Send me a link to your board (any board, backlog or sprint page) and, if you have them, links to the code, and I will connect it."
  fi
fi
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
# "Which version is installed?" answered from the receipt alone: no network, no interval.
if [ "$VERSION" -eq 1 ]; then
  emit "engineering-catalog $INSTALLED is installed (on $(printf '%s' "$FIRST" | field date /dev/stdin | cut -c1-10), from $SOURCE)."
  exit 0
fi
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
