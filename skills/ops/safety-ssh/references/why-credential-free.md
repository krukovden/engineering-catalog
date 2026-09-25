# Why credential-free SSH — the threat model

## The incident pattern this prevents

An AI tool running on a workstation was driven to open PowerShell, SSH into a
server on a restricted internal subnet using **stored credentials**, and run system
and network queries. To the security team this was indistinguishable from an
intruder: an automated process authenticating with saved secrets and probing an
internal network. They had to open an investigation and ask for business
justification, a ticket, and proof of authorization.

Nothing here required malice — the danger was structural:

- **secrets the agent could read and replay** (stored password / key),
- **raw addresses in commands** that look like reconnaissance, and
- **no human-visible authorization boundary** on what the agent could reach.

This skill removes all three.

## Why each rule exists

- **No passwords / `sshpass` / `PasswordAuthentication`.** A password on a command
  line is visible in the process list (`ps`), shell history, `/proc`, and the
  agent's own transcript and tool-call logs. `sshpass`'s own manual calls hiding
  it "doomed". A passphrase-protected key in `ssh-agent` has no plaintext secret on
  any command line to leak.

- **No secrets in `.env` or code.** Plaintext on disk is read by any process
  (including the agent doing `cat`), and `.env` files are routinely committed to
  git, where bots find them within minutes. Any committed secret must be treated as
  compromised and rotated.

- **Connection only, never an IP/host/user.** The connection is a harmless token. Real
  addresses in commands are what make automated access look like network scanning —
  and they are what end up in logs that a security team reviews. Keeping addresses
  in an admin-owned `~/.ssh/config` means the agent literally cannot disclose them.

- **`BatchMode` fail-fast.** Without it, a missing or wrong key makes ssh fall back
  to a `password:` prompt and block forever (no human to answer), or worse, invites
  someone to wire in a stored password. With it, the failure is an immediate
  non-zero exit you can detect and report.

- **Allowlist of approved connections.** The agent can only reach hosts a human
  deliberately approved by adding the connection to `~/.ssh/claude-allowed-hosts`. That
  file *is* the authorization boundary — visible, auditable, and outside the
  agent's job to edit.

- **`accept-new`, never `StrictHostKeyChecking=no`.** Disabling host-key checking
  accepts a changed key silently, which is exactly how a man-in-the-middle
  impersonates a server. `accept-new` trusts first contact but refuses a changed
  key.

## The mental model

The agent should be able to *initiate* an authenticated action while every secret
and every address stays structurally **outside anything it can read, log, or
echo**. It holds one capability — "run a command on the connection `my-server`" — and
nothing more. If that capability leaks, what leaked is the word `my-server`.
