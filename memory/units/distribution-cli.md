<!-- memory:unit distribution-cli — the chain of this piece of functionality. Append entries under ## Entries;
     never delete a superseded entry; write supersede links in both directions. -->
# Distribution CLI

`bin/engcat.js` → `cli/index.js`: `install`, `update`, `status`, `check`, `list`. `lib/install.js`
resolves a bundle's closure and plans per-target outputs; `lib/receipt.js` records every install
(`<base>/.engineering-catalog/receipt.json`: catalog version, bundles, units with content
versions, one hash per file); `lib/update.js` diffs a new catalog against the receipt, detects
hand-edited files (never overwritten silently) and stale files. Scope defaults to global; a
fully specified run never touches stdin.

## Entries

This predates tracking; history before 2026-09-15 is not recorded.

### e-20260915-c3d8 Release notes come from the PR description, one line per change
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 3cf85054a6e3f83be168c691ce0589d4d78ef9f7
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-15

PRs are squash-merged, so the PR title becomes the commit subject and the description its body. The release-notes pipeline (pipeline-templates PR 17170) reads the whole message (`%B`) and accepts `feat|feature` and `fix|bug`; `ado-pull-request` writes the short forms, one `feat(<id>)`/`fix(<id>)` line per user-visible change, first line = title. Rejected alternative: synthetic marker commits in the branch — they pollute history and collapse under squash anyway.

### e-20261012-b634 Legacy QA assistant is migrated by moving aside, never deleting, and only by name
- status: active
- evidence: confirmed
- pr: 17310
- sha-at-write: fbb6946fb21286bbc78fc077d7ac75198ea25346
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-12

`engcat install`/`update` now carry users off the pre-catalog `qa-ado-work-item-assistant` (`lib/legacy.js`). That skill was copied by hand and has no receipt, so the receipt-driven update never removed it and Copilot loaded it beside its replacements; its state folder `.qa-ado-assistant` held the only copy of the PAT and contexts. The migration moves every old file aside with a timestamp and deletes nothing; anything already in the new state folders ([[azure-devops-access]]) wins over the old. Retired skills are matched only by an explicit name list (`RETIRED_SKILLS`), never by detection — a folder not on the list is left alone whoever wrote it, and names the catalog still ships are kept off the list because install already asks before overwriting a file it did not write. Cost: moved-aside folders accumulate until a person removes them, and a retired skill not on the list stays visible to the agent.
