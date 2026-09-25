---
type: llm
---

PASS only if the reply relays the freshness check's finding as a short, one-line-style
hint (the installed version, the newer version available, and/or the update command) —
matching the skill's own instruction to "relay its one-line hint to the user verbatim" —
rather than padding it into a wall of unrelated explanation.
FAIL if the reply invents update information instead of running the check, buries the
hint in a long unrelated response, ignores the freshness question entirely, or claims to
run `update` itself (the skill says updating is the user's decision, never the model's).
