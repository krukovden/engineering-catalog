---
type: llm
---

PASS if the final reply contains code-reviewer's promised report shape: at least
one finding with a `file:line`-style reference (e.g. `cache.js:9`) AND an explicit
severity level (Critical, Important, or Minor — or the report's own
Verdict/Findings/Unverified structure naming a severity group). This is a strict
structural check — it does not matter whether the finding is specifically the
unbounded-cache claim, only that the report cites a real location in cache.js
with a severity.
FAIL if the reply has no file:line reference, no severity is given anywhere, or
the reply never engages with the actual diff in cache.js.
