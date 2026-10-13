---
name: ado-pr-feedback
description: Address review comments on an Azure DevOps pull request — classify every comment against the current code first, fix what is valid, commit before replying, then set each thread's status (fixed / wontFix / closed) once the user approves. Use when the user says "address the PR comments", "go through the review feedback", "resolve the threads on PR 123", "CI is red on my PR", or pastes a reviewer's comment to act on.
requires:
  - ado-credentials
---

# Skill: ado-pr-feedback

Reviewer comments are claims about code at the time they were written. Check each claim
against the code as it is now, change only what survives the check, and tell the reviewer
what happened — through the thread's real status. The comment-resolution policy blocks
the merge until threads are resolved, so status is not decoration.

Run `ado-credentials` first; continue only on `ok`.

## Iron rules

- Verify before implementing. A comment is a claim, not an order.
- Commit the fix before replying. Never reply "fixed" about uncommitted work.
- No performative language: no "Great catch!", "You're absolutely right!", "Thanks for the
  feedback!". State what was done or why not: "Fixed in `a1b2c3d`: guard added in
  `Export.cs:88`." / "Not changed: the caller validates this in `ExportValidator`."
- Replies and status changes happen only after the user approves the list (step 4).

## Step 1 — classify every comment

Read the threads (see Scripts), then for each comment:

1. **Extract the claim**: the file and line cited, and expected versus actual behaviour.
2. **Search beyond the cited file.** Comments often point at one layer while the fix lives
   in another. Look for validators, middleware, pipeline behaviours, decorators, base
   classes and extension methods that handle the same entity or property. Search for the
   name of the thing across the repository, not only the cited file.
3. **Assume the line numbers moved.** Find the code by content, not by the line cited.
4. **Check history**: `git log --oneline --all --grep="<keyword>" -10`. The comment may
   have been fixed by a later commit.
5. **Read the current code** at the place you found.
6. **Classify**:
   - **OUTDATED** — fixed, or refactored so the pattern no longer exists.
   - **VALID** — the problem is still there as described.
   - **PARTIALLY VALID** — some of it is fixed, some remains.
   - **UNCLEAR** — too little detail to check; say what would be needed.
7. **State confidence**, and say what it rests on:
   - high: "I verified the fix at `file:line`".
   - medium: "I searched these locations and found no fix".
   - low: "I only checked the cited file" — search more before concluding.

Do not trust a subagent's classification without spot-checking it. Do not call a comment
VALID after reading one file when a validator or middleware could exist elsewhere.

## Step 2 — CI first, when it is part of the feedback

If a comment concerns a failing build, or the PR's checks are red, run `ci-failures.js`
before touching code. It names the failing step, its kind (test / lint / typecheck /
build) and a bounded log excerpt. Fix from the excerpt, not from a guess.

## Step 3 — plan

Group by file or theme. For each comment: classification and confidence, the proposed fix
or the reason for pushback, and the thread status it will get:

| Outcome | Thread status |
|---|---|
| Fixed in a commit | `fixed` |
| Valid but deliberately not done, or the reviewer is wrong | `wontFix` |
| Outdated, answered by existing code, or resolved in discussion | `closed` |
| UNCLEAR | leave `active`; ask the reviewer |

Technically wrong or harmful suggestions get pushback with evidence, not compliance.

## Step 4 — approval

Show the user the list: thread id, file, classification, confidence, planned action,
planned status, draft reply. **Wait for approval.** Nothing is replied, resolved or
changed on the PR before it. A thread the user strikes from the list is left alone.

## Step 5 — fix, commit, then reply

Apply the approved fixes, run the project's checks and **commit**, one logical change per
commit. Then **push**: a thread is never answered "fixed" and its status never changed to
`fixed` (or `closed`) until the fix commit is on the server in the PR's source branch.

Before any reply or status change, prove it:

1. `git push` succeeded (a failed or rejected push stops here).
2. `git ls-remote origin refs/heads/<source branch>` answers, and after `git fetch origin
   <source branch>` the fix commit is contained: `git merge-base --is-ancestor <fix commit>
   FETCH_HEAD` exits 0.

If the person declines to push, or the check fails, do **not** reply "fixed" and do **not**
resolve the thread — a resolved thread can unblock the merge while the PR still lacks the fix.
Say so plainly ("the fix is committed here but not on the pull request yet, so I left the
thread open") and leave the thread `active`. Threads that need no code change (`wontFix`,
`closed` by discussion) are not held back by this.

## Scripts

Node ≥ 20, no dependencies. `<SKILL_DIR>` is this skill's directory.

Credential: the scripts read a PAT from `AZURE_DEVOPS_EXT_PAT` (or `ADO_PAT`), and on
macOS/Linux fall back to the `az` login. The organization and project come from
`--org`/`--project`, else the `ado-credentials` state (`%USERPROFILE%\.ado-credentials\config.json`
on Windows, `az devops configure --defaults` elsewhere). The credential is never written
anywhere and never printed.

macOS / Linux (the `az` login is used; nothing to set):

```sh
node "<SKILL_DIR>/scripts/threads.js" list --pr 123
```

Windows — put the PAT in the environment of this one command from the unwrapper that
`ado-credentials` installed; do not echo it, do not open `ado-pat.xml`:

```powershell
try {
  $env:AZURE_DEVOPS_EXT_PAT = & "$env:USERPROFILE\.ado-credentials\get-pat.ps1" "Password"
  node "<SKILL_DIR>/scripts/threads.js" list --pr 123
} finally {
  Remove-Item Env:\AZURE_DEVOPS_EXT_PAT -ErrorAction SilentlyContinue
}
```

| Command | What it does |
|---|---|
| `threads.js list --pr <id> [--all]` | Active threads as compact JSON: id, status, file, line, comments. `--all` adds resolved ones |
| `threads.js set-status --pr <id> --thread <id> --status fixed\|wontFix\|closed --approved` | PATCH the thread status |
| `threads.js reply --pr <id> --thread <id> --text "<reply>" --approved` | Add a reply comment to the thread |
| `ci-failures.js --pr <id> [--human]` | Failing builds → failed timeline steps → `kind` (test / lint / typecheck / build) + bounded log excerpt, as JSON; `--human` adds a short summary on stderr |

`set-status` and `reply` refuse to run without `--approved`; pass it only after step 4.
`ci-failures.js` is read-only. It finds the builds through the PR's policy evaluations
(the same data `az repos pr policy list --id <id>` shows).

Exit 1 with a message on stderr is a failure of the call (credential rejected, unknown PR,
network); report it and stop rather than retrying blindly.

## When NOT to use

- The user wants to *write* a review of someone else's changes → `pr-review`.
- The user wants to open or finish a pull request → `ado-pull-request`.
- The user only asks what a comment means or whether a PR is merged; no change is wanted.
- The comment is on a work item, not a pull request thread.
- There is no Azure DevOps PR (GitHub or another host): the scripts speak only Azure DevOps REST.
