---
name: catalog-feedback
description: Runs only when asked — draft and, after explicit approval, file Azure DevOps feedback about this catalog with the unit, receipt version and platform attached automatically.
invocation: user
requires:
  - ado-credentials
---

# Catalog Feedback

File feedback about this catalog into the catalog's own Azure DevOps project. The script
defaults to `https://dev.azure.com/Contoso` / `Platform`, but both are configurable.

Run `ado-credentials` first; continue only on `ok`.

## What to collect

Ask for the minimum the script cannot infer:

- the **unit** (`catalog-doctor`, `memory`, `ado-credentials`, `bundle`, `docs`, ...)
- a short **title**
- the feedback **details** — what happened, why it is a problem or improvement, and any
  evidence or suggestion the user already has

The script adds the current platform and the installed receipt version automatically. If
no receipt is present, it records `not installed`.

## Draft first, then ask for approval

1. Write a temporary JSON draft:

   ```json
   {
     "unit": "catalog-doctor",
     "title": "Doctor should point at the exact Copilot config line",
     "details": "The warning is correct, but the fix would be faster if it named the exact trustedFolders entry to add."
   }
   ```

2. Preview it:

   macOS / Linux / Git Bash:

   ```sh
   node "<SKILL_DIR>/scripts/feedback.js" preview --draft "$draft"
   ```

   Windows:

   ```powershell
   try {
     $env:AZURE_DEVOPS_EXT_PAT = & "$env:USERPROFILE\.ado-credentials\get-pat.ps1" "Password"
     node "<SKILL_DIR>/scripts/feedback.js" preview --draft $draft
   } finally {
     Remove-Item Env:\AZURE_DEVOPS_EXT_PAT -ErrorAction SilentlyContinue
   }
   ```

   Optional overrides: `--org <url>`, `--project <name>`, `--type <work item type>`.
   Default type: `Task`.

3. Show the preview to the user: title, unit, platform, receipt version, project, type,
   and the rendered description. **Do not create anything yet.**
4. Ask for an explicit yes.

Only after a yes:

```sh
node "<SKILL_DIR>/scripts/feedback.js" commit --draft "$draft" --approved-hash <draftHash>
```

The commit step rebuilds the same payload and refuses if the hash no longer matches the
approved preview. It claims a receipt (`~/.engineering-catalog/feedback/<draftHash>.json`)
before it sends anything, so the same approved draft is filed at most once: a second commit
returns `ALREADY-PUBLISHED` with the first item's id. If a commit's outcome is unknown (a
timeout, a 5xx), the receipt stays and the next commit refuses; search the board for the title
first, then follow the refusal's instructions.

## How to present success

Report the work item id, type, title and URL. If the script refuses because the draft hash
changed, show that refusal and preview again instead of forcing the create.

## What this skill does not do

- It does **not** post to Slack or any channel outside Azure DevOps.
- It does **not** create an item without an explicit yes.
- It does **not** guess a different project when the default is wrong; pass `--org` /
  `--project` instead.
