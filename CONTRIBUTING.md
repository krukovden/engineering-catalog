# Contributing — the first hour

You have cloned the catalog and want to change something in it. This page is the process:
what you need installed, the loop you run, and the two or three things that surprise people.
It is not the rules — those are `AGENTS.md` (`CLAUDE.md` just imports it), and you will want
them open beside this. The reasoning behind the rules is `DESIGN.md`. If instead you want to
*use* the catalog in your own project, you are in the wrong file: read `README.md`.

## What you are actually editing

Four kinds of hand-written file are the source of truth:

```
skills/<owner>/<name>/SKILL.md      agents/<owner>/<name>.md
workflows/<owner>/<name>.md         bundles/<name>.json
```

Everything else a consumer reads — `catalog.json`, the plugin manifests, the folder READMEs,
the table inside `README.md` — is produced by `npm run build` and committed, because Claude
Code and Copilot CLI read those files directly. **Never edit a generated file by hand.**
Change a source, rebuild, and commit both.

## Prerequisites

Only the first two are needed to change a skill and get a green build.

| What | Needed for | Check |
|---|---|---|
| Node 20+ | everything | `node --version` |
| Git | everything | `git --version` |
| `az` CLI, logged in | the Azure DevOps skills, and the PR badge in the Claude Code status line | `az account show` |
| `claude` and/or `copilot` CLI | running the eval suite | `claude --version`, `copilot --version` |
| `gh`, authenticated | the Copilot arm of an eval run captures `gh auth token` once, up front | `gh auth status` |
| podman or docker | container isolation for the Copilot eval arm; without it that arm downgrades to the host, with a named reason | `podman --version` |

**There is no `npm install`.** The catalog has zero runtime dependencies and no lockfile, on
purpose — it is installed with `npx` on machines we do not control. An empty `node_modules`
is not a broken checkout.

## The loop

```bash
npm test                 # node --test test/*.test.js — offline, deterministic, no model calls
npm run build            # regenerates catalog.json, both plugin manifests, the READMEs
npm run check            # what CI runs: fails when a committed artifact is stale
git status               # generated files are committed — read their diff too
```

All four are clean before you commit. `npm run check` is the real enforcement; the
`remind-rebuild` hooks under `.claude/` and `.github/` are a courtesy and miss any edit made
through the shell.

Run this loop automatically on every commit, once:

```bash
git config core.hooksPath scripts/git-hooks
```

`scripts/git-hooks/pre-commit` then runs `npm test` and `npm run check` before the commit is
created — the same two commands `azure-pipelines.yml` gates on, so drift (including the
Claude/Copilot parity check inside `npm test`) is caught locally instead of on the next push.
It is a courtesy, not a new rule: `git commit --no-verify` skips it, and the pipeline is still
what actually enforces this.

One more check, before a change that touches a plugin manifest or `package.json`'s publisher
fields:

```bash
claude plugin validate --strict .
```

It reads `.claude-plugin/marketplace.json`, follows `source: "."` into the plugin, and is the
same check Anthropic's submission pipeline runs. It is not in the pipeline: it needs the Claude
CLI, which the build agent does not have, and a step that quietly skips when a binary is missing
is the kind of silent pass this repository keeps out of CI. What the build *can* prove offline —
that every manifest carries the metadata `--strict` demands — is asserted in `test/build.test.js`
instead.

## Adding a skill, end to end

```bash
mkdir -p skills/in-progress/my-skill
$EDITOR skills/in-progress/my-skill/SKILL.md     # name: must equal the folder name
npm run build && npm test
git mv skills/in-progress/my-skill skills/qa/my-skill   # ship it, and name its owner
$EDITOR bundles/qa.json                                  # add it to an audience
npm run build && npm test && npm run check
```

The folder is the whole lifecycle: `in-progress/` is committable but ships nowhere,
an owner folder (`developers`, `qa`, `product`, `ops`) ships, `deprecated/` retires. A unit
that two or more audiences' bundles claim must sit in `shared/` — the build tells you so, with
the `git mv` to run. Read the invariants table in `AGENTS.md` before arguing with an error.

## Evals

```bash
npm run eval -- lint                   # every case loads and is gradable
npm run eval -- static                 # per-target description cost, no model calls
npm run eval -- affected --base main   # which cases your change can move
npm run eval -- compare --base main    # scores the change against two checkouts
```

**Only `compare` calls a model, and it costs real money.** It builds a second worktree,
runs every affected case through both trees, and pays for a judge on top. Run `affected`
first to see the size of what you are about to buy, and pass `--case <substring>` while you
are still iterating. The other three are free and belong in your normal loop.

## Install smoke test

```bash
npm run e2e:install
```

Runs `scripts/e2e/run-scenarios.js` — real `bin/engcat.js` subprocesses, not the in-process
harness `test/cli.test.js` uses — against a scratch `$HOME`, covering a fresh install, the
overwrite-conflict prompt, `--overwrite`, `--keep-local`, and the install→update sequence
(`--keep-local` at install must still be protected on the very next `update`, not just the
first time nothing has changed). It runs inside the same podman/docker image the eval harness
already builds (`evals/container/Containerfile`) to simulate an unrelated host installing the
catalog for the first time — this checkout is never that. Skips with exit 0 when neither
runtime is on `PATH`, so it never blocks a machine without one; the PR build in
`azure-pipelines.yml` runs it on a hosted agent that has one. Not part of `npm test` or the
pre-commit hook — it is slower and needs a container runtime neither is guaranteed to have.
You can also run `node scripts/e2e/run-scenarios.js` directly on the bare host while iterating
on the scenarios themselves; it is the same file either way, just without the container.

## Commits, branches and the release you did not make

Branches are `feature/ADO-<id>-<title>` or `bug/ADO-<id>-<title>`. Commit subjects are plain
conventional commits (`feat:`, `fix:`, `docs:`). **Never** add a `Co-Authored-By: Claude`
trailer, a "Generated with Claude Code" line, or any other assistant attribution, anywhere —
not in commits, not in PR descriptions, not in file headers.

Then the part nobody expects: **the PR build pushes a commit to your branch.** It computes
the version your PR will release, writes it into `package.json`, rebuilds every manifest and
commits `release: prepare vX.Y.Z` to your source branch — never to `main`. That is invariant 9
working, not someone else editing your work. Pull before you push again. After the merge, the
`main` build verifies the artifacts and tags the commit. You only ever bump major.minor by
hand, by setting `package.json` yourself in the PR.

## Your own machine

- `.claude/settings.json` is the shared, committed config — permissions, hooks, the status
  line, the output style. Personal overrides belong in `.claude/settings.local.json`, which is
  git-ignored. Change the shared file only when the whole team should get the change.
- `docs/` is git-ignored and is where local notes and scratch work go.
- Copilot loads `.github/hooks/*.json` only in a folder it trusts. Until you accept the trust
  prompt for this checkout (or add its path to `trustedFolders` in `~/.copilot/config.json`),
  this repository's dev-side Copilot hook silently never runs.
- There is no linter and no formatter. Match the file you are editing; review is the check.

## Where to read next

| File | What it is |
|---|---|
| `AGENTS.md` | the contract — folders, invariants, adapters, evals, decisions taken |
| `CLAUDE.md` | a one-line `@AGENTS.md` import, so Claude Code picks up the contract too |
| `DESIGN.md` | the specification the contract implements |
| `copilot-facts.md` | Copilot CLI behaviour verified live, that the harness and hooks depend on |
| `memory/index.md` | what this project decided and why, including what was rejected |
