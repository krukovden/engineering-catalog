---
tags: [unit:code-reviewer, unit:pr-review]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Task, Skill]
---

Use the code-reviewer agent to review main...HEAD in this repository. The commit message
claims the cache is a bounded LRU capped at 500 entries — verify that claim as part of the
review.
