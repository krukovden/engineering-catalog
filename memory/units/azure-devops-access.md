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
