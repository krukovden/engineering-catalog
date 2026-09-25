---
name: ado-branch
description: Start a task on a correctly named branch — read the Azure DevOps work item and create feature/ADO-<id>-<title>, or bug/ADO-<id>-<title> for a Bug, from main. Use when the user says "start task 12345", "create a branch for bug …", "branch for work item …", or begins work on a work item without a branch.
requires:
  - ado-credentials
---

# Skill: ado-branch

A branch is named after its Azure DevOps work item: `feature/ADO-<id>-<kebab-title>`, or
`bug/ADO-<id>-<kebab-title>` when the work item is a Bug. The name is computed by
`scripts/branch-name.js`, never written by hand, so every branch in the team carries its
work item id in the same place.

## Start a task

The user names a work item ("start task 103533", "branch for bug 103520").

1. **Preflight.** Run the `ado-credentials` skill first and read its outcome. Continue
   only on `ok`. On `absent` or `expired` it has already told the user what to do — stop
   here; do not try the Azure DevOps call anyway.

2. **Read the work item.**

   ```sh
   az boards work-item show --id <id> -o json
   ```

   Take `fields."System.WorkItemType"` and `fields."System.Title"`. Organization and
   project come from `az devops configure --defaults`; the preflight guaranteed them.

3. **Compute the branch name.** Never hand-write it.

   ```sh
   node "<SKILL_DIR>/scripts/branch-name.js" --type "<work item type>" --id <id> --title "<title>"
   ```

   `Bug` → `bug/ADO-<id>-<kebab-title>`; every other type (Product Backlog Item, Task,
   Feature, User Story…) → `feature/ADO-<id>-<kebab-title>`. The slug is lowercase ASCII,
   at most 50 characters, cut at a word boundary.

4. **Create or reuse the branch.**

   ```sh
   git fetch origin main
   git branch --list "*ADO-<id>-*" ; git branch -r --list "*ADO-<id>-*"
   ```

   - Current branch is already the computed name → say so; nothing to create.
   - A branch for this id exists under another name (local or remote) → say which, and
     ask whether to check it out or create the new one. **Never rename or delete a
     branch silently.**
   - Otherwise:

     ```sh
     git checkout -b <name> origin/main
     ```

5. **Report in one line:** the branch and the work item title, for example
   `On bug/ADO-103533-export-empty-file-when-10-mb — "Export: empty file when >10 MB"`.

## Never

- rename or delete an existing branch without asking;
- push, force-push, rebase or otherwise rewrite history — this skill only creates or
  checks out a local branch;
- invent a work item id — ask.
