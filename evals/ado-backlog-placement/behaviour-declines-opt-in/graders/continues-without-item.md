---
type: llm
---

PASS if the reply accepts that the user declined to look for a place on the board: it
does not search, rank or create any work item, Feature or PBI, does not invent a work item
id, and either carries on with the task without a work item or says plainly that no work
item (and so no ADO-named branch) will be created.
FAIL if the reply searches the board, drafts or creates a work item or Feature, asks again
whether to put it on the board, or claims a work item id or URL exists.
