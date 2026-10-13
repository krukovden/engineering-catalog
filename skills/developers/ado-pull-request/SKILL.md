---
name: ado-pull-request
description: Finish a task with a pull request whose title and description feed the release notes, or inspect/update Azure DevOps PR status — feat(<id>)/fix(<id>)/bug(<id>) lines written from the real diff, review offered, squash merge into main. Use when the user says "prepare the PR", "create a pull request", "the code is done", is about to push a finished branch, wants a PR dashboard/status view, or asks to update a drifted PR title/body. Not for reviewing someone else's PR, explaining what squash merge means, or working on non-Azure-DevOps PRs.
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

When `project-workspace` is installed, run its `register` command for the current repository; do nothing else with it here.

## Prepare the PR

The user says the work is done ("prepare the PR", "create a pull request", or is about
to push).

## Other modes

- **One-time repository setup.** When the user asks how `main` should be gated for this
  flow, use `references/branch-policy-template.md`. It is documentation only: the user
  runs the commands; this skill never creates policies or pipeline YAML on its own.
- **Dashboard / status.** When the user wants "my PRs", "what can merge", "what needs my
  vote", or "why can't PR 123 merge", use `references/pr-dashboard.md`.
- **Update an existing PR.** When the scope drifted and the title/body must catch up, use
  `references/pr-update.md`. Rewriting an existing PR still needs explicit user approval
  before `az repos pr update`.

**Preflight.** Run the `ado-credentials` skill first (`-RequireAz` on Windows,
`--require-az` on macOS/Linux, because this skill runs `az`) and read its outcome. On `absent` or
`expired` it has already told the user what to do — still work through steps 1–7 so the
draft is ready, but stop before step 8; do not try the Azure DevOps call anyway. That
preflight also owns the Azure CLI readiness for this skill: if it reported missing `az`,
no `az` login, a missing `azure-devops` extension, or missing default
organization/project, stop and point the user back to its recovery steps instead of
re-checking them here.

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

7. **Show it, offer a review, and get explicit approvals.** Print the title and the
   description. Then ask: *"Run the `pr-review` skill first? (recommended)"* — on yes,
   run it and come back to this step with the result applied; on no, carry on —
   declining is a normal answer. As soon as the review is finished (or declined), and
   before asking anything else, save the commit that was reviewed:

   ```sh
   git rev-parse HEAD
   ```

   Keep that SHA as `REVIEWED_SHA`; step 8 pushes only that commit. A commit added after
   this point — while the user is still answering — has not been reviewed: if the user
   wants it in, go back to the start of this step. Then wait for two explicit answers: create the PR now,
   and if yes, set it to auto-complete with squash + linked work items transitioned on
   merge. Silence, "looks fine" about the text, or a question is not a yes. A yes to
   the draft is not a yes to create; a yes to create is not a yes to auto-complete.
   This step is never skipped: when the Azure DevOps preflight already said
   `absent`/`expired`, or the run cannot ask questions, still print the draft and state
   the two choices (review now / create later) so the user knows what remains.

8. **Create it.** One `--description` argument per line, an empty string for the blank
   line:

   ```sh
   branch="$(git branch --show-current)"
   reviewed="<REVIEWED_SHA>"
   [ "$(git rev-parse HEAD)" = "$reviewed" ] || { echo "HEAD moved since the review; review again"; exit 1; }
   if git rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null; then
     git push origin "$branch" || exit 1
   else
     git push -u origin "$branch" || exit 1
   fi
   [ "$(git ls-remote origin "refs/heads/$branch" | cut -f1)" = "$reviewed" ] || { echo "remote branch does not match the reviewed commit"; exit 1; }

   az repos pr create \
     --source-branch "$branch" --target-branch main \
     --title "<first line>" \
     --description "<line 1>" "<line 2>" "" "Why: …" "How tested: …" "Work item: #<id>" \
     --work-items <id> \
     --squash true --delete-source-branch true \
     -o json
   ```

   Always push the current branch after approval, even when it already has an upstream,
   and never force-push. `<REVIEWED_SHA>` is the SHA saved in step 7; if HEAD is no
   longer that commit, stop before pushing and go back to step 7. After the push,
   verify the remote tip equals the reviewed HEAD on the server itself (`git ls-remote`,
   not the local `origin/<branch>` ref) before creating the PR; if that check fails, stop
   and say the remote branch does not match the reviewed commit. From the JSON, print `pullRequestId` and the URL
   (`<organization>/<project>/_git/<repository.name>/pullrequest/<pullRequestId>`).
   When the user explicitly agreed to auto-complete, follow the create with:

   ```sh
   az repos pr update \
     --id <pullRequestId> \
     --auto-complete true \
     --squash true \
     --transition-work-items true \
     -o json
   ```

   `--auto-complete`, `--squash` and `--transition-work-items` were checked against
   `az repos pr update --help`. If the user declined auto-complete, skip this command.

9. **Close the loop with memory.** If a memory entry (the `memory` skill) was written on
   this branch, set its `pr:` field to the new PR id — the merge-time reconcile finds the
   entry by that number.

## When NOT to use

- The user wants a code review of someone else's PR before merge — `pr-review`.
- The user asks what squash merge means or wants general Azure DevOps help with no PR
  action.
- The pull request lives on GitHub or another host; this skill speaks only Azure DevOps.

## Never

- push to `main`, or to any branch other than the one being prepared;
- force-push, rebase, amend, or otherwise rewrite history;
- create the PR without the user's explicit yes;
- invent a work item id — ask.
