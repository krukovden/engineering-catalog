<!-- memory:unit catalog-sources — the chain of this piece of functionality. Append entries under ## Entries;
     never delete a superseded entry; write supersede links in both directions. -->
# Catalog sources

The hand-written units: `skills/<owner>/<name>/SKILL.md` (a self-contained directory with
`scripts/`, `references/`, `evals/`), `agents/<owner>/<name>.md`, `workflows/<owner>/<name>.md`
and `bundles/<name>.json`. The owner folder (`shared`, `developers`, `qa`, `product`, `ops`) says
who fixes a unit; `in-progress` and `deprecated` never ship. A bundle is an audience's list of
names, never copies. Ten skills, two agents, one workflow and four bundles as of 2026-09-15.

## Entries

This predates tracking; history before 2026-09-15 is not recorded.

### e-20260915-7a1c No `productivity` owner folder
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 0a6f8fa6dc124892acee8644e1e206af90daefae
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-15

A `productivity` folder was rejected as an owner folder: it is a theme, and a theme standing among audiences reintroduces the mixed-axis layout the owner/bundle split exists to remove (DESIGN.md §3.1). Skills that were `productivity` in the predecessor catalog live in `shared` or with the audience that owns them.
