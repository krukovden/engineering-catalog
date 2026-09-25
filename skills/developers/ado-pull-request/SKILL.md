---
name: ado-pull-request
description: Finish a task with a pull request whose title and description feed the release notes — feat(<id>)/fix(<id>)/bug(<id>) lines written from the real diff, review offered, squash merge into main. Use when the user says "prepare the PR", "create a pull request", "the code is done", or is about to push a finished branch.
requires:
  - ado-credentials
  - pr-review
  - unslop
---

# Skill: ado-pull-request

A pull request is squash-merged into `main`, and the squash commit — subject = PR title,
body = PR description — is what the release-notes pipeline reads. Every line shaped
`feat(<id>): …`, `fix(<id>): …` or `bug(<id>): …` becomes a release-note line. Nothing
else does. The format is in `references/release-notes.md`.

## Prepare the PR

The user says the work is done ("prepare the PR", "create a pull request", or is about
to push).

**Preflight.** Run the `ado-credentials` skill first and read its outcome. On `absent` or
`expired` it has already told the user what to do — still work through steps 1–7 so the
draft is ready, but stop before step 8; do not try the Azure DevOps call anyway.

1. **Check the branch is ready.**

   ```sh
   git fetch origin main
   git status --porcelain
   git rev-list --count origin/main..HEAD
   ```

   Refuse — and say why — when there are uncommitted changes (`status` prints anything)
   or the branch is not ahead of `origin/main` (count is `0`). Do not stash, commit or
   push on the user's behalf to get past this.

2. **Read what actually shipped.**

   ```sh
   git diff --stat origin/main...HEAD
   git diff origin/main...HEAD -- <paths the stat does not explain>
   ```

   The diff is the truth. Commit messages are development noise — "wip", "fix test",
   "address review" — and the squash discards them; do not build the PR from them.

3. **Take type and id from the branch.**

   ```sh
   node "<SKILL_DIR>/scripts/parse-branch.js" "$(git branch --show-current)"
   ```

   Prints `{"type":"feat","id":"103520"}`, `{"type":"fix","id":"103533"}`, or `null`.
   On `null` the branch is outside the convention: say so, ask the user for the work item
   id and whether it is a feature or a fix, and continue with their answer.

4. **Write the release-note lines.** One line per change a user of the product would
   notice — not per commit, not per file:

   - `feat(<id>): …` for new behaviour, `fix(<id>): …` for a fixed defect. Use
     `bug(<id>): …` only when the user's team spells it that way; never `feature(…)`.
   - Imperative, ≤ 72 characters, no trailing period: `fix(103533): export the full file
     when it exceeds 10 MB`.
   - Refactoring, tests, formatting, CI and dependency bumps get **no** line. A branch
     that shipped only those still needs one line — the one change that motivated it.

   The first line is the PR title. When a branch ships one change, that is the only line.

5. **Write the description.** Exactly this shape:

   ```text
   fix(103533): export the full file when it exceeds 10 MB
   feat(103533): show the export size before download

   Why: The exporter buffered the whole file in memory and the request timed out
   past 10 MB; it now streams.
   How tested: unit tests for the streaming path; manual export of a 40 MB report.
   Work item: #103533
   ```

   Release-note lines first, a blank line, `Why:` in one or two sentences, `How tested:`
   in one line, `Work item: #<id>`. Nothing else — every extra line ends up in the squash
   commit body.

6. **Clean the prose.** Run the `unslop` skill on what a person will read: the text of
   each release-note line after its prefix, the `Why:` sentences and the `How tested:`
   line. The shape from step 5 is not prose and stays as it is — the prefixes, the three
   labels, the line order, the blank line. After the rewrite, check every release-note
   line again: still imperative, still ≤ 72 characters, still no trailing period.

7. **Show it and offer a review.** Print the title and the description. Then ask:
   *"Run the `pr-review` skill first? (recommended)"* — on yes, run it and come back to
   this step with the result applied; on no, carry on — declining is a normal answer.
   Then wait for the user's explicit **yes** to create the PR. Silence, "looks fine"
   about the text, or a question is not a yes. This step is never skipped: when the
   Azure DevOps preflight already said `absent`/`expired`, or the run cannot ask
   questions, still print the draft and state the two choices (review now / create later)
   so the user knows what remains.

8. **Create it.** One `--description` argument per line, an empty string for the blank
   line:

   ```sh
   az repos pr create \
     --source-branch "<branch>" --target-branch main \
     --title "<first line>" \
     --description "<line 1>" "<line 2>" "" "Why: …" "How tested: …" "Work item: #<id>" \
     --work-items <id> \
     --squash true --delete-source-branch true \
     -o json
   ```

   Push the branch first if it has no upstream (`git push -u origin <branch>`). From the
   JSON, print `pullRequestId` and the URL
   (`<organization>/<project>/_git/<repository.name>/pullrequest/<pullRequestId>`).

9. **Close the loop with memory.** If a memory entry (the `memory` skill) was written on
   this branch, set its `pr:` field to the new PR id — the merge-time reconcile finds the
   entry by that number.

## Never

- push to `main`, or to any branch other than the one being prepared;
- force-push, rebase, amend, or otherwise rewrite history;
- create the PR without the user's explicit yes;
- invent a work item id — ask.
