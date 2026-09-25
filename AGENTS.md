<!-- engineering-catalog:memory:start -->
## Project memory
Read `memory/index.md` first. Load `memory/units/<slug>.md` only when work touches that unit.
Write an entry only when the change is hard to reverse, not obvious without context, and the result of a real trade-off — all three.
A request for something listed under "Rejected at project level" is not implemented: quote the rejection and its reason, ask whether to overturn it, and change nothing until the person says yes.
Unit files win over the index. Update only your own index row. Never record credentials, personal data or session narrative.
Before reporting a task done, drain `memory/.pending` (the memory skill says how): read each queued commit, write an entry only if it passes the test, then mark the queue reconciled.
<!-- engineering-catalog:memory:end -->

# AI Engineering Catalog — repository rules

Vendor-neutral catalog of skills, agents, workflows, bundles for Copilot and Claude Code.
This file is the contract. Edit only this file — never `CLAUDE.md` (one-line `@AGENTS.md`
import) or `.github/copilot-instructions.md` (hand-written `@../AGENTS.md` pointer + two
generated blocks). Spec: `DESIGN.md`; section numbers below refer to it. Rationale for every
non-obvious call in this file: `DESIGN.md` §15.

Readers: Copilot CLI, Codex CLI, Cursor read `AGENTS.md` natively. Copilot CLI also reads
`CLAUDE.md` and merges both with no precedence order (`copilot-facts.md` §5).

## The one-line model

    Skill → Agent → Workflow → Bundle

Four hand-written sources — `skills/<owner>/<name>/SKILL.md`, `agents/<owner>/<name>.md`,
`workflows/<owner>/<name>.md`, `bundles/<name>.json` — are the **only** source of truth.
`npm run build` generates and commits everything else:

| Generated | Read by |
|---|---|
| `catalog.json` | the `engcat` CLI |
| `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, `hooks/hooks.json` | Claude Code (marketplace path, update detection, plugin hooks) |
| `plugin.json` (repo root), `.copilot-plugin/agents/*.agent.md`, `.copilot-plugin/hooks.json` | GitHub Copilot CLI (plugin manifest: `skills` = owner folders, `agents` = that one directory, `hooks` = Copilot-format hooks) |
| `.github/plugin/marketplace.json` | GitHub Copilot CLI (`copilot plugin marketplace add`, update detection) |
| `skills\|agents\|workflows/<folder>/README.md` (21 files) | humans |
| `<!-- catalog:start -->`/`<!-- catalog:end -->` block in `README.md` | humans |
| `<!-- engineering-catalog:style:start -->`/`…:end -->` block in `.github/copilot-instructions.md` | GitHub Copilot CLI (source: `.claude/output-styles/terse.md`) |

Never edit a generated file by hand — change a source and rebuild. `npm run check`
(`build --check`) fails when a committed artifact doesn't match its sources, or when
`.copilot-plugin/agents/` still holds a file for an agent that no longer ships.

`package.json` writes each plugin manifest's publisher metadata (`author`, `homepage`,
`repository`, `license`, `keywords`); `claude plugin validate --strict` fails without
`description`/`author`. `test/build.test.js` asserts it. `displayName` is Claude-only — the
two `.claude-plugin/` files carry it, not root `plugin.json`.

## Folders decide who owns it and whether it ships

Two axes, both folders, never a status field. Folder = owner (exactly one — who fixes it
when it breaks). Bundle = who gets it (many, overlapping). Same seven folders under
`skills/`, `agents/`, `workflows/`.

| Folder | Ships? | Meaning |
|---|---|---|
| `shared/` | yes | claimed by bundles of **two or more** audiences — machine-checked |
| `developers/` | yes | owned by developers |
| `qa/` | yes | owned by qa |
| `product/` | yes | owned by product |
| `ops/` | yes | owned by ops |
| `in-progress/` | no | being built; committable, never shipped |
| `deprecated/` | no | retired; kept for the record |

Promoted (owner-folder) units appear in every generated artifact; unpromoted ones appear in
none, and a bundle may not name them. Promote/demote/retire = one `git mv` + `npm run build`:

```bash
git mv skills/in-progress/foo skills/qa/foo    # ships it, and assigns its owner
```

`shared` membership (§3.1) is derived: a unit belongs there iff bundles of two or more
different audiences name it. `checkCatalog` names the move: in `shared` but claimed by one
audience → move to that audience; in `developers` but also claimed by a `qa` bundle → move
to `shared`. Unclaimed units are unconstrained. `productivity` is a theme, not a folder — the
folder axis is audience only.

`bundles/` is flat. Bundle name = audience when it's `developers|qa|product|ops`; otherwise
requires `"audience"`. A bundle is a list of names, never copies.

Folder list: `lib/units.js` (`AUDIENCES`, `SHARED`, `LIFECYCLE_FOLDERS`) — nowhere else.

## Invocation decides who can reach a skill

`invocation: model` (default) or `invocation: user` — one decision for every target; a skill
is user-invoked everywhere or nowhere. `model`: the agent may fire it itself, so
`description` sits in context every turn, written for the model with trigger phrasing ("Use
when the user…"). `user`: only a person naming it can reach it — zero context cost,
`description` becomes a human-facing line.

Claude adapter: `user` → `disable-model-invocation: true` injected into installed `SKILL.md`;
fired with `/name`. Copilot adapter: installs the same skill **without** the flag — Copilot
CLI has no user-invocation dialect; the flag hides a skill from the model *and* from `/name`
(verified copilot 1.0.83), and `/name` only reaches a visible skill. A user-invoked skill's
`description` must say plainly it runs only when asked. Workflows always install as
user-invoked skills.

`platforms:` carries per-target overrides, only value `skip` (`copilot: skip`, `claude:
skip`). Frontmatter is one level deep: scalars, lists of scalars, lists of single-key maps
(workflow `steps`) — no other shape parses.

## Dependencies and preflight skills (§5)

A skill that needs a credential, a CLI or a login does not carry that check itself; it
declares the preflight skill that does:

```yaml
requires:
  - ado-credentials
```

A **preflight skill** answers three questions about one dependency, deterministically:
is it there, is it alive (proven against the real thing), and if not, what does a person
with no prior experience do about it. It reports "absent", "present but expired" and
"present and working" as distinct outcomes, and it records where a credential lives —
never the credential.

Agents name the skills they lean on in `skills:`; workflows name units in `steps:`
(`- skill: x` / `- agent: y`). Every such name must resolve, and a bundle that names a unit
must also name everything that unit requires (transitively: through agents' skills, and
through a workflow's step agents and skills). `engcat install` resolves the same closure,
so an installed bundle is never missing a requirement.

## Invariants (§11) and what enforces each

| # | Invariant | Enforced by |
|---|---|---|
| 1 | A unit's `name` equals its folder or file name | `loadSkillFromDir` / `loadAgentFromFile` / `loadWorkflowFromFile` throw; `build` treats a skipped unit as fatal |
| 2 | Every unit has `name` and `description` | the same loaders throw |
| 3 | A skill directory is self-contained (no reference outside itself) | `checkCatalog` — `../../` in any file, or a markdown link into `../` |
| 4 | Nothing under `skills/`, `agents/`, `workflows/` sits outside a folder | `scanUnits` warns; `build` promotes the warning to an error |
| 5 | Promoted units in every artifact; unpromoted in none | `generate()` filters on `promoted`; `checkCatalog` rejects bundles naming unpromoted units; `build --check` proves the committed artifacts |
| 6 | Every name in `requires:`, `skills:`, `steps:` and in a bundle resolves (and names are unique across kinds) | `checkCatalog` |
| 7 | A bundle naming a unit also names its requirements | `checkCatalog` |
| 8 | The `shared` rule | `checkCatalog` |
| 9 | The release version moves on every user-visible change | **`azure-pipelines.yml`, in two halves.** The PR build computes the version the PR will release (`scripts/next-version.js`: highest `v*` tag on `main` with the same major.minor → patch + 1; a new major.minor in `package.json` → `X.Y.0`), writes it into `package.json`, rebuilds every manifest and commits `release: prepare vX.Y.Z` to the PR's **source** branch — never to `main`. After the merge the `main` build verifies the artifacts and tags the commit `vX.Y.Z`. Humans bump only major.minor (set `package.json` to `1.1.0` in the PR; it releases as `1.1.0`). Claude and Copilot compare the manifest version with the installed copy to decide whether users see an update; `engcat check` and `catalog-freshness` read the `v*` tags. Branch policy must require this build and expire it when `main` changes, so two PRs cannot land the same version |
| 10 | No secret in any file the catalog ships or writes | `checkCatalog` scans every unit file and bundle for key/token patterns |
| 11 | Every `evals/<group>` names a unit that ships, and every hook has a source with both script twins and a contract fixture | `checkEvalGroups` (via `checkCatalog`), `scanHooks` at build time, `test/hooks.test.js` |

`npm run build` exits non-zero on any error and refuses to write an empty catalog. A `⚠`
is a defect in a source; fix the unit or bundle, never the generated file.

## After changing anything under `skills/`, `agents/`, `workflows/`, `bundles/`

```bash
npm run build     # regenerates catalog.json, plugin manifests, folder READMEs, root README block
npm test          # node --test test/*.test.js — offline, deterministic, no model calls
git status        # generated files are committed — review their diff too
```

All three must be clean before committing. `npm run check` is what CI would run: it fails
when a committed artifact is stale.

## Platform logic lives in adapters, not in units

`lib/adapters/{claude,copilot}.js` own everything target-specific. A third target = one new
adapter file, zero changes to any unit.

Adapter interface: `{ id, label, supportsGlobal, skipReason(unit), outputs(unit, scope),
install(unit, baseDir, scope) }`. `outputs()` is pure — returns `[{ path, content: Buffer,
mode }]` relative to the base dir, is what tests assert against. `install()` writes. Keep the
split: an adapter with only `install()` is untestable.

Three behaviours are load-bearing, fail silently when broken (§10):

- **Whole unit travels.** Every file a skill ships installs, not just `SKILL.md`.
- **File modes survive the copy.** Helper scripts arrive executable; `0644` = permission
  denied at runtime.
- **Managed blocks are idempotent.** In files the user also owns (`CLAUDE.md`,
  `.github/copilot-instructions.md`, `AGENTS.md`), only
  `<!-- engineering-catalog:memory:start -->`/`:end -->` is rewritten; rest survives.

Relative links in a body are never rewritten. Nothing in a unit may depend on an absolute
path or on the agent being Claude (§4). One per-platform value allowed: an agent's `model:`
hint — string (all targets) or map (`claude: opus`, `copilot: gemini-3.8-flash`); each
adapter renders only its own key, missing key = no hint on that platform.

Every install writes `<base>/.engineering-catalog/receipt.json` (catalog version, bundles,
per-unit content version, per-file hash). `engcat update` diffs against it, never overwrites
a hand-edited file silently; `engcat status` reads it.

## Memory (§8)

`memory` (model-invoked), `memory-init` (user-invoked), `memory-writer` (agent) — one
capability, ships in every bundle. Helper scripts: self-contained Node
(`skills/shared/memory/scripts/*.js`, `skills/shared/memory-init/scripts/memory-init.js`),
no `require()` outside their own directory.

`memory-init`'s `pointers` step writes the same memory block into `CLAUDE.md`,
`.github/copilot-instructions.md`, `AGENTS.md` on **every** project — generic behaviour for
consumer projects. **Do not special-case this repository's own `@AGENTS.md`-import layout
into that script** — it is a hand-kept exception here, not a bug to fix.

## Hooks

One hand-written source per hook, `hooks/<name>.json`: `{ name, description, event, script,
args, emitsContext, timeoutSec, platforms }`. `script` = path without extension: `.sh` twin
required, `.ps1` twin required when shipped to Copilot. `npm run build` renders both
manifests (`lib/hooks.js`), mapping event names: `SessionStart`→`sessionStart`,
`SessionEnd`→`sessionEnd`, `UserPromptSubmit`→`userPromptSubmitted`,
`PreToolUse`→`preToolUse`, `PostToolUse`→`postToolUse`. No Copilot equivalent →
`"platforms": ["claude"]`.

`emitsContext: true` = stdout is meant to be read. Claude: plain stdout on `SessionStart`
becomes context. Copilot: stdout must be JSON, message in `additionalContext`, plain text is
dropped. One script emits both shapes; only the Copilot render gets the JSON flag.
Side-effect-only hooks omit the field. Arrival is never guaranteed: on Copilot, two hooks
answering the same event with `additionalContext` both run and log, **neither** reaches the
model (`copilot-facts.md` §6.5, rationale: `DESIGN.md` §15.3) — a hook must inform, never
enforce; nothing may depend on a session message being read.

Every hook needs `test/hooks/<event>.<script basename>.json` — scenarios with setup +
expected say/cost/write. `test/hooks.test.js` runs each scenario through every platform's
generated command (unwrapping Copilot's JSON first) — a hook without a fixture fails the
suite. New hook = one source file + one fixture, zero code changes.

That machinery is for shipped hooks. Two **dev-side** pairs run on this repo itself —
hand-written, installed nowhere, outside the generator, cross-checked by
`.claude/skills/coding-agent-parity`:

- **`.claude/hooks/remind-rebuild.js`** + `.github/hooks/` twin — reminder only, never
  enforcement (`PostToolUse`/`postToolUse` see only `write`-kind calls; a shell edit like
  `sed` passes unnoticed — `npm run check` is the real enforcement). Copilot manifest shape
  is exact and fails silently if wrong: requires `"version": 1` + `"hooks"` wrapper;
  `matcher` is the **runtime** tool name (`create|edit|str_replace_editor|apply_patch`, not
  `Edit|Write`); stdout must be JSON (`additionalContext`); file loads only from a
  Copilot-trusted folder (per-machine, unsettable by this repo). Schema: `copilot-facts.md`
  §4; live captures: §6.
- **`.claude/hooks/block-generated.js`** + Copilot twin — the one dev-side hook that **is**
  enforcement: `PreToolUse`/`preToolUse`, same path list both platforms, `exit 2` denies an
  Edit/Write to a wholesale-generated file (`catalog.json`, the four plugin manifests,
  `hooks/hooks.json`, `.copilot-plugin/{agents/*.agent.md,hooks.json}`, the 21 owner-folder
  `README.md`) — never the generated *blocks* inside hand-written files (those rely on
  `npm run check`). Same silent-failure modes as the reminder pair, plus: Copilot's
  `preToolUse` deny shape (`copilot-facts.md` §4.1) is doc-sourced only, not live-captured —
  re-verify before trusting on a materially newer CLI.

Claude Code: the `PreToolUse` entry in `.claude/settings.json` carries an `if` glob mirroring
the script's own path list, evaluated in-process — a non-matching edit never spawns Node. The
script's own list is the real authority (checked against the `if` string by
`coding-agent-parity`). Copilot has no `if` equivalent — its `matcher` is tool-name-only, so
`block-generated.js` spawns on every matching call.

## Evals

`evals/<unit-name>/<case>/` = `claude plugin eval` format (`prompt.md` + `graders/*.md`,
`case.yaml` only for `context.*`); `evals/scenarios/` = cases with no single owning unit.
Every other `evals/` dir name must name a shipping unit — orphan groups are rejected at
build. Plain YAML `case.yaml`, never `---`-delimited (that form parses under this repo's
lint but the native command rejects it outright). `evals/results/` is git-ignored;
`evals/experiments/` verdict records are committed.

`context.scaffold_script` runs on **both** arms, neither for free: native `--scaffold` is off
by default (`--trust-plugin` doesn't imply it) — `claude.js` passes it only when a case has a
script; Copilot has no equivalent flag, so `copilot.js` runs the script itself in the run's
workdir/fake `HOME`. A missing `scaffold_script` target fails `lint`, not silently.

Metadata lives in `tags` (native runner rejects unknown frontmatter keys):
`trigger:positive` / `trigger:negative`, `behaviour`, `regression`, `scenario`,
`unit:<name>`, `hook:<id>`, `isolation:container`.

```bash
npm run eval -- lint                    # every case loads and is gradable
npm run eval -- static                  # always-on description cost per target, no model calls
npm run eval -- affected --base main    # the cases a change can move [--tier 1|2|3] [--all]
npm run eval -- compare --base main     # run those cases against both trees and score the change
                                        # [--targets claude,copilot] [--case <substring>]
                                        # [--container auto|off|required]
```

Only `compare` calls a model: resolves `--base` to a SHA, adds a **detached** worktree (this
repo is itself a worktree), copies candidate `evals/` over it, runs each case through both
trees alternating which goes first. `--targets` defaults to `claude`; `copilot` installs the
catalog into a fake `HOME` once per arm (`scripts/eval/copilot.js`, no CLI, no
`--plugin-dir`), grades via `scripts/eval/graders.js`, judged by headless `claude -p` on both
targets (`judge.js`, one judge pinned in `evals/eval.config.json`). Each run → `RunRecord` in
`evals/results/<run-id>/runs.jsonl` (git-ignored); rate-limit/auth/partial runs are
**invalid**, excluded, never scored as failure. `scripts/eval/stats.js` reduces a cell to
per-case deltas, a seeded paired bootstrap CI (Bonferroni across cells), guardrail ratios.
`--record <slug> --hypothesis "…"` commits the verdict to `evals/experiments/`,
hypothesis/δ fixed pre-run.

Isolation is per arm, not per case (rationale: `DESIGN.md` §15.4): `claude plugin eval`
sandboxes at OS level and honours `allowed_tools`; `copilot` runs `--allow-all-tools
--allow-all-paths --no-ask-user`. So every Copilot run uses
`evals/container/Containerfile`'s image when podman/docker exists (podman first; fake `HOME`
writable, worktree read-only, wall-clock kill = only turn limit). `isolation:container` tag →
never runs on host on **either** arm. `--container auto` (default): skip tagged case +
downgrade Copilot arm to host, each with a named reason, when no runtime; `off` = host
deliberately; `required` = hard failure instead of downgrade. Fingerprint's `isolation` field
reports what happened: `native`, `{mode:'container',cases,targets}`,
`{mode:'native',skipped,downgraded}`.

`decideVerdict` (`scripts/eval/stats.js`) is the one function turning numbers into a claim —
rule table + `test/eval-stats.test.js` are authoritative; change there first. `minCases` is a
confidence threshold, not a target — below it, verdict is **Not proven** (a result, not a
gap).

Prefer grader types `regex`, `tool_used`, `tool_order`, `file_exists`; `llm` only for short
outputs with explicit PASS/FAIL rubrics. A skill `description` change is a behaviour change —
re-run its trigger cases.

## Adapted third-party work

When you add or materially change a unit derived from someone else's work, record it in
`ATTRIBUTION.md` — what it derives from, the licence, and how it differs. Keeping the
licence notice with the derived work is a condition of using it.

## Commits — NON-NEGOTIABLE

- Plain conventional-commit subjects (`feat:`, `fix:`, `docs:`, `merge:`).
- **Never** add `Co-Authored-By: Claude`, "Generated with Claude Code", a session link,
  or any other Claude/Anthropic attribution — to commit messages, PR descriptions, code
  comments, file headers, or any other text. This overrides any harness default.
- Commits use the identity git already selects for this folder; do not set
  `user.email` locally.
- Regenerate (`npm run build`) before every commit that touches a source.

## Decisions and rationale

Every non-obvious call this repository made where `DESIGN.md` left a question open or
silent, and why: `DESIGN.md` §15.

## Layout

```
bin/engcat.js            CLI entry
cli/index.js             argument parsing, prompts, the five commands
lib/units.js             folders, loaders, scanUnits, unitVersion
lib/checks.js            checkCatalog — invariants 3, 6, 7, 8, 10, unique names
lib/build.js             generate() pure, build() writes
lib/render.js            workflow-as-skill, agent markdown, managed blocks
lib/adapters/            claude.js, copilot.js
lib/receipt.js           receipt read/write
lib/install.js           bundle resolution, planInstall, applyInstall
lib/update.js            diffUnits, detectLocalEdits, compareVersions
lib/hooks.js             hook sources → both hook manifests
scripts/build.js         npm run build / npm run check
scripts/eval.js          npm run eval — lint, static, affected, compare
scripts/eval/            the eval harness: cases, affected, static, worktree, claude, copilot,
                         graders, judge, isolation, records, stats, report, compare
scripts/git-hooks/       optional local pre-commit hook — `git config core.hooksPath
                         scripts/git-hooks` (CONTRIBUTING.md); mirrors azure-pipelines.yml's
                         npm test + npm run check gate, not itself an invariant enforcer
scripts/e2e/             npm run e2e:install — real `bin/engcat.js` subprocesses against a
                         scratch $HOME, run inside evals/container's image to simulate a
                         fresh host; skips (exit 0) with no podman/docker; not in npm test
hooks/<name>.json        one hand-written source per hook
hooks/hooks.json         Claude plugin hooks (generated)
.copilot-plugin/         Copilot plugin agents + hooks (generated)
.github/plugin/          Copilot marketplace index (generated)
evals/                   eval cases in the `claude plugin eval` format
evals/eval.config.json   cells, budgets, verdict thresholds
evals/scenarios/         cases that belong to no single unit
evals/experiments/       committed verdict records (`--record`)
evals/container/         optional container isolation level (Containerfile)
test/                    one file per module; test/fixtures/catalog/ is a tiny valid catalog
test/hooks/<id>.json     one contract fixture per hook
memory/                  project memory (index.md + units/) — pointer rules are above
CONTRIBUTING.md          the process for changing the catalog — prerequisites, loop, releases
CLAUDE.md                a one-line `@AGENTS.md` import — Claude Code's required entry point
.claude/                 this repo's own Claude Code config — settings.json, statusline.js,
                         hooks/ (dev-side, not shipped; `.claude/settings.local.json` is personal)
.claude/output-styles/   terse.md — the response style, and the source of the Copilot block
.github/hooks/           this repo's own Copilot CLI hooks (dev-side, not shipped)
.github/copilot-instructions.md   Copilot-specific instructions — a hand-written `@../AGENTS.md`
                         pointer plus two generated blocks (memory, style)
copilot-facts.md         verified Copilot CLI behaviour the harness and hooks depend on
DESIGN.md                the specification
```

No runtime npm dependencies, ever. Node ≥ 20.
