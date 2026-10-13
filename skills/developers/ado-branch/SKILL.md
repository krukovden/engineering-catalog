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

When `project-workspace` is installed, run its `register` command for the current repository; do nothing else with it here.

## Start a task

The user names a work item ("start task 103533", "branch for bug 103520").

1. **Preflight.** Run the `ado-credentials` skill first (`-RequireAz` on Windows,
   `--require-az` on macOS/Linux, because this skill runs `az`) and read its outcome. Continue
   only on `ok`. On `absent` or `expired` it has already told the user what to do — stop
   here; do not try the Azure DevOps call anyway. That preflight also owns the Azure CLI
   readiness for this skill: if it reported missing `az`, no `az` login, a missing
   `azure-devops` extension, or missing default organization/project, stop and point the
   user back to its recovery steps instead of re-checking them here.

2. **Read the work item.**

   ```sh
   az boards work-item show --id <id> -o json
   ```

   Take `fields."System.WorkItemType"` and `fields."System.Title"`. Organization and
   project come from the defaults the preflight already proved.

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

## No work item id

The user describes the task ("I need to add CSV export") but names no id. Do not stop and
do not guess one.

- `ado-backlog-placement` installed → offer it: "There is no work item for this. Find the
  best place on the board for it? (yes / no)". On yes, run that skill; when it hands back
  an id, continue at step 1 with it. On no, make no branch and say so.
- Not installed → ask for the work item id.

`ado-backlog-placement` is optional, never a requirement of this skill.

## Never

- rename or delete an existing branch without asking;
- push, force-push, rebase or otherwise rewrite history — this skill only creates or
  checks out a local branch;
- invent a work item id — ask.
