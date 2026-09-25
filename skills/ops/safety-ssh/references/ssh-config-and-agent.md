# SSH config, ssh-agent, and the hardened options

This is the detail behind the connection-only model. You rarely need it for a normal
run — read it when setting up a host or debugging why `check-setup` fails.

## `~/.ssh/config` — the connection that hides everything

`ssh my-server` works because a `Host` block maps the connection to the real address,
user, port, and key. None of those appear on the command line, in logs, or in
model context.

```sshconfig
Host my-server                              # the connection you and the agent type
    HostName 192.168.91.50                   # real IP/DNS — hidden from the CLI
    User labuser                             # login user — no `user@` needed
    Port 22                                  # no `-p` needed
    IdentityFile ~/.ssh/id_ed25519_my-server
    IdentitiesOnly yes                       # offer ONLY this key (deterministic auth)
    AddKeysToAgent yes                       # auto-load the key into the agent on use
    ForwardAgent no                          # never forward the agent by default
    StrictHostKeyChecking accept-new         # trust first contact, refuse a CHANGED key

Host *                                       # global defaults go LAST (first match wins)
    IdentitiesOnly yes
    ServerAliveInterval 60
```

Precedence is first-match-wins per parameter, so specific `Host` blocks go at the
top and `Host *` at the bottom.

**Permissions.** Linux/macOS: `chmod 700 ~/.ssh` and `chmod 600 ~/.ssh/config` or
OpenSSH refuses the file. Windows: the file lives at `%USERPROFILE%\.ssh\config`
with identical syntax; restrict it via the file's Security properties / `icacls`
so only your user, SYSTEM, and Administrators can read it.

## ssh-agent — the decrypted key lives out of reach

Generate an ed25519 key **with a passphrase** (encrypted on disk = useless if
copied), then unlock it once into the agent. The agent signs challenges on demand;
the passphrase and key material never reach the AI agent.

```bash
ssh-keygen -t ed25519 -C "claude-agent-my-server"   # prompts for a passphrase
```

**Linux:**
```bash
eval "$(ssh-agent -s)"          # only if $SSH_AUTH_SOCK is unset
ssh-add ~/.ssh/id_ed25519_my-server
ssh-add -l                      # list loaded keys; ssh-add -D clears them
```

**macOS** (persist in Keychain):
```bash
ssh-add --apple-use-keychain ~/.ssh/id_ed25519_my-server
```

**Windows** (ssh-agent is a Windows service, disabled by default):
```powershell
Get-Service ssh-agent | Set-Service -StartupType Automatic
Start-Service ssh-agent
ssh-add $env:USERPROFILE\.ssh\id_ed25519_my-server
```
After `ssh-add` on Windows the key is held in the agent's credential store and
survives reboots; Microsoft suggests backing up then removing the on-disk private
key (it cannot be exported back out).

**Agent forwarding caveat.** `ForwardAgent yes` / `ssh -A` lets root on the remote
*use* your loaded keys for the life of the session. Keep `ForwardAgent no` by
default; prefer `ProxyJump` (`ssh -J jump target`) to reach hosts behind a bastion;
use `ssh-add -c` to require a local confirmation on each key use, and `ssh-add -t
<sec>` to auto-expire.

## The hardened options the wrapper uses, and why

| Option | Why |
|--------|-----|
| `BatchMode=yes` | Disables every interactive prompt. A failed key auth exits non-zero (255) **immediately** instead of writing `password:` and hanging forever with no human to answer. This is the single most important flag. |
| `ConnectTimeout=10` | Caps the wait on a dead host (OS default can be 1–2 minutes). |
| `StrictHostKeyChecking=accept-new` | Trusts the host key on first contact but **refuses if a known key changed** — the man-in-the-middle signature. Never use `no`, which accepts changed keys silently. |
| `IdentitiesOnly=yes` | Offer only the configured key, not every key in the agent (avoids "Too many authentication failures" and non-determinism). |
| `PreferredAuthentications=publickey` | Key only — no password / keyboard-interactive fallback path to leak through. |
| `ClearAllForwardings=yes` | Strip any port/agent/X11 forwarding regardless of config. |

Server-side backstop (set by whoever owns the host): `PasswordAuthentication no`
so there is no password to leak, and for a dedicated agent account, an
`authorized_keys` forced command (`restrict,command="..."`) or `sshd_config`
`Match ... ForceCommand` to limit what the key can do.
