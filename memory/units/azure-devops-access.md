<!-- memory:unit azure-devops-access — the chain of this piece of functionality. Append entries under ## Entries;
     never delete a superseded entry; write supersede links in both directions. -->
# Azure DevOps access

`ado-credentials` (shared) is the preflight: `scripts/check.ps1` (DPAPI-protected PAT + REST
probe, Windows) and `scripts/check.sh` (`az` login + `azure-devops` extension, any OS) answer
`ok` / `absent` / `expired` / `error` with exact steps; on `absent` the assistant offers the
person a choice (do it yourself / install for me) and never handles the PAT. `qa-ado-work-item`
(qa) consumes it: evidence ledger, duplicate search, approval gate, hash-bound publication.
Agent `qa-triage` and workflow `observation-to-work-item` sit on top. The contract between the
skills is the state folder `%USERPROFILE%\.ado-credentials\`, never a path into a neighbour.

## Entries

This predates tracking; history before 2026-09-15 is not recorded.

### e-20261012-3bbd Windows setup runs through the assistant; the PAT arrives via a paste file, and its protection is instruction-only
- status: active
- evidence: confirmed
- pr: 17310
- sha-at-write: 50f745003f275645bec03657c1492d94b3e4c10b
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-12

Before this the tester ran `setup.ps1` in their own PowerShell window. Now the assistant runs everything and the tester only answers in chat: `projects.ps1` stores a project as an alias + board link + optional code links in the `ado-credentials` contexts, reading organization, project, team and area path from the link and proving them before saving. The PAT never passes through chat or a command line: `pat.ps1 -Prepare` creates an owner-only paste file and opens Notepad, `-Import` protects it with DPAPI, proves it and deletes the file; a rejected token never replaces a working one. The trade-off accepted: the assistant runs as the same Windows user, so it can technically decrypt `ado-pat.xml` — DPAPI protects against other users and machines, not against the model. The only barrier is the skill's prohibition on opening, printing or decrypting the file; a live Copilot test did once decrypt and print a PAT, which is why that prohibition is spelled out command by command. The alternative — keeping the console-prompt setup the tester runs — keeps the secret away from the model but makes the tester run a script themselves; the commit records only that the tester no longer opens PowerShell, not what went wrong before. `setup.ps1` remains for manual setup. Consumer: [[distribution-cli]] migrates old contexts into this layout.

### e-20261012-29d1 `ado-board` is the one deliberate exception to "no work tracker": stateless, forward-only, no per-commit hooks
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: b72de0285d80c335de68c6804df9572c4bc1b414
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-12

DESIGN.md §14 kept any work tracker out of scope "without a new decision". This is that decision, written into §14 and the scope line (8796a72, 4cd5da1): the skill `ado-board` (shared, `requires: [ado-credentials]`) moves Azure Boards work item states. The aim is to keep the board current for developers who never move cards and are not using the ai-sdlc-platform. The scope change is kept small. The board stays the record and the catalog owns no store; the only local file is a per-project state map under `~/.engineering-catalog/ado-board/`, committed only with `--in-repo`, holding no credential. The skill changes `State` plus an evidence comment, nothing else. States map by category onto `todo → doing → verify → done`, and moves go forward only. Resolved maps to `verify`, not done, because for a Bug it means awaiting QA verification and QA is one of the catalog's audiences. Removed is never touched. A required field stops the move and names the field instead of inventing a value. Cards with an `idp:` tag belong to the platform runner and are never moved by `reconcile` (`move` needs `--idp`), so the two writers do not race. `reconcile` is stateless and idempotent and reads completed PRs from the PR API, because squash merges leave nothing for `git log --merges` to find. Per-commit git hooks were rejected for the same squash reason, and because a network call in `post-commit` would break the "dumb and instant" memory hook contract (§8.8), need a credential inside a git hook (DPAPI-only on Windows), and share a file with memory's managed block. A `commit-msg` hook adding `#<id>` was dropped too: the PR body's `Work item: #<id>` already carries the mention into main. The cost is board lag between runs; it surfaces through one throttled `catalog-freshness` line, never a second session hook ([[eval-harness]] e-20261012-1e95). Memory still uses no tracker ([[project-memory]] e-20260915-b2d4 stands).

### e-20261012-3f62 `ado-board` writes carry a `test /rev` precondition and re-decide once on conflict
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 6a2efc39e5a82fac226f2e546e4dc0186437cf09
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-12

The `idp:` and forward-only rules of e-20261012-29d1 were checked on a GET, but the PATCH carried no precondition, so a card closed, or claimed by the platform runner through `idp:`, between the read and the write was still moved; the "two writers do not race" claim held only for the tag, not for the window. Every state PATCH now includes `test /rev` with the revision the decision was made on. On HTTP 409/412 the item is read again and the same rules decide once more: it moves, is `unchanged`, or is `refused` with the reason. A second conflict ends in `conflict` (exit `3`) with nothing written. The alternatives were refusing on the first conflict (noisy under `reconcile`, where a card moved on by someone else is the normal case and is reported, not failed) and retrying until it lands (unbounded, and it would keep re-deciding against a card a person is actively editing). Which status code the service returns for a failed `test` is taken from the docs, not a live capture; `references/rest.md` marks it **verify**. The REST calls moved to `scripts/board-rest.js`.

### e-20261012-a973 Azure CLI readiness is owned by the `ado-credentials` preflight; `az` consumers only require it
- status: active
- evidence: inferred
- pr: none
- sha-at-write: b68afcaa51701fe4fe50d0bfe1faa5810ff95d0c
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-12

`ado-branch` and `ado-pull-request` each carried their own copy of the `az` readiness probe (`command -v az`, `az account show`, the `azure-devops` extension, `az devops configure --list` defaults), because on Windows the DPAPI/PAT preflight proved only the REST credential. a9e3576 removed both copies and moved the contract into `ado-credentials` (a "Azure CLI readiness" section with three states: absent, present but not logged in, working); b68afca made `check.ps1` enforce it, so after a working PAT it runs the same probe as `check.sh` and answers `absent` with `missing: "az"` instead of `ok`. One preflight answers one outcome per situation, and a consumer cannot drift from it. On Windows the probe is caller-scoped: `check.ps1` runs it only with `-RequireAz`, which the `az` skills (`ado-branch`, `ado-pull-request`, `git-sync`) pass, so REST-only consumers (`qa-ado-work-item`, `ado-board`) still get `ok` from a working PAT — an unconditional gate (b68afca as first written) would have blocked QA testers who never install the Azure CLI. The alternative — a per-skill probe — duplicated the check in every `az` skill and let them drift.

### e-20261013-d68c Every skill that creates a work item publishes through one contract, copied per skill and pinned by a parity test
- status: active
- evidence: inferred
- pr: none
- sha-at-write: 89392585cca633deaddb3c547c411c5c10ff599f
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-13

`ado-backlog-placement` (shared, `requires: [ado-credentials]`, developers and product bundles) is the second skill that creates work items, after `qa-ado-work-item`. It reuses that skill's publish contract rather than inventing its own: a preview first, then a create only with `--approved <draftHash>`, where the hash binds organization, project, type, parent and every field (case and a trailing slash normalised), and a receipt claimed exclusively (`CreateNew` / `wx`) before the request, with the states `in-flight`, `created` and `failed`. A definitive 4xx (400/401/403/404/422) releases the receipt; anything else, a timeout included, keeps it, so a retry refuses instead of filing a second item, and a person searches the board before clearing it. Because a skill directory may not reference anything outside itself (invariant 3), the contract cannot be a shared module: the Node implementation (`placement-logic.js`) and the PowerShell one (`publish-work-item.ps1`) are separate copies, and `test/ado-backlog-placement.test.js` pins both to `test/fixtures/ado-backlog-placement/publish-parity.json` (same patch, same canonical string, same receipt states and release codes). The cost is two implementations that can still drift where the test does not look; the alternative, a shared helper, would break the self-contained-skill rule that installs depend on. The skill is opt-in at every step and `ado-branch` only offers it when no id is given, never `requires:` it (9fab4dd), so the developer bundle's branch flow works without board writes. 8e84c8d brought `catalog-feedback` under the same receipt rule: its commit claims `~/.engineering-catalog/feedback/<draftHash>.json` before the POST, releases it on the same definitive 4xx set, and otherwise keeps it so a retry answers `ALREADY-PUBLISHED` or refuses. The commit messages state what the contract is; the reason for copying it rather than sharing code is reconstructed from invariant 3.

### e-20261013-4d04 On macOS/Linux a PAT in the environment is the credential too; the `az` probe runs only for callers that ask
- status: active
- evidence: inferred
- pr: none
- sha-at-write: dd64440c478c0886df335f0006eee4eab23e4983
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-13

e-20261012-a973 made the `az` readiness probe caller-scoped on Windows only; `check.sh` still treated the `az` login as the one credential on macOS/Linux, so every caller, REST-only ones included, was told to `az login`. dd64440 brings `check.sh` to the same shape as `check.ps1`: when `AZURE_DEVOPS_EXT_PAT` (or `ADO_PAT`) is set, that PAT is the credential and is proved with one read of the organization's project list, and the `az` states are checked only with `--require-az`, which `ado-branch`, `ado-pull-request` and `git-sync` now pass. Without a PAT the old `az` path is unchanged. The organization comes from `--org`, `ADO_ORG` or the `az` default; with none of them the answer is `absent` ("no organization to check the PAT against") rather than a guess. The skill never writes the PAT anywhere: it is put in the environment by the person or their container. According to the working session, the trigger was a live test in a Linux container, where a tester who had only a PAT was told to `az login`. The commit message does not state this. The alternative, keeping `az` mandatory on macOS/Linux, makes the Azure CLI a hard prerequisite for QA and container users whose skills never call it, and leaves the two check scripts with different contracts.

### e-20261013-49d5 A completed PR moves an item at most into testing; `done` for a type with testing states is a person's move
- status: active
- evidence: inferred
- pr: none
- sha-at-write: 19d53324dfb1724476778dba1fb7cc5a6ed9cfa9
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-13

e-20261012-29d1 mapped states by category alone onto `todo → doing → verify → done`, and `reconcile` sent a completed PR's item to `done` (`verify` for a Bug). Processes whose testing steps (*Ready for Testing*, *In Testing*, *Ready for Acceptance*) sit in the InProgress or Resolved category therefore saw merged-but-untested items proposed for Done. 19d5332 adds a `testing` bucket between `doing` and `verify`. A state counts as `testing` by its **name** (`test`, `acceptance`, `verif`, `QA`, `review`) in any category except Completed and Removed, because Azure DevOps has no category for testing. For a type that has testing states, a completed PR moves a `todo`/`doing` item to the chosen testing state and never further. An item already in testing is only `observed`. `done` is reached only by an explicit `move <id> done`. Types with no testing state keep the old behaviour. A state map discovered before this change is detected as `stale-map`, and nothing moves on PR evidence for that type until `states discover` runs again; the alternative, reinterpreting the old map, would let a stale map keep closing items. When a bucket holds two states, `states discover` asks once which one to use, with the first state in process order as the usual answer. The cost is a name heuristic that can misclassify a state, for example a "review" state that is not testing, and the board stays in testing until a person moves it on. According to the working session, the trigger was a live finding that *Ready for Testing* items were proposed for Done. The commit subject states the rule ("never closes untested work on a PR"), and DESIGN.md §14 now carries it. The forward-only, `idp:`, stateless and no-hook rules of e-20261012-29d1 are unchanged.
