---
tags: [trigger:negative, unit:qa-triage]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Task, Skill]
---

This is already confirmed and filed as Bug #4821 in Azure DevOps: calling add(2, 2)
in the calculator returns 5 every time, 100% reproducible on build 2026.9.14. Can you
add a comment to the ticket noting it also repros on the staging build?
