---
name: onboard-project
description: "Guided project onboarding — preflight Azure DevOps credentials, initialise project memory, discover board states, inspect branch policies, and verify with catalog-doctor."
---

# onboard-project

## Steps

1. skill: ado-credentials
2. skill: memory-init
3. skill: project-workspace
4. skill: ado-board
5. skill: catalog-doctor

# Onboard Project

A guided onboarding workflow that sets up a repository to work with the engineering
catalog and Azure DevOps. It owns no schema and creates no policies directly — it
is a thin UX layer over existing catalog skills and inspection commands.

## Step 1 — `ado-credentials`

Preflight the Azure DevOps credential before anything else runs. Continue only on
`ok`. On `absent` or `expired`, follow `ado-credentials`: on Windows it hands the PAT
over through Notepad or adds the project from a board link, in this conversation;
elsewhere it shows its `steps`. Do not work around a missing credential, and never
read the PAT yourself.

## Step 2 — `memory-init`

Initialise project memory in this repository. Follow the interactive flow from
`memory-init`:
1. Ask the user whether project memory should live in `committed` (recommended)
   or `local` store.
2. Run the initialization script to scaffold memory files, write pointer blocks into
   `CLAUDE.md`, `AGENTS.md`, and `.github/copilot-instructions.md`, and configure the
   `post-commit` hook.
3. Fill initial index sections from the code you can see (`## What this project is`,
   `## Architecture`, and initial functional units).
4. Verify pointer blocks are intact and commit changes for a committed store.

## Step 3 — `project-workspace`

Set up the shared project-copy workspace before board work:
1. Run `project-workspace`.
2. Ask the shared-folder question it hands back, with the default folder offered first.
3. If the person is a developer, ask the working-folder question only after the shared-folder
   answer is settled.
4. Continue once the shared folder is configured.

## Step 4 — `ado-board`

Discover and map work item states for this project:
1. Run `states discover` via `ado-board` to query the Azure DevOps work item type
   definitions.
2. If any state category holds multiple candidate states (an ambiguous choice), present
   the options and ask the user to choose the mapping.
3. Verify that the discovered state map is saved to the project configuration.

## Step 5 — Branch-policy inspection

Check branch policies on `main` against the catalog's recommended baseline.

Query the live repository policies using the Azure CLI (`az repos policy list` or
specific policy list commands):
1. **Linked work items required**: verify a blocking policy requiring linked work
   items exists.
2. **Build validation**: verify a PR-validation pipeline is configured for PRs into
   `main`.
3. **All comments resolved**: verify unresolved comments block merge.
4. **Squash only**: verify the merge strategy enforces squash merging.
5. **Votes reset on push + minimum reviewers**: verify minimum reviewer count and that
   votes reset on source push.

Report which recommended policies are in place and which are missing. If the user asks
for the one-time setup commands, provide them inline from this checklist instead of
handing off to another skill's private reference. **Never create or modify policies
automatically** — policy creation is a one-time administrative action that the user
must perform or approve via Azure DevOps settings or CLI commands.

## Step 6 — `catalog-doctor`

Run `catalog-doctor` to perform a comprehensive health check:
1. Execute the doctor script to verify prerequisites (`node` on PATH), detect any
   Copilot plugin versus `engcat` namespace collisions, check folder trust status in
   Copilot configuration, ensure no conflicting hook definitions exist, and confirm
   memory pointer health.
2. Present diagnostic findings categorized as `fail`, `warn`, or `ok`.
3. If any warnings or failures are reported, highlight the recommended one-line fix
   for each.
