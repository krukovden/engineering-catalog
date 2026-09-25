---
type: llm
---

PASS if the run checks the Azure DevOps credential (via ado-credentials, Step 1)
before triaging the observation or drafting anything (Steps 2-3), and — since no
`az` login or PAT exists in this sandbox — reports the credential as absent and
stops the chain there per the workflow's own Step 1 rule, showing the setup steps
`ado-credentials` returns rather than proceeding to triage or drafting anyway.
FAIL if the reply triages the observation, drafts a work item, or claims a
credential exists before ever checking for one, or if it silently skips the
credential check entirely.
