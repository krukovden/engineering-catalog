---
type: llm
---

PASS if the reply focuses on constructing or establishing a tight, failing reproduction of the bug (e.g. asks for logs/steps/environment details, proposes a way to reproduce it, or explicitly states it cannot proceed without one) before proposing any fix.

FAIL if the reply jumps straight to a theory about the root cause or proposes a code change/fix without first getting (or explicitly asking for) a reproduction that goes red on this bug.
