<!-- memory:unit artifact-generation — the chain of this piece of functionality. Append entries under ## Entries;
     never delete a superseded entry; write supersede links in both directions. -->
# Artifact generation

`lib/build.js` (`generate()` pure, `build()` writes) turns validated sources into the committed
artifacts consumers read: `catalog.json` for the CLI, `.claude-plugin/{marketplace,plugin}.json`
for Claude Code, root `plugin.json` + `.copilot-plugin/{agents/*.agent.md,hooks.json}` +
`.github/plugin/marketplace.json` for Copilot CLI, the 21 folder READMEs and the table block
in the root README. `npm run check` fails when a committed artifact is stale. The release
version is `package.json`'s and is written into every manifest.

## Entries

This predates tracking; history before 2026-09-15 is not recorded.

### e-20260915-6e5f Release version is produced by the pipeline on merge to main
- status: superseded
- evidence: confirmed
- pr: none
- sha-at-write: f5e681da10766c6c21a5853f83ea60bbf222df77
- merged-sha: none
- supersedes: none
- superseded-by: e-20260915-5c2e
- date: 2026-09-15

Invariant 9 ("the version moves on every user-visible change") was a review rule with nothing enforcing it. Now `azure-pipelines.yml` runs on every merge to `main`: major.minor comes from `package.json`, the patch counter from the shared `pipeline-templates/steps/generate-version.yml` (counter tags `v-main-<major.minor>.N`), and the pipeline writes the version into `package.json`, rebuilds the manifests, commits with `[skip ci]` and tags `v<version>`. Trade-off: the version is no longer chosen by a person and cannot be pinned in a PR — humans control only major.minor; the price of never shipping a manifest whose version did not move.

### e-20260915-5c2e Version is prepared in the PR, main is never pushed to
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: dead923f55c5e1bc695f041f9a01bd3f08f352b9
- merged-sha: none
- supersedes: e-20260915-6e5f
- superseded-by: none
- date: 2026-09-15

The merge-time release (e-20260915-6e5f) needed the build service to push to `main`, which a
"PRs only" branch policy forbids and bypassing it would hollow the policy out. Now the PR
build computes the version from the highest `v*` tag on `main` (`scripts/next-version.js`:
patch + 1, or `X.Y.0` when `package.json` carries a new major.minor), rebuilds, and commits
`release: prepare vX.Y.Z` to the PR's source branch; the `main` build only tags the merge
commit. The shared `generate-version.yml` template was dropped: it is built for direct
pushes to a release branch and yields `X.Y.N.M-merge` inside a PR build. Cost: two PRs
prepared in parallel compute the same number, so the branch policy must expire PR builds
when `main` changes, and the `main` build fails on an already-existing tag rather than
tagging twice.

### e-20260917-9b2e The manifests are a listing, and the standard that would unify them was declined
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 0e5985e89cbd46bb0c08ea04bcca72e7eac9bf1d
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-17

The four plugin manifests carried a name, a description and a version and nothing else, which
was enough to install and not enough to publish: `claude plugin validate --strict .` failed on
the marketplace's missing `description` and the plugin's missing `author`, and that is the check
Anthropic's submission pipeline runs. `package.json` is now the single source for `author`,
`homepage`, `repository`, `license` and `keywords`, and `generate()` spreads one `listing` object
into all four; `displayName` goes only into the two `.claude-plugin/` files, because Copilot's
manifest schema does not list the field and sending an untested key into the manifest that
actually loaded live is a gamble with nothing to win.

Two things were rejected on the way. **`claude plugin validate --strict` in the PR build**: the
agent has no Claude CLI, and a step guarded by `command -v claude` passes silently on every agent
that lacks it — the failure mode this repository spends the most effort avoiding. What the build
can prove offline, that every manifest carries the metadata `--strict` demands, is asserted in
`test/build.test.js`; the CLI check is a documented human step in CONTRIBUTING. The cost is real:
a schema rule Anthropic adds later lands on whoever next runs it by hand, not on CI.

**Agent Plugins 1.0** (`agent-plugins.org`, backed by GitHub/Vercel/AWS/OpenAI) would replace both
manifests with one, and Copilot CLI 1.0.85 already supports it. It was declined because its
discovery paths are fixed: `skills/<name>/SKILL.md` exactly one level deep, agents and hooks under
`com.github.copilot/`. This catalog's skills live at `skills/<owner>/<name>/`, and that second
level *is* the ownership axis — the thing §3.1 enforces and every README, bundle check and
promotion `git mv` is built on. Adopting the standard means dismantling it, and Claude Code's
reference does not mention the standard at all, so the trade would buy portability to one CLI that
already loads us. Revisit when Claude Code ships support; `copilot-facts.md` §7 holds the captures.

### e-20261012-afdc Promoted workflows ship in both plugin manifests as generated skill folders, one per platform
- status: active
- evidence: inferred
- pr: none
- sha-at-write: 127faee2193a55ec07fee4a107406a658a35392d
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-12

Until 127faee a workflow reached a person only through `engcat install`; the plugin manifests listed owner skill folders, so anyone who installed the catalog as a Claude or Copilot plugin got no workflows. `generate()` now renders each promoted workflow as a skill and commits it twice: `.claude-workflows/<name>/SKILL.md` (with `disable-model-invocation: true`) and `.copilot-plugin/workflows/<name>/SKILL.md` (without it), each parent folder appended to its manifest's `skills` list only when a workflow ships. Two folders because the two renderings must differ ([[target-adapters]] e-20260915-a0c1: on Copilot the flag also hides the skill from `/name`), and a single shared folder would either make the workflow model-invocable on Claude or unreachable on Copilot. Claude's folder sits at the plugin root because Claude's plugin docs keep components out of `.claude-plugin/`. Each rendering is asserted byte-equal to what its adapter installs, so the plugin path and the `engcat` path cannot drift. The cost: two more generated trees per workflow, a stale-folder sweep in `build()` like the one for Copilot agent files, and the dev-side `block-generated` path list grew to cover them. The folder names are now part of what installed plugins read, so renaming them is a manifest change for every user.
