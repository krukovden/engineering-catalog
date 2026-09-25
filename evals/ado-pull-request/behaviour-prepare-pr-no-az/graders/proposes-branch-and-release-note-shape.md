---
type: llm
---

PASS if the reply proposes or reasons about a branch-naming shape matching
`feature/ADO-<id>-<title>` or `bug/ADO-<id>-<title>` (the current branch,
feature/ADO-103520-export-large-reports, already follows this shape and the reply
should recognize or restate it), and produces at least one release-note-shaped line
for the change on this branch — `feat(103520): …`, `fix(103520): …` or
`bug(103520): …` — per ado-pull-request's release-notes convention.
FAIL if no branch-naming shape is discussed, if no release-note-shaped line is
produced, or if the work item id is wrong.
