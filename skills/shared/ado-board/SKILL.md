---
name: ado-board
description: Keep Azure Boards in sync with repo facts — discover each work item type's states, move one item forward with an evidence comment, and reconcile pushed branches and completed PRs back onto the board. Use when board tracking must be deterministic or when the platform needs board movement without reimplementing it.
requires:
  - ado-credentials
---

# Skill: ado-board

This unit owns Azure Boards **state movement** for this catalog. It is stateless: git, the
board and the project-local state map are the inputs. Do not call Azure DevOps directly from
the model prompt; run this unit's Node scripts.

## Before you run it

1. Run `ado-credentials` first and continue only on `ok`.
2. Run `states discover` once per project before `move` or `reconcile`.
3. Read JSON output when you pass `--json`; the platform runner depends on it.

## Commands

All commands are run through the script:

```sh
node "<SKILL_DIR>/scripts/ado-board.js" <command> [flags]
```

| Command | Purpose |
|---|---|
| `states discover` | Reads each work item type's states, maps Azure state categories onto `todo / doing / verify / done`, and writes the project-local map file under `.engineering-catalog/ado-board.json`. It records **every** state name per Azure category and then chooses one primary state per bucket for writes, so alternate Proposed/Resolved/Removed states still map correctly on later reads. If a category has two candidate states, the script asks once and records the answer; for unattended runs pass `--non-interactive --choose "Type:bucket=State"` |
| `move <id> <bucket>` | Moves one work item **forward only** and writes an evidence comment. Use `--comment "..."` when you already have the witness text; otherwise the script names the current branch and SHA. `move` refuses `idp:`-tagged items with a non-zero result; only `reconcile` is allowed to skip them automatically. If Azure DevOps refuses the transition because a field is required, the script stops and returns the field name |
| `reconcile` | Compares pushed branches plus completed pull requests with the board, repairs forward drift, and reports stale work, untracked pushed branches and missing blueprint links. It never aborts the whole run on one bad item: Removed, closed/backwards, unmapped and missing items are reported as per-item skips, while successful moves stay applied. Completed PRs are recorded after they are processed so a later human reopen is never pushed forward again. |

## Required flags and defaults

- `--json` — machine-readable result for every command.
- `--state-file <path>` — optional override for the project map file. Default:
  `.engineering-catalog/ado-board.json` at the repository root.
- `.engineering-catalog/ado-board.json` holds only organization/project, discovered states and
  reconcile markers; it never stores credentials. Commit it if the team should share the
  mapping and processed-PR memory, or ignore it if the repo treats board wiring as local.
- `reconcile --stale-days <n>` — how long a `doing` or `verify` item may sit without a
  pushed commit before it is reported. Default: `7`.
- `reconcile --allow-unconfigured` — return a skipped result instead of failing when the
  project has no discovered state map yet. The session-start hook uses this.
- `reconcile --throttle-hours <n>` — do nothing when the same repository was already
  reconciled within the window. The session-start hook uses this too.

## What `reconcile` moves

| It sees | It does |
|---|---|
| `feature/ADO-<id>-…`, `bug/ADO-<id>-…` or `pbi/<id>-…` on `origin`, still ahead of the repo base branch, while the work item is `todo` | move the work item to `doing` |
| A completed pull request into the repo base branch for a linked work item that is not finished yet | move the item to `done`, or to `verify` when the work item type is `Bug` (falling back to `done` when that process has no `Resolved` state) |

The script finds completed pull requests through the PR API, not merge commits, so squash
merges are safe. On Azure Repos remotes it derives the organization and project from the
repository `origin` and refuses to run when that disagrees with the discovered state file or
the configured Azure context, so a hook never writes to the wrong org by accident. The
comment it writes names the branch or pull request that justified the move. `reconcile` is
idempotent: a second run over the same board and git state makes no changes.
