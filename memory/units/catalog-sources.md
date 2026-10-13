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

### e-20261012-a4f1 PR review loads local `.ado/ai-review/rules.md` by glob and falls back to the catalog rubric
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 7490deadb3ef795bd2b1a7dee7f056321c7cfe3d
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-12

The local pre-PR review now treats the product repository's checked-in `.ado/ai-review/rules.md` as the source of per-area rules: each `## <glob>` section is matched only against changed files, and the review falls back to `skills/developers/pr-review/references/checklist.md` when no project rules file exists. The rubric content is aligned with the organisation's pipeline AI review (in the shared `pipeline_templates`, `templates/steps/ai-review/`), so the local and the pipeline review do not drift apart: its severity table, trigger evidence bar and whole-file verify pass were adopted, but the catalog kept its better local behaviour — claim checking against commit/PR text and an **Unverified** bucket for low-confidence concerns instead of silently dropping them. The direction is templates → catalog: a pipeline agent has no installed catalog, so the pipeline never reads the catalog's rubric. The rejected alternative was for the reviewer to fetch the templates repository at review time: that would make the agent guess which remote source governs this product and could drift from the rules actually committed beside the code. The cost is that rubric changes now span the source files and [[eval-harness]] graders together, and a prompt-shape edit touches both.
