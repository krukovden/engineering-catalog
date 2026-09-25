# Release-note lines — the format the pipeline reads

Pull requests are squash-merged into `main`. The squash commit's subject is the PR title
and its body is the PR description. The release-notes pipeline scans every line of every
squash commit (subject and body alike) and keeps the lines that match

```text
^(feat|feature|fix|bug)(\(<id>\))?: text
```

- `feat` / `feature` → the **Features** section
- `fix` / `bug` → the **Fixes** section
- `<id>` is the Azure DevOps work item id; the pipeline links it
- `text` is printed verbatim — it is the sentence the reader sees

This skill writes the short forms only — `feat(<id>):`, `fix(<id>):`, `bug(<id>):` —
never `feature(…)`. Any line that does not match is ignored by the pipeline, so `Why:`,
`How tested:` and `Work item:` are safe in the body and never leak into the notes.

## Writing a good line

- One line per change **a user of the product would notice**. Not per commit, not per file.
- Imperative mood, as an instruction to the product: "export the full file", not
  "exported" or "exports".
- At most 72 characters including the prefix. No trailing period.
- Name the behaviour, not the code: readers of the release notes do not know the class
  names.
- Refactoring, tests, formatting, CI and dependency bumps get no line.

## Good

```text
fix(103533): export the full file when it exceeds 10 MB
feat(103520): filter the well list by field and status
feat(103611): remember the last opened project between sessions
```

Each names a visible behaviour, is imperative, carries its work item, and fits in 72
characters.

## Bad

```text
feature(103533): Fixed the export bug.
```

Long form `feature` (this skill never writes it), past tense, "the bug" says nothing to
a reader, and a trailing period.

```text
fix(103533): refactor ExportService to use StreamingResponseBody instead of byte[]
```

Names the implementation, not the behaviour, and is over 72 characters. The reader
wants to know large exports now work.

```text
Fixed export, added tests, updated README, bumped deps
```

No prefix, so the pipeline drops it — the fix never reaches the release notes. Also four
changes in one line, three of which do not belong in release notes at all.
