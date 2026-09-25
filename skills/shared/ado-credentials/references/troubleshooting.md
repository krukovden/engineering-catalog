# Outcomes, exit codes and credential failures

> Script paths on this page are relative to this skill's directory — the folder that holds `SKILL.md`.

## Preflight outcomes

`check.ps1` and `check.sh` print one JSON line `{ "outcome", "detail", "steps": [] }` and
signal the same thing through the exit code. Read both.

| Outcome | Code | Meaning | What to do |
|---|---|---|---|
| `ok` | 0 | Credential present and accepted by the organization | Continue |
| `absent` | 3 | No credential or no configuration on this machine | Show `steps` verbatim; the user runs first-time setup |
| `expired` | 4 | Credential present but rejected — expired, revoked, or missing a scope | Show `steps` verbatim; the user replaces the PAT (Windows) or runs `az login` again |
| `error` | 1 | The check could not complete | Report `detail`; check network access and the organization URL |

`setup.ps1` exits 0 on success and 1 on any error, with the reason on stderr.

## Common errors

**"Azure DevOps rejected the PAT"** — expired, revoked, or missing a scope. Azure DevOps
answers a bad PAT with its sign-in page (HTTP 203) or 401 rather than a JSON error, which
is what this message detects. The PAT needs **Code (Read)** and **Work Items (Read &
write)**. Re-run `scripts\setup.ps1`; it offers to keep or replace the stored PAT.

**"Protected PAT not found"** — the PAT is protected with DPAPI and only unwraps for the
same Windows user on the same machine. A copied profile, a new machine, or a different
account all mean re-running `scripts\setup.ps1`.

**"This script runs on Windows only"** — the PAT protection has no macOS or Linux
equivalent. It refuses rather than storing the secret less safely. On macOS/Linux the
preflight is `scripts/check.sh`, which uses the `az` CLI's own login.

**"Could not create SSL/TLS secure channel"** or a request that fails before any HTTP
status — Windows PowerShell 5.1 negotiates TLS 1.0 by default and Azure DevOps requires
1.2 or later. `common.ps1` enables TLS 1.2 on load; if the error persists, the machine's
.NET Framework predates TLS 1.2 support or a proxy is terminating TLS. Update .NET
Framework (4.7.2+) or open a ticket with whoever owns the proxy.

**"Access is denied" on `%USERPROFILE%\.ado-credentials`** — `setup.ps1` strips
inherited permissions from the state folder with `icacls` and grants only the current
account, so another profile on a shared machine cannot read the PAT. If the folder was
created by a different account, or the account was renamed, delete the folder from an
elevated prompt and re-run `scripts\setup.ps1`.

**"Context 'X' already exists"** from `setup.ps1` — deliberate. Existing contexts are never
silently replaced; `-Force` replaces that one context and leaves the others alone.

**Git prompts for credentials or hangs** — `GIT_ASKPASS` did not resolve. Confirm
`%USERPROFILE%\.ado-credentials\git-askpass.cmd` exists and that the `get-pat.ps1` beside
it is still there; re-running `scripts\setup.ps1` rewrites both.

**`az` says the session expired, or `AADSTS` / `TF400813` in the output** (macOS/Linux) —
the cached `az login` token is no longer valid. Run `az login` again (or
`az login --use-device-code` on a machine without a browser) and re-run the check.

## Rotating the PAT

Delete `%USERPROFILE%\.ado-credentials\ado-pat.xml`, revoke the old PAT in Azure DevOps,
and re-run `scripts\setup.ps1` with the replacement. If a PAT was ever pasted into a chat,
treat it as compromised and rotate it.
