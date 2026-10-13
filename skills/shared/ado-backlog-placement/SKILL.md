---
name: ado-backlog-placement
description: Find where a new task belongs on the Azure Boards backlog — check for an existing item, rank the open Features it could sit under, offer to create a Feature when none fits, then draft the PBI and create it only after an explicit yes. Optional; it asks first. Use when the user says "I need to do X" or "start working on X" with no work item id, "put this on the board", "where does this belong", or "create a PBI for …" without naming a parent.
requires:
  - ado-credentials
---

# Skill: ado-backlog-placement

A task with no work item finds its place on the board: an existing item if there is one,
otherwise a new PBI under the Feature it belongs to. **Every step asks; nothing is
automatic.** Nothing is written to Azure DevOps before an explicit yes to the exact draft.

## When NOT to use

- The user gave a work item id → `ado-branch`.
- A tester reports a defect or files a bug → `qa-ado-work-item`.
- The user only wants to search the board or read an item.

## Commands

Node ≥ 20, no dependencies, the same on macOS, Linux and Windows. `<SKILL_DIR>` is this
skill's directory. Each command prints one JSON object.

Credential, as in `ado-board`: a PAT from `AZURE_DEVOPS_EXT_PAT` (or `ADO_PAT`), else on
macOS/Linux the `az` login. It is never written anywhere and never printed. Windows — put
the PAT in the environment of the one command; do not echo it, do not open `ado-pat.xml`:

```powershell
try {
  $env:AZURE_DEVOPS_EXT_PAT = & "$env:USERPROFILE\.ado-credentials\get-pat.ps1" "Password"
  node "<SKILL_DIR>/scripts/placement.js" candidates --text "<task>"
} finally {
  Remove-Item Env:\AZURE_DEVOPS_EXT_PAT -ErrorAction SilentlyContinue
}
```

| Command | Does |
|---|---|
| `placement.js context` | Local only, no network. The current organization / project / team, and where each came from |
| `placement.js projects [--project P]` | The projects in the organization; with `--project`, its teams |
| `placement.js duplicates --text "<task>"` | Open PBIs, stories, tasks and bugs in the team's area paths that share the task's significant words |
| `placement.js candidates --text "<task>" [--type Feature\|Epic] [--top 3] [--recent-days 30]` | Open Features (or Epics) in the team's area paths, ranked, every score part printed |
| `placement.js create --draft <file.json> [--approved <hash>]` | Without `--approved`: validates and previews, sends nothing. With it: creates the item once, reads it back |

`--org`, `--project`, `--team` override the context on every command. Exit codes: `0` done
or a preview · `1` a call or validation failed, nothing created · `2` a person must choose
(organization or project unknown) · `3` refused (no or stale approval, a receipt already
exists), nothing sent · `5` created, but the read-back differs from the draft: **do not
retry**, report the id and URL.

## Flow

1. **Opt in.** Ask: "There is no work item for this. Find the best place on the board for
   it? (yes / no — continue without one)". On *no*, stop and query nothing. The caller
   carries on without a work item (`ado-branch` makes no branch, and says so).

2. **Preflight.** Run `ado-credentials`; continue only on `ok`.

3. **Confirm where.** Run `context` and ask its `ask` line: "Working in <org> / <project> /
   <team> — right?". It reads, in this order: flags, the repository's Azure Repos remote,
   the `ado-credentials` current context (Windows), `az devops configure` defaults. With no
   team it uses the project's default team; say so. On *no* (or exit `2`), run `projects`,
   let the user pick a project, run `projects --project <P>`, let them pick a team, and pass
   `--org/--project/--team` from then on. Query nothing until the user agrees.

4. **Optional code search first.** If `project-workspace` is installed and seeing whether the
   behaviour already exists in code would help place or draft the work, ask whether to search
   the relevant repositories first. On yes, use it read-only; on no, skip it. If the skill is
   not installed, skip this step.

5. **Duplicates first.** Run `duplicates --text "<task in one sentence>"`. An item is listed
   when it shares at least half of the task's significant words (two at least). Show id,
   type, state and title, and ask: use the existing item, or create a new one. Using one
   ends here: hand its id back.

6. **Rank parents.** Run `candidates --text "<task>"`. Only Features sharing a word with the
   task are listed; bonuses order them, never qualify them. Show the top three with each
   score part — words in the title (2 each), words in the description (1 each), in the
   current iteration (+2), a linked PR or branch in this repository (+2), changed in the
   last 30 days (+1) — plus "none of these". The user picks.

7. **No fitting Feature → offer one.** On `none-fits` or "none of these", offer to create a
   Feature. On yes, pick its parent Epic the same way (`candidates --type Epic`, or none),
   draft the Feature, and publish it through step 8. Its new id becomes the parent.

8. **Draft the item.** Type: `suggestedItemType` from `candidates` (Product Backlog Item,
   else User Story, Requirement, Issue, Task — whatever the process has). Write the draft
   file outside the repository (for example the system temp folder):

   ```json
   {
     "organization": "https://dev.azure.com/acme",
     "project": "Orion",
     "type": "Product Backlog Item",
     "parentId": 4120,
     "fields": {
       "System.Title": "CSV export on the report page",
       "System.Description": "<p>…</p>",
       "Microsoft.VSTS.Common.AcceptanceCriteria": "<ul><li>…</li></ul>",
       "System.AreaPath": "<areaPath from candidates>",
       "System.IterationPath": "<iterationPath from candidates, unless the user says otherwise>"
     }
   }
   ```

   Title at most 100 characters. Run `create --draft <file>` and show the user the
   preview: type, parent, every field, and the checks. Fix any problem and preview again.

9. **Publish once, after an explicit yes.** Only after the user approves *this* preview,
   run `create --draft <file> --approved <draftHash>`. The hash covers the type, every
   field, the parent and the organization/project: change any of them and the old approval
   no longer publishes. A receipt `<file>.receipt.json` is claimed exclusively before the
   request, so a second run never creates a second item (`ALREADY-PUBLISHED`, exit `3`). A
   definitive 4xx releases it; a timeout keeps it — then search with `duplicates` before
   doing anything else. Print the id and URL from the read-back.

10. **Hand back.** Return the id. `ado-branch` continues with the branch, then `ado-board
   move <id> doing` when that skill is installed.

## Never

- query the board before the user said yes in step 1 and confirmed the project in step 3;
- create a Feature or an item without an explicit yes to its exact preview;
- pass an `--approved` hash the user did not approve, or edit the draft after approval;
- delete a receipt to retry without first searching for the item;
- write a credential, or its path, into the draft or anywhere else.

See `references/rest.md` for the endpoints and the shapes still to verify.
