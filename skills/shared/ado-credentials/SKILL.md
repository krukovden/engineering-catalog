---
name: ado-credentials
description: Preflight for Azure DevOps access — answers whether a credential is present, whether it still works against the organization, and exactly what to do if not. Run it first, then continue with the skill that needs Azure DevOps (for example qa-ado-work-item to file a bug); that skill starts only after this one answers ok. Also use when the user asks which Azure DevOps projects are connected, wants to add or remove a project (they give a board link and code links), says they now work in or want to switch to another project or team, or needs to enter or replace their PAT — on Windows all of it runs through this conversation, the user never runs a script. On macOS/Linux it checks the az CLI login and the azure-devops extension.
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

On Windows you run every script yourself; the user only answers in chat and approves the
commands. Never ask them to open PowerShell. `check.ps1` adds `missing` to tell you which
conversation to start:

- **`ok`** — continue with the skill that needed Azure DevOps. Nothing to tell the user.
- **`absent` / `expired` with `missing: "pat"`** — the PAT hand-over (below). For a
  brand-new user, ask for the board link first: it gives the organization the token page
  and the proof need.
- **`absent` with `missing: "project"`** — the PAT is fine but no project is configured:
  ask for the board link (and code links) and add the project (below).
- **`error`** — report `detail`, suggest the `steps`, and stop.
- **`warnings`** naming a paste file — a PAT was left on disk in plain text. Run
  `pat.ps1 -Import` now; it stores the PAT and deletes the file.

Whatever the outcome, this skill does not stand in for the one that sent you here: no
drafting, filing, reviewing or "ready-to-use" work items from this skill. That work
belongs to the skill that needs Azure DevOps and starts only after `ok`.

When the result carries `missing`, there is nothing to choose: start that conversation.
**macOS / Linux** (no `missing`, `check.sh`) has no hand-over: show the `steps` verbatim
and offer exactly two options — *you do it* (they run the steps, tell you, you re-check) or *I do it for you*
(you run the installs and `az login`, showing each command; the browser sign-in stays
theirs). Do not pick for them.

## The PAT hand-over (Windows)

The PAT is **never typed into chat, never printed, never passed as an argument**, and
never read from its file by you. Only `pat.ps1` opens the paste file.

**Never open, print, `cat`, `Get-Content`, `Import-Clixml` or decrypt `ado-pat.xml` or the
paste file — not to check it, not to debug, not once.** You run as the user, so you *could*
unwrap it; doing so sends the secret to the model provider and it must then be revoked.
The only test of whether the PAT works is `check.ps1` (or `pat.ps1 -Import` for a new one).
If those cannot answer, report what they said and stop.

1. Run `pat.ps1 -Prepare -Organization <org URL>` (the organization from the board link
   or from `projects.ps1 -List`). It creates an empty file readable only by this account
   and opens it in Notepad.
2. Show its `steps` verbatim: where to create the token (the link goes straight to the
   token page), which scopes, paste, save, close Notepad, say "done".
3. On "done", run `pat.ps1 -Import`. `ok` → re-run the check and carry on. `empty` → they
   have not saved yet; repeat its step. `rejected` → the token was not accepted; the
   previous PAT (if any) is still in place; offer to repeat from step 1. The file is
   deleted on every outcome except `empty`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<SKILL_DIR>/scripts/pat.ps1" -Prepare -Organization "https://dev.azure.com/ORG"
powershell -NoProfile -ExecutionPolicy Bypass -File "<SKILL_DIR>/scripts/pat.ps1" -Import
```

If a PAT has been pasted into a conversation anyway, tell the user to revoke it in Azure
DevOps and create a new one — anything typed into a chat panel is sent to a service and
may be retained.

## Projects (Windows)

A project is what the user can paste: a **board link**, optional **code links**, an
optional **alias**. `projects.ps1` reads the organization, project, team and the team's
area path from the links and proves them against Azure DevOps before saving. The board
link may be any page of the project — board, backlog (items, features, epics), sprint
taskboard/backlog/capacity, a work item, a query; the team comes from the page, from the
work item's area, or is the project's default team.

| The user says | You run |
|---|---|
| "which projects are connected?" | `projects.ps1 -List` — show alias, project / team, board link, repositories, and which one is current. A project with `needsBoard: true` was set up before board links existed: its work items land in the project root, not on a team board — say so and ask for its board link |
| "add a project" | ask for the board link and code links (alias optional), then `projects.ps1 -Add -BoardUrl <url> -CodeUrl <url>,<url> [-Alias <name>]` |
| "I work in X now" / "switch to X" | `projects.ps1 -Use X` |
| "remove X" | `projects.ps1 -Remove X` (cloned code stays on disk; say where) |
| a board link for a `needsBoard` project | `projects.ps1 -Add -Alias <that alias> -BoardUrl <url> [-CodeUrl ...]` — completes it in place (`upgraded: true`); nothing else about it changes |

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<SKILL_DIR>/scripts/projects.ps1" -Add -BoardUrl "<board link>" -CodeUrl "<code link>","<code link>" -Alias "<alias>"
```

Each prints one JSON line. On `-Add`: do what its `next` says in the same turn, then report the alias, project / team and repositories it
found, and every entry of `warnings` (a skipped code link says why). `needs-pat` → do the
hand-over with the `organization` it names, then add again. `error` → its `detail` says
what to fix (an unknown team or project lists the real ones). The first project becomes
current; a later one does not — say so, and offer `-Use`.

**Right after a successful `-Add`, run the command in its `next` field** when there is
one (it appears when `qa-ado-work-item` is installed): it clones the code links and makes
the team's area the default for new work items. Exit 2 means the workspace is saved but a
repository did not clone; say which.

"Switching" always means `projects.ps1 -Use` — acknowledging it in words changes nothing
on disk, and the next work item would still go to the old project.

## Where the credential lives

Everything is under `%USERPROFILE%\.ado-credentials\`, outside every repository:

| File | Holds |
|---|---|
| `config.json` | `{ "version": 1, "activeContext": "<alias>", "contexts": [ { "name", "organization", "project", "team", "areaPath", "boardUrl", "repositories" } ] }` — the projects; `activeContext` is the current one. Where to check, never what with |
| `paste-pat-here.txt` | Exists only between `pat.ps1 -Prepare` and `-Import`; the check warns if it is left behind |
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

**Windows.** Nothing for the user to run: the check reports `missing`, and the hand-over
and `projects.ps1 -Add` above do the rest. `setup.ps1` (masked console prompt for the PAT,
then a project URL and a context name) remains for setting a machine up by hand. The PAT
needs the scopes **Code (Read)** and **Work Items (Read & write)**; anything more is
avoidable risk. One PAT covers one organization unless it was created for all accessible
organizations.

**macOS / Linux.** Three commands, run by the user:

```sh
az login
az extension add --name azure-devops
az devops configure --defaults organization=https://dev.azure.com/<ORG> project=<PROJECT>
```

Then re-run the check.

See `references/troubleshooting.md` for the messages each script can produce.
