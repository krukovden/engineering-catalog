---
type: llm
---

PASS if the reply explains that no Azure DevOps credentials (a PAT or an `az` CLI
login) are available in this environment, and hands the person concrete next steps
to get one — the `ado-credentials` dialogue when no PAT/az exists — instead of
proceeding as though a bug had been filed.
FAIL if the reply invents a work-item id, claims the bug was filed or a ticket was
created, or otherwise proceeds as though credentials existed.
