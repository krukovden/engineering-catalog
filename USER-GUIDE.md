# AI Engineering Catalog — user guide

A shared set of instructions, helpers and roles for the AI assistants our team uses:
GitHub Copilot CLI and Claude Code. It is for testers, developers, product owners and
ops. Install it once and you get three things: the assistant behaves the same way in
Copilot and in Claude, on Windows, macOS and Linux; every project keeps one memory of
what the team decided and why, shared by both assistants; and Azure DevOps is reached
only through a checked credential that the assistant never sees.

## Install in 5 minutes

You need:

| What | How to check |
|---|---|
| Node.js 20 or newer | `node --version` prints `v20` or higher. If not, install from <https://nodejs.org>. |
| Git | `git --version` prints a version. |
| Access to the catalog repository | <https://github.com/krukovden/engineering-catalog> opens in your browser and shows files. |
| An assistant | GitHub Copilot CLI, Claude Code, or both, installed and signed in. |

A "terminal" below means PowerShell or Windows Terminal on Windows, Terminal on macOS.

**The one command.** Open a terminal and type:

```bash
npx git+https://github.com/krukovden/engineering-catalog install
```

> Temporary note: until this branch is merged to `main`, append `#feat-ado-catalog-multi`
> to the address in every command on this page, like
> `npx git+https://github.com/krukovden/engineering-catalog#feat-ado-catalog-multi install`.

`npx` downloads the catalog and starts its installer. Nothing is written until you have
answered three questions:

1. **Which bundle?** A numbered list: `developers`, `ops`, `product`, `qa`, each with one
   line of description. Type a number (`4`), several (`1,4`), or `all`.
2. **Which tool?** `1` Claude Code, `2` GitHub Copilot, `3` Both.
3. **Install where?** `1` Global (every project on this machine, the default, just press
   Enter) or `2` This project (only the folder you are in).

It prints one line per unit (`✓ skill ado-credentials`, …) and ends with a line like
`Installed 8 units (31 files) for GitHub Copilot (global) into /Users/you; receipt: …`.

**The one-line variant**, when you already know the answers. Nothing is asked, and the
scope is global:

```bash
npx git+https://github.com/krukovden/engineering-catalog install --bundle qa --target both
```

`--bundle` takes `developers`, `qa`, `product` or `ops` (several with commas);
`--target` takes `claude`, `copilot` or `both`; add `--local` to install into the
current project only.

**Check what you have:**

```bash
npx git+https://github.com/krukovden/engineering-catalog status --global
```

**Where the files landed** (`~` is your home folder):

| Tool | Skills | Agents |
|---|---|---|
| Claude Code | `~/.claude/skills/<name>/` | `~/.claude/agents/<name>.md` |
| GitHub Copilot | `~/.copilot/skills/<name>/` | `~/.copilot/agents/<name>.agent.md` |

A "this project" install (`--local`) uses `.claude/skills`, `.claude/agents`,
`.github/skills` and `.github/agents` inside the project instead. The **receipt** — a
small file that records what was installed and lets `update` know what changed — is
`~/.engineering-catalog/receipt.json` (or `<project>/.engineering-catalog/receipt.json`
for a local install).

**The marketplace alternative** (available once the catalog is on `main`). Both
assistants can install the catalog as a plugin; the same files land on your machine,
only the updater differs (`copilot plugin update` or Claude's plugin manager instead of
`engcat update`):

- Copilot: `copilot plugin marketplace add https://github.com/krukovden/engineering-catalog`, then `copilot plugin install engineering-catalog@engineering-catalog`.
- Claude Code: `/plugin marketplace add https://github.com/krukovden/engineering-catalog`, then `/plugin install engineering-catalog`.
- Agents installed this way in Copilot are named `engineering-catalog:<name>`, for example `engineering-catalog:memory-writer`.

## What you get

The catalog holds four kinds of things:

- **Skill** — instructions the assistant picks up by itself when your request matches
  (a few are "type it yourself", see below).
- **Agent** — a separate worker you launch for a big job; it works in its own session
  and hands you a short result.
- **Workflow** — a step-by-step procedure you start by typing `/name`.
- **Bundle** — a shopping list used only at install time; you never "run" a bundle.

Three rules cover almost all use:

| Rule | What it means in practice |
|---|---|
| You don't call skills — you describe the task. | Say "the export gives an empty file" or "grill me on this plan". The assistant picks the skill. |
| `/name` = a one-time setup or a full procedure. | `/memory-init` sets memory up once; `/observation-to-work-item …` runs a whole procedure; `/writing-great-skills` opens a reference. |
| "launch agent X" = a separate worker, you get a short result. | Copilot: `copilot --agent memory-writer -p "…"` or `/agent memory-writer` inside a session. Claude Code: ask for it ("use the memory-writer agent to …"); Claude runs it as a subagent. |

## Everyone gets: project memory and freshness

Every bundle contains project memory (`memory`, `memory-init`, `memory-writer`) and the
update reminder (`catalog-freshness`).

**Project memory** is a `memory/` folder in the repository that both assistants read
first and add to when the team makes a real decision. Four steps:

1. **Enable it once per project.** Open the project in your assistant and type
   `/memory-init` (Claude Code) or write `Use /memory-init in this repository` (Copilot).
   It asks one question — keep memory **committed** in the repository (recommended) or
   **local** on this machine only — then creates `memory/index.md` and
   `memory/units/`, adds a short pointer to `CLAUDE.md`, `.github/copilot-instructions.md`
   and `AGENTS.md` (existing content stays), installs a git hook that notes every
   commit in `memory/.pending`, and writes a first index from the code. Commit what it
   suggests. Running it again is safe: it reports `kept` for what already exists.
2. **It reads automatically.** From then on the assistant reads `memory/index.md` at
   the start of every session, and a unit file only when work touches that part.
3. **It refuses rejected approaches.** If you ask for something listed under "Rejected
   at project level", the assistant stops, quotes the rejection and its reason, and
   asks whether you want to overturn it. Only an explicit yes overturns; the old entry
   is then marked superseded, never deleted. An entry is written only for a decision
   that is hard to reverse, not obvious without context, and the result of a real
   trade-off — all three. Renames and formatting never qualify.
4. **Drain the queue at the end of a task or day.** The hook queues every commit; the
   `memory-writer` agent reads them in isolation and writes entries for the ones that
   pass the test.

   | Assistant | Type |
   |---|---|
   | Copilot | `copilot --agent memory-writer -p "Drain memory/.pending"` (or `/agent memory-writer` inside a session) |
   | Claude Code | `use the memory-writer agent to drain memory/.pending` |

   It reports entries written, commits skipped and why, and how many remain.

**Freshness** needs nothing from you. Once per session, at most once a week, the
assistant checks whether a newer catalog exists and, only if so, prints one line:
`engineering-catalog 1.0.0 → 1.1.0 available. Update: npx git+… update`. It never
updates on its own.

## If you are a developer

Bundle `developers`: `ado-branch`, `commit`, `ado-pull-request`, `pr-review`, `diagnosing-bugs`, `grilling`,
`ado-credentials`, `writing-great-skills`, `unslop`, memory, freshness; agents `code-reviewer`,
`memory-writer`.

| I want | I say or type |
|---|---|
| Start a task on the right branch | "start task 103520". `ado-branch` checks Azure DevOps access, reads the work item, and creates `feature/ADO-103520-<title>` (or `bug/ADO-<id>-<title>` for a Bug) from `main`. If a branch for that id already exists under another name it says so and asks; it never renames silently. |
| Commit my changes | "commit this". `commit` reads how this repository writes its commits (prefixes, scopes, ticket ids, bodies) from the last thirty, and uses conventional commits when there is no pattern. It groups the changes into one commit per change, and when one file carries parts of two changes it splits that file by hunk. It drafts each message from the diff, runs `unslop` on the wording, then shows the whole plan: which files and hunks go into which commit, and every message in full. It commits only after your explicit yes to that plan. It never touches the working tree, and it never pushes, amends or skips a hook. |
| Finish a task with a pull request | "code is done, prepare the pull request". `ado-pull-request` reads what really changed against `main` (not the commit messages — the squash discards them), writes one release-note line per user-visible change (`feat(103520): …` for new behaviour, `fix(103533): …` for a fixed defect; the first line is the PR title), runs `unslop` on the wording, shows the draft, and asks *"run a code review first?"* — **yes**: the `code-reviewer` agent, on a different model than the one that wrote the code, reports findings with file:line and severity; you fix or accept. **No** is a normal answer. Then, after your explicit yes, it creates the PR: squash merge, work item linked, source branch deleted after merge. The release-notes pipeline reads those lines from the squash commit. |
| Review a branch without opening a PR | "review my branch" — `pr-review` collects the diff and launches `code-reviewer` on its own. The checklist, in order: correctness, claims verified against the code, security, reuse and simplification, SOLID, KISS, YAGNI, file and function size (a file over 300 lines needs a reason, over 500 is a finding, a function over 50 lines is a minor), tests. Verdict / Strengths / Findings / Unverified. |
| Find the cause of a bug or a slowdown | "debug this: the import job throws after 200 rows" or "diagnose why the list is slow". The assistant first builds a test that fails on this exact bug, then bisects; it refuses to guess before it has that signal. |
| Sharpen a plan before building | "grill me on this migration plan". One question at a time, with a recommended answer for each, until you both agree. |
| Do something on the Azure DevOps board | Ask for it plainly. `ado-credentials` runs first and answers `ok`, `absent` or `expired`. On `absent` it shows the setup steps and offers exactly two options: **1. You do it** (you run the steps in your own terminal, then say so) or **2. I do it for you** (it runs the tool install and login steps, showing each command). The token itself is never typed into chat: on Windows you enter it in `setup.ps1`'s masked prompt, on macOS/Linux `az login` handles it. |
| Clean AI-sounding text | "unslop this" and the text or file. It scans for a fixed list of tells (stock vocabulary, em dashes, rule-of-three, filler, hedging, passive voice), rewrites with meaning and tone kept, then audits its own result. |
| Write a new skill for the catalog | `/writing-great-skills` — the reference on descriptions, triggers and pruning. |
| Catch memory up on today's commits | `copilot --agent memory-writer -p "Drain memory/.pending"` / "use the memory-writer agent to drain memory/.pending" |

## If you are a tester (QA)

Bundle `qa`: `qa-ado-work-item`, `ado-credentials`, `grilling`, `unslop`, memory, freshness;
agents `qa-triage`, `memory-writer`; workflow `observation-to-work-item`.

**The full procedure.** Type, in Copilot or in Claude Code:

```
/observation-to-work-item the export gives an empty file
```

What happens, in order:

1. **Preflight** — `ado-credentials` checks that Azure DevOps access is in place and
   still works. On `absent` or `expired` it shows the steps and stops; nothing is worked
   around.
2. **Triage** — the `qa-triage` agent sorts what is known into confirmed / reported /
   inferred / unknown, searches the repositories and the board for duplicates, and
   recommends Bug, Task, Product Backlog Item or Feature (or "nothing to file, here is
   the answer"). If you choose to link an existing item, it stops here.
3. **Draft** — `qa-ado-work-item` writes the exact title, description, steps and
   evidence, checks every field against the live project, and shows you the preview
   with the words "Nothing has been created yet".
4. **Your explicit yes** — silence, "looks good" about an earlier version, or a request
   to edit are not approval. Any edit produces a new preview.
5. **Publish once** — the item is created one time, bound to the draft you approved.
6. **Read back** — the assistant reads the item back, reports its id and URL, and
   states any mismatch instead of retrying.

**Quick questions** need no procedure. Just ask: "is the empty export already on the
board?", "check this observation against the code". The assistant searches and answers;
it files nothing.

**Triage on its own.** Launch `qa-triage` when you are not sure whether something is a
bug at all: `copilot --agent qa-triage -p "the export gives an empty file"` (Copilot) or
"use the qa-triage agent on: the export gives an empty file" (Claude Code). It returns
the evidence ledger, the duplicates found, and a recommended type and parent. It never
files anything.

**First-time Azure DevOps setup.** Filing work items runs on **Windows** (Windows
PowerShell 5.1 or newer, Git for Windows). Two scripts, run once, in your own PowerShell
window — never in the chat:

1. Credential. Create a Personal Access Token (PAT) in Azure DevOps under *User settings →
   Personal access tokens* with scopes **Code (Read)** and **Work Items (Read & write)**,
   then run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\.copilot\skills\ado-credentials\scripts\setup.ps1"
   ```

   It asks for the PAT in a masked prompt, stores it encrypted for your Windows account
   under `%USERPROFILE%\.ado-credentials\`, asks for the organization, project and a
   short context name, and proves the token works. Never paste a PAT into chat; if that
   happens, revoke it in Azure DevOps and create a new one.
2. Repositories. Run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\.copilot\skills\qa-ado-work-item\scripts\setup-workspace.ps1"
   ```

   It clones the repositories the triage reads as evidence and records the defaults for
   that context.

For a Claude-only install use `$HOME\.claude\skills\…` in both paths. On macOS/Linux the
access check works through `az login`, `az extension add --name azure-devops` and
`az devops configure --defaults organization=https://dev.azure.com/<ORG> project=<PROJECT>`.

**Agents:** `qa-triage` and `memory-writer`, launched as above (Copilot:
`copilot --agent <name> -p "…"` or `/agent <name>`; Claude Code: "use the `<name>` agent
to …").

## If you are a product owner

Bundle `product`: `grilling`, `writing-great-skills`, `unslop`, memory, freshness; agent
`memory-writer`.

| I want | I say or type |
|---|---|
| Pressure-test a feature idea | "grill me on the self-service onboarding idea". The assistant walks the decision tree one question at a time, looks up facts itself, and leaves every decision to you. |
| Sharpen fuzzy requirements before handing them over | "stress-test this plan before we build it" |
| Write or trim a skill | `/writing-great-skills` |
| Clean AI-sounding text | "unslop this" and the text or file. It scans for a fixed list of tells (stock vocabulary, em dashes, rule-of-three, filler, hedging, passive voice), rewrites with meaning and tone kept, then audits its own result. |
| See what the team decided and why | Ask "what did we decide about X?" — the assistant reads `memory/index.md` and the unit file. Set memory up once with `/memory-init`; drain the queue with `memory-writer` (see above). |

## If you are ops

Bundle `ops`: `safety-ssh`, memory, freshness; agent `memory-writer`.

| I want | I say or type |
|---|---|
| Do something on a server | "restart the api service on prod-web", "free up disk on build-agent-2", "tail the nginx log on staging". The assistant works only through a **named connection** and never sees or types a password, username, hostname or IP. |
| Connect to a new machine | Name it: "set up a connection called prod-web". The skill's `new-connection` script writes a template into `~/.ssh/config` with `<FILL_IN>` placeholders; you fill in the host and user and load the key yourself, then the assistant authorizes the name and runs `check-setup`. Both scripts exist in `.sh` and `.ps1`. |

Never paste a password or key into the chat. If you do, treat it as compromised and
rotate it.

## Commands

Every command is `npx git+https://github.com/krukovden/engineering-catalog <command>`.

| Command | Why you'd use it |
|---|---|
| `install [--bundle a,b] [--target claude\|copilot\|both] [--global\|--local] [--yes]` | First time on a machine, or to add a bundle to what is already there. |
| `update [--global\|--local] [--keep-local\|--overwrite] [--yes]` | Bring an install up to the newest catalog. Shows `+` new, `~` changed, `-` removed, `=` unchanged, then writes. |
| `status [--global\|--local]` | What is installed, from which catalog version, and whether any file was edited locally. Send its output when asking for help. |
| `check` | Is there a newer release than the one you are running? Reads the tags on the repository. |
| `list` | Everything in the catalog: bundles, skills, agents, workflows. `[type it]` marks skills you start with `/name`. |

**"A file was edited locally"** means the file on disk no longer matches the hash in the
receipt — somebody changed it by hand. `update` never overwrites it silently: it asks
`Overwrite <file>? [y/N]` (or `Delete <file> (no longer in the catalog)? [y/N]`), one file
at a time. `y` takes the catalog's version; Enter keeps yours and asks again next time.
`--keep-local` or `--overwrite` answers for every file at once; `--yes` takes the default
answer everywhere else (scope → global) but never decides about a local edit.

**Pinning a version** so a team installs the same thing:

```bash
npx git+https://github.com/krukovden/engineering-catalog#v1.0.0 install --bundle qa --target both --version 1.0.0
```

`#v<version>` picks the release; `--version` makes the command fail if what was
downloaded is not that release.

## When something goes wrong

| You see | What to do |
|---|---|
| `npx: command not found` or `node: command not found` | Node.js is missing. Install version 20 or newer from <https://nodejs.org>, close and reopen the terminal, try again. |
| `update` prints `! <file> was edited locally` and asks `Overwrite <file>? [y/N]` | Somebody changed that file by hand. `y` takes the catalog's version, Enter keeps yours. |
| `nothing installed here (…, global) — run engcat install` | Nothing is installed at that scope. Run the install command (add `--local` if you meant this project only). |
| The access check answers `expired`, or `Azure DevOps rejected the PAT` | The token no longer works. Create a new PAT with the two scopes above and run `setup.ps1` again — it offers to replace the stored token. On macOS/Linux run `az login` again. |
| `installed X is newer than this catalog Y` on `update` | You are running an older catalog than the one installed. Run the plain command without a version pin, or pin the newer one with `#v<version>`. |

Still stuck? Run `status --global` and send its output to a maintainer.

## Full inventory

**Skills**

| Skill | Who triggers it | Bundles | Purpose |
|---|---|---|---|
| `ado-credentials` | another skill (before any Azure DevOps work) | developers, qa | Is Azure DevOps access present and alive? If not, exact steps to fix it. |
| `catalog-freshness` | assistant, once per session | all | Says in one line when a newer catalog exists. |
| `grilling` | assistant ("grill me", "pressure-test this plan") | developers, product, qa | Sharpens a plan one question at a time until it is shared understanding. |
| `memory` | assistant, every session | all | Reads project memory first; writes an entry only for real decisions. |
| `memory-init` | you, `/memory-init` | all | Sets up project memory in a repository, once. |
| `writing-great-skills` | you, `/writing-great-skills` | developers, product | Reference for writing and pruning skills. |
| `unslop` | assistant ("unslop this", "remove the AI tells"), or another skill on its own draft | developers, product, qa | Cuts AI tells from any writing: scan for the listed patterns, rewrite, self-audit. |
| `commit` | assistant ("commit this", "write a commit message") | developers | Commit message in the repository's own convention, from the diff, committed only after your yes. |
| `diagnosing-bugs` | assistant ("debug this", "why is it slow") | developers | Builds a failing feedback loop before theorising about a bug. |
| `qa-ado-work-item` | assistant (a defect report, "file a bug", "is it on the board?") | qa | Fact-checked Bug/Task/PBI/Feature in Azure DevOps, published only after your explicit approval. |
| `safety-ssh` | assistant ("ssh into…", "on the server…") | ops | Remote work through a named connection only; no secrets or addresses in chat. |

**Agents**

| Agent | Bundles | Copilot | Claude Code |
|---|---|---|---|
| `memory-writer` | all | `copilot --agent memory-writer -p "Drain memory/.pending"` or `/agent memory-writer` | "use the memory-writer agent to drain memory/.pending" |
| `qa-triage` | qa | `copilot --agent qa-triage -p "<what you saw>"` or `/agent qa-triage` | "use the qa-triage agent on: <what you saw>" |

Through the Copilot marketplace the names carry the prefix `engineering-catalog:`.

**Workflows**

| Workflow | Bundle | How to start |
|---|---|---|
| `observation-to-work-item` | qa | `/observation-to-work-item <what you saw>` in Copilot or Claude Code |

**Bundles**

| Bundle | Audience | Contents |
|---|---|---|
| `developers` | developers | skills `grilling`, `writing-great-skills`, `unslop`, `commit`, `diagnosing-bugs`, `ado-credentials`, `catalog-freshness`, `memory`, `memory-init`; agent `memory-writer` |
| `qa` | qa | skills `grilling`, `unslop`, `ado-credentials`, `qa-ado-work-item`, `catalog-freshness`, `memory`, `memory-init`; agents `qa-triage`, `memory-writer`; workflow `observation-to-work-item` |
| `product` | product | skills `grilling`, `writing-great-skills`, `unslop`, `catalog-freshness`, `memory`, `memory-init`; agent `memory-writer` |
| `ops` | ops | skills `safety-ssh`, `catalog-freshness`, `memory`, `memory-init`; agent `memory-writer` |

## For maintainers

[`AGENTS.md`](AGENTS.md) is the contract for adding, moving or retiring a unit
(`CLAUDE.md` just imports it, for Claude Code); the design is [`DESIGN.md`](DESIGN.md).
After any change under `skills/`, `agents/`, `workflows/` or `bundles/`:
`npm run build && npm test && npm run check`.
Releases are versioned by the pipeline at PR time; humans bump only `major.minor`.

Predecessor: [krukovden/skill-catalog](https://github.com/krukovden/skill-catalog).
