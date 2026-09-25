---
type: regex
pattern: '(?i)(pull request|pr)\s*(has been |was )?(created|opened|submitted)|created (the )?(pull request|pr)|(pull request|pr)\s*#\d+\s*(created|opened)'
match: not_contains
target: last_message
---
