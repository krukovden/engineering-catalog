# Exit codes and failure modes

> Script paths on this page are relative to this skill's directory — the folder that holds `SKILL.md`.

Every script prints one JSON object on stdout and signals outcome through its exit code.
Read both — the code distinguishes "nothing happened" from "something happened and needs
reporting", and that distinction decides whether a retry is safe.

Credential problems — a rejected PAT, a missing protected PAT, git prompting for a
password — belong to the `ado-credentials` skill. Run its preflight first: it names the
outcome (`absent` / `expired`) and the exact steps, and its own troubleshooting page
covers the rest.

## Exit codes

| Script | Code | Meaning | What to do |
|---|---|---|---|
| any | 1 | Error; nothing was written to Azure DevOps | Read the message and fix the cause |
| `setup-workspace.ps1` | 0 | Workspace recorded, repositories cloned | Continue |
| `sync-context.ps1` | 0 | Every repository is current | Continue |
| `sync-context.ps1` | 2 | Some repository is not current | **Continue.** Label evidence from that repository with its state |
| `query-ado.ps1` | 0 | Read succeeded | Continue |
| `publish-work-item.ps1` | 0 | Preview produced, or item created and verified | Continue / report the id and URL |
| `publish-work-item.ps1` | 1 | Validation failed; nothing sent | Fix the draft, preview again |
| `publish-work-item.ps1` | 3 | Refused; **nothing sent** | See "Refusals" below. Never force past it |
| `publish-work-item.ps1` | 5 | Created, but the read-back differs | Report the mismatch with the URL. **Never retry** |

## Repository states from `sync-context.ps1`

| State | Meaning |
|---|---|
| `current` | Fetched and fast-forwarded; `detail` is the short HEAD sha |
| `dirty` | Uncommitted local changes — fetched, pull skipped, tree untouched |
| `detached` | Not on a branch — fetched, pull skipped |
| `no-upstream` | The branch tracks nothing — fetched, pull skipped |
| `diverged` | Local commits differ from upstream; fast-forward refused, nothing changed |
| `fetch-failed` | Remote unreachable, or the PAT lacks **Code (Read)** — run the `ado-credentials` preflight |
| `missing` | No Git checkout at the configured path — re-run `setup-workspace.ps1` |

Anything other than `current` is still usable evidence. It is not usable as *current* evidence.

## Refusals (exit 3)

**"-Commit requires -ApprovedHash"** — run the preview, show it to the user, and pass back
the `draftHash` they approved.

**"The draft changed after the approved preview"** — the draft moved between approval and
publish. Preview again and ask again. Do not pass the new hash without re-asking; the point
of the check is that the human saw this wording.

**"This draft was already published"** — the receipt beside the draft records the id and
URL. Report those. There is no second item to create.

**"A previous publish … never recorded an outcome"** / **"… failed at … with:"** — the
request went out, so the item may or may not exist. The second form names the error Azure
DevOps returned, which usually settles it — but search before doing anything either way:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts/query-ado.ps1" -Action Duplicates -Text "<the draft title>"
```

If it exists, write its id and url into the `.receipt.json` file with `"state": "created"`.
If it does not, delete the receipt file and re-run the publish. Deleting a receipt without
searching first is how a duplicate gets created.

## Common errors

**"Context 'X' has credentials but no workspace"** — the `ado-credentials` setup ran for
that context but this skill's `setup-workspace.ps1` did not. The user runs it, in a local
PowerShell window, and picks the repositories.

**"Context 'X' not found in the credentials config"** — the name does not exist on the
credentials side, so there is no organization or project to work against. Either the name
is misspelled (the message lists the known ones) or the `ado-credentials` setup has not
been run for it yet.

**"Workspace config not found"** — `%USERPROFILE%\.qa-ado-work-item\config.json` does not
exist. Run `setup-workspace.ps1`.

**"Azure DevOps rejected the PAT"** — the credential is the `ado-credentials` skill's
concern. Run its preflight; it reports `expired` with the steps to replace the PAT.

**"'X' is not a work item type in <project>"** — the process does not have that type. Run
`query-ado.ps1 -Action Types`.

**"not fields of '<type>'"** — a real field name, wrong type. See
[field-mapping.md](field-mapping.md); the usual cause is `System.Description` on a Bug.

**"Context 'X' already has a workspace"** from `setup-workspace.ps1` — deliberate. Existing
contexts are never silently replaced; `-Force` replaces that one context and leaves the
others alone.

**"Git credential helper not found"** — `git-askpass.cmd` is written by the
`ado-credentials` setup into `%USERPROFILE%\.ado-credentials\`. Run that setup; nothing in
this skill writes the helper.

**"This skill runs on Windows only"** — the PAT protection has no macOS or Linux
equivalent. It refuses rather than storing the secret less safely.
