---
name: catalog-freshness
description: Once per session, before other work, check whether the installed engineering catalog is outdated — run the freshness script (it is cheap, needs only git, and stays silent when nothing is due) and relay its one-line hint to the user if it prints one. Applies to every project where the catalog is installed, on Claude Code and on GitHub Copilot alike.
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
- If it prints nothing, say nothing about freshness and carry on — `--quiet`
  means the check was skipped (still inside the interval) or the catalog is
  already current.
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
