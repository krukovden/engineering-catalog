<!-- memory:unit target-adapters — the chain of this piece of functionality. Append entries under ## Entries;
     never delete a superseded entry; write supersede links in both directions. -->
# Target adapters

`lib/adapters/claude.js` and `lib/adapters/copilot.js` own everything target-specific: layouts
(Claude `.claude/skills|agents`; Copilot `.github/skills|agents` locally, `~/.copilot/skills|agents`
globally), `outputs()` pure / `install()` writes, whole-tree copy with file modes, workflows
rendered as user-invoked skills (`lib/render.js`). `invocation: user` becomes
`disable-model-invocation: true` on Claude only — on Copilot the flag hides the skill from
`/name` as well, so the Copilot adapter omits it.

## Entries

This predates tracking; history before 2026-09-15 is not recorded.

### e-20260915-3f9e No Codex adapter
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 0a6f8fa6dc124892acee8644e1e206af90daefae
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-15

A third target (OpenAI Codex) was rejected for the first release: the catalog targets GitHub Copilot first and Claude Code second (DESIGN.md §1, CLAUDE.md decisions). Adding one later is a single adapter file and no change to any unit.

### e-20260915-a0c1 Copilot installs user-invoked skills without the model-invocation flag
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 3cf85054a6e3f83be168c691ce0589d4d78ef9f7
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-15

On Copilot CLI `disable-model-invocation: true` hides a skill from the model and from `/name` alike (verified on 1.0.83: the model answered "Skill not found" and a person had no way to reach `memory-init`). The Copilot adapter therefore installs user-invoked skills and workflows without the flag; Claude keeps it. Trade-off: on Copilot the model *could* fire such a skill on its own; the description says it runs only when asked, and nothing worse than an unrequested `memory-init` (idempotent) follows.

### e-20260915-b7e2 Independent review on a different model than the author's
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 3cf85054a6e3f83be168c691ce0589d4d78ef9f7
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-15

The `code-reviewer` agent carries a per-platform model hint (`claude: opus`, `copilot: gemini-3.8-flash`) so the local pre-PR review does not share the writer's model, and the pipeline review (`ai-pr-review`, Sonnet) adds a third. Same checklist for both, in `pr-review/references/checklist.md`. Trade-off: a hinted model may be unavailable on a plan — Copilot then warns and falls back to `auto` (observed), so the hint is a preference, never a requirement.
