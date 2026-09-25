---
name: coding-agent-parity
description: Repo-local maintenance check only — run when a person explicitly asks to verify, sync, or check parity between this repository's Claude Code dev config and its GitHub Copilot CLI dev config (the two "dev-side" hook twins under .claude/hooks/ and .github/hooks/, their wiring in .claude/settings.json and .github/hooks/remind-rebuild.json, and whether npm run check is clean). Never triggers itself — invoke only via /coding-agent-parity.
disable-model-invocation: true
---

# Coding agent parity check

This repository is worked on with two different CLIs — Claude Code and GitHub Copilot CLI —
and AGENTS.md (the contract; `CLAUDE.md` just imports it) promises an engineer the same
experience on either one. Most of that promise is kept for free: `npm run build` generates
both plugin manifests, both hook manifests, and the Copilot-instructions style block from
the same hand-written sources, so those can't drift.

The one place that promise is *not* generator-backed is the pair AGENTS.md calls out by name:
`.claude/hooks/remind-rebuild.js` and its Copilot twin `.github/hooks/remind-rebuild.js`,
wired up in `.claude/settings.json` and `.github/hooks/remind-rebuild.json` respectively.
AGENTS.md is explicit that these are "hand-written, installed nowhere, and deliberately
outside the generator" — which means nothing stops someone editing one twin without the
other, and it would fail silently: both hooks only ever produce a reminder string, so a
divergence shows up as one CLI nudging contributors correctly and the other saying something
stale, or nothing at all.

Run this skill after touching either dev-side hook, either hook's wiring file, or
`copilot-facts.md` — or whenever asked to check the two CLIs are in sync.

## What it does

```bash
node .claude/skills/coding-agent-parity/scripts/check-parity.js
```

It is read-only except for shelling out to `npm run check` (also read-only — `--check` mode
never writes). It checks:

1. **Hook script parity** — the human-readable reminder message and the
   `skills|agents|workflows|bundles` path regex are byte-identical between
   `.claude/hooks/remind-rebuild.js` and `.github/hooks/remind-rebuild.js`. It also checks
   each script still emits the JSON shape its own CLI actually reads — Claude wants
   `hookSpecificOutput.additionalContext` (nested), Copilot wants a flat `additionalContext`
   (copilot-facts.md §6.2) — so it flags either script if it starts emitting the *other*
   CLI's shape, not if the two shapes differ from each other.
2. **Hook wiring** — `.claude/settings.json`'s `PostToolUse` matcher, command path, and
   timeout against `.github/hooks/remind-rebuild.json`'s `postToolUse` matcher, command path,
   and `timeoutSec`. The two matchers are *expected* to read differently — Claude uses its
   own tool names (`Edit|Write`); Copilot only ever sees runtime tool names, so it has to be
   `create|edit|str_replace_editor|apply_patch` (copilot-facts.md §6.1 — `Edit|Write` silently
   never fires there). The check knows this and only flags a matcher that stops matching its
   *own* CLI's expected list, never the difference between the two.
3. **`copilot-facts.md` anchors** — AGENTS.md's Hooks section cites this file by section
   number (§4, §6, §6.5). If those headings move, get renamed, or the file goes missing,
   AGENTS.md's claims go stale silently.
4. **Generator freshness** — runs `npm run check`, which is the real enforcement for
   everything that *is* generated (catalog.json, both plugin manifests, both hook manifests,
   the generated blocks in `.github/copilot-instructions.md`). This skill doesn't re-implement
   that logic, just surfaces a failure so a "parity check" doesn't pass while an artifact is
   actually stale.

Exit code 0 means the two CLIs currently behave identically for a contributor. Non-zero
prints one `[check-name] detail` block per drift found — fix Copilot's side to match Claude's
unless the report itself says the asymmetry is expected.

## Tests

This is deliberately **not** a `claude plugin eval` suite. That format tests whether a model
*chooses* to invoke a skill on ambiguous natural-language phrasing — but this skill is
`disable-model-invocation: true`, so there is no such choice to measure: the only door in is a
literal `/coding-agent-parity`. It's also not eligible as an eval target in the first place —
`claude plugin eval` loads "your plugin" into an isolated, empty sandbox, and a bare
`.claude/skills/<name>/SKILL.md` with no `.claude-plugin/plugin.json` is a *plain skill*, not
a *skills-directory plugin* (the distinction `code.claude.com/docs/en/plugins-reference`
draws); only the latter is a loadable target. Wrapping this in a manifest just to make it
eval-able would turn a two-file dev tool into a plugin, which is exactly what it's meant not
to be.

What `check-parity.js` actually is, though, is 100% deterministic code with zero model
behavior to grade — and the eval cookbook's own priority order puts that case ahead of a model
grader anyway ("[code-based grading] is by far the best grading method if you can design an
eval that allows for it" — `platform.claude.com/cookbook/misc-building-evals`). So it's tested
the way every other pure-JS module in this repository is tested: `test/coding-agent-parity.test.js`,
picked up automatically by `npm test` (`node --test test/*.test.js`) alongside everything else.
The script exports `runChecks({ root, runNpmCheck })` so the suite can stage a synthetic root
and inject a stub for the one check that would otherwise shell out.

```bash
node --test test/coding-agent-parity.test.js   # just this file
npm test                                        # everything, this included
```

## When this needs a new check, not just a run

If a new dev-side hook is added (anything else hand-written under `.claude/hooks/` or
`.github/hooks/` that isn't part of the generated catalog hook pipeline in `hooks/*.json`),
extend `scripts/check-parity.js` with the same two questions asked of `remind-rebuild`: do
the two scripts say the same thing to a human, and does each CLI's wiring file still match
that CLI's actual, live-verified matcher syntax rather than what the docs imply would work.
