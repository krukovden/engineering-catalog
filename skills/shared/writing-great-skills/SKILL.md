---
name: writing-great-skills
description: Reference for authoring and pruning skills.
invocation: user
---

A skill exists to wrangle determinism out of a stochastic system. **Predictability** — the agent taking the same _process_ every run, not producing the same output — is the root virtue; every lever below serves it.

**Bold terms** are defined in [`GLOSSARY.md`](GLOSSARY.md); look them up there for the full meaning.

## Invocation

Two choices, trading different costs:

- A **model-invoked** skill keeps a **description**, so the agent can fire it autonomously _and_ other skills can reach it (you can still type its name too). It contributes to **context load** — the description sits in the window every turn. Mechanics: write a model-facing description with rich trigger phrasing ("Use when the user wants…, mentions…").
- A **user-invoked** skill strips the description from the agent's reach: only you, typing its name, can invoke it — and no other skill can. Zero context load, but it spends **cognitive load**: _you_ are the index that must remember it exists.

Pick model-invocation only when the agent must reach the skill on its own, or another skill must. If it only ever fires by hand, make it user-invoked and pay no context load.

When user-invoked skills multiply past what you can remember, that piled-up cognitive load is cured by a **router skill**: one user-invoked skill that names the others and when to reach for each.

## Writing the description

A model-invoked **description** does two jobs — state what the skill is, and list the **branches** that should trigger it. Every word increases **context load**, so a description earns even harder pruning than the body:

- **Front-load the skill's leading word** — the description is where it does its invocation work.
- **One trigger per branch.** Synonyms that rename a single branch are **duplication** — "build features using TDD … asks for test-first development" is one branch written twice. Collapse them; keep only genuinely distinct branches.
- **Cut identity that's already in the body.** Keep the description to triggers, plus any "when another skill needs…" reach clause.
- **Negative scoping ("When NOT to use").** For model-invoked skills and router skills, explicitly specify when _not_ to use the skill, directing the model to the appropriate alternative (e.g. "Do not use for X; use /other-skill instead"). Dropping negative-scoping guidance measurably increases false-invocation rates because models over-trigger when adjacent domains lack an explicit negative boundary.
- **Back negative boundaries with evals.** Every "When NOT to use" exclusion in a model-invoked skill must be backed by at least one `trigger:negative` eval case under `evals/<unit>/` confirming the agent refrains from invoking the skill on adjacent tasks.

## Information hierarchy

A skill is built from two content types — **steps** and **reference** — that mix freely: a skill can be all steps, all reference, or both. The core decision is which to use and where each sits on the **information hierarchy**, a ladder ranked by how immediately the agent needs the material:

1. **In-skill step** — an ordered action in `SKILL.md`, the primary tier: what the agent does, in order. Each step ends on a **completion criterion**, the condition that tells the agent the work is done. Make it _checkable_ (can the agent tell done from not-done?) and, where it matters, _exhaustive_ ("every modified model accounted for", not "produce a change list") — a vague criterion invites **premature completion**.
2. **In-skill reference** — a definition, rule, or fact in `SKILL.md`, consulted on demand. Often a legitimately flat peer-set (every rule of a review on one rung) — a fine arrangement, not a smell. _This skill is all reference._
3. **External reference** — reference pushed out of `SKILL.md` into a separate file, reached by a **context pointer**, loaded only when the pointer fires.

A demanding completion criterion drives thorough **legwork** — the digging the agent does within the work — whether the skill has steps or not, since "every rule applied" binds flat reference just as "every step done" binds a sequence.

Push too little down and the top bloats; push too much and you hide material the agent actually needs. That tension is the whole decision.

**Progressive disclosure** is the move down the ladder — out of `SKILL.md` into a linked file — so the top stays legible. Mechanics: a linked `.md` file in the skill folder, named for what it holds (this skill discloses its full definitions to [`GLOSSARY.md`](GLOSSARY.md)).

- **Decompose on conditionality, not size.** Split a sub-file out *only* when it is read *conditionally* — a mode branch (e.g. subagent dispatch vs direct execution), an edge-case / failure / degrade path, or a template used only in some runs. Disclosure earns its keep by letting the agent *skip* reading the sub-file when that branch does not fire. Content read on every invocation must stay inline in `SKILL.md`; splitting always-read content forces an extra model read-turn per run for content the agent was always going to load, causing pure latency with zero disclosure benefit. Size is not the trigger: a 350-line SOP whose every step always runs belongs in one file; a 150-line file with three rarely-hit edge-case sections should split those out.
- **Context pointers decide reach.** A **context pointer**'s _wording_, not its target, decides when and how reliably the agent reaches the material.
- **Co-location.** Keep a concept's definition, rules, and caveats under one heading rather than scattered, so reading one part brings its neighbours with it.

## Instruction economy

The instruction budget is finite — every added line dilutes every other rule. Pay for new prose by deleting elsewhere:

- **Numeric caps over adjectives.** "≤3 bullets", "≤15 lines" are followed; "be concise", "keep it brief" are ignored. Write the number: an exact ceiling provides a measurable completion target.
- **Ceilings, never floors.** A minimum length forces the model to pad its response to reach the floor. State upper bounds only.
- **Cap the artifact, not the reasoning.** "Investigate thoroughly, report in ≤N words" — capping reasoning itself degrades accuracy on complex tasks. Restrict the output length, never the investigation or thought required to produce it.
- **Ration emphasis.** MUST/NEVER earn their weight by being rare — modern models read them literally and over-trigger. Ration them to 1–2 per file on constraints that genuinely break things, because normal prose already reads as an instruction.
- **No "double-check" lines.** Current models self-verify; vague "double-check your work" lines waste budget without altering behaviour. Ask for a specific mechanical check (run a test, diff lists) or ask for nothing.
- **Pair each hard rule with its one-sentence why.** Adherence measurably improves when the reason is given; a rule whose reason you cannot state in one sentence is probably not a rule.

## When to split

**Granularity** is how finely you divide skills, and each cut spends one of the two loads, so split only when the cut earns it. Two cuts:

- **By invocation** — split off a **model-invoked** skill when you have a distinct **leading word** that should trigger it on its own, or another skill must reach it. You pay **context load** for the new always-loaded **description**, so that independent reach has to be worth it.
- **By sequence** — split a run of **steps** when the steps still ahead (a step's **post-completion steps**) tempt the agent to rush the one in front of it (**premature completion**). Keeping them out of view encourages the agent to do more **legwork** on the current task.

## Pruning

Keep each meaning in a **single source of truth**: one authoritative place, so changing the behaviour is a one-place edit.

Check every line for **relevance**: does it still bear on what the skill does?

Then hunt **no-ops** sentence by sentence, not just line by line: run the no-op test on each sentence in isolation, and when one fails, delete the whole sentence rather than trim words from it. Be aggressive — most prose that fails should go, not be rewritten.

## Leading words

A **leading word** is a compact concept already living in the model's pretraining that the agent thinks with while running the skill (e.g. _lesson_, _fog of war_, _tracer bullets_). Repeated throughout the text (though not necessarily — a strong leading word might only be needed once), it accumulates a distributed definition and anchors a whole region of behaviour in the fewest tokens, by recruiting priors the model already holds.

It serves predictability twice. In the body it anchors _execution_: the agent reaches for the same behaviour every time the word appears. In the description it anchors _invocation_: when the same word lives in your prompts, docs, and code, the agent links that shared language to the skill and fires it more reliably.

Hunt for opportunities to refactor skills to use leading words. A triad spelled out at three sites (**duplication**), a description spending a sentence to gesture at one idea — each is a passage begging to **collapse** into a single token. Examples include:

- "fast, deterministic, low-overhead" → _tight_ — one quality restated across a phase — into a single pretrained word (a _tight_ loop).
- "a loop you believe in" → _red_ — converts a fuzzy gate into a binary observable state (the loop goes _red_ on the bug, or it doesn't).

You win twice over: fewer tokens, _and_ a sharper hook for the agent to hang its thinking on. Assume every skill is carrying restatements that leading words retire — go find them.

## Subagents and delegation

When a skill or agent delegates work to a subagent:

- **Encapsulate the boundary.** An orchestrator dispatches a subagent via exactly three things: the file path the subagent follows (SOP or step file), structured inputs, and a contract describing what comes back. The orchestrator never inlines step instructions into the spawn prompt and never reads internal draft artifacts (`arch.md`, `plan.md`); the subagent never reads orchestrator routing logic. Structured return data is the orchestrator's only routing surface.
- **Verify claims against the diff.** Subagent summaries describe what they intended to do, not necessarily what they did. The diff is authoritative; the report is auxiliary. Before trusting a completion report, the orchestrator must inspect the actual working tree (`git status --short`, `git diff --stat`), verify every claimed modified file appears in the diff, investigate unmentioned diffs, and reconcile unexpected state before committing.

Detailed dispatch contracts and the 5-step diff verification discipline are disclosed in [`references/subagent-encapsulation.md`](references/subagent-encapsulation.md).

## Targeted edits of user-owned files

When a skill's helper scripts or execution steps mutate structured configuration files that the user or project also owns (e.g. Copilot settings, `ado-credentials` config, `ado-board` maps, `settings.json`, YAML manifests):

- **Never wholesale-serialize.** Do not use `JSON.parse` → mutate → `JSON.stringify` or raw YAML `load` → `dump`. Wholesale re-serialization destroys comments, reorders keys, and normalizes formatting across the entire file.
- **Targeted edits with single-match assertions.** For JSON/JSONC, use targeted string replacement anchored to enclosing keys. For YAML, use an AST-preserving mutator that preserves comments and formatting. In all cases, assert the new value appears exactly once — more than one match means a sibling field was clobbered; zero matches means the anchor missed. If the assertion fails, restore backup and exit non-zero.

Detailed mutation patterns and regex anchoring rules are disclosed in [`references/targeted-edits.md`](references/targeted-edits.md).

## Failure modes

Use these to diagnose issues the user may be having with the skill.

- **Premature completion** — ending a step before it's genuinely done, attention slipping to _being done_. Defence, in order: sharpen the completion criterion first (cheap, local); only if it is irreducibly fuzzy _and_ you observe the rush, hide the post-completion steps by splitting (the sequence cut).
- **Duplication** — the same meaning in more than one place. Costs maintenance and tokens, and inflates a meaning's prominence on the ladder past its real rank.
- **Sediment** — stale layers that settle because adding feels safe and removing feels risky. The default fate of any skill without a pruning discipline.
- **Sprawl** — a skill simply too long, even when every line is live and unique. Hurts readability and maintainability and wastes tokens. The cure is the ladder: disclose **reference** behind pointers, and split by **branch** or sequence so each path carries only what it needs.
- **No-op** — a line the model already obeys by default, so you pay load to say nothing. The test: does it change behaviour versus the default? Vague "double-check your work" lines, weak leading words (_be thorough_), and conversational adjectives (_be concise_) are common no-ops.
- **Negation** — steering execution by prohibition backfires: _don't think of an elephant_ names the elephant and makes it more available, not less. Prompt the **positive** — state the target behaviour so the banned one is never spoken; keep a prohibition only as a hard guardrail you can't phrase positively, and even then pair it with what to do instead. Contrast this with invocation routing: negative scoping in a description ("When NOT to use") is required to prevent false triggers between skills.

## Applying this in the engineering catalog

Five of this catalog's rules exist because of the levers above — honour them when authoring here:

- **A skill folder is self-contained.** Disclose reference to a sibling file inside the skill (`references/foo.md`, `GLOSSARY.md`), never to a path in another skill. The install adapters copy the folder verbatim, so a `../other-skill/FILE.md` pointer arrives broken. Where two skills need the same material, one invokes the other by name in prose (`Run the /grilling skill`) rather than reaching across folders.
- **Conditionality governs references.** Place conditional branches (subagent orchestration, config editing, specialized templates) in `references/`, never always-read steps.
- **Targeted edits protect user configuration.** Any script modifying consumer configuration must use targeted field edits with single-match assertions.
- **Owner folders carry the invocation decision that frontmatter can't yet.** A skill you only ever fire by hand belongs in the catalog all the same; until per-platform invocation metadata lands, say so in the description's first clause rather than relying on a flag. The folders are `shared, developers, qa, product, ops, in-progress, deprecated`; `shared` is machine-checked (§3.1), and a `requires:` list declares preflight dependencies (§5).
- **The description is the trigger contract.** Editing it is a behaviour change, not a docs change — re-run the skill's trigger eval under `evals/` afterwards.

The repo's own invariants live in `AGENTS.md` at its root (`CLAUDE.md` just imports it).
