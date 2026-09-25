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
