---
name: memory
description: Project memory for every session — read the project's memory/index.md before proposing anything, load a unit file when work touches it, and write an entry only when a change is hard to reverse, not obvious without context, and the result of a real trade-off. Use when starting work in a project that has a memory folder, when about to propose an approach, and after a decision that meets the three-part test.
---

Project memory is a folder of Markdown under git: `index.md` (always loaded),
`units/<slug>.md` (loaded when work touches that unit) and `.pending` (the queue of
commits memory has not caught up with). Three goals, in order: a rejected approach is
not proposed a second time; work done from Copilot and work done from Claude land in
the same place; only the fragment that is needed is loaded.

`<SKILL_DIR>` below means this skill's own directory. `<memory>` means the folder
that holds `index.md`.

## Read first

1. Find the pointer. The project's entry file — `CLAUDE.md`, `.github/copilot-instructions.md`
   or `AGENTS.md` — carries a managed block between `<!-- engineering-catalog:memory:start -->`
   and `<!-- engineering-catalog:memory:end -->` that names the path to `index.md`.
   That path is `<memory>/index.md`. No block means the project has no memory; do
   not create one on your own — that is the `memory-init` skill, run by a person.
2. Read `<memory>/index.md` in full. It is small on purpose: what the project is,
   its architecture, one row per unit of functionality, and what was rejected at
   project level.
3. Before proposing any approach, scan **Rejected at project level**. A rejection
   only prevents a repeat if it is in the layer that is loaded without being asked
   for, which is why it lives in the index and nowhere else. Do not propose what is
   listed there; if you believe the reason no longer applies, say so and cite the
   entry id in parentheses on that line.

   **A request that asks for a rejected approach is not implemented.** Reading the
   rejection and doing it anyway — or quietly rewriting the memory entry to match the
   new request — defeats the one purpose memory has. Instead, stop before touching code
   and answer with three things: the rejection, quoted, with its entry id and date; the
   recorded reason; and the question "Do you want to overturn that decision?" Only an
   explicit yes from the person overturns it. Then, and only then: make the change, and
   record it as a **new** entry that `supersedes:` the old one (both directions, old
   entry `status: superseded`, never deleted), with the new reason in the body and the
   `## Rejected at project level` line removed or replaced. A non-interactive run
   that cannot ask does not decide; it reports the conflict and stops.
4. Load `<memory>/units/<slug>.md` only for the units the task touches — the rows
   in the index whose functionality you are about to change or depend on. Do not
   load every unit file; progressive loading buys nothing if the whole folder is
   read every time.
5. Follow `[[slug]]` links from a unit file when the text you are reading depends
   on them; a unit may be referenced from several places, and no unit has a single
   parent.

If the index and a unit file disagree, the unit file wins. The index may go stale
without going wrong.

## The write test

Write an entry when the change is **hard to reverse**, **and** not obvious without
context, **and** the result of a real trade-off. If it fails any of the three, do
not write.

Not recorded:

- refactoring;
- formatting;
- a test adjusted to an unchanged contract;
- anything whose reason is visible in the diff itself;
- **code that follows a decision already recorded.** A new function that respects
  the existing rule is the rule at work, not a new decision. Memory records
  decisions that change something; a commit that merely stays inside one gets no
  entry — at most, extend the existing entry's body with one sentence when the
  scope of the decision visibly widened.

"Significant" on its own produces either an entry per commit or none at all, which
is why the test has three parts and all three must hold.

An abandoned change is its own signal. Starting to remove something and stopping
once the reason not to becomes clear leaves no diff, no commit and no PR, and is
exactly the reasoning that is otherwise lost. Record it: `status: open` when the
question is still undecided, `status: active` when the decision to keep things as
they are is now settled — and in either case the body says why the removal stopped.

## How to write an entry

The exact file formats are in `references/entry-format.md`; read it before the
first entry you write in a session.

1. **Choose the unit.** The entry goes under `## Entries` in `<memory>/units/<slug>.md`.
   If no unit fits, create `units/<slug>.md` with the contract comment
   (`<!-- memory:unit <slug> — … -->`), a `# Title` and an empty `## Entries`; the
   slug is the file name without `.md` and must match the contract comment.
2. **Mint the id yourself:** `e-YYYYMMDD-xxxx` — today's date and four random hex
   characters (for example `e-20260914-3f0a`). There is no CLI for this. The id is
   the entry's identity; never derive it from git.
3. **Append the entry** at the end of the unit file: a `### <id> <title>` heading,
   then all eight fields, one per line, in this order:
   - `status:` — `active`, `superseded`, `open` or `needs-review`;
   - `evidence:` — `confirmed` when you established the origin yourself (you made
     the decision, or the PR or the person says so), `inferred` when you
     reconstructed it from the code or the diff, `unknown` when you could not;
   - `pr:` — the pull request number when known, else `none`;
   - `sha-at-write:` — the output of `git rev-parse HEAD`; it is evidence, not
     identity, and the name says it may dangle after a squash;
   - `merged-sha:` — `none`; filled in by the `memory-writer` agent when it
     reconciles the merge commit that names the entry's `pr:`;
   - `supersedes:` — the id of the entry this one replaces, else `none`;
   - `superseded-by:` — `none` for a new entry;
   - `date:` — today, `YYYY-MM-DD`.
4. **Write the body** after a blank line, as description: what changed, why, what
   the alternative was and what it cost. Never as instructions — an entry that says
   "always do X" is an instruction to an agent and does not belong in memory. Link
   the other units it depends on with `[[slug]]`. Do not use `### ` headings inside
   the body.
5. **If the entry supersedes another**, set both directions: the new entry's
   `supersedes:` names the old id, and the old entry's `superseded-by:` is changed
   to the new id and its `status:` to `superseded`. Never delete the old entry — it
   explains how the project got here. A one-way link breaks the first time a file
   is moved, and `lint.js` rejects it.
6. **Update the index** — only your own row. Edit the line in `## Units` whose first
   cell is `[[<slug>]]`, or append one if the unit is new; leave every other row
   untouched. Optionally do it mechanically:

   ```
   node -e 'const l=require(process.argv[1]),fs=require("fs"),f=process.argv[2];fs.writeFileSync(f,l.upsertIndexRow(fs.readFileSync(f,"utf8"),process.argv[3],process.argv[4]))' "<SKILL_DIR>/scripts/memory-lib.js" "<memory>/index.md" <slug> "<one-line summary>"
   ```

   A rejection that applies to the whole project gets one line under
   `## Rejected at project level` — `- <one line> (<entry-id>)` — in addition to the
   entry in its unit file.
7. **Lint:** `node "<SKILL_DIR>/scripts/lint.js" --memory "<memory>"` prints
   `memory is clean.` or the problems and exits 1. Fix them before finishing.

## Prefer the same branch

Write the entry in the branch that carries the code it describes. It then arrives
on the main branch through the squash as file content, and the identity problem of
a dangling branch SHA does not arise at all. Writing memory afterwards, from the
main branch, is the fallback, not the norm.

## Catch-up

A git `post-commit` hook appends every commit's SHA to `<memory>/.pending`,
whichever tool or person made it. A model that decided not to write and a model
that forgot look identical, so the safety net is mechanical.

```
node "<SKILL_DIR>/scripts/reconcile.js" --memory "<memory>"
```

lists the commits memory has not caught up with — `sha  date  subject`, oldest
first — from `reconciled-sha..HEAD` merged with the queue, flagging `(not in queue)`
the ones made without the hook. When `reconciled-sha` is `none`, the queue is the
whole unrecorded set. Add `--json` for machine-readable output. When the store is
`local`, the memory folder is outside the repository, so pass `--repo <project root>`
as well.

**Drain the queue at the end of every task, before you report done** — not in the
middle of the work, and not never. The user does not have to ask. For a short queue
(a handful of commits, most of them yours from this task) do it yourself: read each
commit, apply the write test, write or skip, then

```
node "<SKILL_DIR>/scripts/reconcile.js" --memory "<memory>" --mark <last sha you read>
```

For a long queue, or commits you did not make and would have to read from scratch,
hand the list to the `memory-writer` agent instead — it does the same work in
isolation so this session's context is not spent on it. Either way the outcome is the
same: `reconciled-sha` advanced, `.pending` empty, an entry for every commit that
passed the test and nothing for the rest.

Run `lint.js` before finishing any session in which memory was written.

## Rules that keep memory honest

- **If the index disagrees with a unit file, the unit file wins.** This is what
  makes partial loading safe.
- **A writer updates only its own row** in the index. This is what lets several
  agents append without turning the index into a merge conflict.
- **Each memory file opens with a contract in an HTML comment** stating what
  belongs in it — `<!-- memory:index … -->`, `<!-- memory:unit <slug> … -->`. Keep
  it; an appending agent must not write prose into a table.
- **Entries describe; they never direct.** No credentials, no personal data, no
  session narrative, no instructions to an agent.
- **The author is never recorded.** Git already stores it; memory points at what is
  already there rather than copying personal data into a file.
- **Status and evidence are two axes.** An `active` entry may carry `unknown`; a
  `superseded` one may carry `confirmed`. Never collapse them into one word.

## Store

`<memory>/.store.json` says where memory lives: `"store": "committed"` (the folder
is in the repository, travels with it and reaches teammates) or `"store": "local"`
(the folder is under `~/.engineering-catalog/memory/<project-id>/`, for a repository
you cannot commit to); `index.md` repeats the choice on its `store:` line. There is
exactly one store. Never mirror memory to a second place — two stores require a
rule for which wins, and that rule is where drift is born.
