---
name: safety-ssh
description: >-
  Safe, credential-free SSH to remote servers — the assistant works only through a
  named connection and never sees or types passwords, usernames, hostnames, or IPs.
  Use this skill to actually carry out any task that lives on another machine — a
  server, box, host, VM, instance, prod/staging environment, build or CI agent,
  database server, or jump/bastion host. If fulfilling the request means logging in
  over SSH and doing something there — restart or bounce a service, deploy, prune
  docker images, dump a schema, free up disk, tail or grep remote logs, run
  df/du/systemctl — this is the skill, and it is the required path for doing it.
  Treat these as triggers: "ssh into…", "log into…", "connect to my server and…",
  "hop to the internal host and…", a pasted `ssh user@host`, a bare IP, or an
  offered SSH password/key/.env secret. Not for local-only SSH: making keys, git
  publickey errors, explaining ssh flags or agent forwarding, passphrases, or local
  rsync.
---

# Safety SSH

Run remote commands over SSH **without the assistant ever handling secrets,
hostnames, or IPs.** Automated SSH from an AI tool that carries stored credentials
and pokes at raw IP addresses looks exactly like an intrusion to a security team.
The fix: move every secret and every address *out* of anything the assistant can
read, log, or echo, and leave it only a harmless **connection name**.

## The one rule that makes this safe

**The assistant only ever refers to an SSH connection by its name** (e.g.
`my-server`). The real IP, hostname, username, port, and key path live in
`~/.ssh/config`, which a human fills in. The decrypted key lives in `ssh-agent`. So
the worst thing that can land in a transcript, a log, or a tool call is the word
`my-server` — never a credential or an address.

If the user hands you an IP, hostname, username, or password, **do not put it in a
command.** Route it into a connection (below) and then use only the connection name.

## Workflow

Always go through the bundled scripts — they are deterministic, so the safe path
does not depend on remembering flags. Pick `.sh` (bash/macOS/Linux) or `.ps1`
(Windows/PowerShell). Examples below use `my-server` as the connection name.

### 1. Preflight — is this connection ready?

```
scripts/check-setup.sh my-server
```

Read-only, exposes no secrets. It reports whether `~/.ssh/config` defines the
connection, whether it is authorized, whether the key is loaded in `ssh-agent`, and
whether a real fail-fast connection works. If it prints `RESULT: ready`, skip to
step 4.

### 2. If it is not set up — scaffold it (assistant runs this)

```
scripts/new-connection.sh my-server
```

This creates `~/.ssh/config` if missing and appends a connection **template with
empty `<FILL_IN>` placeholders**. It writes no real values. Then tell the user, in
plain terms:

> I've created a connection template for `my-server` in `~/.ssh/config`. Please
> open that file and fill in the two `<FILL_IN>` values (the host/IP and the login
> user), then create the key with a passphrase and load it — the script printed the
> exact `ssh-keygen` / `ssh-add` commands. Tell me when that's done.

**Stop here and wait.** The host address and the passphrase go into the file and the
agent *by the user*, never through the chat. Do not offer to fill them in yourself.

### 3. Once the user says it's filled — authorize (assistant runs this)

```
scripts/authorize-connection.sh my-server
```

This registers the connection so the assistant may use it (adds the name to
`~/.ssh/claude-allowed-hosts`) and then re-runs the preflight check. It **refuses**
if the user left a `<FILL_IN>` placeholder or the key file is missing — so you can
only authorize a connection a human actually completed. If it refuses, relay what's
missing and wait.

### 4. Run commands — everything goes out through the connection

```
scripts/safe-ssh.sh my-server -- df -h
```

From now on, every command you generate runs through `safe-ssh <connection> --
<command>`. The wrapper refuses any connection not in the allowlist, rejects
arguments that try to inject ssh options, and always uses `BatchMode=yes` so a
missing key fails immediately instead of waiting on a hidden password prompt. Treat
access as **read-only unless the user has explicitly authorized a change** for this
connection.

## Boundaries, and why they matter

- **Never use a password, `sshpass`, or `PasswordAuthentication=yes`.** A password
  on a command line ends up in the process list, shell history, and the assistant's
  own transcript — it cannot be hidden. A passphrase-protected key in `ssh-agent`
  has no secret on any command line to leak. See `references/why-credential-free.md`.
- **Never put SSH passwords or keys in `.env`, code, or a committed file.** Plaintext
  on disk gets read, logged, and eventually committed; treat any such secret as
  already compromised.
- **Never type a raw IP/hostname/user in a command.** Use the connection name.
  Addresses in commands are what make automated access look like reconnaissance.
- **Never disable host-key checking** (`StrictHostKeyChecking=no`) — it silently
  accepts a changed key, the signature of a man-in-the-middle. The scripts use
  `accept-new`: trust first contact, refuse a *changed* key.
- **Never authorize a connection for yourself by filling in the values.** The human
  filling `~/.ssh/config` is the authorization boundary; `authorize-connection`
  enforces it by refusing placeholders.

## References

Read these when you need the detail; a normal run does not require them.

- `references/ssh-config-and-agent.md` — full `~/.ssh/config` directives, the
  ssh-agent workflow on Windows and Linux/macOS, host-key policy, and the hardened
  ssh options the wrapper uses and why.
- `references/why-credential-free.md` — the threat model and the incident pattern
  this skill is designed to prevent.
