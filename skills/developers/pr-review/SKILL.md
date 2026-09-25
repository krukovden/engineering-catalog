---
name: pr-review
description: Review a branch or pull request before it is opened or merged — collect the diff, launch the code-reviewer agent on a different model, and turn its findings into a short list to fix or accept. Use when the user says "review my branch", "review this PR", "check this before I open a PR", or is about to create a pull request.
---

# PR Review

An independent review of a branch before it becomes a pull request. The reviewer
is the `code-reviewer` agent, run on a different model than the one that wrote
the code, so the review is a second opinion and not the author grading itself.
The rubric is `references/checklist.md`; this skill collects the input, launches
the reviewer, and decides what to do with the report.

## When it runs

- **Before a pull request.** Run it on the branch as it stands, fix what it
  finds, then open the PR. A review after the PR exists is still useful, but the
  fixes cost more.
- **On request.** "Review my branch", "review PR 1234", "check this before I
  open a PR".
- **From `ado-pull-request`.** That skill offers this review before it creates
  the pull request; accepting the offer runs the steps below.

## Collect

Gather what the reviewer will need, from the repository root:

```sh
git fetch origin main
git log --oneline main..HEAD          # the commits and their claims
git diff --stat main...HEAD           # what changed, how much
sh scripts/file-sizes.sh              # changed files by size, ! past 300 lines, !! past 500
```

For a PR rather than a branch, check out its source branch first, and collect
its description too — the reviewer verifies every claim in it.

If the branch is not against `main`, pass the real base to every command above
and to `scripts/file-sizes.sh <base> HEAD`.

## Launch the reviewer

Hand the collected summary to the `code-reviewer` agent and let it read the
diff and the surrounding code itself — do not paste the diff into the prompt.

- **Copilot CLI:** `copilot --agent code-reviewer -p "Review main...HEAD in $(pwd)"`,
  with the commit list and size table appended to the prompt.
- **Claude Code:** use the `code-reviewer` agent on `main...HEAD`, with the same
  summary.

Name the base and the range explicitly whenever they are not `main...HEAD`.

## Read the report

The report arrives in the format below. Act on it by severity:

- **Critical and Important** — fix before the PR. Show the user each change you
  make and the finding it answers. If you disagree with a finding, say why, with
  evidence from the code; do not just skip it.
- **Minor** — list them for the user; the user decides which to take.
- **Unverified** — tell the user what the reviewer could not confirm, so they can
  check it or accept the risk.

Never silently drop a finding. Every item in the report ends up either fixed,
declined with a reason, or handed to the user.

## Report format

Defined in `references/checklist.md`; in brief:

```markdown
### Verdict        Approve | Fix first
### Strengths      specific, before any finding
### Findings       grouped Critical / Important / Minor, each `file:line — what — why — how to fix`
### Unverified     claims the reviewer could not confirm from the code
```
