# AI Engineering Catalog — design

**Status:** draft for review · **Date:** 2026-09-14 · **Author:** design session

An internal catalog of AI engineering capabilities. A developer installs it once,
runs one command inside a project, and from that moment every agent they use —
GitHub Copilot first, Claude Code second — behaves the same way in that project
and shares one memory of it.

This document defines what the catalog contains, how it is organised, how it is
distributed and updated, and the contract of its flagship capability, project
memory. It defines no code.

**Repository:** `https://github.com/krukovden/engineering-catalog`
**Succeeds:** [krukovden/skill-catalog](https://github.com/krukovden/skill-catalog) — see §9.

---

## 1. Scope

**In scope.** The unit model, the repository layout, the generated artifacts, the
dependency mechanism, distribution and update for Claude Code and GitHub Copilot,
and the project-memory capability end to end.

**Out of scope.** Any work tracker. Any hosted service. Any database. The catalog
writes plain files into a git repository and nothing else.

**Not a Claude plugin, and not a Copilot plugin.** It is a vendor-neutral catalog
whose unit is the Skill; Claude and Copilot are two of its delivery targets and
neither owns the model. A third target is one adapter file and zero changes to any
skill.

---

## 2. The four units

    Skill → Agent → Workflow → Bundle

| Unit | Is | Lives in |
|---|---|---|
| **Skill** | a small reusable capability | `skills/<owner>/<name>/SKILL.md` |
| **Agent** | a role that draws on several skills | `agents/<owner>/<name>.md` |
| **Workflow** | an ordered use of skills and agents | `workflows/<owner>/<name>.md` |
| **Bundle** | what a developer installs in one command | `bundles/<name>.json` |

Each unit is a directory or a file that a human writes. Everything a machine reads
at install time is generated from them (§6).

### 2.1 Skill

Unchanged from the existing catalog, plus one field.

```yaml
---
name: <name>                 # must equal the folder name
description: <one line>      # how an agent decides to fire it
invocation: model            # model (default) | user
requires:                    # optional; see §5
  - ado-credentials
platforms:                   # optional; only value is `skip`
  copilot: skip
---

# Body
```

`invocation` is one decision for every platform. `model` means the agent may fire
the skill itself, so its `description` sits in context every turn and is written
for the model, trigger phrasing included. `user` means only a person naming it can
reach it: zero context cost, and the `description` becomes a human-facing line.

A skill directory is self-contained. Helper scripts in `scripts/`, on-demand
documents in `references/`. No `../` into another skill — adapters copy the directory
verbatim and anything outside it does not arrive, which is also why eval cases live
outside the unit, in the repository's own `evals/` (§12).

### 2.2 Agent

A role. It names the skills it leans on and the boundaries it works inside. It does
not restate their content.

```yaml
---
name: <name>
description: <one line — when this role is the right one>
skills:                      # skills this role expects to be installed
  - diagnosing-bugs
  - ado-credentials
model: <optional>            # a hint, not a requirement
---

# Body — what this role does, what it refuses to do, when it hands back
```

An agent that names a skill creates a dependency the build checks (§5).

### 2.3 Workflow

An ordered use of skills and agents, written for a human and an agent to follow.

```yaml
---
name: <name>
description: <one line>
steps:                       # ordered; each names a skill, an agent, or neither
  - agent: qa-triage
  - skill: ado-credentials
  - skill: qa-ado-work-item
---

# Body — what each step is for, what stops the chain, who decides
```

**Open (§13.1).** The portable representation of a workflow is the least settled
part of this design. The frontmatter above is a list a human can follow and an
agent can read; it is deliberately not an execution format. If a vendor-native
orchestration format later earns its place, it arrives as an adapter concern, not
as a change to this file.

### 2.4 Bundle

What a developer actually installs. A bundle is a **list of names, never copies** —
a skill duplicated into two bundles diverges at the second edit.

```json
{
  "name": "qa",
  "description": "Everything a tester needs",
  "skills": ["grilling", "ado-credentials", "qa-ado-work-item"],
  "agents": ["qa-triage"],
  "workflows": ["observation-to-work-item"]
}
```

Bundles carry no owner folder: **a bundle is an audience.** `bundles/qa.json`,
`bundles/backend.json`. A second audience layer above them would say nothing.

---

## 3. Organisation

Two axes, both expressed as folders, never as a status field.

```
skills/
  shared/          used by two or more audiences — see §3.1
  developers/
  qa/
  product/
  ops/
  in-progress/     committable, never shipped
  deprecated/      retired, kept for the record
agents/            same owner folders
workflows/         same owner folders
bundles/           flat
```

**The folder says who owns it** — exactly one, answering "who fixes this when it
breaks". **The bundle says who gets it** — many, overlapping. A skill lives in one
folder and appears in as many bundles as claim it.

Lifecycle folders sit at the same level, which makes promotion one move that does
two things:

```bash
git mv skills/in-progress/foo skills/qa/foo    # ships it, and assigns its owner
```

### 3.1 The `shared` rule, and why it is machine-checked

A folder named `shared` is a gravity well: "someone else might want this" is always
plausible, and in a year it holds most of the catalog and informs nothing.

> **A unit belongs in `shared` when, and only when, bundles of two or more
> different audiences name it.** Not "could be shared" — *is* shared.

This makes `shared` a derived fact the build computes rather than a matter of
taste:

| Build observes | Build says |
|---|---|
| in `shared`, named only by one audience's bundles | move it to that audience |
| in `developers`, also named by a `qa` bundle | move it to `shared` |
| no bundles reference it yet | silent — no constraint before bundles exist |

`productivity` is deliberately **not** an audience folder. It is a theme, and a
theme standing among audiences reintroduces the mixed-axis problem this layout
exists to remove.

---

## 4. What a skill must not assume

- That any other skill is installed, unless it declares it in `requires:`.
- That its files live at a particular absolute path.
- That the agent reading it is Claude.

---

## 5. Dependencies and preflight

A capability that needs credentials, a CLI, or a login must not carry that check
inside itself. Every other capability needing the same thing would rewrite it, and
the self-containment rule forbids reaching into a neighbour's folder.

```yaml
requires:
  - ado-credentials
```

A **preflight skill** is a skill whose whole job is to answer three questions about
one dependency, deterministically:

1. **Is it there?**
2. **Is it alive?** — proven against the real thing, not inferred from a file's
   existence.
3. **If not, what does a person with no prior experience do about it?** — concrete
   steps, in order, naming the exact command.

A preflight skill reports a distinct outcome for "absent", "present but expired"
and "present and working". Collapsing expired into absent is what produces advice
that cannot fix the problem.

**Build checks.** Every name in a `requires:` or an agent's `skills:` resolves to a
unit in the catalog, and a bundle naming a unit also names everything that unit
requires. An unresolvable name fails the build.

**Secrets never enter the catalog.** A preflight skill records where a credential
lives; it never records the credential.

---

## 6. Source of truth and generated artifacts

`SKILL.md`, `agents/*.md`, `workflows/*.md` and `bundles/*.json` are the only
hand-written files. These are generated by the build and committed, because
consumers read them directly:

| Generated | Read by |
|---|---|
| `catalog.json` | the CLI |
| `.claude-plugin/marketplace.json` | Claude, when the marketplace is added |
| `.claude-plugin/plugin.json` | Claude, to install and to detect updates |
| `plugin.json` (repo root) | the Copilot plugin marketplace format |
| each owner folder's `README.md` | humans |
| the root `README.md` table | humans |

Two manifests are needed because the two formats differ and neither reads the
other: Claude discovers skills by convention from a `skills/` directory and its
schema has no `skills` field; the Copilot CLI format requires the list to be
explicit. One file cannot serve both.

The release version lives in one place — the package manifest — and the build
writes it into everything else. Claude compares that field against the installed
copy to decide whether a user sees an update, so a version that does not move means
installed users never update.

---

## 7. Distribution

### 7.1 Install

One install, two questions: **which tools** (Claude, Copilot, or both) and **which
scope**. Global is recommended and is the default the installer proposes; local
exists for a machine shared with someone else's conventions.

| Target | Global | Local |
|---|---|---|
| Claude Code | `~/.claude/skills/<name>/` or the plugin directory | `.claude/skills/<name>/` |
| GitHub Copilot | `~/.copilot/skills/<name>/` | `.github/skills/<name>/` |

Claude additionally supports a native marketplace path (`/plugin marketplace add`,
`/plugin install`), which installs the promoted set globally and updates itself.
That path is a convenience, not the contract; the CLI is the contract, because it
is the only path both tools share.

**Hooks ship with the plugin.** Where a target supports plugin-delivered hooks, the
catalog ships them rather than documenting them. An autostart that a user has to
paste into a settings file by hand is an autostart that is not installed.

### 7.2 The receipt

Every install writes a receipt recording:

- the catalog version installed,
- every unit installed, with its own version,
- the target and the scope,
- the date,
- a content hash per installed file.

Without a receipt, `update` cannot know what to update, and nothing can answer
"what do I have installed". The receipt sits beside the install: with the project
for a local install, with the user for a global one.

### 7.3 Update

    update

Fetches the catalog, compares it against the receipt, reinstalls what changed, and
reports what moved and to which version. Idempotent; the same adapters as install.

**Local edits are never overwritten silently.** A file whose hash differs from the
receipt has been edited by hand. `update` says so and asks; it does not decide.

**Pinning.** An explicit version may be requested, so a team and its CI install the
same thing.

### 7.4 Being told an update exists

An update mechanism nobody triggers is not a mechanism. The check lives **inside
the skill**, not in a vendor hook: a periodic freshness check — "check every N
days, last checked on D" — that any agent performs because it is just reading a
file and running a command. This works on Copilot, which may have no session-start
hook at all, and that is why it is the primary mechanism rather than a fallback.

---

## 8. Project memory — the flagship capability

The reason the catalog exists in its current form. Three units, one capability:

| Unit | Kind | Runs |
|---|---|---|
| `memory-init` | command | once per project, invoked by a person |
| `memory` | skill | always, in every session |
| `memory-writer` | agent | in isolation, to write entries without spending the working session's context |

Goals, in order:

1. A rejected approach is not proposed a second time.
2. Two tools, one memory: work done from Copilot and work done from Claude land in
   the same place.
3. Only the fragment that is needed is loaded.

### 8.1 Where memory lives

Chosen once, during `memory-init`:

| Choice | Consequence |
|---|---|
| **committed folder** (recommended) | travels with the repository, reaches teammates, survives a new machine |
| **agent-local** | stays on this machine, for a repository you cannot commit to |

There is exactly one store. The catalog does not mirror memory to a second place,
because two stores require a rule for which wins, and that rule is where drift is
born.

### 8.2 Layout

```
<memory>/
  index.md            always loaded
  units/<slug>.md     loaded when work touches that unit
  .pending            not committed — the queue of unrecorded commits
```

A **unit of memory** is any coherent piece of functionality — a feature, a theme, a
subsystem. The catalog does not impose the granularity; it requires only that the
boundary is meaningful and that a file does not become a dumping ground.

### 8.3 What goes where

**`index.md` — always loaded, therefore small.**

- what this project is;
- its architecture;
- one line per unit of functionality, with a link to its file;
- **what was rejected at project level**, one line each.

Project-level rejections live here and nowhere else, for a mechanical reason: an
agent about to propose something does not know to go looking for whether it was
already rejected. A rejection only prevents a repeat if it is in the layer that is
loaded without being asked for.

**`units/<slug>.md` — loaded on demand.**

The **chain** of one piece of functionality, and this is its only home: built one
way → a requirement changed it → a later requirement returned it to the first. Each
link records what changed, why, and a link to the commit.

The chain belongs here rather than in the index because it matters only to someone
working on that functionality. In the index it would be noise, and the index must
stay small or progressive loading buys nothing.

### 8.4 A graph, not a tree

Unit files reference each other with `[[name]]`. A unit may be referenced from
several places; overlap is expected and no unit has to be assigned a single parent.
The format is ordinary Markdown, so Obsidian opens the folder as it is and draws
the graph without the catalog doing anything for it.

### 8.5 Entry format

Two independent axes, which never collapse into each other:

- **Status** — where the entry is in its life: `active`, `superseded`, `open`,
  `needs-review`.
- **Evidence** — how well the *origin* of the claim is established: `confirmed`,
  `inferred`, `unknown`.

An `active` entry may carry `unknown`; a `superseded` one may carry `confirmed` for
what was true while it held. Reducing a mixed case to one word never picks the
stronger one.

A superseded entry is **never deleted** — it explains how the project got here. The
supersede link is written **in both directions**: the replaced entry names its
replacement and the replacement names what it replaced. A one-way link breaks the
first time a file is moved.

### 8.6 The commit link

A commit SHA is **evidence, not identity.** Squash-merge creates a new object with
a new hash, the branch is deleted, and the original becomes unreachable — a
recorded branch SHA does not resolve in a fresh clone. Each entry therefore
carries:

| Field | Role |
|---|---|
| entry id | the identity; minted at write time, never derived from git |
| pull request | the durable automatic anchor — assigned before the merge, and carried into the squash commit message by default |
| `sha-at-write` | evidence; the field name states that it may dangle |
| `merged-sha` | filled in by reconciliation after the merge |

The author is **not** recorded. Git already stores it; the memory points at what is
already there rather than copying personal data into a file.

Where a memory entry can be written on the same branch as the code it describes, it
arrives on the main branch through the squash as file content, and the identity
problem does not arise at all. That is the preferred path.

### 8.7 When an entry is written

The rule lives in the project's entry-point file, so that any agent follows it.

> Write an entry when the change is **hard to reverse**, **and** not obvious
> without context, **and** the result of a real trade-off. If it fails any of the
> three, do not write.

Refactoring, formatting, and a test adjusted to an unchanged contract are not
recorded. "Significant" on its own produces either an entry per commit or none at
all, which is why the test has three parts and all three must hold.

An abandoned change is its own signal: starting to remove something and stopping
once the reason not to becomes clear leaves no diff, no commit and no PR, and is
exactly the reasoning that is otherwise lost.

### 8.8 The catch-up path

The rule above is followed by a model, and a model that decided not to write and a
model that forgot look identical. The safety net is mechanical.

A git `post-commit` hook, installed by `memory-init`, does exactly one thing:
append the new SHA to `.pending`. It is dumb and instant — it calls no model and
delays no commit. The `memory-writer` agent drains the queue later, in isolation.

**The hook does not ask which tool made the commit.** Copilot, Claude, or a person
typing `git commit` — all land in the same queue. This is what makes one memory
across two tools work rather than leak along the boundary between them.

`index.md` also records the SHA up to which memory has been reconciled, so the
unrecorded set is a short list rather than the whole history.

### 8.9 How agents find it

`memory-init` writes a pointer into each tool's own entry-point file — Claude's and
Copilot's — aimed at `index.md`. An agent reads its entry file and arrives at
memory. This is vendor-neutral and works on any tool that reads an entry file at
all, which is why it is the primary mechanism rather than a hook.

### 8.10 Rules that keep memory honest

- **If the index disagrees with a unit file, the unit file wins.** This is what
  makes partial loading safe: the index may go stale without going wrong.
- **A writer updates only its own row** in the index. This is what lets several
  agents append without turning the index into a merge conflict.
- **Each memory file opens with a contract in an HTML comment** stating what
  belongs in it, so an appending agent does not write prose into a table.
- **Entries describe; they never direct.** No credentials, no personal data, no
  session narrative, no instructions to an agent.

### 8.11 What `memory-init` writes

1. The storage choice (§8.1) and the memory folder.
2. An `index.md` recording **what exists and how it works** — derived from the code.
3. The **"why" is left empty.** It is not in the code. Where no history exists, the
   entry says so plainly: this predates tracking. Tracking begins now.
4. An honest evidence grade on every reconstructed claim, so inferred never reads as
   verified.
5. The pointer in each tool's entry-point file.
6. The `post-commit` hook.

`memory-init` is resumable: run twice, it continues from the last completed step
rather than starting over.

---

## 9. Migration from the existing catalog

The catalog this one succeeds is **[krukovden/skill-catalog](https://github.com/krukovden/skill-catalog)**
— six skills in topical buckets, three install adapters (Claude, Copilot, Codex),
generated manifests, and a CLI. Its machinery carries over; what changes is the
organising axis (§3), the three units it does not have (§2), dependencies (§5) and
update (§7).

Four of its decisions are adopted unchanged and should not be relitigated: the
entry document is the only hand-written source and everything else is generated;
the folder is the status, with no status field to keep in sync; `invocation` is one
decision for every target; and adapters separate what would be written from writing
it.

| From | To | Note |
|---|---|---|
| `grilling` | `shared` | claimed by product, developer and QA bundles |
| `safety-ssh` | `ops` | already ships both `.sh` and `.ps1` — the precedent for §5 |
| `diagnosing-bugs` | `developers` | overlaps a Claude-side skill the user already has; kept because Copilot has no equivalent |
| `writing-great-skills` | `shared` | meta: the tool for maintaining this catalog |
| `azure-reviewer` | `developers` | second consumer of `ado-credentials`, and therefore the proof that it belongs in `shared` |
| `qa-ado-work-item-assistant` | split, below | |

### 9.1 Splitting the QA assistant

Its first-run gate, credential setup and PAT retrieval are not QA logic — they are a
dependency check that any Azure DevOps capability needs.

| Part | Destination |
|---|---|
| first-run gate, credential setup, PAT retrieval, the shared helpers they use | new preflight skill `ado-credentials` |
| evidence ledger, duplicate search, parent validation, approval gate, hash-bound publication, read-back | stays, as the work-item skill |

`ado-credentials` starts in `qa` and moves to `shared` when `azure-reviewer` claims
it — by the build's instruction (§3.1), not by a guess made now.

**Open (§13.3).** It is currently Windows and PowerShell only.

---

## 10. Adapters

Per-target install logic lives in adapters and nowhere else. A skill author writes
one `SKILL.md` and never thinks about targets.

An adapter separates **what would be written** from **writing it**. The first is a
pure function and is what tests assert against; an adapter implementing only the
second is untestable.

Three behaviours are load-bearing and fail silently when broken:

- **The whole unit travels.** Every file the unit ships, not only its entry
  document. A body that says "run `scripts/foo.sh`" is a promise the install keeps.
- **File modes survive the copy.** A helper script installed non-executable fails at
  runtime with a permission error.
- **Managed blocks are idempotent.** Where an adapter writes into a file the user
  also owns, it rewrites only its own delimited block.

---

## 11. Invariants

Machine-checked; the build fails or warns loudly on each.

1. A unit's declared `name` equals its folder or file name.
2. Every unit has a `name` and a `description`.
3. A unit directory is self-contained: no reference outside itself.
4. Nothing under `skills/`, `agents/` or `workflows/` sits outside an owner or
   lifecycle folder.
5. Promoted units appear in every generated artifact; unpromoted units appear in
   none.
6. Every name in `requires:`, in an agent's `skills:`, and in a bundle resolves.
7. A bundle naming a unit also names that unit's requirements.
8. A unit in `shared` is claimed by bundles of two or more audiences; a unit outside
   `shared` is claimed by at most one audience (§3.1).
9. The release version moves on every user-visible change.
10. No secret appears in any file the catalog ships or writes.
11. Every eval group names a unit that ships, and every hook has a source, both script
    twins, and a contract fixture.

---

## 12. Testing

Deterministic, offline, no network and no model calls: adapter output, manifest
generation, receipt and update logic, the `shared` rule, dependency resolution,
memory file parsing and the reconciliation arithmetic. Hooks belong here too: each one
declares a contract fixture, and the suite runs its scenarios through every platform's
generated command, so the two CLIs cannot drift apart.

Behaviour is measured separately, by experiment. `evals/` holds cases in the documented
`claude plugin eval` format; Claude runs them through that command and a Node runner reads
the same files for Copilot. A run compares two versions of the catalog on identical cases
and reports a verdict — better, worse, not worse, not proven — rather than a score in
isolation, because a score says nothing about whether a change helped. Four tiers keep the
cost honest: static description budget (no model calls), trigger cases, the cases a change
can reach, and the full suite. A change to a skill's `description` is a behaviour change,
not a documentation change, because the description is the trigger.

Isolation is the fourth thing a run has to be honest about, and it is decided per target rather
than per case, because the two CLIs do not start level. The native Claude command sandboxes shell
tools at the OS level and honours the case's own tool grants; the Copilot CLI has to be launched
with every tool and every path allowed, so a throwaway home and working directory are otherwise
all that separates a case from the machine running it. An optional container closes that gap:
where a runtime exists, every Copilot run goes inside it, and a case may additionally demand one
on both arms. Where none exists the run says so — a demanded case is skipped and the Copilot arm
is downgraded, both named in the record — because a fingerprint that claims isolation it did not
get is worse than one that admits the downgrade.

Three properties make a verdict worth trusting, and each costs something. Both arms run the
**same cases** — the candidate's suite is copied over the base checkout — so a difference can
only come from the catalog. A rate-limited, unauthenticated or budget-truncated run is
**invalid, not failed**: counted separately and excluded, because otherwise a provider's bad
afternoon reads as a regression. And the statistic is **seeded**, so the same records always
yield the same interval; models are pinned by full id for the same reason. The rule that turns
the interval into a word is a policy choice, kept in one pure function with its thresholds in
`evals/eval.config.json`, so changing the standard of proof is a visible, reviewable edit
rather than a scattered set of constants.

---

## 13. Open questions

**13.1 The workflow format.** §2.3 defines a workflow a human and an agent can
follow, not an execution format. Whether it ever needs to become one is unanswered,
and nothing should be built on the assumption that it will.

**13.2 Copilot is unmeasured.** Every behavioural claim in this document about how
an agent reacts to memory has been demonstrated on Claude and not on Copilot.
Copilot is the primary tool here. The first verification after the first build
therefore runs on Copilot, not on Claude — and the surrounding evidence gives a
concrete reason to check rather than assume: in a published cross-agent comparison
the GPT-family row was the weakest, on exactly the behaviour this design depends
on, which is an agent exercising restraint instead of doing what the prompt
literally said. That comparison used a different harness and different routing, so
it is a reason to measure, not a conclusion.

**13.3 `ado-credentials` on non-Windows.** Either it gains a shell twin, following
the precedent already set by `safety-ssh`, or its description states Windows-only
plainly. Not both, and not neither.

**13.4 The memory folder's name.** A leading dot keeps it out of the way at the
project root; a plain name keeps it visible to people who should know it exists.

**13.5 Where the Copilot pointer goes.** Copilot reads more than one entry-point
file. Until it is verified which one it honours in the installed configuration,
`memory-init` writes to both; a redundant pointer costs nothing, a missing one
costs everything.

---

## 14. What is deliberately not here

- **A work tracker.** Memory lives in the repository. Nothing in this design
  requires a board, and nothing should acquire that requirement without a new
  decision.
- **A database, a service, a daemon, an index to rebuild.** Markdown under git is
  the store. Anything derived must be rebuildable from it and must never be the
  thing that is trusted.
- **A second memory store to mirror into.** One store, chosen once.
- **The author of a decision.** Git has it.

---

## 15. Decisions taken at implementation

Where §13 leaves a question open or silent, this is what was built, and why.

| Question | Decision |
|---|---|
| Targets | `claude`, `copilot` only. No Codex adapter (§1: a third target is one adapter file later). If one is ever added, note that Codex CLI caps its `AGENTS.md` chain at 32 KiB and silently truncates past it (`coding-agent-platforms` reference) — keep this file's growth in view. |
| Copilot layout | §7.1: local `.github/skills/<name>/`, global `~/.copilot/skills/<name>/`. Agents: local `.github/agents/<name>.agent.md`, global `~/.copilot/agents/<name>.agent.md`. Copilot reads the same Agent Skills `SKILL.md` format as Claude, so the tree is copied verbatim; `invocation: user` becomes `disable-model-invocation: true` on Claude only — on Copilot the flag would hide the skill from `/name` too, so it is omitted there. |
| Workflow install | A workflow is installed on both targets as a **user-invoked skill** (`<skills>/<name>/SKILL.md`) rendered from the workflow file (§2.3: readable list, not an execution format). Workflows do not appear in the Claude plugin manifest (the plugin path is a convenience, not the contract). |
| Unit version (§7.2) | A 12-hex content fingerprint over the unit's files, computed by the build and published in `catalog.json`. |
| Receipt location (§7.2) | `<base>/.engineering-catalog/receipt.json` where `<base>` is the project dir (local) or `~` (global). Records `bundles` too, so `update` can re-plan. |
| Memory folder (§13.4) | `memory/` at the project root, overridable with `--dir`. |
| Canonical instruction file (§13.5) | `AGENTS.md` is the contract, read natively by Copilot CLI, Codex CLI and Cursor. `CLAUDE.md` is a one-line `@AGENTS.md` import, because Claude Code does not auto-read `AGENTS.md`. `.github/copilot-instructions.md` carries its own `@../AGENTS.md` import too — not load-bearing for Copilot CLI, which already reads `AGENTS.md` independently, but there for any other Copilot surface that reads only this file; `../` because Copilot resolves a `@` reference relative to the file containing it, not the repository root (`copilot-facts.md` §5.1, live-verified). `memory-init`'s pointer block (the small "Project memory" text, not this contract) still goes to all three of `CLAUDE.md`, `.github/copilot-instructions.md` and `AGENTS.md`, because that script is a generic product feature for consumer projects that mostly do not share this repository's own `@AGENTS.md`-import layout. Managed block markers `<!-- engineering-catalog:memory:start -->` / `<!-- engineering-catalog:memory:end -->`. |
| `ado-credentials` on non-Windows (§13.3) | Shell twin: `check.ps1` (DPAPI PAT + REST probe, Windows) and `check.sh` (`az` login + `azure-devops` extension, any OS). Description says both plainly. |
| Bundle audience | The bundle's `name` when it is one of the audience folders; otherwise a required `"audience"` field. |
| CLI | bin `engcat`; commands `install`, `update`, `status`, `check`, `list`. Scope defaults to **global** (§7.1). |
| Freshness check (§7.4) | Skill `catalog-freshness` (shared, model-invoked) with `scripts/check-freshness.sh` / `.ps1` that read the receipt, compare against `git ls-remote --tags`, and remember the last check in `~/.engineering-catalog/freshness.json`. A Claude plugin `SessionStart` hook (`hooks/hooks.json`, hand-written) and a generated Copilot `sessionStart` hook (`.copilot-plugin/hooks.json`) call the same script (§7.1: hooks ship with the plugin). Copilot runs plugin hooks with cwd = plugin root and exports `COPILOT_PLUGIN_ROOT` / `COPILOT_PROJECT_DIR` (verified on copilot 1.0.83), so the generated command steps into the project dir before running the script. |
| Skill helper scripts in Node | Acceptable: the catalog is installed with `npx`, so Node exists on every machine that has it. |
| Unit names | Unique across all kinds (skill/agent/workflow), so a workflow can be installed as a skill without collision. |
| Frontmatter | One level deep; lists of scalars and lists of single-key maps are the only nested shapes. |
| Agent `model:` | A string (the same hint everywhere) or a map keyed by target (`claude:` accepts `opus\|sonnet\|haiku\|inherit`, `copilot:` a Copilot CLI model id). `catalog.json` keeps it as written; adapters emit `model:` only where a value exists for their platform. |
| Eval case format | The documented `claude plugin eval` format, so Claude runs the suite natively and the Copilot runner reads the same files. Cases live in a root `evals/`, not inside skill directories: the native command reads one eval directory, agents and workflows are single files with nowhere to put cases, scenarios belong to no single unit, and cases inside a skill used to ship to users. |
| Eval models | Cheap models where the catalog's effect has room to show: trigger cases on `claude-haiku-4-5` (effort low) and `gpt-5-mini`, behaviour cases on `claude-sonnet-5` (effort medium) and `gpt-5.4`; one judge for both CLIs, `claude-opus-5` (effort high). Copilot's list is what this organization's Copilot Business policy allows — Anthropic, Google, xAI and gpt-5.5/5.6 models are refused by the server. Pinned in `evals/eval.config.json`. |
| Hook manifests | Generated from one source per hook (§7.1), so a new hook needs no code change and cannot exist on one platform by accident. |
| Version A vs B | Ours, not the native runner's. `claude plugin eval --ablation` compares plugin-on with plugin-off; `npm run eval -- compare` compares two checkouts of the catalog, which is the question this repository actually asks. Every invocation therefore pins `--ablation none` and the arms are two worktrees. |
| The verdict rule | `decideVerdict(summary, config)`: first match wins — invalid share or a cut-short cell (zero case rows below `minCases`) is Invalid; a hard regression or a CI entirely below zero is Worse; entirely above zero is Better; a lower bound clearing `-δ` is Not worse; otherwise Not proven, with per-case drops ≥ 0.67 flagged below `minCases`. Guardrails (cost/duration ratio, rising false-trigger rate) report beside the verdict without changing it. |
| The Copilot arm | `scripts/eval/copilot.js` installs the catalog into a fake `HOME` via `lib/install.js` directly (no CLI, no `--plugin-dir` — confirmed not to load plugin skills), once per arm and reused across every case/run of that arm. `gh auth token` is captured once, in the real environment, before any fake `HOME` exists. `graders.js` is the pure grading engine Claude gets for free natively; `judge.js` calls headless `claude -p` for `llm`/`baseline` graders on **both** targets — one judge, pinned in `eval.config.json`, never Copilot's own CLI. An agent fires through `Task` with `subagent_type: "<plugin>:<agent-name>"`, the same namespacing `Skill` uses. |
| Container isolation | Per arm, not per case, and optional — some engineers have neither docker nor podman. The two arms differ in what they already have: `claude plugin eval` sandboxes shell tools at OS level and honours a case's `allowed_tools`, while `copilot` runs `--allow-all-tools --allow-all-paths`. So the Copilot arm is containerized on every run when a runtime exists, and the Claude arm only for a case tagged `isolation:container` (which then never runs on the host on either arm). `scripts/eval/isolation.js` detects podman before docker and wraps a command to run inside `evals/container/Containerfile`'s image (both CLIs installed there). No runtime: under `auto`/`off` a tagged case is skipped and the Copilot arm downgrades to the host, each with a named reason; under `required` either is a hard failure. Only the case's own CLI call is containerized — a credential safelist plus the Copilot run's own `HOME`/`COPILOT_HOME`, never the full host env — and the judge always runs on the host. |

### 15.1 Why `AGENTS.md`, not `CLAUDE.md`

`AGENTS.md` is read natively by Copilot CLI, Codex CLI and Cursor. Claude Code reads only
`CLAUDE.md`, so `CLAUDE.md` is kept as a one-line `@AGENTS.md` import — that is its entire
content. Copilot CLI additionally reads `CLAUDE.md` directly and merges it with `AGENTS.md`
(verified live, `copilot-facts.md` §5), with no precedence order, so nothing in `AGENTS.md`
needs duplicating into `CLAUDE.md` by hand. `npm run check` does not enforce that split — it
is prose, not a generated artifact — so review keeps it true.

`AGENTS.md`'s claim of being "read natively by Codex CLI" is a statement about Codex's own
AGENTS.md convention, not a guarantee this file fits inside it: Codex truncates its AGENTS.md
chain at 32 KiB silently, and no Codex adapter ships (rejected, `e-20260915-3f9e`) — so this
file's size is tuned to Claude Code's and Copilot CLI's documented thresholds, not Codex's.

### 15.2 Why the `shared` folder rule is derived, not chosen

A unit belongs in `shared` when, and only when, bundles of two or more different audiences
name it — never a manual editorial call. This keeps ownership answerable from the bundles
alone, with no separate "is this shared" judgment to keep in sync by hand as bundles change.

### 15.3 Why hooks may inform but never enforce

Copilot loses **all** of a `SessionStart` message when two hooks answer the same event with
`additionalContext` — both payloads run and log, neither reaches the model
(`copilot-facts.md` §6.5). The second hook is usually not this catalog's own; it belongs to
whatever repository the catalog installs into, which this catalog cannot know in advance.
Hence the rule: a hook may inform, must never enforce, and nothing may depend on a session
message actually being read.

### 15.4 Why eval isolation is decided per arm, not per case

The two eval arms do not start level: `claude plugin eval` sandboxes shell tools at the OS
level itself and honours a case's `allowed_tools`; `copilot` is launched with
`--allow-all-tools --allow-all-paths --no-ask-user` and has nothing but a throwaway `HOME`
and workdir between a case and the machine. Containerizing only the weaker arm (Copilot,
always) rather than deciding per case keeps the comparison apples-to-apples without paying
container overhead on the arm that doesn't need it.
