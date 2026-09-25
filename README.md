# AI Engineering Catalog

Skills, agents and workflows for GitHub Copilot and Claude Code, installed once, shared by
the team. Same behaviour in every assistant, one project memory, safe Azure DevOps access.
Long version: [USER-GUIDE.md](USER-GUIDE.md). Changing the catalog:
[CONTRIBUTING.md](CONTRIBUTING.md) for the process, [AGENTS.md](AGENTS.md) for the rules.

## Install

Needs Node 20+, Git, access to this repository, and Copilot CLI or Claude Code.
**Recommended: everything, globally, for both tools** — one command, done:

```
npx git+https://github.com/krukovden/engineering-catalog install --bundle all --target both
```

| Only what my role needs | Command |
|---|---|
| developer | `npx git+…/engineering-catalog install --bundle developers --target both` |
| tester | `npx git+…/engineering-catalog install --bundle qa --target both` |
| product | `npx git+…/engineering-catalog install --bundle product --target both` |
| ops | `npx git+…/engineering-catalog install --bundle ops --target both` |
| ask me | `npx git+…/engineering-catalog install` — Enter at every question gives the recommended answer |

`…` is always `https://github.com/krukovden/engineering-catalog`. `--target claude` or
`copilot` for one tool; `--local` to install into the current project only.

| Later | Command |
|---|---|
| what is installed? | `npx git+…/engineering-catalog status` |
| update | `npx git+…/engineering-catalog update` — asks before touching a file you edited (`--keep-local` / `--overwrite` answer for all) |
| newer version? | `npx git+…/engineering-catalog check` — the assistant also tells you once a week |
| everything in the catalog | `npx git+…/engineering-catalog list` |

### Or install it as a plugin

The `npx` commands above copy the units into your machine and write a receipt. The plugin path
instead leaves the catalog where it is and lets the assistant load it — useful when you want the
catalog in *someone else's* repository without adding files to it. It installs every audience's
skills and agents at once, unlike `npx … install`, which lets you scope to one bundle — there is
no bundle picker on the plugin path.

```
# Copilot CLI
copilot plugin marketplace add https://github.com/krukovden/engineering-catalog
copilot plugin install engineering-catalog@engineering-catalog

# Claude Code
/plugin marketplace add https://github.com/krukovden/engineering-catalog
/plugin install engineering-catalog@engineering-catalog
```

Write the Azure DevOps URL **without** a `.git` suffix — Claude Code clones any URL whose path
contains `/_git/`, and appending `.git` makes the clone fail.

To hand a whole team the marketplace without each person adding it, commit this to the repository
they work in — Claude Code adds it for anyone who trusts the folder:

```json
{
  "extraKnownMarketplaces": {
    "engineering-catalog": {
      "source": { "source": "url", "url": "https://github.com/krukovden/engineering-catalog" }
    }
  },
  "enabledPlugins": { "engineering-catalog@engineering-catalog": true }
}
```

Two things that setting does **not** do, both by design on Claude Code's side:

- It does not install. A plugin from an external source that only project settings enable stays
  uninstalled until each person runs `claude plugin install engineering-catalog@engineering-catalog`
  once. Claude Code names the command when it reports the plugin as missing.
- It does not keep it current. Auto-update is off by default for marketplaces that are not
  Anthropic's; turn it on per marketplace in `/plugin`, or run `claude plugin update`.

Copilot CLI has no repository-level equivalent — plugins and marketplaces are per person, in
`~/.copilot/config.json`. The two commands above are the whole story there. It will also install
from a bare repository URL with no marketplace, but that form prints a deprecation warning
("only `plugin@marketplace` installs will be supported in a future release"), so use the
marketplace.

The weekly "a newer version exists" reminder only reaches installs made with `npx …` — it reads the
receipt those write, and a plugin install writes none.

## How it works — three rules

1. **Skills load themselves.** You never call a skill. You describe the task in plain words; the assistant recognises it and follows the skill.
2. **A few things you start by typing `/name`** — either once, to set something up (`/memory-init`), or to run a full procedure step by step instead of a quick answer (`/observation-to-work-item …`). Same spelling in Copilot and in Claude Code.
3. **Agents are separate workers you launch for a big job** and get a short result back. Copilot: `copilot --agent NAME -p "…"` (or `/agent NAME` in a session). Claude Code: say "use the NAME agent to …".

## Skills that work by themselves

Say it the way you would to a colleague; the skill in the middle column loads on its own.

**Developer**

| You say | Skill | Agent | What happens |
|---|---|---|---|
| "start task 103520" | `ado-branch` | — | reads the work item in Azure DevOps, creates `feature/ADO-103520-<title>` (or `bug/ADO-…`) from `main`, switches to it |
| "commit this" | `commit` | — | reads the repository's own commit convention from its history (conventional commits when there is none), groups the changes into one commit per change, by hunk where a file mixes two, drafts each message from the diff, cleans it with `unslop`, shows which files and hunks go into which commit with every message, commits only after your yes; never pushes, never amends |
| "code is done, prepare the pull request" | `ado-pull-request` | `code-reviewer` (offered) | reads what really changed against `main`, writes the release-note lines (`feat(103520): …` / `fix(103533): …`, first line = PR title), cleans the wording with `unslop`, asks "run a code review first?" — yes: the reviewer reports findings with file:line, you fix or accept; no: carries on — then, after your yes, creates the PR: squash, work item linked, branch deleted |
| "review my branch" | `pr-review` | `code-reviewer` | the same review on its own, without a PR |
| "diagnose why this test fails every third run" | `diagnosing-bugs` | — | reproduces the failure in a tight loop first, theorises only after it is red |
| "grill my migration plan" | `grilling` | — | one question at a time until the plan holds |
| "unslop this README" | `unslop` | — | rewrites the text without AI tells, meaning and tone kept; `commit` and `ado-pull-request` run it on their own drafts |
| "create a PBI for …", anything in Azure DevOps | `ado-credentials` first | — | checks access; `absent` → shows the steps and asks *1 — you do it / 2 — I do it for you* |

**Tester**

| You say | Skill | What it does |
|---|---|---|
| "file this bug in Azure DevOps: the export gives an empty file" | `qa-ado-work-item` | checks the code and the board, drafts, publishes only after your explicit yes |
| "is the empty export already on the board?" | `qa-ado-work-item` | searches, answers, files nothing |
| "pressure-test this test plan" | `grilling` | one question at a time |
| "unslop this bug report" | `unslop` | rewrites the text without AI tells, meaning and tone kept |

**Product**

| You say | Skill | What it does |
|---|---|---|
| "grill this feature idea" | `grilling` | walks the decision tree with you before anything is built |
| "unslop this announcement" | `unslop` | rewrites the text without AI tells, meaning and tone kept |

**Ops**

| You say | Skill | What it does |
|---|---|---|
| "ssh to staging and restart nginx" | `safety-ssh` | works through a named connection; no passwords, hosts or IPs in chat |

**Everyone, silently:** `catalog-freshness` checks once a week whether the catalog is outdated and says so; `memory` reads the project's memory (see below). You do nothing for either.

## Things you type

| Type | Does | Who |
|---|---|---|
| `/memory-init` | turns project memory on in this repository (once) | everyone |
| `/observation-to-work-item what you saw` | full QA procedure: access check → triage → draft → your yes → publish once → read back | tester |
| `/writing-great-skills` | how to write a skill for this catalog | developer, product |

## Agents

| Agent | Launch — Copilot / Claude | When |
|---|---|---|
| `qa-triage` | `copilot --agent qa-triage -p "the export gives an empty file"` / "use the qa-triage agent on: …" | not sure it is a bug: sorts confirmed / reported / inferred, finds duplicates, files nothing |
| `code-reviewer` | `copilot --agent code-reviewer -p "review main...HEAD"` / "use the code-reviewer agent on main...HEAD" | a second pair of eyes on a different model: correctness, security, SOLID / KISS / YAGNI, file size, tests — never edits |

Marketplace installs name agents `engineering-catalog:<name>`.

## Project memory

**What it is.** A `memory/` folder in the repository that every assistant reads before it
proposes anything: what the project is, how it is built, and — most important — what the team
already **rejected** and why. The point: a rejected idea is not proposed a second time, and
work from Copilot and from Claude lands in the same memory. It travels with the repo.

**It is off until you turn it on.** Once per project, in the repository root:

```
/memory-init
```

That creates `memory/index.md` and `memory/units/`, points both assistants at it, and installs a
tiny git hook. Commit the `memory/` folder with your code. Run it again any time — it only adds
what is missing.

**After that, nothing to do.**

- Every session starts by reading `memory/index.md`.
- Ask for something under *Rejected at project level* and the assistant stops, quotes the reason,
  and asks "overturn it?" — it changes nothing until you say yes.
- A memory entry is written only for a decision that is hard to reverse **and** not obvious
  **and** a real trade-off. Refactors, formatting, code that follows an old decision: no entry.
- Every commit (from any tool or person) is queued in `memory/.pending`; the assistant drains that
  queue before it reports a task done, so memory keeps up with the code by itself.

## Azure DevOps, first time

Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\.copilot\skills\ado-credentials\scripts\setup.ps1"`
(the PAT goes into its masked prompt, never into chat; scopes *Code Read* + *Work Items Read & write*),
then `…\qa-ado-work-item\scripts\setup-workspace.ps1` for repositories. macOS/Linux: `az login`
then `az extension add --name azure-devops`. Replace `.copilot` with `.claude` for a Claude-only install.
Or just ask for the Azure DevOps task — the assistant detects the missing access and offers to set it up.

## If something goes wrong

| Symptom | Do |
|---|---|
| `npx: command not found` | install Node 20+ from nodejs.org |
| `update` says a file was edited locally | `y` takes the catalog's version, `n` keeps yours |
| "not installed here" | run `install` (global) or `install --local` in this project |
| access check says `expired` | new PAT → rerun `setup.ps1` (Windows) or `az login` |
| memory fell behind the code (commits made by hand, by a colleague, or a session that never finished) | tell the assistant "catch memory up with `memory/.pending`" — it reads what was missed |

Predecessor: [krukovden/skill-catalog](https://github.com/krukovden/skill-catalog).

## Catalog

Generated by `npm run build` — do not edit between the markers.

<!-- catalog:start -->

### Skills

| Name | Owner | Invocation | Description |
|---|---|---|---|
| [ado-credentials](skills/shared/ado-credentials/SKILL.md) | shared | model | Preflight for Azure DevOps access — answers whether a credential is present, whether it still works against the organization, and exactly what to do if not. Run it first, then continue with the skill that needs Azure DevOps (for example qa-ado-work-item to file a bug); that skill starts only after this one answers ok. On Windows it checks the DPAPI-protected PAT written by its setup script; on macOS/Linux it checks the az CLI login and the azure-devops extension. |
| [catalog-freshness](skills/shared/catalog-freshness/SKILL.md) | shared | model | Once per session, before other work, check whether the installed engineering catalog is outdated — run the freshness script (it is cheap, needs only git, and stays silent when nothing is due) and relay its one-line hint to the user if it prints one. Applies to every project where the catalog is installed, on Claude Code and on GitHub Copilot alike. |
| [grilling](skills/shared/grilling/SKILL.md) | shared | model | Grill the user relentlessly about a plan, decision, or idea before any of it gets built — walk the decision tree one question at a time until there is shared understanding. Use when the user wants to stress-test their thinking, says "grill me", asks to sharpen or pressure-test a plan, or is about to start building something whose requirements are still fuzzy. |
| [memory](skills/shared/memory/SKILL.md) | shared | model | Project memory for every session — read the project's memory/index.md before proposing anything, load a unit file when work touches it, and write an entry only when a change is hard to reverse, not obvious without context, and the result of a real trade-off. Use when starting work in a project that has a memory folder, when about to propose an approach, and after a decision that meets the three-part test. |
| [memory-init](skills/shared/memory-init/SKILL.md) | shared | user | Initialise project memory in this repository — choose the store, create the memory folder and index, point Claude and Copilot at it, install the post-commit hook, then fill the index from the code with honest evidence grades. Run once per project; safe to run again. |
| [unslop](skills/shared/unslop/SKILL.md) | shared | model | Cut AI tells from any writing — scan for the listed patterns, rewrite with meaning and tone kept, self-audit. Use when the user says "unslop this", "remove the AI tells", "make this sound less like AI", or when another skill hands over a text it has drafted, such as a commit message or a PR description. |
| [writing-great-skills](skills/shared/writing-great-skills/SKILL.md) | shared | user | Reference for authoring and pruning skills. |
| [ado-branch](skills/developers/ado-branch/SKILL.md) | developers | model | Start a task on a correctly named branch — read the Azure DevOps work item and create feature/ADO-<id>-<title>, or bug/ADO-<id>-<title> for a Bug, from main. Use when the user says "start task 12345", "create a branch for bug …", "branch for work item …", or begins work on a work item without a branch. |
| [ado-pull-request](skills/developers/ado-pull-request/SKILL.md) | developers | model | Finish a task with a pull request whose title and description feed the release notes — feat(<id>)/fix(<id>)/bug(<id>) lines written from the real diff, review offered, squash merge into main. Use when the user says "prepare the PR", "create a pull request", "the code is done", or is about to push a finished branch. |
| [commit](skills/developers/commit/SKILL.md) | developers | model | Commit the current changes as one commit per change — split by hunk when a file carries parts of two — each with a message that follows this repository's own convention, read from its history, conventional commits when there is none, built from the diff, cleaned of AI tells, and created only after the user has reviewed which files go into which commit, read every message, and said yes. Use when the user says "commit this", "commit my changes", "write a commit message", or has finished a change and wants it recorded. |
| [diagnosing-bugs](skills/developers/diagnosing-bugs/SKILL.md) | developers | model | Diagnosis loop for hard bugs and performance regressions — refuses to theorise until a tight feedback loop already goes red on this bug. Use when the user says "diagnose" or "debug this", or reports something broken, throwing, failing, flaky, or slow. |
| [pr-review](skills/developers/pr-review/SKILL.md) | developers | model | Review a branch or pull request before it is opened or merged — collect the diff, launch the code-reviewer agent on a different model, and turn its findings into a short list to fix or accept. Use when the user says "review my branch", "review this PR", "check this before I open a PR", or is about to create a pull request. |
| [qa-ado-work-item](skills/qa/qa-ado-work-item/SKILL.md) | qa | model | Turn a tester's observation into a fact-checked Azure DevOps Bug, Task, Product Backlog Item or Feature — gather evidence from the repositories and the board first, then draft, then publish only what the user explicitly approved. Use when the user reports a defect or unexpected behaviour, asks to create or file a bug/task/PBI/feature in Azure DevOps, asks whether something is already on the board, or wants a QA observation checked against the code. |
| [safety-ssh](skills/ops/safety-ssh/SKILL.md) | ops | model | Safe, credential-free SSH to remote servers — the assistant works only through a named connection and never sees or types passwords, usernames, hostnames, or IPs. Use this skill to actually carry out any task that lives on another machine — a server, box, host, VM, instance, prod/staging environment, build or CI agent, database server, or jump/bastion host. If fulfilling the request means logging in over SSH and doing something there — restart or bounce a service, deploy, prune docker images, dump a schema, free up disk, tail or grep remote logs, run df/du/systemctl — this is the skill, and it is the required path for doing it. Treat these as triggers: "ssh into…", "log into…", "connect to my server and…", "hop to the internal host and…", a pasted `ssh user@host`, a bare IP, or an offered SSH password/key/.env secret. Not for local-only SSH: making keys, git publickey errors, explaining ssh flags or agent forwarding, passphrases, or local rsync. |

### Agents

| Name | Owner | Description |
|---|---|---|
| [memory-writer](agents/shared/memory-writer.md) | shared | Drains the project's unrecorded-commit queue into memory entries, in isolation, so the working session spends no context on it. Use after a batch of commits, at the end of a task, or when reconcile.js reports commits memory has not caught up with. |
| [code-reviewer](agents/developers/code-reviewer.md) | developers | Independent code review of a branch or pull request on a different model than the one that wrote the code — a rubber duck that reads the diff, verifies claims against the code, and returns findings with file:line and severity. Use before opening a pull request, when asked to review a branch or PR, or when a change feels too big to trust. |
| [qa-triage](agents/qa/qa-triage.md) | qa | Triages a tester's observation before anything is filed — separates confirmed from reported from inferred, checks the board for duplicates, and decides whether it is a bug, a backlog item, or a question. Use when a tester describes unexpected behaviour and it is not yet clear what, if anything, should be filed. |

### Workflows

| Name | Owner | Steps | Description |
|---|---|---|---|
| [observation-to-work-item](workflows/qa/observation-to-work-item.md) | qa | skill:ado-credentials → agent:qa-triage → skill:qa-ado-work-item | From a tester's observation to an approved Azure DevOps work item — preflight the credential, triage the observation, draft, get explicit approval, publish once and read it back. |

### Bundles

| Bundle | Audience | Skills | Agents | Workflows |
|---|---|---|---|---|
| [developers](bundles/developers.json) | developers | grilling, writing-great-skills, unslop, diagnosing-bugs, pr-review, ado-credentials, ado-branch, ado-pull-request, commit, catalog-freshness, memory, memory-init | memory-writer, code-reviewer |  |
| [ops](bundles/ops.json) | ops | safety-ssh, catalog-freshness, memory, memory-init | memory-writer |  |
| [product](bundles/product.json) | product | grilling, writing-great-skills, unslop, catalog-freshness, memory, memory-init | memory-writer |  |
| [qa](bundles/qa.json) | qa | grilling, unslop, ado-credentials, qa-ado-work-item, catalog-freshness, memory, memory-init | qa-triage, memory-writer | observation-to-work-item |

<!-- catalog:end -->
