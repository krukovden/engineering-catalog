---
type: llm
---

PASS if memory/units/cache.md gained a new entry (a fresh e-YYYYMMDD-xxxx id,
distinct from e-20260908-cc01) whose body states the real trade-off recorded in
the drained commit — an unbounded Map causing a memory leak under load, an LRU
cap being hard to reverse because callers now rely on cold misses past the cap —
with sha-at-write set to the drained commit's sha, and memory/index.md's
reconciled-sha advanced past it.
FAIL if no new entry was written, the entry merely restates the diff without the
reasoning, credentials/personal data/session narrative were recorded, or the
queue was marked reconciled without an entry actually being written.
