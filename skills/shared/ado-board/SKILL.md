---
name: ado-board
description: Keep Azure Boards in sync with repo facts — discover each work item type's states, move one item forward with an evidence comment, and reconcile pushed branches and completed PRs back onto the board. Use when board tracking must be deterministic or when the platform needs board movement without reimplementing it.
requires:
  - ado-credentials
---

# Skill: ado-board

This unit owns Azure Boards **state movement** for this catalog. It stores only local
reconcile metadata: discovered Azure state names, a bounded set of processed PR markers, and
retryable completed PR keys that must stay queryable. Correctness comes from the repository,
the board, and server-side timestamps plus ado-board's own evidence comments in work item
history. Do not call Azure DevOps directly from the model prompt; run this unit's Node
scripts.

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
| `move <id> <bucket>` | Moves one work item **forward only** and writes an evidence comment. Use `--comment "..."` when you already have the witness text; otherwise the script names the current branch and SHA. `move` refuses `idp:`-tagged items by default; only the platform runner may opt in with `--allow-idp` when it is moving its own runner-owned card. If Azure DevOps refuses the transition because a field is required, the script stops and returns the field name |
| `reconcile` | Compares pushed branches plus completed pull requests with the board, repairs forward drift, and reports stale work, untracked pushed branches and missing blueprint links. It never aborts the whole run on one bad item: Removed, closed/backwards, unmapped and missing items are reported as per-item skips, while successful moves stay applied. It never touches `idp:` cards. Completed PR markers are recorded only after non-retryable outcomes, retryable PRs stay in a bounded local retry set, and fresh clones still avoid replaying human reopen/todo changes by checking server-side state-change history and ignoring ado-board's own evidence-comment revisions. |

## Required flags and defaults

- `--json` — machine-readable result for every command.
- `--state-file <path>` — optional override for the project map file. Default:
  `.engineering-catalog/ado-board.json` at the repository root.
- `move --allow-idp` — explicit opt-in for the platform runner when it must move its own
  `idp:`-tagged card through `move`. Do not use it for ordinary board repair.
- `.engineering-catalog/ado-board.json` holds only organization/project, discovered states,
  bounded processed-PR markers, and bounded retryable PR keys; it never stores credentials.
  Treat it as local machine state and gitignore it unless a repo deliberately wants to share
  the discovered mapping.
- `reconcile --stale-days <n>` — how long a `doing` or `verify` item may sit without a
  pushed commit before it is reported. Default: `7`.
- `reconcile --first-run-days <n>` — with no reconcile watermark yet, only PRs closed within
  the last `n` days are examined. Default: `14`.
- `reconcile --max-pr-pages <n>` — PR list pages (100 PRs each) examined per run. Default: `2`,
  which keeps the session-start hook inside its 30 s budget; raise it for an on-demand
  catch-up. Hitting the budget is reported as the `pr-list-truncated` warning.
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
