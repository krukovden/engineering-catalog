---
type: regex
pattern: '(?i)(bug|work item)\s*#?\d+\s*(has been |was )?(created|filed|opened)|successfully (filed|created)|created successfully|ticket\s*(id|number)\s*:\s*\d+'
match: not_contains
target: last_message
---
