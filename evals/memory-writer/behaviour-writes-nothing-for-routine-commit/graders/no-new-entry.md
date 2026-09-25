---
type: regex
pattern: 'e-2026\d{4}-(?!cc01)[a-z0-9]{4}'
match: not_contains
target: { source: file, path: memory/units/cache.md }
---
