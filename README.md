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
skills, agents and workflows at once, unlike `npx … install`, which lets you scope to one bundle — there is
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
| "I need to add CSV export to the report page" (no id) | `ado-backlog-placement` | — | asks first whether to look on the board, confirms org / project / team, shows open items that look the same, ranks the Features it could sit under (every score part shown), offers to create a Feature when none fits, drafts the PBI and creates it only after your yes to that exact draft; `ado-branch` then branches from the new id |
| "commit this" | `commit` | — | reads the repository's own commit convention from its history (conventional commits when there is none), groups the changes into one commit per change, by hunk where a file mixes two, drafts each message from the diff, cleans it with `unslop`, shows which files and hunks go into which commit with every message, commits only after your yes; never pushes, never amends |
| "code is done, prepare the pull request" | `ado-pull-request` | `code-reviewer` (offered) | reads what really changed against `main`, writes the release-note lines (`feat(103520): …` / `fix(103533): …`, first line = PR title), cleans the wording with `unslop`, asks "run a code review first?" — yes: the reviewer reports findings with file:line, you fix or accept; no: carries on — then, after your yes, creates the PR: squash, work item linked, branch deleted |
| "review my branch" | `pr-review` | `code-reviewer` | the same review on its own, without a PR |
| "address the PR comments", "CI is red on my PR" | `ado-pr-feedback` | — | sorts every comment against the current code, fixes what is valid, commits, then sets each thread's status only after your yes; for a red build it pulls the failing step's log |
| "sync with main", "how far behind am I", "clean up merged branches" | `git-sync` | — | merges the base in, resolves the obvious conflicts and asks about the rest; reports how far behind the branch is; deletes branches already squash-merged |
| "move 103520 to doing", "sync the board" | `ado-board` | — | moves the work item forward only on evidence (branch, PR, merge); `reconcile` compares the board with branches and completed PRs, dry run first. Run `states discover` once per project |
| "search Warehouse, Reports and Sidecar for the export timeout", "did this change recently?" | `project-workspace` | — | searches the latest version on the server of each repository you name, code and recent changes in one answer; uses your own project folders where you have them and never touches your branch or unsaved work; asks once before downloading anything missing |
| "diagnose why this test fails every third run" | `diagnosing-bugs` | — | reproduces the failure in a tight loop first, theorises only after it is red |
| "grill my migration plan" | `grilling` | — | one question at a time until the plan holds |
| "unslop this README" | `unslop` | — | rewrites the text without AI tells, meaning and tone kept; `commit` and `ado-pull-request` run it on their own drafts |
| "create a PBI for …", anything in Azure DevOps | `ado-credentials` first | — | checks access; `absent` → shows the steps and asks *1 — you do it / 2 — I do it for you* |

**Guard (Claude Code):** a `git commit` straight on `main`/`master` of an Azure Repos repository is
refused with the reason and the command to run instead (`git switch -c feature/…`). Work on a
branch and nothing changes. The guard never blocks anything when it cannot decide.

**Tester**

| You say | Skill | What it does |
|---|---|---|
| "file this bug in Azure DevOps: the export gives an empty file" | `qa-ado-work-item` | checks the code and the board, drafts, publishes only after your explicit yes |
| "is the empty export already on the board?" | `qa-ado-work-item` | searches, answers, files nothing |
| "find where the empty export breaks in Warehouse, Reports and Sidecar" | `project-workspace` | searches all of them at once, read-only, and shows each place and each recent change; asks once before downloading a project that is not on your computer, and says when a project could not be checked |
| "pressure-test this test plan" | `grilling` | one question at a time |
| "unslop this bug report" | `unslop` | rewrites the text without AI tells, meaning and tone kept |

**Product**

| You say | Skill | What it does |
|---|---|---|
| "grill this feature idea" | `grilling` | walks the decision tree with you before anything is built |
| "put this idea on the board", "where does this belong?" | `ado-backlog-placement` | checks for an existing item, ranks the open Features it could sit under, offers a new Feature when none fits, creates the PBI only after your yes to the exact draft |
| "which of our projects already has CSV export?" | `project-workspace` | searches the team's repositories, read-only, and answers which ones have it, where, and who changed it recently |
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
| `/onboard-project` | sets a repository up step by step: Azure DevOps access → memory → board states → branch-policy check → `catalog-doctor` | everyone |
| `/catalog-doctor` | checks this install and the repository wiring, names the next fix | everyone |
| `/catalog-feedback what went wrong` | drafts feedback about the catalog with version and platform attached; files it in Azure DevOps after your yes | everyone |

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

## For testers: Azure DevOps in Copilot

Windows, Copilot CLI. You never run a setup script: you talk to Copilot, it runs the scripts
and asks you to approve each command. macOS/Linux use `az login` and
`az extension add --name azure-devops` instead.

### Install and update

Close Copilot first: Windows will not move a folder Copilot has open. Then, in PowerShell:

```powershell
# first install, and also the move from the old qa-ado-work-item-assistant
npx -y git+https://github.com/krukovden/engineering-catalog install --bundle qa --target copilot

# later: pick up a newer catalog
npx -y git+https://github.com/krukovden/engineering-catalog update --global --target copilot

# what is installed, and which version
npx -y git+https://github.com/krukovden/engineering-catalog status --global
```

Coming from the old `qa-ado-work-item-assistant`: the same `install` moves the old skill out of
Copilot's sight (to `~\.engineering-catalog\legacy\<date>\`) and carries your stored PAT
and any old projects over. Nothing is deleted; the old settings folder is renamed
`.qa-ado-assistant.migrated-<date>`.

### First run

Open Copilot. If no project is connected yet, it says so in its first answer. Then:

```text
You:     Add a project. Board: https://dev.azure.com/Contoso/Platform/_boards/board/t/Driller%20Dashboard/Backlog%20items
         Code: https://dev.azure.com/Contoso/Platform/_git/MPD-Manager
         Call it MPD.
Copilot: Added MPD: Platform / Driller Dashboard, area Platform\Driller Dashboard,
         repository MPD-Manager cloned to C:\Users\<you>\QA-Workspaces\MPD. MPD is current.
```

If you have no token stored (or it expired), Copilot opens Notepad with an empty file and a
link to *User settings → Personal access tokens*. Create a token with **Code (Read)** and
**Work Items (Read & write)**, paste it into Notepad, save, close Notepad, and type `done`.
**Never paste a token into the chat.** If that happens, revoke it in Azure DevOps.

### Everyday phrases

| You say | What happens |
|---|---|
| "Which version of the engineering catalog is installed?" | the installed version and date, read from the install receipt |
| "Which projects are connected?" | a list: alias, project / team, board, code, which one is current |
| "Add a project" | Copilot asks for the board link, code links (optional), alias (optional) |
| "I work in MPD now" | MPD becomes the current project; new bugs go there |
| "Remove Orion" | forgets the project; cloned code stays on disk |
| "File a bug: Export hangs for 30 s on an empty table" | evidence, duplicate search, a draft naming the project and area; nothing is filed until you say yes |
| "My token expired" | the Notepad hand-over again; a token Azure DevOps rejects never replaces a working one |

### Which link to give

Any page of the project, copied from the browser address bar. Copilot reads the organization,
project and team from it, and takes the team's area as the default for new bugs.

| Link you have | Team taken from |
|---|---|
| `…/Platform/_boards/board/t/Driller%20Dashboard/Backlog%20items` (board) | the link |
| `…/Platform/_backlogs/backlog/Driller%20Dashboard/Features` (backlog: items, features, epics) | the link |
| `…/Platform/_sprints/taskboard/Driller%20Dashboard/…/Sprint_16` (sprint, capacity) | the link |
| `…/Platform/_workitems/edit/104382` (a work item, e.g. a feature) | the team whose area holds that item |
| `…/Platform` or a query link | the project's default team |

Code links: `…/Platform/_git/<repo>` with or without `?path=…`, a pull request link, the
clone URL (`https://Contoso@dev.azure.com/…`) or the SSH remote all work.

### Where the configuration lives

You do not edit these files; Copilot writes them. They are shown so you know what "connected"
means.

`%USERPROFILE%\.ado-credentials\config.json` — your projects, and which one is current:

```json
{
  "version": 1,
  "activeContext": "MPD",
  "contexts": [
    {
      "name": "MPD",
      "organization": "https://dev.azure.com/Contoso",
      "project": "Platform",
      "team": "Driller Dashboard",
      "areaPath": "Platform\\Driller Dashboard",
      "boardUrl": "https://dev.azure.com/Contoso/Platform/_boards/board/t/Driller%20Dashboard",
      "repositories": [
        { "name": "MPD-Manager", "project": "Platform", "remoteUrl": "https://Contoso@dev.azure.com/Contoso/Platform/_git/MPD-Manager" }
      ]
    }
  ]
}
```

`%USERPROFILE%\.qa-ado-work-item\config.json` — per project: where the code is cloned, the
default area, environments to check (`systems`), and the fields a draft may set:

```json
{
  "version": 1,
  "contexts": [
    {
      "name": "MPD",
      "workspaceRoot": "C:\\Users\\<you>\\QA-Workspaces\\MPD",
      "repositories": [ { "name": "MPD-Manager", "remoteUrl": "https://Contoso@dev.azure.com/Contoso/Platform/_git/MPD-Manager", "path": "C:\\Users\\<you>\\QA-Workspaces\\MPD\\MPD-Manager" } ],
      "systems": [ { "name": "Staging", "kind": "web", "url": "https://staging.example.local" } ],
      "defaults": { "workItemType": "Bug", "parentId": null, "areaPath": "Platform\\Driller Dashboard", "iterationPath": null }
    }
  ]
}
```

The token itself is `%USERPROFILE%\.ado-credentials\ado-pat.xml`, encrypted for your Windows
account; it does not work if copied to another user or machine.

### FAQ

**I already had projects set up the old way.** They keep working. "Which projects are
connected?" marks the ones without a board link: their bugs land in the project root, not on a
team board. Give Copilot the board link for that project and it completes it in place.

**Two teams in the same project?** Add each one with its own board link and alias, then switch
with "I work in …". Adding a project never changes the current one, except the very first.

**A project in another organization?** Add it the same way. The token must cover that
organization too: create it with *All accessible organizations*, or keep one project per
organization.

**The bug did not show up on our board.** The project has no board link (see the first
question), or the draft named another area. Every draft shows its project and area before you
approve it.

**The `npx` command printed nothing.** Run it again with `npx.cmd` instead of `npx`, and send a
screenshot of the whole window if it is still silent.

**Start over.** Close Copilot, delete `%USERPROFILE%\.ado-credentials` and
`%USERPROFILE%\.qa-ado-work-item`, open Copilot, and add the project again.

## If something goes wrong

| Symptom | Do |
|---|---|
| `npx: command not found` | install Node 20+ from nodejs.org |
| `update` says a file was edited locally | `y` takes the catalog's version, `n` keeps yours |
| "not installed here" | run `install` (global) or `install --local` in this project |
| access check says `expired` | Windows: tell Copilot "my token expired"; macOS/Linux: `az login` |
| something in the catalog does not fire, or you are not sure it is installed right | `/catalog-doctor` |
| "project state behind: run …" at session start | run the command it names (`/memory-init` or `ado-board states discover`); it is safe to repeat |
| memory fell behind the code (commits made by hand, by a colleague, or a session that never finished) | tell the assistant "catch memory up with `memory/.pending`" — it reads what was missed |

Predecessor: [krukovden/skill-catalog](https://github.com/krukovden/skill-catalog).

## Catalog

Generated by `npm run build` — do not edit between the markers.

<!-- catalog:start -->

### Skills

| Name | Owner | Invocation | Description |
|---|---|---|---|
| [ado-backlog-placement](skills/shared/ado-backlog-placement/SKILL.md) | shared | model | Find where a new task belongs on the Azure Boards backlog — check for an existing item, rank the open Features it could sit under, offer to create a Feature when none fits, then draft the PBI and create it only after an explicit yes. Optional; it asks first. Use when the user says "I need to do X" or "start working on X" with no work item id, "put this on the board", "where does this belong", or "create a PBI for …" without naming a parent. |
| [ado-board](skills/shared/ado-board/SKILL.md) | shared | model | Keep the Azure Boards card in step with the code — move a work item forward (todo → doing → testing → verify → done) on evidence, and reconcile the board with pushed branches and completed pull requests. Use when the user says "move 123 to doing", "mark the bug resolved", "sync the board", "reconcile the board", "which of my items have not moved", or a session line says items have not moved. Also run `states discover` once per project before the first move. |
| [ado-credentials](skills/shared/ado-credentials/SKILL.md) | shared | model | Preflight for Azure DevOps access — answers whether a credential is present, whether it still works against the organization, and exactly what to do if not. Run it first, then continue with the skill that needs Azure DevOps (for example qa-ado-work-item to file a bug); that skill starts only after this one answers ok. Also use when the user asks which Azure DevOps projects are connected, wants to add or remove a project (they give a board link and code links), says they now work in or want to switch to another project or team, or needs to enter or replace their PAT — on Windows all of it runs through this conversation, the user never runs a script. On macOS/Linux it proves the PAT in AZURE_DEVOPS_EXT_PAT when one is set, else the az CLI login and the azure-devops extension. |
| [catalog-doctor](skills/shared/catalog-doctor/SKILL.md) | shared | user | Runs only when asked — diagnose this engineering catalog install and repository wiring, report silent failure modes, and tell you the next fix. |
| [catalog-feedback](skills/shared/catalog-feedback/SKILL.md) | shared | user | Runs only when asked — draft and, after explicit approval, file Azure DevOps feedback about this catalog with the unit, receipt version and platform attached automatically. |
| [catalog-freshness](skills/shared/catalog-freshness/SKILL.md) | shared | model | Once per session, before other work, check whether the installed engineering catalog is outdated — run the freshness script (it is cheap, needs only git, and stays silent when nothing is due) and relay its one-line hint to the user if it prints one. Applies to every project where the catalog is installed, on Claude Code and on GitHub Copilot alike. Also use when the user asks which version of the engineering catalog is installed; then run the script with --version (-Version) and answer with the line it prints. |
| [grilling](skills/shared/grilling/SKILL.md) | shared | model | Grill the user relentlessly about a plan, decision, or idea before any of it gets built — walk the decision tree one question at a time until there is shared understanding. Use when the user wants to stress-test their thinking, says "grill me", asks to sharpen or pressure-test a plan, or is about to start building something whose requirements are still fuzzy. |
| [memory](skills/shared/memory/SKILL.md) | shared | model | Project memory for every session — read the project's memory/index.md before proposing anything, load a unit file when work touches it, and write an entry only when a change is hard to reverse, not obvious without context, and the result of a real trade-off. Use when starting work in a project that has a memory folder, when about to propose an approach, and after a decision that meets the three-part test. |
| [memory-init](skills/shared/memory-init/SKILL.md) | shared | user | Initialise project memory in this repository — choose the store, create the memory folder and index, point Claude and Copilot at it, install the post-commit hook, then fill the index from the code with honest evidence grades. Run once per project; safe to run again. |
| [project-workspace](skills/shared/project-workspace/SKILL.md) | shared | model | Search several of the team's repositories at once, read-only, and know where every repository lives on this computer. Use when the user says "find where this breaks", "search all our repositories", "which project has this code", "did this change recently", "check Warehouse, Reports and Sidecar", names more than one repository to look in, or another skill needs to look at code it does not have open. Not for one repository the user is already working in — search that one directly. |
| [unslop](skills/shared/unslop/SKILL.md) | shared | model | Cut AI tells from any writing — scan for the listed patterns, rewrite with meaning and tone kept, self-audit. Use when the user says "unslop this", "remove the AI tells", "make this sound less like AI", or when another skill hands over a text it has drafted, such as a commit message or a PR description. |
| [writing-great-skills](skills/shared/writing-great-skills/SKILL.md) | shared | user | Reference for authoring and pruning skills. |
| [ado-branch](skills/developers/ado-branch/SKILL.md) | developers | model | Start a task on a correctly named branch — read the Azure DevOps work item and create feature/ADO-<id>-<title>, or bug/ADO-<id>-<title> for a Bug, from main. Use when the user says "start task 12345", "create a branch for bug …", "branch for work item …", or begins work on a work item without a branch. |
| [ado-pr-feedback](skills/developers/ado-pr-feedback/SKILL.md) | developers | model | Address review comments on an Azure DevOps pull request — classify every comment against the current code first, fix what is valid, commit before replying, then set each thread's status (fixed / wontFix / closed) once the user approves. Use when the user says "address the PR comments", "go through the review feedback", "resolve the threads on PR 123", "CI is red on my PR", or pastes a reviewer's comment to act on. |
| [ado-pull-request](skills/developers/ado-pull-request/SKILL.md) | developers | model | Finish a task with a pull request whose title and description feed the release notes, or inspect/update Azure DevOps PR status — feat(<id>)/fix(<id>)/bug(<id>) lines written from the real diff, review offered, squash merge into main. Use when the user says "prepare the PR", "create a pull request", "the code is done", is about to push a finished branch, wants a PR dashboard/status view, or asks to update a drifted PR title/body. Not for reviewing someone else's PR, explaining what squash merge means, or working on non-Azure-DevOps PRs. |
| [commit](skills/developers/commit/SKILL.md) | developers | model | Commit the current changes as one commit per change — split by hunk when a file carries parts of two — each with a message that follows this repository's own convention, read from its history, conventional commits when there is none, built from the diff, cleaned of AI tells, and created only after the user has reviewed which files go into which commit, read every message, and said yes. Use when the user says "commit this", "commit my changes", "write a commit message", or has finished a change and wants it recorded. |
| [diagnosing-bugs](skills/developers/diagnosing-bugs/SKILL.md) | developers | model | Diagnosis loop for hard bugs and performance regressions — refuses to theorise until a tight feedback loop already goes red on this bug. Use when the user says "diagnose" or "debug this", or reports something broken, throwing, failing, flaky, or slow. |
| [git-sync](skills/developers/git-sync/SKILL.md) | developers | model | Sync the current branch with base or upstream changes, merge latest main, check if behind, resolve merge conflicts, or tidy squash-merged branches. Use when the user asks to sync with remote, pull or merge upstream/main, check branch freshness or behind count, resolve git conflicts, or clean up merged branches. |
| [implementation-discipline](skills/developers/implementation-discipline/SKILL.md) | developers | model | Developer reference for implementation work — verify sub-agent diffs, re-run affected tests after base merges, think before coding, and keep a single source of truth. Use when the user asks for implementation discipline or coding principles, or when checking a sub-agent diff or what to do after merging main into a branch. |
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
| [onboard-project](workflows/shared/onboard-project.md) | shared | skill:ado-credentials → skill:memory-init → skill:project-workspace → skill:ado-board → skill:catalog-doctor | Guided project onboarding — preflight Azure DevOps credentials, initialise project memory, discover board states, inspect branch policies, and verify with catalog-doctor. |
| [observation-to-work-item](workflows/qa/observation-to-work-item.md) | qa | skill:ado-credentials → agent:qa-triage → skill:qa-ado-work-item | From a tester's observation to an approved Azure DevOps work item — preflight the credential, triage the observation, draft, get explicit approval, publish once and read it back. |

### Bundles

| Bundle | Audience | Skills | Agents | Workflows |
|---|---|---|---|---|
| [developers](bundles/developers.json) | developers | grilling, writing-great-skills, unslop, diagnosing-bugs, catalog-doctor, catalog-feedback, pr-review, ado-credentials, project-workspace, ado-branch, ado-pull-request, ado-pr-feedback, ado-board, ado-backlog-placement, commit, git-sync, implementation-discipline, catalog-freshness, memory, memory-init | memory-writer, code-reviewer | onboard-project |
| [ops](bundles/ops.json) | ops | safety-ssh, ado-credentials, project-workspace, ado-board, catalog-doctor, catalog-feedback, catalog-freshness, memory, memory-init | memory-writer | onboard-project |
| [product](bundles/product.json) | product | grilling, writing-great-skills, unslop, ado-credentials, project-workspace, ado-board, ado-backlog-placement, catalog-doctor, catalog-feedback, catalog-freshness, memory, memory-init | memory-writer | onboard-project |
| [qa](bundles/qa.json) | qa | grilling, unslop, ado-credentials, project-workspace, ado-board, catalog-doctor, catalog-feedback, qa-ado-work-item, catalog-freshness, memory, memory-init | qa-triage, memory-writer | observation-to-work-item, onboard-project |

<!-- catalog:end -->
