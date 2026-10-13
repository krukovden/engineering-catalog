# Update a drifted PR title/body

Use this mode when the work outgrew the current PR title/body and the metadata must catch
up before review or merge.

## 1. Find the active PR and read it first

If the user gave a PR id, use it. Otherwise, look up the active PR for the current
branch:

```sh
az repos pr list --source-branch "$(git branch --show-current)" --status active -o json
```

Refuse to guess when that returns zero PRs or more than one.

Once you have the id, read the PR before drafting anything:

```sh
az repos pr show --id <id> -o json
```

Take `sourceRefName`, `targetRefName`, `title`, and `description`. The current PR is the
truth for which branch pair is under review and which user-written details already exist.

## 2. Read what really shipped on that PR

```sh
git fetch origin <source-branch> <target-branch>
git diff --stat origin/<target-branch>...origin/<source-branch>
git diff origin/<target-branch>...origin/<source-branch> -- <paths the stat does not explain>
```

Use the PR's real source and target refs everywhere above, even when another branch is
checked out locally. If the PR targets something other than `main`, the diff must still
follow `target...source`, not `origin/main...HEAD`.

## 3. Decide whether the metadata drifted

Update when the title/body no longer describe the primary change, the summary is missing
deliverables visible in the diff, or the scope materially expanded or shifted. Do not
update for trivial follow-up commits that still fit the current description.

## 4. Draft the replacement

Use the same release-note shape as prepare mode:

- first line = PR title;
- blank line;
- `Why: ...`;
- `How tested: ...`;
- `Work item: #<id>`.

Preserve user-written details from the current title/body that are still true. Reuse the
current PR title and description as source material, then rewrite only the parts the diff
made false or incomplete.

## 5. Show the rewrite and wait for explicit approval

A "looks fine" about the draft is not approval to push the change into Azure DevOps.

## 6. Apply it

```sh
az repos pr update \
  --id <pull-request-id> \
  --title "<first line>" \
  --description "<line 1>" "<line 2>" "" "Why: ..." "How tested: ..." "Work item: #<id>" \
  -o json
```

If the user also wants the merge options refreshed, this same command accepts
`--auto-complete`, `--squash` and `--transition-work-items`; use only what the user
explicitly approved.
