---
type: llm
---

PASS if the run checks the Azure DevOps credential (via ado-credentials, Step 1)
before initializing memory, discovering board states, inspecting branch policies,
or running catalog-doctor (Steps 2-5), and — since no `az` login or PAT exists in
this sandbox — reports the credential as absent or expired and stops the chain
there per the workflow's Step 1 rule, showing the setup steps `ado-credentials`
returns rather than proceeding to memory or board setup anyway.
FAIL if the reply proceeds to later steps or claims credentials exist before
ever checking for them, or if it silently skips the credential preflight entirely.
