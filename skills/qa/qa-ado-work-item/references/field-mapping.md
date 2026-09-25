# Mapping the draft onto Azure DevOps fields

> Script paths on this page are relative to this skill's directory — the folder that holds `SKILL.md`.

The chat preview in Step 5 is written for a human. This file turns it into the `fields`
block of the JSON draft. Read it when you are about to write a draft file.

`query-ado.ps1 -Action Fields -Type "<type>"` is the authority for the project in front of
you — this page is the map, that command is the territory.

## The draft file

```json
{
  "context": "Acme-QA",
  "type": "Bug",
  "parentId": 12345,
  "fields": { "System.Title": "…" }
}
```

- `context` — must match a context name in the credentials config and in this skill's `config.json`. It selects the organization,
  project, repositories, and allow list.
- `type` — the work item type **as the project spells it** (`Product Backlog Item`, not `PBI`).
- `parentId` — omit or `null` for an unparented item.
- `fields` — reference names only (`System.Title`), never display names (`Title`).

An empty or `null` field value is dropped before the request, so leaving a field blank is
the same as omitting it.

## Preview line → field

| Preview line | Field reference name |
|---|---|
| Title | `System.Title` |
| Description (Task / PBI / Feature) | `System.Description` |
| Reproduction steps + Actual + Expected (Bug) | `Microsoft.VSTS.TCM.ReproSteps` |
| Environment / build (Bug) | `Microsoft.VSTS.TCM.SystemInfo` |
| Acceptance criteria | `Microsoft.VSTS.Common.AcceptanceCriteria` |
| Impact | `Microsoft.VSTS.Common.Priority` (1–4) |
| Severity | `Microsoft.VSTS.Common.Severity` (`1 - Critical` … `4 - Low`) |
| Area / iteration | `System.AreaPath`, `System.IterationPath` |
| Tags | `System.Tags` (semicolon-separated) |

**Bugs and `System.Description`.** In the Agile and Scrum processes a Bug carries
`Microsoft.VSTS.TCM.ReproSteps`, not `System.Description` — put steps, actual, and expected
in ReproSteps. The publisher's `fields-exist-on-type` check catches the mistake before the
user is asked to approve anything, but drafting it right saves a round trip.

## Process differences

| | Agile | Scrum | CMMI | Basic |
|---|---|---|---|---|
| Story-level type | User Story | Product Backlog Item | Requirement | Issue |
| Bug repro field | ReproSteps | ReproSteps | ReproSteps | Description |
| Bug has Severity | yes | yes | yes | no |
| Acceptance criteria | yes | yes | yes | no |

Run `query-ado.ps1 -Action Types` once per context and remember what came back — the
project's process is not something to assume.

## HTML fields

`System.Description`, `Microsoft.VSTS.TCM.ReproSteps`, `Microsoft.VSTS.TCM.SystemInfo`, and
`Microsoft.VSTS.Common.AcceptanceCriteria` are HTML. Use `<p>`, `<ol>/<li>`, `<ul>/<li>`,
`<strong>`, and `<br/>`; escape `&`, `<`, and `>` inside the text. Plain text with newlines
lands on the board as one unbroken paragraph.

Azure DevOps normalises HTML on save, so the read-back in Step 7 reports these fields as
`normalized` when the wrapping changed but the visible text did not. That is a pass.
`differs` means the text itself changed and is a real mismatch.

## Widening the allow list

`publish-work-item.ps1` refuses any field outside the context's `allowedFields`. To add
one, confirm the reference name first:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts/query-ado.ps1" -Action Fields -Type "Bug"
```

then add that exact `referenceName` to the context in
`%USERPROFILE%\.qa-ado-work-item\config.json`. The allow list is a deliberate narrowing:
it keeps a drafting mistake from writing to a field the team maintains by hand, such as
state, assignment, or effort.
