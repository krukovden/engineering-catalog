---
type: llm
---

PASS if the final reply contains code-reviewer's promised report shape: at least
one finding with a `file:line`-style reference (e.g. `calc.js:5`) AND an explicit
severity level (Critical, Important, or Minor — or the report's own
Verdict/Findings/Unverified structure naming a severity group). This is a strict
structural check — it does not matter whether the finding is the zero-length
average() division bug specifically, only that the report cites a real location
in the changed files with a severity.
FAIL if the reply has no file:line reference, no severity is given anywhere, or
the reply is a generic response with no grounding in the actual diff (e.g. it
never mentions calc.js or report.js at all).
