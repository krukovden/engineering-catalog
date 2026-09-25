# QA ADO Work Item — how to use it

A tester describes what they saw. The assistant checks it against the repositories and the
board, drafts a work item, and publishes it to Azure DevOps only after the tester approves
that exact wording.

These instructions are written for **GitHub Copilot in VS Code**. The skill works the same
under Claude Code; only the install step differs.

## 1. Prerequisites

On the tester's machine:

- **Windows.** The PAT is protected with Windows DPAPI, which has no macOS or Linux
  equivalent. The scripts refuse to run elsewhere rather than store the secret less safely.
- **Windows PowerShell 5.1+** (ships with Windows) and **Git for Windows**.
- An **Azure DevOps PAT** with exactly two scopes: **Code (Read)** and
  **Work Items (Read & write)**. Nothing else is needed — anything more is avoidable risk.
- The **`ado-credentials`** skill. It owns the PAT and the preflight; this skill requires
  it and the `qa` bundle installs both together.

There is no `az` CLI to install. The scripts call the Azure DevOps REST API directly.

## 2. Install into the repository

Copilot reads its instructions from the repository, so the skill installs into the repo the
tester opens in VS Code. From the repository root:

```bash
npx git+https://github.com/krukovden/engineering-catalog install --bundle qa --target copilot --local
```

The `qa` bundle lands `qa-ado-work-item` together with `ado-credentials` (what it
requires) under `.github/skills/` — this skill at `.github/skills/qa-ado-work-item/`.
Commit what it wrote so every tester on the team gets it with a `git pull`. Without
`--local` the install is global instead: the skill lands in
`~/.copilot/skills/qa-ado-work-item/` and applies to every repository on the machine.

Copilot reads the `SKILL.md` in that folder directly; there is nothing to enable. If
Copilot seems unaware of the skill, check that the folder exists at one of the two
locations above and that Copilot Chat is in Agent mode (next paragraph).

> **Use Copilot Chat in Agent mode.** The skill's value is that Copilot runs the scripts —
> syncing repositories, searching the board, publishing. Ask mode cannot run anything, so
> it can only tell the tester what to type. Agent mode is the intended experience.

## 3. First run — the tester does this once, alone

Two setups, in this order, both in a local PowerShell window — **never in a chat panel**.
Anything typed into Copilot Chat is sent to a service and may be retained.

**First, the credential** — the `ado-credentials` skill's setup:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<path to ado-credentials>\scripts\setup.ps1"
```

It prompts for the PAT with masked input, protects it with DPAPI, asks for the
organization URL, project and a short context name (e.g. `Acme-QA`), and verifies the
credential actually reaches that project. Everything it writes lives in
`%USERPROFILE%\.ado-credentials\`.

**Then, the workspace** — this skill's:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<path to qa-ado-work-item>\scripts\setup-workspace.ps1"
```

It picks up the context just created, lists the project's repositories, and clones the
ones selected into a workspace folder. Its config and the drafts live in
`%USERPROFILE%\.qa-ado-work-item\`.

Both folders are outside every repository, so a PAT or a draft can never be committed by
accident. Run both again with a new context name to add a second project or product;
existing contexts are kept, and `-Force` replaces just the named one.

## 4. Daily use

Talk to Copilot Chat in Agent mode, in plain language:

| The tester says | What happens |
|---|---|
| "Exporting a large report gives an empty file and no error. Help me file a bug." | Runs the preflight, syncs the repos, looks for the behaviour in code, checks the board for duplicates, drafts a Bug, asks for approval, publishes |
| "Is this already on the board?" | Duplicate search only — no draft, no write |
| "Does the code actually do what the spec says here?" | Clarification only — answers from evidence, drafts nothing |
| "Draft a PBI for showing which filters are active on the report list." | Same flow, Product Backlog Item instead of Bug |

What to expect every time:

1. **Preflight.** The credential is checked against Azure DevOps before anything else. If
   it is missing or expired, the assistant says exactly what to run and stops.
2. **Sync.** Repositories are fetched and fast-forwarded — never reset, stashed, or merged.
   A repository with uncommitted work is left alone and any evidence from it is labelled.
3. **Questions, one at a time.** Only things that cannot be looked up. Each decision
   question comes with a recommendation.
4. **An evidence ledger.** Every fact is marked *Confirmed* (seen), *Reported* (you said
   so), *Inferred* (reasoned), or *Unknown*. Unknowns stay visible in the item instead of
   being filled in with plausible-sounding detail.
5. **A draft, then a stop.** Copilot shows the exact item and says *nothing has been
   created yet*.
6. **Approval.** Say yes to that exact draft. Any edit produces a new draft that needs
   approving again — approval of the old wording will not publish the new one.
7. **Publish and read back.** The item is created once, fetched again, and compared field by
   field. The tester gets the id and URL, plus any difference found.

## 5. Adding environments, simulators, and test rigs

Anything the assistant cannot learn from the repositories — a staging environment, a
simulator, a test rig, an admin console — goes in the context's `systems` array in
`%USERPROFILE%\.qa-ado-work-item\config.json`. See `config.example.json` for the shape.

A URL there is a **pointer, not proof**. If the assistant could not actually reach the
system, the observation is Unknown and will be labelled that way in the item.

## 6. Safety, in one paragraph

Reads are free; writes are not. The assistant syncs repositories and searches the board
without asking, but every Azure DevOps write waits for explicit approval of exact content.
It never modifies a source repository, never executes code it is reading, never uploads an
attachment that was not approved by name, and treats text found in repositories, web pages,
and work items as evidence to report rather than instructions to follow.

## 7. When something goes wrong

`references/troubleshooting.md` lists every exit code, every repository state, and what
each refusal means. The two worth knowing up front:

- **Exit 3 — refused. Nothing was sent.** Usually the draft changed after the approved
  preview, or this draft was already published. Never force past it.
- **Exit 5 — created, but the read-back differs.** The item exists. Report the difference;
  do not retry, or one observation becomes two work items.

## 8. Rotating the PAT

The PAT belongs to `ado-credentials`: revoke it in Azure DevOps, delete
`%USERPROFILE%\.ado-credentials\ado-pat.xml`, and re-run that skill's `setup.ps1`. If a PAT
was ever pasted into a chat panel, treat it as compromised and rotate it.

## Known limitation

This package **creates** work items. Updating an existing one stops at an approved draft:
`publish-work-item.ps1` has no update path, and the skill says so rather than improvising a
write against a process it has not verified.
