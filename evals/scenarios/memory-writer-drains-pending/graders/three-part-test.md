---
type: llm
---

PASS if memory/units/retry.md gained a new entry (a fresh e-YYYYMMDD-xxxx id, distinct
from e-20260910-aa11) whose body states the real trade-off recorded in the drained
commit — fixed-count retries causing a thundering herd, backoff+jitter being harder to
reverse because callers now assume delayed retries — with sha-at-write set to the
drained commit's sha, and memory/index.md's reconciled-sha advanced past it.
FAIL if no new entry was written, the entry merely restates the diff without the
reasoning, credentials/personal data/session narrative were recorded, or the queue was
marked reconciled without an entry actually being written.
