<!-- memory:unit board-tracking — the chain of this piece of functionality. Append entries under ## Entries;
     never delete a superseded entry; write supersede links in both directions. -->
# Board tracking

## Entries

### e-20261012-b4a7 Azure Boards writes are now an explicit catalog responsibility
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 8cf21d1b41794a4724bea0558d8ffdbff0fb5dd1
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-12

The catalog now owns deterministic Azure Boards **state** movement through `ado-board`,
instead of leaving tracker writes outside scope. The trade-off was between keeping the
catalog board-agnostic and putting the one mechanism every developer already uses in the
same place as `ado-branch` and `ado-pull-request`, so a person who never runs the higher
level platform still gets accurate board movement. The scope change is explicit in
`DESIGN.md` §14 rather than implicit in skill prose.

The unit keeps the mutable project state small and rebuildable: `states discover` writes a
project-local `.engineering-catalog/ado-board.json` map with no credential material, while
Azure access still comes through [[azure-devops-access]]. `reconcile` stays inside the
existing freshness hook as one throttled best-effort line so both Claude and Copilot keep a
single `SessionStart` context hook and the board repair path stays out of git hooks.
