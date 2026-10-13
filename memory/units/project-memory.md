<!-- memory:unit project-memory — the chain of this piece of functionality. Append entries under ## Entries;
     never delete a superseded entry; write supersede links in both directions. -->
# Project memory

The flagship capability (DESIGN.md §8): skill `memory` (rules + `scripts/memory-lib.js`,
`reconcile.js`, `lint.js`), user-invoked skill `memory-init` (`scripts/memory-init.js`: memory
folder, index skeleton, pointer blocks in `CLAUDE.md` / `.github/copilot-instructions.md` /
`AGENTS.md`, post-commit hook appending the SHA to `.pending`, `.gitignore` line; resumable)
and agent `memory-writer` (drains the queue in isolation). Entries carry two independent axes,
status × evidence; superseded entries are never deleted. All scripts are self-contained Node.

## Entries

This predates tracking; history before 2026-09-15 is not recorded.

### e-20260915-b2d4 One memory store, no mirror, no tracker
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 0a6f8fa6dc124892acee8644e1e206af90daefae
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-15

Mirroring memory into a second store, and using a work tracker or a database as the store, were rejected: two stores need a rule for which one wins and that rule is where drift is born; Markdown under git is the store and anything derived must be rebuildable from it (DESIGN.md §8.1, §14).

### e-20261012-2c2d Catalog-written project state carries a version stamp; an idempotent re-run is the migration
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: e9d73eac4ad101ecb4e0964adcdf074774db079e
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-12

The catalog writes state into consumer projects that it cannot later rewrite in bulk: the memory pointer block in three instruction files, the memory `post-commit` block, and the `ado-board` state map. Each now carries a format version. The markers became `<!-- engineering-catalog:memory:start v=1 -->` and `# engineering-catalog:memory:start v=1`, and the board map gained `"version"`. An unstamped marker or map reads as version 0. No migration code was written: re-running `memory-init` or `ado-board states discover` rewrites the block in place. `memory-init` writes the three pointer files atomically and stops at the first failing step, so the old stamp survives a failed run. `catalog-freshness` reports "project state behind" at most once a day. The approach comes from CRAP's upgrade skill (spec §6.4). The cost: every reader of the markers has to accept both the bare and the `v=N` forms, and 0.x installs carry bare markers indefinitely. `catalog-doctor` missed this and needed a fix (ce1f0ba). The alternative was a separate per-project state file, which would be a second record of what the files already say.
