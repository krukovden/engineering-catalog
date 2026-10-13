---
name: catalog-freshness
session-start: true
description: Once per session, before other work, check whether the installed engineering catalog is outdated — run the freshness script (it is cheap, needs only git, and stays silent when nothing is due) and relay its one-line hint to the user if it prints one. Applies to every project where the catalog is installed, on Claude Code and on GitHub Copilot alike. Also use when the user asks which version of the engineering catalog is installed; then run the script with --version (-Version) and answer with the line it prints.
---

## What to do

Once per session, before doing anything else, run:

```
sh "<SKILL_DIR>/scripts/check-freshness.sh" --quiet
```

replacing `<SKILL_DIR>` with this skill's own directory. On Windows, when no POSIX
shell is available, run the PowerShell twin instead:

```
powershell -NoProfile -ExecutionPolicy Bypass -File "<SKILL_DIR>/scripts/check-freshness.ps1" -Quiet
```

- If the script prints a line, relay it to the user verbatim, then carry on with
  whatever the user actually asked for.
- One line is not about freshness: *"No Azure DevOps project is connected yet…"*. It
  appears every session on Windows while the QA skill is installed and no project is set
  up. Relay it, and when the user sends a board link, add the project with
  ado-credentials when it is installed.
- One line is about the board: *"N items have not moved: …"*. It comes from `ado-board`
  when that skill is installed beside this one; relay it, and offer to reconcile the board
  with `ado-board` (dry run first). Never move cards on the strength of this line alone.
- One line is about local catalog-owned state: *"project state behind: run memory-init"*,
  *"… run ado-board states discover"*, or both joined by "and". It appears at most once a
  day when a managed memory block or the memory post-commit hook (→ `memory-init`), or an
  `ado-board` state map (→ `ado-board states discover`), still carries an older format stamp
  than this installed catalog writes. Relay it as is; each named command is an idempotent
  re-run that migrates its own component.
- If it prints nothing, say nothing about freshness and carry on — `--quiet`
  means the check was skipped (still inside the interval) or the catalog is
  already current. Not "the check is silent", not "now the preflight": never narrate
  this check, a preflight or any other internal step; the user sees only results.
  Send the tool call with no text beside it: on Copilot, words written next to a tool
  call reach the user as a message of their own.
- When the user asks which catalog version is installed, run the script with `--version`
  (PowerShell: `-Version`) instead of `--quiet` and answer with the line it prints. It reads
  the install receipt only: no network, no seven-day interval.
- Never run `update` yourself. The script only reports; updating is the user's
  decision.

## Why it lives here and not in a hook

An update mechanism nobody triggers is not a mechanism. The check lives inside
this skill, not in a vendor-specific hook, because a skill is something any
agent can be told to run — "check every N days, last checked on D" — just by
reading a file and running a command. This is what makes it work on GitHub
Copilot too, which may have no session-start hook at all: the skill is the
primary mechanism, not a fallback for when a hook is missing. See DESIGN.md
§7.4.

## What it reads

The script reads the install receipt — `./.engineering-catalog/receipt.json` in the
project when there is one, otherwise the one in the home directory — and takes the
source and installed version from the **first** install recorded there. It never
prompts for credentials: an unreachable or private remote is reported as "could not
read tags", not waited on.

## Interval

The default interval is 7 days, tracked in
`~/.engineering-catalog/freshness.json` (or under `$ENGCAT_HOME` when that
environment variable is set) as `{ "lastChecked": "<ISO date>", "latest": "<v>" }`.
Pass `--days N` to use a different interval, or `--force` to ignore the
interval and check right now regardless of when it last ran.

## The board line

When `ado-board` sits beside this skill, the script also runs `ado-board/scripts/board.js
nudge`: at most once every 24 hours per Azure DevOps project, cached in
`~/.engineering-catalog/board-nudge.json` (or under `$ENGCAT_HOME`) as
`{ "<organization>/<project>": { "lastChecked": "<ISO date>", "count": N } }`. It counts your
items in `doing` with no pushed commit in this repository for 5 days. It stays silent, and
never slows the session past a few seconds, when the repository is not on Azure Repos, the
project has no `ado-board` state map, there is no credential, or the network does not
answer. It is part of this one session-start check, never a second hook.

The script also tracks per-project local state stamps in
`~/.engineering-catalog/project-state.json` (or under `$ENGCAT_HOME`) as
`{ "<project path>": { "lastNotified": "<ISO date>", "signature": "<state>" } }`. A
legacy memory marker with no `v=…` counts as version 0; the current catalog writes
`<!-- engineering-catalog:memory:start v=1 -->` and `# engineering-catalog:memory:start v=1`.
