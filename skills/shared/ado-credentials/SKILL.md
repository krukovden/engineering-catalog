---
name: ado-credentials
description: Preflight for Azure DevOps access — answers whether a credential is present, whether it still works against the organization, and exactly what to do if not. Run it first, then continue with the skill that needs Azure DevOps (for example qa-ado-work-item to file a bug); that skill starts only after this one answers ok. On Windows it checks the DPAPI-protected PAT written by its setup script; on macOS/Linux it checks the az CLI login and the azure-devops extension.
---

# Skill: ado-credentials

A preflight answers three questions about one dependency, deterministically: is it
there, is it alive, and if not, what does a person with no prior experience do about it.
This skill answers them for Azure DevOps. It never holds the credential — it records
where the credential lives and proves it against the real organization.

## Outcomes

| Outcome | Meaning | Exit code |
|---|---|---|
| `ok` | A credential is present and Azure DevOps accepted it for the configured organization and project | 0 |
| `absent` | No credential, no configuration, or (macOS/Linux) no `az` login / extension / defaults | 3 |
| `expired` | A credential exists but Azure DevOps rejects it — expired, revoked, or missing a scope | 4 |
| `error` | The check itself could not complete (network, unexpected response) | 1 |

`expired` is never collapsed into `absent`, because the fix differs: an absent credential
needs first-time setup; an expired one needs a new PAT (or a fresh `az login`) written
over the old one.

## Run it

Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<SKILL_DIR>/scripts/check.ps1"
```

macOS, Linux, Git Bash:

```sh
sh "<SKILL_DIR>/scripts/check.sh"
```

Both print exactly one JSON line and exit with the code from the table:

```json
{ "outcome": "ok", "detail": "Reached https://dev.azure.com/ORG / PROJECT as context 'Acme-QA'.", "steps": [] }
```

Read the JSON line **and** the exit code. Pass `-ContextName <name>` to `check.ps1` when
the machine holds several organizations and the request names one.

## What each outcome means for you

- **`ok`** — continue with the skill that needed Azure DevOps. Nothing to tell the user.
- **`absent`** — the user has a choice; you do not make it for them. Show the `steps`
  array verbatim, in order, then offer exactly two options and wait for the answer:
  1. *You do it* — the steps above, in a local terminal; tell you when done and you
     re-run the check.
  2. *I do it for you* — you run the tool installation and login steps here, one by one,
     showing each command before it runs, and re-run the check at the end. The one step
     that stays with the user is the credential itself: on Windows `setup.ps1` asks for
     the PAT in a masked prompt in *their* window; on macOS/Linux `az login` opens a
     browser or prints a device code that *they* complete.
  Do not start installing, configuring or logging in before the user picks option 2, and
  do not pick it on their behalf when they cannot answer (a non-interactive run). Do not
  try to work around the missing credential and do not attempt the Azure DevOps call anyway.
- **`expired`** — same two options, with the `steps` for a replacement credential. The
  old one is on the machine but no longer works; only the user can replace it.
- **`error`** — report `detail`, suggest the `steps`, and stop.

Whatever the outcome, this skill does not stand in for the one that sent you here: no
drafting, filing, reviewing or "ready-to-use" work items from this skill. That work
belongs to the skill that needs Azure DevOps and starts only after `ok`. Until then, tell
the user plainly what is blocked and why.

The PAT is **never typed into chat, never printed, never passed as an argument**, and
never read from its file by you. If a PAT has been pasted into a conversation, tell the
user to revoke it in Azure DevOps and rotate it — anything typed into a chat panel is
sent to a service and may be retained.

## Where the credential lives

Everything is under `%USERPROFILE%\.ado-credentials\`, outside every repository:

| File | Holds |
|---|---|
| `config.json` | `{ "version": 1, "activeContext": "<name>", "contexts": [ { "name", "organization", "project" } ] }` — where to check, never what with |
| `ado-pat.xml` | The PAT, protected with Windows DPAPI (`Export-Clixml` of a `SecureString`). Unwraps only for the same Windows user on the same machine |
| `get-pat.ps1` | Copy of the unwrapper, placed here so git's helper keeps working wherever this skill is installed |
| `git-askpass.cmd` | Git's credential helper (`GIT_ASKPASS`) — points at the `get-pat.ps1` beside it |

This skill records the **location** of the credential. It never records the value, and
no file in this skill's directory ever contains one. Other skills that need Azure DevOps
read the organization and project from `config.json` and use the same state folder; they
do not reach into this skill's directory.

On macOS and Linux there is no state folder: the credential is the `az` CLI's own cached
login, and the organization and project come from `az devops configure --defaults`.

## First-time setup

**Windows.** The user runs this themselves, in a local PowerShell window — never you,
and never in chat:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<SKILL_DIR>/scripts/setup.ps1"
```

It prompts for the PAT with masked input, protects it with DPAPI, asks for the
organization URL, project and a short context name, proves the credential reaches the
project and can list its work item types, and writes `config.json`, `get-pat.ps1` and
`git-askpass.cmd` into the state folder. The PAT needs the scopes **Code (Read)** and
**Work Items (Read & write)**; anything more is avoidable risk.

**macOS / Linux.** Three commands, run by the user:

```sh
az login
az extension add --name azure-devops
az devops configure --defaults organization=https://dev.azure.com/<ORG> project=<PROJECT>
```

Then re-run the check.

## Adding a second organization

Run setup again with a different context name:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<SKILL_DIR>/scripts/setup.ps1" -ContextName "Other-Org"
```

Contexts are **merged, never replaced** — an existing context with the same name is an
error, and `-Force` replaces just that one. The newest context becomes `activeContext`;
skills that consume this state pick a context by name when the request identifies one and
fall back to `activeContext` otherwise. All contexts share the one protected PAT; setup
offers to keep the existing PAT or type a new one.

See `references/troubleshooting.md` for the messages each script can produce.
