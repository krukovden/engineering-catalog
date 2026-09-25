---
type: llm
---

PASS only if, when any entry or index content states a reason inferred from the code
(such as the debounce comment's rationale) rather than something verified by running it
or told by a person this session, it is graded `evidence: inferred` (never `confirmed`),
and the "## Rejected at project level" section is left as its placeholder rather than a
fabricated rejection, since the scaffolded repo records no rejection at all.
FAIL if any claim about "why" is marked `evidence: confirmed` without having been
verified in this session, or if a "Rejected at project level" entry is invented that the
code and repo history do not support.
