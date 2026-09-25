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
