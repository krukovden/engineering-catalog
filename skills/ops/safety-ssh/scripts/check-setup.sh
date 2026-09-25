#!/bin/sh
# check-setup — verify credential-free SSH is correctly set up for a connection.
# Read-only. Exposes no secrets. Exit 0 = ready, 1 = not ready.
#
# Usage: check-setup.sh <connection>
set -u

CONNECTION="${1:-}"
[ -n "$CONNECTION" ] || { echo "usage: check-setup.sh <connection>" >&2; exit 2; }

ALLOWLIST="${SAFE_SSH_ALLOWLIST:-$HOME/.ssh/claude-allowed-hosts}"
fail=0
ok()  { printf '[ok]   %s\n' "$1"; }
bad() { printf '[FAIL] %s\n' "$1"; fail=1; }

# 1. ssh-agent reachable and holding at least one key.
ssh-add -l >/dev/null 2>&1; rc=$?
if   [ "$rc" -eq 0 ]; then ok "ssh-agent is running with a key loaded"
elif [ "$rc" -eq 1 ]; then bad "ssh-agent is running but has NO keys loaded (run: ssh-add <keyfile>)"
else                       bad "ssh-agent is not reachable (start it, then run: ssh-add <keyfile>)"
fi

# 2. Connection is actually defined in ~/.ssh/config. `ssh -G` always succeeds and
#    echoes the connection back as hostname when no Host block matched, so an unchanged
#    hostname means "not defined".
resolved_host=$(ssh -G "$CONNECTION" 2>/dev/null | awk 'tolower($1)=="hostname"{print $2; exit}')
if [ -n "$resolved_host" ] && [ "$resolved_host" != "$CONNECTION" ]; then
  ok "connection '$CONNECTION' is defined in ~/.ssh/config"
else
  bad "connection '$CONNECTION' is not defined in ~/.ssh/config (a human must add a Host block)"
fi

# 3. Connection is approved in the allowlist.
if [ -f "$ALLOWLIST" ] && grep -qxF "$CONNECTION" "$ALLOWLIST"; then
  ok "connection '$CONNECTION' is in the allowlist"
else
  bad "connection '$CONNECTION' is NOT in the allowlist ('$ALLOWLIST')"
fi

# 4. Key auth: at least one IdentityFile configured for the connection EXISTS on disk.
#    `ssh -G` lists stock defaults for any host, so existence is what makes this
#    check discriminating rather than always-true.
keyok=0
for f in $(ssh -G "$CONNECTION" 2>/dev/null | awk 'tolower($1)=="identityfile"{print $2}'); do
  expanded=$(printf '%s' "$f" | sed "s|^~|$HOME|")
  [ -f "$expanded" ] && keyok=1
done
if [ "$keyok" -eq 1 ]; then
  ok "a configured private key file exists for '$CONNECTION'"
else
  bad "no existing private key file is configured for '$CONNECTION' (run new-connection)"
fi

# 5. A real, fail-fast, key-only connection works (no prompts, short timeout).
if ssh -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes \
       -o PreferredAuthentications=publickey "$CONNECTION" true >/dev/null 2>&1; then
  ok "key-based connection to '$CONNECTION' works (BatchMode, no prompt)"
else
  bad "could not connect to '$CONNECTION' with key auth — check the key is authorized on the host"
fi

if [ "$fail" -eq 0 ]; then echo "RESULT: ready"; else echo "RESULT: not ready"; fi
exit "$fail"
