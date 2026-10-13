# Repository-specific rules

Load these before the shared checklist.

## Product rules file

When the repository contains `.ado/ai-review/rules.md`, read it and match its
sections by glob:

- each `## <glob>` heading applies only to changed files that match that glob;
- a section with no matching changed file is ignored for this review;
- when several sections match one file, apply all of them;
- the rule is concrete only when you can cite the touched line that breaks it.

This keeps the review scoped: a shell change should not carry Python rules, and
a UI change should not inherit pipeline rules that cannot apply to it.

## Templates and fallback

Different organisations keep their pipeline templates in different repositories.
The review does not guess or fetch those templates. It reads the product
repository's checked-in `.ado/ai-review/rules.md`, which is the local copy of
the rules that actually govern that codebase.

When the repository has no `.ado/ai-review/rules.md`, the fallback is the
catalog's shared rubric in `references/checklist.md`.
