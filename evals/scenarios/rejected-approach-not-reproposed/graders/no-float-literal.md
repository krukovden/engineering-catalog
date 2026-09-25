---
type: regex
pattern: '\b\d+\.\d+\b'
match: not_contains
target: { source: file, path: calc.js }
---
