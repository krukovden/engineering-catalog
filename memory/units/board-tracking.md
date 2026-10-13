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

### e-20261012-f3c1 Reconcile now records processed PRs and trusts the repo remote over az defaults
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: e5484cf4b9f6685db2c52205b8ac07b297322a98
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-12

`ado-board` no longer treats reconcile as purely stateless. Completed pull requests that
reconcile has already handled are now recorded in the project-local
`.engineering-catalog/ado-board.json` file, bounded to a small recent set, so a later
session does not replay the same PR onto a work item that a person deliberately reopened.
That trade-off chose a little local state over the previous "scan the last completed PRs
every run" design because replaying old PRs was both wrong and able to wedge the whole run
behind one bad item.

The same file now carries the repo's effective Azure context as a consistency check:
on Azure Repos remotes, reconcile derives organization/project from `origin` and refuses to
run when the discovered state file or configured credentials point somewhere else. That made
the hook less ambient — it can now fail fast instead of guessing — but it prevents a repo in
one org from writing tracker state into another org that happens to be configured in `az`.

### e-20261012-6a4e Reconcile correctness now comes from server timestamps, not shared state-file markers
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: d47db43ecaa5a2525070898bd9e24e2f18930c3c
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-12

`ado-board` still keeps discovered state names and a bounded set of processed PR markers in
`.engineering-catalog/ado-board.json`, but replay safety no longer depends on sharing that
file. A fresh clone now checks the work item's server-side `StateChangeDate` against the PR
close time or branch commit time before it replays any evidence, so a human reopen or a
manual move back to todo wins even when the local marker cache is empty.

That changed the purpose of the state file from "shared source of truth for replay safety"
to "local cache that avoids rescanning work this machine already handled". The trade-off is
intentional: the file can stay local and stop dirtying worktrees on no-op hook runs, while
correctness still comes from Azure DevOps history and the repository's own timestamps.

### e-20261012-b92d Reconcile now proves human-vs-ado-board state changes from work item history
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 8448f5a4246f5ae6b2123748d23926b9791c0c30
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-12

Replay guards now distinguish human changes from ado-board's own earlier moves by reading the
work item's update history and looking for ado-board's evidence-comment marker on state
transitions. A plain `StateChangeDate > PR close time` check was not enough: squash-merge
timing meant reconcile's own todo→doing move could look like a later reopen and permanently
block the completed-PR move to done.

The local reconcile file also grew a bounded retryable-PR set beside the processed-PR set.
That keeps older failed PRs queryable even after later PRs succeed and advance the happy-path
watermark. The trade-off is slightly more local state, but it preserves retry safety without
going back to unbounded rescans.
