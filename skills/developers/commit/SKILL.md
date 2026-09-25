---
name: commit
description: Commit the current changes as one commit per change — split by hunk when a file carries parts of two — each with a message that follows this repository's own convention, read from its history, conventional commits when there is none, built from the diff, cleaned of AI tells, and created only after the user has reviewed which files go into which commit, read every message, and said yes. Use when the user says "commit this", "commit my changes", "write a commit message", or has finished a change and wants it recorded.
requires:
  - unslop
---

# Skill: commit

A commit message is written for the person who reads `git log` a year from now. It
follows the convention the repository already has, it says what changed and why in
plain words, and it describes the diff — not the conversation that produced it.

## Commit

1. **See what changed.**

   ```sh
   git status --porcelain
   git diff --staged
   git diff
   ```

   - The user staged something on purpose and asked to commit that → the plan is one
     commit of the index as it stands. Mention unstaged changes in one line; do not add
     them.
   - Otherwise → plan the commits yourself, from everything that differs from the last
     commit.
   - Nothing changed → say so and stop.

   **Group by change, not by file.** A commit holds one change, whole: the fix with its
   test, the rename everywhere it lands. Two unrelated things (a fix and a rename
   elsewhere) are two commits; say why. The unit is the hunk, not the file — when one
   file carries parts of two changes, each part goes to the commit it belongs to:

   ```sh
   node "<SKILL_DIR>/scripts/hunks.js" list <file>          # id, @@ range, +/- counts, first changed line
   node "<SKILL_DIR>/scripts/hunks.js" show <file> <id>     # the full hunk
   node "<SKILL_DIR>/scripts/hunks.js" list --fine <file>   # zero context: separates edits that sit close together
   ```

   An id is a hash of the hunk's changed lines, so it stays the same after other hunks
   of the file are committed. Hunks with identical changes share an id; `list` marks
   the later ones `id#2`, `id#3`, counted among the hunks still uncommitted, so list
   again before staging a twin. Read every hunk before assigning it; a hunk goes where
   its change belongs, not where most of the file went. Two edits that `--fine` still
   shows as one hunk cannot be separated: the hunk goes to one commit and the plan says
   so. New, deleted, renamed and binary files have no hunks to pick (`list` prints
   `whole-file`) and go whole.

   A file that looks like a secret — `.env`, a key, a token, a credentials file — stays
   out of every commit: name it and ask.

2. **Learn the convention.**

   ```sh
   git log --no-merges -30 --format=%s
   git log --no-merges -5 --format='%s%n%n%b%n----'
   ```

   Read off what the history does consistently: prefixes and scopes (`fix(cli): …`), a
   ticket id and where it sits, capitalisation, a trailing period or none, the separators
   it uses, the language, how long subjects run, whether commits carry a body and what
   the body holds. Follow that. When there is no history, or it shows no pattern, use
   `references/conventional-commits.md`.

3. **Draft from the diff.** One message per planned commit, each written from the diff
   of its own files and hunks. The subject names the change in behaviour, not the activity:
   "export streams files over 10 MB", not "update exporter". Add a body only when the
   reason is not visible in the diff: why this approach, what it replaces, what was
   found and how. Name files only when that helps the reader find the change. Nothing
   from the chat goes in — no "as discussed", no list of attempts.

4. **Clean the prose.** Run the `unslop` skill on what a person will read: the subject
   text after any prefix, and the body. The convention from step 2 is not prose and stays
   as it is — the prefix, the scope, a ticket id, the separators the history uses. After
   the rewrite, check the subject against the length the history keeps (72 characters
   when there is no history).

5. **Show the plan and wait.** Before anything is staged or committed, print the whole
   plan for review — every commit, in the order it will be made, each with its files by
   name and its full message, subject and body:

   ```text
   Commit 1 of 2
     files:   src/export/stream.js
              test/export/stream.test.js
              src/app.js   hunks a3f9c1e (register the streaming route)
     message: fix(export): stream files over 10 MB

              The exporter buffered the whole file in memory, and the request
              timed out past 10 MB. It now writes to the response as it reads.

   Commit 2 of 2
     files:   src/wells/list.js
              src/app.js   hunks 77b2e04, c01d9aa (call sites of the renamed function)
     message: refactor(wells): rename listAll to listWells

   Left out: .env.local (looks like a secret), notes.txt (untracked, unrelated)
   ```

   One commit is a plan of one and is shown the same way. A file listed without hunks
   goes whole. A file split between commits appears in each of them with its hunk ids
   and a few words on what those hunks change, so the user can check the split without
   opening the diff. Every changed file and every hunk lands exactly once: in a commit,
   or under `Left out` with the reason.

   A commit cut out of a larger change is a state nobody has run. When a commit in the
   plan would not build or pass its tests on its own — it uses something a later commit
   adds, or leaves a generated file stale — say so under the plan and offer the order or
   the merge that avoids it.

   Wait for the user's explicit **yes**. Silence, a question, or a comment is not a yes.
   A comment — move a file to another commit, merge two commits, reword a message —
   changes the plan: apply it and print the whole plan again. The yes covers exactly the
   plan last shown, nothing more. When the run cannot ask questions, print the plan and
   stop; do not commit.

6. **Commit.** A plan of "the index as it stands" is one command: `git commit -F -` with
   the message on stdin, and nothing else touches the index. For a plan you built, make
   the commits in the approved order, one at a time, each from an index that holds that
   commit and nothing else:

   ```sh
   git reset -q                                   # empty the index; no file and no commit changes
   git add -- <whole file> <whole file>           # also a deleted path, and both paths of a rename
   node "<SKILL_DIR>/scripts/hunks.js" stage <file> <id> <id>    # add --fine when the ids came from list --fine
   git diff --staged --stat                       # must match the plan for this commit, no more and no less
   git commit -F - <<'MSG'
   <subject>

   <body>
   MSG
   ```

   `hunks.js stage` changes the index only; the working tree keeps every edit for the
   commits that follow. When `git diff --staged` shows anything the plan does not list
   for this commit, or misses something it does, stop and say so — do not commit a
   near match. The message goes on stdin so quotes and line breaks survive.

   When a hook rejects a commit, print its output and stop — the remaining commits of
   the plan are not made. The fix is the user's call, not a flag.

7. **Report one line per commit:** the short hash and the subject, for example
   `a1b2c3d fix(export): stream files over 10 MB`. When the plan stopped early, say
   which commits were made and which were not.

## Never

- stage or commit anything before the user has seen the plan — which files go into
  which commit, and every message in full — and said yes to it;
- commit a file or a hunk the approved plan does not list, or change a message after
  the yes;
- change, stash, restore or check out anything in the working tree — staging is the only
  thing this skill moves;
- push — the commit stays local until the user pushes or asks for a pull request;
- amend, rebase, reset to another commit, or otherwise rewrite history (`git reset -q`
  with no commit named only empties the index);
- pass `--no-verify` or skip a hook in any other way;
- run `git add -A`, `git add .` or the interactive `git add -p` — stage by name and by
  hunk id;
- add a tool signature, a generated-by line or a co-author trailer the user did not ask
  for;
- commit on `main` or `master` without saying so first and hearing a yes.
