#!/bin/sh
# new-connection — scaffold a credential-free SSH connection template.
#
# Safe for the AI to run: it creates ~/.ssh/config (if missing) and appends a
# template block for <name> with EMPTY <FILL_IN> placeholders. It writes NO real
# hostnames, users, or secrets — a human fills those in afterward. This is how the
# real address stays out of the chat: the AI scaffolds the shape, you fill the values.
#
# Usage: new-connection.sh <connection-name>
set -eu

NAME="${1:-}"
[ -n "$NAME" ] || { echo "usage: new-connection.sh <connection-name>" >&2; exit 2; }
case "$NAME" in
  -* | */* | *' '*) echo "connection name must be a bare token (no spaces, slashes, leading -)" >&2; exit 1;;
esac

SSH_DIR="$HOME/.ssh"
CONFIG="$SSH_DIR/config"
KEYFILE="$SSH_DIR/id_ed25519_${NAME}"

mkdir -p "$SSH_DIR"; chmod 700 "$SSH_DIR"
touch "$CONFIG"; chmod 600 "$CONFIG"

if grep -qiE "^[[:space:]]*Host[[:space:]]+${NAME}([[:space:]]|$)" "$CONFIG"; then
  echo "Connection '$NAME' already exists in $CONFIG. Edit it there if you need to change it."
  exit 0
fi

cat >> "$CONFIG" <<EOF

# --- SSH connection '${NAME}' — replace the two <FILL_IN> values below ---
Host ${NAME}
    HostName <FILL_IN_hostname_or_ip>
    User <FILL_IN_login_user>
    Port 22
    IdentityFile ${KEYFILE}
    IdentitiesOnly yes
    AddKeysToAgent yes
    ForwardAgent no
    StrictHostKeyChecking accept-new
EOF

cat <<EOF
Created a template for connection '${NAME}' in ${CONFIG}.

Now YOU (not the assistant) do two things:

  1. Open ${CONFIG} and replace the two <FILL_IN> values
     (HostName = the real host/IP, User = the login user).

  2. Create the key WITH a passphrase, load it, and install the public key:
       ssh-keygen -t ed25519 -f "${KEYFILE}" -C "${NAME}"
       ssh-add "${KEYFILE}"
       # then append ${KEYFILE}.pub to ~/.ssh/authorized_keys on the server

When that's done, tell the assistant to authorize the connection
(it will run: authorize-connection.sh ${NAME}).
EOF
