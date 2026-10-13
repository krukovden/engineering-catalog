---
name: project-workspace
description: Search several of the team's repositories at once, read-only, and know where every repository lives on this computer. Use when the user says "find where this breaks", "search all our repositories", "which project has this code", "did this change recently", "check Warehouse, Reports and Sidecar", names more than one repository to look in, or another skill needs to look at code it does not have open. Not for one repository the user is already working in — search that one directly.
requires:
  - ado-credentials
---

# Skill: project-workspace

You find code and recent changes across the team's repositories for a person who never types
commands — a tester, a product owner, or a developer. They talk to you; you run the script,
ask what it says must be asked, and answer in plain words.

What it guarantees, so you can say it with confidence:

- Searching never changes anyone's work. A developer's own project folder is only refreshed
  in the background; its files, its branch and anything unsaved stay exactly as they were.
- Projects that are not on the computer yet are downloaded only after a yes, into one shared
  folder kept separate from the person's own work.
- Each search reads the server's version as of at most 10 minutes ago, and says how old it is. When
  the server cannot be reached, the copy already on the computer is searched and its age said.

## When to use, when not

Use it when the question spans repositories, names a repository the person does not have
open, or asks what changed recently and where. Do **not** use it for the one repository the
person is working in right now — search that directly. Do not use it to change code: it only
reads.

## Talking to the person

- **Never decide for the person.** `setup`, `--approved` and `--reset` run only after the person
  answered yes to that exact question in this conversation. If you cannot ask (no question
  tool, a one-shot run), end your reply with the question and stop; do not pick the default
  folder or download anyway.
- **No text beside a tool call.** Call the scripts silently; words written next to a tool call
  reach the person as a message of their own. Write only questions and results.
- **One question at a time.** Never stack two questions in one message.
- **Offer the default** instead of an open question: "Is that fine, or should I use another
  folder?" — not "Which folder?".
- Show a folder path once, when confirming it; afterwards say "the shared folder".
- Never show the person a script name, a flag, `origin/…`, "fetch", "clone", "detached" or
  JSON. Say "download", "the latest version on the server", "the copy on this computer".
- Name repositories the way the person does (Warehouse, Reports), not by link.

### First run

With nothing configured, `search` and `ensure` answer `needs: setup` before anything else (`where`, `setup` and `register` work without it). Ask exactly its question, for example:

> I'll keep copies of projects in Documents\Projects. Is that fine, or should I use another
> folder?

A developer is asked one more question, after the answer to the first, and only then:

> Where do your working projects live?

If the reply to `setup` carries `needs: move-qa-workspaces`, ask its question once (projects the
earlier bug-filing assistant downloaded can be moved instead of downloaded again).

### Each decision the script hands back

Every reply with a `needs` field carries `ask` (the question, already in plain words),
`options` (the answers to offer) and `then` (what to run after a yes). Ask `ask`, offer
`options`, and act on the answer:

| `needs` | Ask | After the answer |
|---|---|---|
| `setup` | where the shared folder goes (default offered) | yes → run `then`; another folder → `setup --reference-root "<their folder>"`. A developer: ask the second first-run question, add `--working-root "<their folder>"`. Then retry what you were doing |
| `move-qa-workspaces` | may the projects the earlier bug-filing assistant downloaded be moved into the shared folder (setup is already saved) | yes → run `then`; no → leave them, carry on |
| `which-repos` | which repositories to search (known ones offered) | run `search` again with `--repos "<names>"`, or `--all` for "all of them" |
| `which-project` | which Azure DevOps project the repository is in (the projects are the options) | run `then` with `<org>/<project>/<name>` written in place of the bare name |
| `repo-link` | the link to the repository — nobody knows which project it is in; ask in plain words for the address of its page in Azure DevOps | run `then` with the link in place of the name |
| `clone-consent` | may the missing repositories be downloaded (sizes are unknown up front; do not guess one) | yes → run `then`; no → run the same search with those repositories left out of `--repos`, and say they were skipped |
| `reset-consent` | the shared copy has changes not on the server — throw them away? | yes → run `then`; no → search again without that repository and say why it was left out. Never discard without this yes |
| `board-choice` | which team's board the repository belongs to (teams listed) | run `then` with the team chosen; "none" → `--team none` |

## Commands — for the model only

Node ≥ 20, no dependencies, the same on macOS, Linux and Windows. `<SKILL_DIR>` is this
skill's directory. Every command prints one JSON object and never waits for input. Exit `0`
means a result or a `needs`; exit `1` means `{ "error" }` — tell the person in plain words.

Before the first `search` or `ensure` of a session, and before `link-board`, run
`ado-credentials` and continue with Azure DevOps only on `ok`: each of them may contact Azure
DevOps — to download a missing project or to refresh one already on the computer. When the check
does not answer `ok`, do not offer downloads; a `search` may still run over the copies already on
the computer, which come back `offline: true` — say they are offline copies and how old they are,
and what the person must do (from `ado-credentials`) to get the latest version.

Credential: a PAT from `AZURE_DEVOPS_EXT_PAT` (or `ADO_PAT`) authenticates both the downloads
and refreshes (passed to git through environment-only settings) and the board calls; else, on
macOS/Linux, the `az` login and git's own credential helper. It is never written anywhere and
never printed. Windows — put the PAT in the environment of the one command and remove it in
`finally`, so it never outlives that command in the session; do not echo it, do not open
`ado-pat.xml`:

```powershell
try {
  $env:AZURE_DEVOPS_EXT_PAT = & "$env:USERPROFILE\.ado-credentials\get-pat.ps1" "Password"
  node "<SKILL_DIR>/scripts/workspace.js" search --text "<words>" --repos "Warehouse,Reports"
} finally {
  Remove-Item Env:\AZURE_DEVOPS_EXT_PAT -ErrorAction SilentlyContinue
}
```

On macOS/Linux:

```bash
node "<SKILL_DIR>/scripts/workspace.js" search --text "<words>" --repos "Warehouse,Reports"
```

| Command | Does |
|---|---|
| `setup [--reference-root P] [--working-root P] [--move-qa]` | Without a folder: `needs: setup`. With one: saves it, maps the repositories under the working folder; earlier QA-Workspaces copies → `needs: move-qa-workspaces` |
| `where` | Folders, and per repository: where it lives, its shared copy, its board, when it was last refreshed |
| `register [path]` | Adds the repository at `path` (default: current folder) to the map. Other skills call it |
| `ensure <link\|org/project/repo\|name> [--org O --project P] [--approved] [--reset] [--fresh]` | Makes one repository searchable; returns `{ path, ref, fetchedAt, ageMinutes, offline }` |
| `search --text T [--repos a,b \| --project P \| --all] [--org O --project P] [--since "2 weeks ago"] [--approved] [--fresh]` | Searches the server's latest version of each repository: code (file:line) and commits (message or change) |
| `link-board <repo> [--team T]` | Attaches a team's board; without `--team`: `needs: board-choice` |

A bare repository name (Warehouse) is looked up in the projects the request names first. When
the person names the Azure DevOps project ("Contoso / Platform", "in Platform"), pass it:
`--org "Contoso" --project "Platform"`. A link in the same `--repos` list names the project for
the bare names beside it. Otherwise the script tries `ADO_ORG`/`ADO_PROJECT`, the boards it
knows, the current folder's repository, the `ado-credentials` project and the `az` defaults, and
asks (`which-project`, `repo-link`) only when that leaves more than one project or none.

`--fresh` skips the 10-minute wait between refreshes. Use it whenever the person asks about
something just pushed or merged, or wants the answer "right now" — a copy up to 10 minutes old can
miss it and give a false "not found". Every result carries `ageMinutes` (and `repos[].ageMinutes`):
when the copy is older than a few minutes, say how old it is, and offer a re-run with the latest.

## Reporting

Lead with the count, then the places, then the history:

> Found it in 2 of 3 repositories:
> - Reports — `src/export/CsvWriter.cs:118`
> - Warehouse — `Arm/Calibrate.cs:42`
>
> Recent changes:
> - Maria Lopez, 3 days ago, Reports: stopped writing the header row when the list is empty.

- A code result is `repo` + `file:line` (`path` is the file on this computer — use it for a link).
- A commit is who, when (in plain relative words), which repository, what it did in plain words
  from its subject. `match: message` = the words were in the description; `change` = the code
  changed those words.
- Nothing found → say so, and which repositories were searched.
- Many results → the ten most telling, then "and N more"; offer to narrow down.

### What could not be checked — always on its own line

- `failed` (`partial: true`): "I couldn't search Warehouse: it could not be downloaded (access
  denied)." Say what failed in plain words, never the raw error.
- `offline: true` on a repository: "Warehouse is unreachable right now, so I searched the copy
  from yesterday 14:00." Turn `ageMinutes` into a time a person would say.
- Every result, not only offline ones: when `ageMinutes` is more than a few minutes, say so in
  plain words ("searched the server's version from 8 minutes ago").
- `truncated: true`: "Reports had more matches than I could list."
