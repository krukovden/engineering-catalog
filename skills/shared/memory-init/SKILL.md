---
name: memory-init
description: Initialise project memory in this repository — choose the store, create the memory folder and index, point Claude and Copilot at it, install the post-commit hook, then fill the index from the code with honest evidence grades. Run once per project; safe to run again.
invocation: user
requires:
  - memory
---

Sets up the memory that the `memory` skill reads in every later session. Run it
from the project root, once per project. It is resumable: run twice, it continues
from the last completed step rather than starting over.

`<SKILL_DIR>` below means this skill's own directory.

## Step 1 — ask the store

Ask one question, with a recommendation:

> Where should project memory live? **committed** (recommended — a `memory/` folder
> in the repository: travels with it, reaches teammates, survives a new machine)
> or **local** (on this machine only, for a repository you cannot commit to)?

Accept the answer and move on. There is exactly one store; the catalog never mirrors
memory to a second place, so this is chosen once. If the answer is `local`, the
folder goes under `~/.engineering-catalog/memory/<hash of the project path>/` and
nothing memory-related is added to the repository except the pointers.

## Step 2 — run the script

```
node "<SKILL_DIR>/scripts/memory-init.js" --project . --store <committed|local> [--dir memory] [--name <project name>]
```

`--dir` is the folder name inside the repository for a committed store (default
`memory`); `--name` is the title used in the index (default: the project folder's
name). Add `--json` for machine-readable output.

The script prints `memory dir: <path>` and then one line per step,
`<step>  <state>  <detail>`:

| Step | What it does | `done` | `kept` | `skipped` |
|---|---|---|---|---|
| `folder` | creates `<memory>/units/` and `<memory>/.store.json` (`{ "store", "dir", "created" }` — `dir` is the repo-relative posix path such as `memory` for a committed store, the absolute folder for a local one) | created now | both already existed | — |
| `index` | writes a skeleton `index.md`: contract comment, `reconciled-sha: none`, `store: <choice>`, empty sections, an empty `## Units` table, a placeholder rejection line | written now | file already existed — untouched | — |
| `pointers` | writes the managed block into `CLAUDE.md`, `.github/copilot-instructions.md` and `AGENTS.md` (created if absent; existing content kept) | at least one file changed | all three already carried the block | — |
| `hook` | installs `git rev-parse HEAD >> "$(git rev-parse --show-toplevel)/<dir>/.pending"` (committed store; the local store uses its absolute folder, forward slashes) into the repository's `post-commit` hook, between `# engineering-catalog:memory:start/end` markers; an existing hook keeps its own content | written now | already present | not a git repository |
| `gitignore` | adds `<dir>/.pending` to `.gitignore` | added now | already listed | store is `local` |

`error` on any line means that step failed and the script exits 1; read the detail,
fix the cause, run the same command again. Re-running continues — every step that
is already in place reports `kept`; nothing is recreated, and an existing
`index.md` is never overwritten.

## Step 3 — fill the index from the code

The script leaves `## What this project is` and `## Architecture` as placeholders
and the `## Units` table empty. Fill them from the code you can see — read the
build files, the top-level layout, the entry points and the tests — and write:

1. **What this project is** — two to five sentences: what it does, for whom, what it
   is built with.
2. **Architecture** — the main parts and how they connect, as prose or a short
   list. Derived from the code, not from what a README promises.
3. **Units** — one row per coherent piece of functionality (a feature, a theme, a
   subsystem): `| [[<slug>]] | <one line> |`. Do not impose a granularity; the
   boundary must be meaningful and a file must not become a dumping ground. For
   every row create `<memory>/units/<slug>.md`:

   ```markdown
   <!-- memory:unit <slug> — the chain of this piece of functionality. Append entries under ## Entries;
        never delete a superseded entry; write supersede links in both directions. -->
   # <Title>

   ## Entries

   This predates tracking; history before <YYYY-MM-DD> is not recorded.
   ```

   with today's date. **The "why" stays empty.** It is not in the code, and a
   reconstructed reason reads later as a verified one. Tracking begins now.
4. **Evidence grades.** If you record any claim about *why* something is the way it
   is — for instance an entry describing a constraint you can see in the code —
   grade it `evidence: inferred`. Use `confirmed` only for what you verified by
   running it or what a person told you in this session. Never invent a
   rejection: leave the placeholder line under `## Rejected at project level` as
   it is until a real one is recorded.

Then lint: `node "<memory skill dir>/scripts/lint.js" --memory "<memory>"` — the
`memory` skill carries the script. It checks that every index row has a unit file,
every unit file has a row, and every entry's fields are valid.

## Step 4 — pointers

Verify the managed block landed in all three files:

```
<!-- engineering-catalog:memory:start -->
## Project memory
Read `memory/index.md` first. Load `memory/units/<slug>.md` only when work touches that unit.
Write an entry only when the change is hard to reverse, not obvious without context, and the result of a real trade-off — all three.
Unit files win over the index. Update only your own index row. Never record credentials, personal data or session narrative.
<!-- engineering-catalog:memory:end -->
```

(for a `local` store the two paths are absolute). `CLAUDE.md` is Claude's entry
file; `.github/copilot-instructions.md` and `AGENTS.md` are both Copilot's, on
purpose: until it is verified which one Copilot honours in the installed
configuration, both are written — a redundant pointer costs nothing, a missing one
costs everything. Do not remove either. The pointer is how any agent finds memory,
on any tool that reads an entry file at all.

## Step 5 — commit

For a `committed` store:

```
git add memory CLAUDE.md AGENTS.md .github/copilot-instructions.md .gitignore
git commit -m "chore: initialise project memory"
```

(use the `--dir` name instead of `memory` if you changed it). `memory/.pending` is
ignored by `.gitignore` and must stay uncommitted — it is this machine's queue. The
hook lives under `.git/` and is not committed; each clone runs `memory-init` once to
get it, and reports `kept` for everything else.

For a `local` store, commit only the three pointer files if the repository allows
it; otherwise leave them as local modifications.

## What this does not do

- **No work tracker.** Memory lives in the repository; nothing here requires a
  board.
- **No database, service, daemon or index to rebuild.** Markdown under git is the
  store; anything derived must be rebuildable from it and is never the thing that
  is trusted.
- **No second store.** One store, chosen once in Step 1; never mirrored.
- **No author.** Entries never record who decided; git has it.
