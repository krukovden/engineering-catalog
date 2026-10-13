---
name: ado-board
description: Keep the Azure Boards card in step with the code — move a work item forward (todo → doing → testing → verify → done) on evidence, and reconcile the board with pushed branches and completed pull requests. Use when the user says "move 123 to doing", "mark the bug resolved", "sync the board", "reconcile the board", "which of my items have not moved", or a session line says items have not moved. Also run `states discover` once per project before the first move.
requires:
  - ado-credentials
---

# Skill: ado-board

One rule: **all work is visible on the board, and the board moves itself.** Cards move on
facts (a branch with pushed work, a completed pull request), never on anyone's memory.
Git and the board are the only inputs; nothing is remembered between runs.

Run `ado-credentials` first; continue only on `ok`.

## Buckets

Every work item type's states are mapped by their Azure DevOps **category** onto buckets:

| Category | Bucket | Note |
|---|---|---|
| Proposed | `todo` | |
| InProgress | `doing` | |
| any but Completed and Removed, **named** like `test`, `acceptance`, `verif`, `QA`, `review` | `testing` | *Ready for Testing*, *In Testing*, *Ready for Acceptance*: merged, not yet checked |
| Resolved | `verify` | Not done: for a Bug it means "awaiting QA verification" |
| Completed | `done` | |
| Removed | — | Never touched, neither from nor to |

Moves go **forward only**: `todo → doing → testing → verify → done`. A move to the same bucket does
nothing; a move backwards is refused. A card carrying any tag starting with `idp:` belongs to
the ai-sdlc-platform runner and is never moved by `reconcile` (a skip with reason
`idp-owned`); `move` refuses it unless `--allow-idp` is passed. `--allow-idp` is only for the
platform runner moving its own cards — never pass it yourself. This skill owns work item **states**; phase tags,
claims, owner and paused tags belong to the platform.

## Commands

Node ≥ 20, no dependencies. `<SKILL_DIR>` is this skill's directory. Run inside a clone of
the Azure Repos repository: the organization, project and repository come from `origin`
(`--org` / `--project` override).

Credential, as in `ado-pr-feedback`: a PAT from `AZURE_DEVOPS_EXT_PAT` (or `ADO_PAT`), else
on macOS/Linux the `az` login. The credential is never written anywhere and never printed.
Windows — put the PAT in the environment of the one command and remove it in `finally`; do not
echo it, do not open `ado-pat.xml`:

```powershell
try {
  $env:AZURE_DEVOPS_EXT_PAT = & "$env:USERPROFILE\.ado-credentials\get-pat.ps1" "Password"
  node "<SKILL_DIR>/scripts/ado-board.js" reconcile --dry-run
} finally {
  Remove-Item Env:\AZURE_DEVOPS_EXT_PAT -ErrorAction SilentlyContinue
}
```

| Command | Does |
|---|---|
| `ado-board.js states discover [--types "Bug,User Story"] [--choose "<type>:<bucket>=<state>;…"]… [--in-repo] [--non-interactive]` | Reads every board type's states and writes the per-project map. Without `--types`, takes every enabled type (Epic, Feature, the PBI / User Story / Requirement type, Task, Bug, …) except test, code-review and feedback types. `--choose` takes `;`-joined choices and may repeat |
| `ado-board.js move <id> <todo\|doing\|testing\|verify\|done> [--comment "<evidence>"] [--dry-run] [--allow-idp]` | One forward transition, with an evidence comment in the same revision. Without `--comment` the evidence is the current branch and HEAD; with neither, it refuses |
| `ado-board.js reconcile [--dry-run] [--stale-days 5] [--since 30] [--grace 10] [--everyone]` | Plans and applies the moves below, then reports |

`board.js` is an alias of `ado-board.js`. Each prints one JSON object on stdout and nothing
else; messages go to stderr. `--json` is accepted on every command and changes nothing, and
nothing ever prompts, so `--non-interactive` changes nothing either. Exit codes: `0` done or nothing to do · `1` a call failed
(credential, network, unknown item) — report it and stop · `2` a person must decide · `3`
refused by a rule (backwards, Removed, `idp:`, no evidence) — report the `reason`.

### `states discover`

Run once per project, and again when the process changes. When one bucket holds two
states (Scrum's *New* and *Approved* are both Proposed; *Ready for Testing* and *In Testing*
are both `testing`), it exits `2` with `needs-choice` and lists them in process order.
**Ask the user once** which state that bucket moves to, then re-run with `--choose`. Never
pick for them; for `testing`, the first listed state is the usual answer.

The map is written to `~/.engineering-catalog/ado-board/<organization>/<project>.json`
(`$ENGCAT_HOME` replaces `~`), on every OS, outside every repository. It holds the
organization, the project, the states and a `"version"` stamp — no credential and no
credential path. Only when the user asks to share it with the team, pass `--in-repo`: it
is then written to `<repo>/.engineering-catalog/ado-board.json`, which is read first when
present. Re-running `states discover` is the migration path, and it merges into the map
already there: the user's earlier choices are reused (`--choose` overrides one), types not
named in `--types` stay, fields it does not know stay. A legacy map with no `"version"` is
treated as version 0 and upgraded in place; a map with nothing to change is left alone.
Committing it is the user's decision.

`written` and `kept` answer with the path, `types` (each type's bucket targets) and
`stateMap`, the platform runner's view: `{ "<type>": { todo, doing, verify, done } }` as state
names, where `verify` is the type's `testing` state when it has one, else its Resolved state,
and is absent when it has neither.

### `move`

Pass evidence that names the branch, PR or witness: `--comment "PR 4821 completed"`.

`verify` is the Resolved bucket. For a type with `testing` states and no Resolved state it
means `testing`, so `move <id> verify` lands on the testing state. When
Azure DevOps refuses the transition because a field is required, the result is
`field-required` with the field's name (exit `2`). **Stop there.** Tell the user which
field the work item needs; never invent a value and never retry with a guess.

Every write tests the revision it was decided on. When the card changed in between, it is
read again. A changed work item type is `refused` (`type-changed`): the bucket was chosen
for the old type. Otherwise the same rules decide once more (`idp:`, Removed, forward only):
it then moves, is `unchanged`, or is `refused` with the reason. A second change in between is
`conflict` (exit `3`): nothing was written; tell the user and let them look at the card.

### `reconcile`

Always run `--dry-run` first and show the plan; apply after the user agrees, unless they
asked for the moves outright. Stateless and idempotent: a second run moves nothing.

| It sees | It does |
|---|---|
| A branch `feature/ADO-<id>-…` / `bug/ADO-<id>-…` with pushed commits, the item still `todo` | → `doing` |
| A completed PR, the item's type has `testing` states, the item is `todo`/`doing` | → `testing` (the chosen state), never `done` |
| A completed PR, the item is already `testing` | nothing: `observed`; a person moves it on after testing |
| A completed PR, the type has no `testing` state | → `done`; `verify` for a Bug (when its type has a Resolved state) |

A merged PR proves the code merged, not that it was tested: for a type with testing states,
`done` is only ever a person's `move <id> done`. Tell the user which items now wait in
testing; do not offer to close them.

- Completed PRs come from the PR API (linked work items, a `feat(<id>)`/`fix(<id>)`/`bug(<id>)`
  title, the source branch), never `git log --merges`: squash merges leave none. It pages
  through every PR closed in `--since` days; `coverage.pullRequests.complete: false` (with a
  `warning`) means it stopped early and some were not read. Say so, and suggest a smaller
  `--since`.
- It does not race the server. When "complete linked work items" was on, a PR completed in
  the last `--grace` minutes is left to the server (`waiting`); later, an item the server
  already moved is `observed` and left alone.
- `skipped` lists items it will not move and why (`code`): `idp` (reason `idp-owned`), `removed`, `not-found`,
  `unknown-type` (re-run `states discover`), `stale-map`: the map predates the `testing`
  bucket and the type has testing-looking states, so nothing moves on PR evidence until the
  user re-runs `states discover`. Suggest that run.
- `reports.staleDoing`: items in `doing` (yours; `--everyone` for all) whose state has not
  changed and that have no pushed commit in this repository for `--stale-days` days. An item
  worked in another repository shows here too; say so rather than moving it.
- `reports.unlinkedBranches`: pushed work on a branch that names no work item.

A move that needs a required field is reported in `applied` as `field-required`; the rest
still run. A card someone else moved on while reconcile ran is `unchanged` or `refused`
(`backwards`) in `applied`, and is not a failure.

## When it runs

On demand, at the end of every platform phase, or on a schedule (an Orca automation or a
pipeline). The `catalog-freshness` session check adds at most one line a day — "N items have
not moved" — when this skill is installed beside it and the project has a map. There are
**no per-commit git hooks**: a network call in `post-commit` would slow every commit, need
a credential inside a git hook, and share a file with memory's managed block.

## When NOT to use

- Creating, editing or commenting on a work item without a state change → `qa-ado-work-item`
  or the `az boards` CLI.
- Moving a card backwards, reopening it, or moving it to Removed: do that by hand on the board.
- Setting phase, claim, owner or paused tags, or any card with an `idp:` tag outside the
  platform runner.
- Choosing a value for a field a transition demands.
- The repository is not on Azure Repos, or the tracker is not Azure Boards.
- Starting a branch (`ado-branch`) or opening a pull request (`ado-pull-request`); those
  skills create the facts this one reads.

See `references/rest.md` for the endpoints and the shapes still to verify.
