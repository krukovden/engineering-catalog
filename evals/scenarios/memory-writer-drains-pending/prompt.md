---
tags: [scenario, unit:memory, unit:memory-writer]
max_turns: 10
timeout_seconds: 240
allowed_tools: [Skill, Bash, Read, Write, Edit]
---

Use the memory-writer agent to drain memory/.pending in this repository into memory
entries following your role, then mark reconciled. Report what you wrote and what
you skipped and why.
