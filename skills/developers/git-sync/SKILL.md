---
name: git-sync
requires:
  - ado-credentials
description: "Sync the current branch with base or upstream changes, merge latest main, check if behind, resolve merge conflicts, or tidy squash-merged branches. Use when the user asks to sync with remote, pull or merge upstream/main, check branch freshness or behind count, resolve git conflicts, or clean up merged branches."
---

# Skill: git-sync

Sync the current branch with its upstream base branch, resolve merge conflicts using a structured classification, inspect branch freshness, or tidy squash-merged local branches.

When `project-workspace` is installed, run its `register` command for the current repository; do nothing else with it here.

## Base-branch detection

Before syncing, determine the target base branch for the current branch:

1. **Check for an active pull request.**
   When Azure Repos is used, run the `ado-credentials` preflight first (`-RequireAz` on Windows,
   `--require-az` on macOS/Linux); without `ok`, skip this step and fall through to step 2:
   ```sh
   az repos pr list --source-branch "$(git branch --show-current)" --status active --query "[0].targetRefName" -o tsv
   ```
   If a target ref is returned, strip any `refs/heads/` prefix (e.g., `refs/heads/main` → `main`).

   When GitHub CLI is used:
   ```sh
   gh pr list --head "$(git branch --show-current)" --state open --json baseRefName --jq '.[0].baseRefName'
   ```

2. **Default to main.**
   If no active PR exists or CLI tools are not available or configured, prefer the remote default branch, then the common remote names, and fall back to local names only when the remote says nothing. A local `main` does not prove it is this repository's base: a repository whose default is `develop` can still have one. When the local `origin/HEAD` was never set, ask the server for its default (`git ls-remote --symref origin HEAD`) before trying any common name.
   ```sh
   if git symbolic-ref --quiet --short refs/remotes/origin/HEAD >/dev/null 2>&1; then
     git symbolic-ref --quiet --short refs/remotes/origin/HEAD | sed 's|^origin/||'
   elif remote_head="$(git ls-remote --symref origin HEAD 2>/dev/null | sed -n 's|^ref: refs/heads/\(.*\)[[:space:]]HEAD$|\1|p')" && [ -n "$remote_head" ]; then
     echo "$remote_head"
   elif git show-ref --verify --quiet refs/remotes/origin/main; then
     echo "main"
   elif git show-ref --verify --quiet refs/remotes/origin/master; then
     echo "master"
   elif git show-ref --verify --quiet refs/heads/main; then
     echo "main"
   elif git show-ref --verify --quiet refs/heads/master; then
     echo "master"
   else
     echo "main"
   fi
   ```
   *(On Windows PowerShell, use `(git branch --show-current)` instead of `$(git branch --show-current)`).*

## Syncing: Merge, not rebase, when PRs squash

Fetch the detected base branch from `origin` and **merge** it into the current branch:

```sh
git fetch origin <base>
git merge origin/<base>
```

### Why merge, not rebase?

If your repository uses squash merges on pull requests, rebasing onto `origin/<base>` surfaces commits from previously squash-merged PRs as orphans. Those orphans then reappear as new commits in the PR diff, creating spurious duplication and junk commits on the base branch after the next squash merge. A merge commit preserves the branch's original commit topology, cleanly incorporates upstream changes, and avoids orphan commit regeneration.

## Post-merge verification: Re-run affected tests

When merging the base branch into the current branch mid-cycle, re-run the affected test group before continuing new work or declaring sync complete:

```sh
# Run targeted tests covering the changed domain
npm test
```

A base merge can introduce silent interface breaks, contract drift, or behavioral regressions in the same problem domain even when `git merge` reports clean with zero textual conflicts. A quick targeted test run catches these before subsequent commits compound the scope.

## Conflict resolution

When `git merge` exits with conflicts (exit code non-zero), inspect the conflicting files with `git status --porcelain` and classify each conflict into **AUTO-RESOLVE** or **ASK-USER**.

### Before classifying any conflict

Understand **WHY** upstream changed before choosing a resolution. Do not blindly pick "ours" or "theirs":
1. Check recent upstream commits affecting the conflicting file:
   ```sh
   git log --oneline origin/<base> -- <conflicting-file>
   ```
2. Read the upstream commit messages to understand the intent of the change.
3. Read both sides of the conflict markers in the file to see what each side contributes.
4. Often the correct resolution requires combining upstream structural intent with branch additions rather than picking one side.

### AUTO-RESOLVE (apply, stage, log)

| Pattern | Resolution |
|---|---|
| **Lockfiles** (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `packages.lock.json`) | Accept either side (`git checkout --ours -- <file>` or `--theirs`), then regenerate with the package manager (`npm install`, `pnpm install`, `yarn install`). Never hand-edit conflict markers in lockfiles. |
| **Same-major version bumps in package manifests** (`package.json`, `Directory.Packages.props`, `*.csproj`) where both sides bump the same dependency | Take the higher version. **Only for same-major versions**: e.g., `8.0.1` vs `8.0.2` → take `8.0.2`. A major version difference (e.g. `18.3.0` vs `19.0.0`) is a breaking-change boundary → **ASK-USER**. |
| **Non-overlapping edits** (conflict markers caused by nearby lines, but edits touch completely separate sections or logic) | Keep both changes. First verify upstream structural intent: if upstream reformatted or restructured the section, adopt their structure and integrate your additions into it. Never blindly take ours/theirs without reading both sides. |
| **Auto-generated files** (`.designer.cs`, `.g.cs`, swagger/OpenAPI generated schemas, compiled assets) | Take incoming version (`git checkout --theirs -- <file>`), then regenerate immediately from the merged source inputs. Stage the generated file only after regeneration succeeds. If regeneration is not possible, classify the conflict as **ASK-USER**. |
| **Both sides appended to end of file** | Keep both additions in sequence: current branch additions first, then incoming additions. |

Stage each resolved file immediately:
```sh
git add <file>
```

### ASK-USER (present options with recommendation)

Everything else requires user confirmation:

| Pattern | What to present |
|---|---|
| **Both sides modified the same function or method body** | Show both versions side-by-side. Recommend keeping incoming if the current branch has not been submitted for review yet, or combining if both edits are functional. |
| **Constructor + new method in same class** | Explain constructor dependency wiring may need to connect to the new method; recommend keeping both but flagging for review. |
| **Config file with overlapping keys** | Show both values; recommend incoming unless the branch value was intentionally customized. |
| **Renamed file + modified file** | Explain the rename; recommend applying the modifications to the renamed file. |
| **Deletion on one side, modification on the other** | Ask whether the item should exist; recommend modification unless deletion was intentional dead-code cleanup. |
| **Major version bump disagreement** (e.g. `18.3.0` vs `19.0.0`) | Show both versions; explain that major bumps represent breaking changes. Recommend the safer minor bump as default unless the major upgrade is required. |

#### Asking the user

Present the conflict with:
- The conflicting filename.
- A 1-sentence description of what each side changed.
- 2–3 concrete resolution choices, with your recommended choice listed first and marked `(Recommended)`.

### Rollback

If the user chooses to abort conflict resolution:
```sh
git merge --abort
```
Confirm the working tree is clean with `git status`.

## Mode: tidy

Clean up local branches whose pull requests have already been squash-merged.

### Why `[gone]` is not enough

`git branch -v` looking for `[gone]` only catches branches whose configured upstream tracking branch was pruned on the remote. Local branches pushed without `-u` or branches that never tracked an upstream will **never** show `[gone]` even after their PR has been squash-merged into `main`.

### Triage classification

Before deleting anything, triage all local branches into three buckets:

- **SAFE** — only with proof that the branch's work is already in the base:
  - Merged into base: `git merge-base --is-ancestor <branch> origin/<base>` returns 0.
  - Its pull request was **merged** (completed) into this exact base, and the PR's last source commit is the branch tip:
    ```sh
    az repos pr list --source-branch <branch> --target-branch <base> --status completed \
      --query "[?targetRefName=='refs/heads/<base>'].lastMergeSourceCommit.commitId" -o tsv
    # or with GitHub CLI:
    gh pr list --head <branch> --base <base> --state merged --json headRefOid,baseRefName \
      --jq '.[] | select(.baseRefName == "<base>") | .headRefOid'
    ```
    Only a PR whose `targetRefName` is exactly `refs/heads/<base>` counts: a PR completed into another branch (say `develop` while tidying against `main`) proves nothing about `<base>`. Compare each returned SHA with `git rev-parse <branch>`. A tip that is not among them has commits the merged PR never saw: classify it **ASK**.
- **KEEP**:
  - Current checkout (`git branch --show-current`).
  - Base / protected branches (`main`, `master`, `release/*`).
  - Active open pull request (`--status active` / `--state open`).
  - Branch has uncommitted or dirty changes in an active worktree (`git status --porcelain`).
- **ASK**:
  - Marked `[gone]` without one of the SAFE proofs. `[gone]` only says the upstream was deleted, not that its work was merged.
  - PR abandoned, or closed without merging (`--status abandoned`, `--state closed`): rejected work can be the only copy.
  - Unmerged branches with no PR or no PR data.
  - Detached HEADs or local branches with unpushed commits.

### Execution rule: Never delete without explicit approval

Present the list of candidate branches by bucket to the user. **NEVER** delete any branch without the user's explicit yes.

Once approved:
```sh
# For branches merged via regular merge:
git branch -d <branch>

# For branches whose PR was squash-merged (git sees commit SHA difference):
git branch -D <branch>
```

## Mode: behind

Check how far behind the base branch the current branch is, using `git ls-remote` **without fetching or downloading objects**.

1. Resolve the remote base ref:
   ```sh
   git ls-remote --symref origin HEAD
   # or for a specific base branch:
   git ls-remote origin refs/heads/<base>
   ```
2. Read the remote tip commit SHA:
   ```sh
   remote_sha=$(git ls-remote origin refs/heads/<base> | awk '{print $1}')
   ```
3. If the fetched remote-tracking ref is current, compare HEAD to that exact base tip:
   ```sh
   fetched_sha=$(git rev-parse refs/remotes/origin/<base> 2>/dev/null || true)
   ```
4. Compare SHAs:
   - If `fetched_sha` is empty or differs from `remote_sha`, report:
     `origin/<base> is stale locally; exact behind count requires git fetch origin <base>`.
   - If the SHAs match, count both sides against that fetched tip in one read:
     ```sh
     git rev-list --left-right --count HEAD...origin/<base>
     ```
     It prints `<ahead> <behind>`. A feature branch with its own commits is normally both ahead and behind once the base moves, so report both numbers:
     - `0 0` — up to date.
     - `N 0` — ahead only; nothing to merge in.
     - `0 M` — behind by `M`, fast-forwardable (`git merge-base --is-ancestor HEAD origin/<base>` succeeds).
     - `N M` — diverged: ahead by `N`, behind by `M`. Say both; never collapse it to "behind" alone.

This mode is strictly read-only: it never mutates the working tree, checkout, or local refs.

## When NOT to use

- When the user explicitly requests a git rebase workflow or the repository enforces linear history without merge commits.
- When there are uncommitted changes in the working tree (commit or stash them before syncing).
- When currently checked out on `main` or `master` (use standard `git pull` or fast-forward instead).
- When resolving conflicts in repositories that mandate external specialized graphical merge tools.
