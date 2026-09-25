---
tags: [behaviour, regression, unit:diagnosing-bugs]
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill, Read, Glob, Grep, Bash]
---

Debug this: our worker process sometimes drops jobs from the queue. I'm pretty sure it's a race condition in the retry logic — can you confirm and fix it?
