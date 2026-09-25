<!-- memory:index — what this project is, its architecture, one row per unit, project-level rejections.
     Machine-read fields: `reconciled-sha:` and `store:` lines. Keep it small; unit files win on conflict. -->
# engineering-catalog — memory index

reconciled-sha: 1fb451476fa11277fd91394b14c7c5d6b9e5fd4c
store: committed

## What this project is
A vendor-neutral catalog of AI engineering capabilities — skills, agents, workflows and
bundles — installed once and used by GitHub Copilot and Claude Code alike. A developer runs
one command in a project; from then on every assistant behaves the same way there and
shares one project memory. (Derived from the code and DESIGN.md — `inferred`.)

## Architecture
Hand-written sources under `skills/`, `agents/`, `workflows/`, `bundles/` → `lib/units.js`
loads → `lib/checks.js` validates → `lib/build.js` generates the committed manifests and
READMEs. The `engcat` CLI (`cli/`, `lib/install.js`, `lib/receipt.js`, `lib/update.js`)
installs through `lib/adapters/{claude,copilot}.js` and keeps a receipt. Memory tooling
ships as self-contained Node scripts inside the memory skills. No runtime dependencies;
`npm test` is offline. (`inferred`)

## Units
| Unit | Summary |
|---|---|
| [[catalog-sources]] | the hand-written units, owner folders, bundles |
| [[catalog-validation]] | frontmatter, loaders, invariant checks |
| [[artifact-generation]] | build → catalog.json, plugin manifests and their listing metadata, READMEs |
| [[distribution-cli]] | engcat install/update/status, receipts, PR/release-notes flow |
| [[target-adapters]] | Claude and Copilot layouts, pure outputs, per-platform model hints |
| [[project-memory]] | memory, memory-init, memory-writer |
| [[azure-devops-access]] | ado-credentials preflight, qa-ado-work-item |
| [[eval-harness]] | eval cases and scaffolds, tiers, hook sources and contracts and what each host consumes, per-arm isolation, the two-worktree compare |

## Rejected at project level
- A `productivity` owner folder — it is a theme, not an audience (e-20260915-7a1c)
- A Codex adapter in the first release (e-20260915-3f9e)
- Pushing release commits to main from the pipeline (e-20260915-5c2e)
- Marker commits in a branch to feed release notes (e-20260915-c3d8)
- A second memory store, a tracker or a database as the store (e-20260915-b2d4)
- Agent Plugins 1.0 as the manifest format — its fixed `skills/<name>/` discovery would dismantle the owner-folder axis (e-20260917-9b2e)
- `claude plugin validate` in the pipeline — no CLI on the agent, and a guarded step passes silently (e-20260917-9b2e)
- (anything else before 2026-09-15 predates tracking)
