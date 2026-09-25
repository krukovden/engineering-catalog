<!-- memory:unit eval-harness — the chain of this piece of functionality. Append entries under ## Entries;
     never delete a superseded entry; write supersede links in both directions. -->
# Eval harness

`evals/` holds behaviour cases in the documented `claude plugin eval` format; `scripts/eval.js`
(`lint`, `static`, `affected`, `compare`) and `scripts/eval/` load them, price the always-on
descriptions, work out which cases a change can move (reusing `unitNeeds` from `lib/checks.js`
inverted), and run a case through two checkouts of the catalog to score the change.
`lib/hooks.js` turns one source per hook into both hook manifests, and `test/hooks.test.js`
runs each hook's contract fixture through every platform's generated command.

## Entries

### e-20260916-7d41 Eval cases live in the repository root, in Claude's native case format
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 28e8d86197792e841a22f8075cfe16aa44f522e1
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-16

The three skill-creator suites under `skills/<owner>/<name>/evals/` moved to `evals/<unit>/` and
were rewritten as `prompt.md` + `graders/*.md`. Four reasons, in order of weight: `claude plugin
eval` reads one eval directory per run, so per-skill directories cannot be a suite; agents and
workflows are single files with nowhere to put a case; scenarios that exercise several units
belong to no single unit; and the adapters copy every file of a skill, so the old suites were
being installed onto users' machines. The cost is that a unit and its cases are no longer moved
by one `git mv` — `checkEvalGroups` catches the orphan instead. The native format was chosen over
a bespoke one so Claude runs the suite with its own command, graders included, and only Copilot
needs a runner of ours.

### e-20260916-b8c2 Both hook manifests are generated from one source per hook
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 28e8d86197792e841a22f8075cfe16aa44f522e1
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-16

`hooks/<name>.json` is now the only hand-written hook file; `hooks/hooks.json` (Claude) and
`.copilot-plugin/hooks.json` (Copilot) are both generated, and the Claude→Copilot event map lives
in `lib/hooks.js`. Before this, the Copilot manifest was a literal inside `lib/build.js` that named
the freshness script directly, so a second hook meant editing code and could silently exist on one
platform only. Trade-off: `hooks/hooks.json` stopped being hand-written, which changes the contract
in CLAUDE.md, and a Claude-only event (Stop, PreCompact, …) must now declare `platforms: ["claude"]`.

### e-20260916-3e57 Evals run on cheap models, and Copilot's list is set by organization policy
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 28e8d86197792e841a22f8075cfe16aa44f522e1
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-16

Trigger cases run on `claude-haiku-4-5` (effort low) and `gpt-5-mini`, behaviour cases on
`claude-sonnet-5` (effort medium) and `gpt-5.4`, with `claude-opus-5` (effort high) judging both
CLIs. Measured cost of one trigger run: $0.26 sonnet/medium, $0.13 haiku/low, 20 credits gpt-5.4,
8 credits gpt-5-mini — a tier-1 comparison is dozens of runs, so the floor models are what keep a
comparison inside its budget, and a weaker model also leaves room for the catalog's effect to show.
On Copilot the choice is not free: this account is Copilot **Business**, and the organization's
model policy refuses `claude-sonnet-5`, `grok-4.5`, Gemini and every `gpt-5.5`/`gpt-5.6` model.
Only `gpt-5-mini`, `gpt-5.4-mini`, `gpt-5.4` and `gpt-5.3-codex` answer. A configured model that
policy refuses is silently swapped for the default in a session and only errors behind `--model`.

### e-20260916-9c05 The comparison is ours; the rule that names a winner is deliberately unwritten
- status: superseded
- evidence: confirmed
- pr: none
- sha-at-write: 28e8d86197792e841a22f8075cfe16aa44f522e1
- merged-sha: none
- supersedes: none
- superseded-by: e-20260916-4a71
- date: 2026-09-16

`npm run eval -- compare --base <ref>` runs each affected case through two checkouts. The native
`--ablation` flag answers a different question (plugin on versus off), so every invocation pins
`--ablation none` and the arms are worktrees. Three details are load-bearing and each cost
something. The base ref is resolved to a SHA and added `--detach`, because this repository is
itself a worktree and `main` is already checked out at the primary checkout — a branch checkout
would simply fail. The candidate's `evals/` is copied over the base tree, so editing a case can
never masquerade as a catalog improvement; the price is that a case cannot be compared against
its own older version. And arm order alternates per case, so a rate limit or a provider rollout
lands on both arms rather than on whichever ran second.

`decideVerdict(summary, config)` throws on purpose. Its input, output, rule table and guardrails
are documented in `scripts/eval/stats.js`, nine skipped tests in `test/eval-stats.test.js` are
its specification, and `compare` catches the throw and prints `verdict: not decided` beside the
full numbers. Deciding what counts as proof of improvement is the judgement this whole harness
exists to serve, and it belongs to the person who owns the catalog, not to the code that measures
it. A reader who mistakes it for an unfinished bug and fills it in silently defeats the point.

Measured while proving the path end to end: on `trigger-ssh-staging-box-restart-api` with
`claude-haiku-4-5` at effort low, the skill fired in 2 of 3 runs from an unchanged checkout. That
is the harness working — but it means `runs.trigger: 2` in `evals/eval.config.json` is near the
floor, and a single trigger case will never carry a verdict on its own. Per-case variance, not
per-run cost, is what should drive that number when the rule is written.

### e-20260916-4a71 decideVerdict is written; "cut short" is zero case rows, not just few
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 28e8d86197792e841a22f8075cfe16aa44f522e1
- merged-sha: none
- supersedes: e-20260916-9c05
- superseded-by: none
- date: 2026-09-16

`decideVerdict(summary, config)` is implemented, matching the rule table already documented in
its JSDoc and CLAUDE.md. One judgment call the table didn't settle: two of the specification
tests in `test/eval-stats.test.js` (nine of them at the time; the file has grown since) both had
`n < minCases`, yet one expected Invalid and the
other Not proven with a flagged per-case drop — the same condition, two different answers, which
meant "the run was cut short" (the original skip note's own words) needed a real signal beyond
`n`. The one the tests actually distinguish on is `summary.cases.length`: a cell that produced
**zero** case rows despite claiming some `n` never ran anything real (a cost-ceiling abort before
its first case finished) and is Invalid; a cell with a few *real* rows below `minCases` is a
small honest sample, not a broken run, and falls to Not proven with the ≥0.67 drops named. The
`partial` flag `compare` also carries was dropped from this path — it duplicated what
`cases.length === 0` already proves and would have made "cut short" mean two different things.

Confirmed live: `npm run eval -- compare --base HEAD --tier 1 --all --case
trigger-ssh-staging-box-restart-api --runs 1 --max-cost-usd 0.60` (an A/A check — base and
candidate are the same commit) reported **Not proven** for `claude:claude-haiku-4-5:low`, never
Better or Worse — the A/A guarantee CLAUDE.md's consistency rules ask for held on the first real run
of a written verdict.

### e-20260916-f2a8 case.yaml must be plain YAML, never --- wrapped
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 28e8d86197792e841a22f8075cfe16aa44f522e1
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-16

`scripts/eval/cases.js`'s original case.yaml loader reused `readFrontmatter`, which requires
`---`/`---` delimiters — the shape `prompt.md` and `graders/*.md` actually have. `case.yaml`
does not: the native docs' own example is plain YAML with no delimiters at all, and
`claude plugin eval` rejects a delimited one outright ("case.yaml must be a YAML object").
Our own lint accepted the wrapped form silently (`parseFrontmatter` on a delimiter-free file
just returns empty frontmatter, so a case.yaml written the *correct* way would have loaded
with an empty, wrong context and still passed lint) — so every one of the 18 case.yaml files
written today, across five different workers who all followed the one convention `cases.js`
validated, would have failed the moment anyone actually ran them. Caught only because a
coverage worker tried a live `compare` run and got 0 case data back.

Fix: `lib/frontmatter.js` now exports `parseYamlDocument(text)` — the same one-level-deep
grammar as `parseFrontmatter`, applied with no delimiter stripping — and `cases.js` reads
`case.yaml` through it instead. All 18 existing files had their `---` wrapper stripped.
`test/eval-cases.test.js` now asserts the reverse case too: a wrapped `case.yaml` must fail
loudly, not parse to an empty, wrong context. The lesson generalises: this harness's own lint
is only as trustworthy as its agreement with the native parser it stands in for, and that
agreement needs its own test, not just an assumption.

### e-20260916-7b19 The Copilot arm is wired into compare and proven live end to end
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 28e8d86197792e841a22f8075cfe16aa44f522e1
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-16

`scripts/eval/copilot.js` (runner), `graders.js` (pure grading engine over a normalized trace)
and `judge.js` (headless `claude -p` as the one judge pinned for both CLIs) exist and are wired
into `compare.js`: a cell's `target` decides `runClaudeArm` vs `runCopilotArm`. Two decisions
worth recording. First, the fake HOME `copilot.js` needs is installed **once per arm, not once
per run** — `compare` creates exactly two (base, candidate) via `installCatalog`, before the
case loop, and every run of every copilot case/cell in that arm reuses it; reinstalling per run
would have been correct but wastefully slow, since the catalog under test doesn't change within
an arm. Second, `gh auth token` is captured exactly once per compare (not per run), in the
compare process's own real environment, and threaded through as `token` to every copilot run —
per copilot-facts.md, capturing it any later (once a fake HOME is already in a child's env)
makes `gh` fail against the wrong home's keychain.

Verified live end to end: `npm run eval -- compare --base HEAD --tier 1 --all --targets
claude,copilot --case trigger-ssh-staging-box-restart-api --runs 1 --max-cost-usd 1.00` ran all
four cells (claude×2 arms, copilot×2 arms) for $0.08, the skill fired in every one, and the
verdict correctly reported **Not proven** for both cells rather than fabricating a result from
one case — the `n < minCases` guard held under real data, not just the unit tests' fixtures.

Also confirmed live (a real, reproducible finding, not a guess): a plugin **agent** fires through
the `Task` tool with `subagent_type` set to the plugin-namespaced name
(`"subagent_type": "engineering-catalog:qa-triage"`), the same namespacing `Skill` uses — a
cheap model (`claude-haiku-4-5`/low) answered a qa-triage-shaped prompt in one turn without
invoking anything, while `claude-sonnet-5`/medium correctly delegated. Agent trigger cases
(`evals/qa-triage/`, `evals/code-reviewer/`) grade `tool_used: Task` with that pattern instead of
`Skill`. The background task the agent runs in has its own, stricter tool-permission scope
inside the eval sandbox (`Glob`/`Grep` calls from inside it were denied even though the parent
session had them) — a sandbox artifact, not a catalog defect; agent behaviour cases grade the
final reply and whether `Task` fired, not the subagent's internal tool-call success.

### e-20260916-c41f Container isolation: real bug found only by dropping the mocks, and never actually wired until now
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: e64b267aa1d83af89fe430c1ad4720fd0fc5f5eb
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-16

An audit asked "what's only ever been unit-tested with fakes, never run for real" and found two
things about `scripts/eval/isolation.js` that its 100%-mocked test suite could never have caught.

First, a real bug: `spawnInContainer` passed the container's `-e NAME=value` env straight through
as `child_process.spawn`'s own `env` option. `spawn`'s `env` *replaces* the process's environment
rather than merging into it, so it silently wiped `PATH` — any real call that forwarded a
non-empty `env` failed with `ENOENT: spawn podman`, because `podman` itself was no longer
findable. Every unit test injected a fake `exec`/`spawnInContainer`, so this was invisible until
an Orca worker was told to actually run `podman build` and a real command inside the resulting
image. Fixed by merging onto `process.env` instead of replacing it. The lesson generalises past
this one file: a DI seam that is *always* faked in tests proves the calling code, never the seam
itself — that seam needs at least one real, live exercise before it's trusted, not just a mock
that agrees with itself.

Second, and more basic: `isolation:container` was already a documented, lint-accepted case tag
(`cases.js`'s `TAG_PREFIXES`) and CLAUDE.md already described its skip-when-unavailable
behaviour as settled — but nothing in `compare.js` or `cases.js` actually read the tag.
`compare.js` hardcoded `isolation: 'native'` in its fingerprint unconditionally. The design had
been written down as if it were built; it wasn't. Wired now: `cases.js` normalises the tag into
`c.isolation`, `compare.js` gained `--container auto|off|required` (default `auto`) with real
skip-vs-fail branching, and a resolved container case's arm is routed through a small adapter
with the exact `(command, args, {cwd, env}) => {code, stdout, stderr}` shape `claude.js`/
`copilot.js` already expect — forwarding a small credential **safelist** read from `process.env`
at call time (`CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`/`COPILOT_GITHUB_TOKEN` plus the cell's
effort level), never the full merged host env `claude.js`/`copilot.js` build for a host run —
forwarding that whole object would blow up the container's `-e` argv with irrelevant and
possibly sensitive host variables. The judge always runs on the host regardless of arm; only the
CLI-under-test is containerized. No eval case actually uses `isolation:container` yet — that's
the next real gap, not a claimed one.

(That last sentence was the right observation and the wrong conclusion; `e-20260917-9f2e` settles
it by moving the decision from the case to the arm. Everything above it still holds.)

### e-20260917-1a3c No eval case ever ran its scaffold — on either arm
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: b0891b7e3fc1f38a6b9ca5fa592181997129ce99
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-17

`cases.js` parsed `context.scaffold_script` into `c.context` and nothing ever read it back.
`claude.js` did not pass `--scaffold`, which the native command has off by default and which
`--trust-plugin` explicitly does not imply; `copilot.js` had no concept of a scaffold at all. So
all 18 cases with a setup script — every `behaviour`, `task` and `scenario` case in the suite —
reached the model on a bare directory. The two verdict records committed under
`evals/experiments/` survive this: both ran tier-1 trigger cases only, and no trigger case carries
a `scaffold_script`. Every behaviour result ever produced before this fix does not.

The failure mode is worth naming because nothing pointed at it: the cases loaded, linted, ran and
scored. A grader that checks "did the skill fire" passes just as happily with no repository
underneath it, so the suite stayed green while measuring less than it claimed. What exposed it was
reading the native command's own `--help` against the harness's `buildArgs`, not any test.

Fixed on both arms, deliberately differently. Claude gets `--scaffold`, and only for a case that
actually has a script — it runs author-supplied bash as the operator, so it is not a blanket flag.
Copilot has no equivalent, so `copilot.js` executes the script itself through the same injected
`exec`, in the run's own workdir and fake `HOME`, before the CLI starts; a non-zero exit or a
missing file throws into the existing catch and the run is reported **failed** rather than graded,
because a case whose setup never ran is not a model result. `lint` now rejects a `scaffold_script`
that names a file which does not exist — the cheapest guard against the same class of silence.

### e-20260917-9f2e Container isolation belongs to the Copilot arm, not to a case tag
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: b0891b7e3fc1f38a6b9ca5fa592181997129ce99
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-17

The tag wired in `e-20260916-c41f` was still carried by zero cases, and the question that settled
it was "what happens when most runs go through Copilot?". The two arms are not symmetric.
`claude plugin eval` sandboxes shell tools at the OS level and honours a case's `allowed_tools`;
`copilot` must be launched with `--allow-all-tools --allow-all-paths --no-ask-user` to run
unattended, and its only containment is a throwaway `HOME` and workdir. Per-case opt-in therefore
protected the arm that was already protected and left the exposed one bare — which is why the tag
being unused looked like dead code and was really a wiring error.

So the decision moved from the case to the arm: every Copilot run is containerized when podman or
docker is available, and the tag now means the stricter "never on the host on *either* arm". A
missing runtime skips a tagged case but only downgrades the Copilot arm, and both are named in the
warning and in the fingerprint (`targets` / `downgraded`) — the fingerprint must never claim
isolation it did not get.

Two mechanical consequences the first design had not needed. `makeContainerExec` had discarded the
caller's `cwd` and env wholesale, which is right for Claude (it runs in the worktree) and wrong for
Copilot, whose fake `HOME` holds the installed catalog and lives outside it: the Copilot branch now
mounts that `HOME` writable and the worktree read-only, keeps the throwaway workdir as `cwd`, and
forwards exactly `HOME`/`COPILOT_HOME`/`COPILOT_GITHUB_TOKEN` by name — never the merged host env.
And `runInContainer` had no timeout, which the Claude arm never needed because the native command
enforces `max_turns` itself; the Copilot arm has no turn limit at all and leans entirely on a
wall-clock kill, so losing it inside the container would have turned a runaway run into a hung
compare.

Proven live rather than by mock, which is how the third bug in this seam surfaced: with real
mounts, real `-e` forwarding and a real image, every containerized run died at exit 125 with
"Cannot connect to Podman". `runInContainer` had been handing the *container's* env to the
podman client as well as baking it into argv, and a Copilot run's `HOME` points at a throwaway
directory — so the client went looking for its connection config and socket in a home that had
neither. It now forwards nothing to the client, which is also simpler than the `process.env` merge
the earlier `PATH` fix had introduced. The live run then confirmed the rest of the contract:
the fake `HOME` mounted writable with the installed catalog visible inside, writes to it readable
back on the host, the worktree present but **not** writable, nothing leaked into it, the token and
effort level arriving, both CLIs present in the image, and the timeout actually killing the run.
(`detectRuntime` still only proves the *client* exists — with a stopped podman machine it says
`podman` and `buildImage` is what fails, which `auto` already turns into a named downgrade.)

Deliberately **not** done: tagging the 18 scaffolded cases `isolation:container`, which the plan
for this change had proposed. It would have made those cases vanish on any machine without a
container runtime, gutting the entire behaviour tier to mitigate a risk the arm-level rule already
covers — the scaffolds are in-repo reviewed bash, and the `safety-ssh` cases that actually bait
dangerous commands grant `[Skill, Read, Glob, Grep]` with no `Bash` at all.

### e-20260917-4d6b Every hook the repository owns printed into a void on Copilot
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 65fab90baef6f4f5a9e32c4d3e0e9ea48c3370e8
- merged-sha: none
- supersedes: none

`catalog-freshness` is the one hook the catalog ships, and §7.4's entire point is that it tells a
person their catalog is stale. It printed a plain line. Claude Code adds a `SessionStart` hook's
plain stdout to the session as context, so that worked; **Copilot parses a hook's stdout as JSON
and takes the message from `additionalContext`, and drops anything else without a word**. So the
hook ran on every Copilot session, wrote its state file, and said nothing, for as long as it has
existed. The same held for the dev-side `remind-rebuild` twins on both CLIs — `PostToolUse` plain
stdout reaches Claude's debug log and nothing else.

`test/hooks.test.js` was written to make exactly this impossible ("one hook cannot behave
differently on the two CLIs") and did not catch it, because it asserted on the script's stdout —
which is byte-identical on both platforms, since it is the same script. The assertion had to move
to what each **host consumes**: unwrap Copilot's JSON, then compare. That is the reusable lesson
here, and it is worth more than the fix: a cross-platform contract test that asserts before the
platform boundary proves nothing about the platforms.

Three designs were on the table for producing two shapes from one script. Letting the script sniff
the platform from `COPILOT_PLUGIN_ROOT` was rejected — a shipped skill's script is a unit file, and
"platform logic lives in adapters, not in units" is the rule that keeps a third target cheap.
Per-platform `args` in the hook source was rejected as duplicating every argument to vary one.
What landed is `emitsContext: true` on the hook source — a declaration that *this hook's output is
meant to be read* — with `lib/hooks.js` appending `--json`/`-Json` to the Copilot rendering only.
A hook with a side effect and no message leaves the field out and is unaffected.

Two further facts about Copilot hooks were captured live at the same time and are recorded in
`copilot-facts.md` §6, because both had been guessed wrong in this repository within the week.
A `postToolUse` matcher fires on the **runtime** tool name only: `Edit|Write` never matched a
file write on 1.0.85, though GitHub's reference says the Claude-equivalent name also matches, and
a previous commit had changed the matcher *to* `Edit|Write` on the strength of that sentence. And
`.github/hooks/*.json` loads only inside a folder listed in `trustedFolders` — an untrusted
checkout runs no repository hook at all, silently. A dev-side hook is therefore per-machine
opt-in and can never be the enforcement for anything; `npm run check` is.
