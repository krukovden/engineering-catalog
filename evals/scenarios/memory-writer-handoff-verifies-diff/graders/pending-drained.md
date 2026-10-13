---
type: regex
pattern: '[^\s]'
match: not_contains
target: { source: file, path: memory/.pending }
---
