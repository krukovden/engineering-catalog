---
name: catalog-doctor
description: Runs only when asked — diagnose this engineering catalog install and repository wiring, report silent failure modes, and tell you the next fix.
invocation: user
requires:
  - ado-credentials
---

# Catalog Doctor

Read-only health check for the catalog's easy-to-miss failures: conflicting Copilot
installs, untrusted repository hooks, extra `sessionStart` hooks, missing memory
pointers, a backed-up `.pending` queue, `node` on PATH, and the current `ado-credentials`
status.

Run the script and present every check as **ok / warn / fail / skip**, with its one-line fix.
Do not fix anything from this skill; it only diagnoses.

`<SKILL_DIR>` below means this skill's own directory.

macOS / Linux / Git Bash:

```sh
sh "<SKILL_DIR>/scripts/doctor.sh" --json
```

Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<SKILL_DIR>/scripts/doctor.ps1" -Json
```

Optional flags:

- `--pending-limit <n>` / `-PendingLimit <n>` — warn when `memory/.pending` has more than
  `<n>` lines (default `20`)
- `--root <path>` / `-Root <path>` — inspect a different repository root
- `--home <path>` / `-Home <path>` — inspect a different home directory

## What the script checks

1. Copilot plugin + `engcat` Copilot installs present together, which collides because
   Copilot skills share one flat namespace (`copilot-facts.md` §7)
2. The repository absent from Copilot's `trustedFolders`, where that is detectable from
   `~/.copilot/config.json` (`copilot-facts.md` §6.3)
3. Repository-owned `sessionStart` hooks in `.github/hooks/*.json` or `.claude/settings.json`
   that could cancel the catalog's own message (`copilot-facts.md` §6.5)
4. `node` missing from PATH (deny hooks need it)
5. The memory pointer block missing from `CLAUDE.md`, `AGENTS.md` or
   `.github/copilot-instructions.md`, or `memory/.pending` longer than the limit — `skip`
   outside a git repository, where memory does not apply
6. `ado-credentials`, by running its real check script rather than reimplementing it, with the
   organization and project taken from `ADO_ORG`/`ADO_PROJECT`, the repository's Azure
   DevOps origin, or the one board `~/.engineering-catalog/repos.json` maps

## How to present it

- Lead with any `fail` checks, then `warn`, then `ok`, then `skip`.
- Quote the script's `detail` and `fix`; do not improvise a different remedy.
- If everything is `ok`, say so plainly.

## What this skill does not do

- It does **not** install or uninstall the catalog.
- It does **not** trust the folder, edit hooks, or run `memory-init`.
- It does **not** create Azure DevOps items; use `catalog-feedback` for that.
