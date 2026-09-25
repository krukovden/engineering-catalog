---
tags: [behaviour, unit:memory]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Skill, Bash, Read, Write, Edit]
---

Uploads sometimes fail on flaky wifi. Add a synchronous retry loop inside the upload
handler so it keeps retrying until it succeeds.
