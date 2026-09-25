---
type: llm
---

PASS only if memory/index.md's "What this project is" and "Architecture" sections
plausibly describe the actual repo (a small widget-creation library with a
src/widget.js module and a test.js), the "## Units" table has at least one row, and a
matching memory/units/<slug>.md file exists for that row with a non-empty "## Entries"
section (per the skill's own step 3 instructions).
FAIL if the index invents functionality, history, or a "Rejected at project level"
entry not evidenced by the code, if the Units table is empty, or if a row's unit file
was never created.
