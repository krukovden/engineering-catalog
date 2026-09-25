---
name: observation-to-work-item
description: From a tester's observation to an approved Azure DevOps work item — preflight the credential, triage the observation, draft, get explicit approval, publish once and read it back.
steps:
  - skill: ado-credentials
  - agent: qa-triage
  - skill: qa-ado-work-item
---

# Observation To Work Item

## Step 1 — `ado-credentials`

Preflight the Azure DevOps credential before anything else runs. Continue only on
`ok`. On `absent` or `expired`, show the `steps` it returns verbatim and stop the
chain here — the credential is the tester's to create or replace, never something
this workflow works around.

## Step 2 — `qa-triage`

Build the evidence ledger and run the duplicate search against the observation.
This step stops the chain, without drafting anything, when the tester chooses to
link an existing item instead of filing a new one, or when the ledger does not
support filing anything at all. Otherwise it hands forward a recommended type,
parent, and the ledger behind them.

## Step 3 — `qa-ado-work-item`

Draft the exact wording from the ledger and the recommendation, preview it
against the live project, and show it to the tester with the plain statement
that nothing has been created yet. This step stops the chain — indefinitely, if
needed — whenever approval is withheld or an edit is requested; publication
happens once, only after the tester approves the exact draft in front of them,
and the item is read back and reported. The tester decides what gets filed and
in what words; this workflow never publishes on its own.
