#!/bin/sh
# authorize-connection — register a connection the human has finished setting up.
#
# Refuses unless the config block is fully filled (no <FILL_IN> left) and the key
# file exists. That guard is the point: the AI can only authorize a connection a
# human actually completed — it cannot invent one and approve it for itself.
#
# Usage: authorize-connection.sh <connection-name>
set -eu

NAME="${1:-}"
[ -n "$NAME" ] || { echo "usage: authorize-connection.sh <connection-name>" >&2; exit 2; }

SSH_DIR="$HOME/.ssh"
CONFIG="$SSH_DIR/config"
ALLOWLIST="${SAFE_SSH_ALLOWLIST:-$SSH_DIR/claude-allowed-hosts}"

# 1. Connection must be defined and have a real HostName (no leftover placeholder).
resolved=$(ssh -G "$NAME" 2>/dev/null | awk 'tolower($1)=="hostname"{print $2; exit}')
if [ -z "$resolved" ] || [ "$resolved" = "$NAME" ] || [ "$resolved" != "${resolved#*FILL_IN}" ]; then
  echo "refused: connection '$NAME' is not finished in $CONFIG (HostName empty or still a placeholder)." >&2
  echo "A human must fill it in first (run new-connection.sh '$NAME', then edit $CONFIG)." >&2
  exit 1
fi

# 2. The configured key file must exist on disk.
keyfile=$(ssh -G "$NAME" 2>/dev/null | awk 'tolower($1)=="identityfile"{print $2; exit}')
keyfile_exp=$(printf '%s' "$keyfile" | sed "s|^~|$HOME|")
if [ -z "$keyfile_exp" ] || [ ! -f "$keyfile_exp" ]; then
  echo "refused: key file for '$NAME' not found ($keyfile)." >&2
  echo "A human must generate it: ssh-keygen -t ed25519 -f \"$keyfile_exp\"" >&2
  exit 1
fi

# 3. Register the connection (this is what makes it usable by safe-ssh).
touch "$ALLOWLIST"; chmod 600 "$ALLOWLIST"
if grep -qxF "$NAME" "$ALLOWLIST"; then
  echo "Connection '$NAME' is already authorized."
else
  echo "$NAME" >> "$ALLOWLIST"
  echo "Authorized connection '$NAME' in $ALLOWLIST"
fi

# 4. Verify the full setup end to end.
echo
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sh "$DIR/check-setup.sh" "$NAME"
