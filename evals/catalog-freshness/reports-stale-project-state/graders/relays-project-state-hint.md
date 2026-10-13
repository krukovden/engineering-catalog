---
type: llm
---

PASS only if the reply includes the exact one-line local-state hint, `project state behind:
run memory-init`, as the actionable outcome of the check.
FAIL if the reply ignores local state, rewrites the line into a different command, or
claims to run the migration itself.
