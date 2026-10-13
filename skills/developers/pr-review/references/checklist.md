# Review checklist

Apply the rules in this order. Load repository-specific rules first as
`references/rules.md` defines, then apply this shared rubric. Correctness comes
first because a beautifully structured change that returns the wrong answer is
still wrong.

Every finding is `file:line — what — why — how to fix`. "Why" means the exact
input, state, sequence, or concrete rule that makes it fail. No trigger and no
broken rule means no finding.

## 1. Severity

Use these buckets exactly:

| Severity | Meaning | Criteria |
|---|---|---|
| **CRITICAL** | Must fix before merge | Wrong result, security hole, data loss, broken functionality, or a must-have acceptance criterion left unimplemented |
| **HIGH** | Should fix before merge | A real defect risk under a plausible input or state, a touched acceptance criterion this change does not satisfy, or an unhandled boundary failure |
| **MEDIUM** | Worth fixing | Maintainability, a limited-impact edge case, or changed behaviour with no convincing test |
| **LOW** | Optional | Style, naming, formatting, or a small cleanup with little risk |

Formatting and naming are never `CRITICAL` or `HIGH`.

## 2. Evidence bar and findings discipline

- **Cite or drop.** Every finding cites the touched code with `file:line`. If
  the exact line cannot be named, it is not a finding.
- **Trigger or rule.** Every finding names the input, state, sequence, or
  concrete repository rule that makes it wrong. "This looks fragile" is not a
  finding. No concrete failure scenario means it belongs under **Unverified** as
  a question, not under Findings.
- **Low confidence goes to Unverified.** Do not silently drop a plausible
  concern. Move it to **Unverified** with what would confirm or refute it.
- **More than five `LOW` findings become one pattern.** Cite each instance in
  that single pattern observation instead of listing six nits.
- **Zero findings on a non-trivial scope means re-examine.** Make a second pass
  before returning a clean review.
- **Flag only what the change touched.** A pre-existing complexity spike,
  duplicate, or architectural issue stays out unless the changed code depends on
  it directly.
- **Read-only includes git state.** Never `checkout`, `switch`, `restore`,
  `reset`, or `stash` in a shared tree. Read other refs with `git diff`,
  `git show`, and PR metadata commands.

## 3. Correctness and claims

Bugs, races, error handling, boundaries, and author claims all land here.

- **Recognise:** off-by-one errors; null or empty inputs the code never
  considered; swallowed failures; retries with no cap; claim/behaviour mismatches
  such as "no behaviour change" beside a changed condition.
- **Say:** the exact trigger, where it breaks, and what the code actually does.
- **Severity:** wrong result or data loss → `CRITICAL`; wrong behaviour on a
  plausible input → `HIGH`; limited-impact edge case → `MEDIUM`.

## 4. Reuse and simplification

Run the simplification lenses inline. Do **not** rely on Claude's `/simplify`.
There is no efficiency lens here.

- **Reuse:** the same logic written twice in the diff, or once in the diff and
  once already in the repository; a new helper where an existing one would do.
- **Quality:** redundant state, parameter sprawl, copy-paste with slight
  variation, dead code after the change, stubs and TODO-shaped scaffolding.
- **Altitude:** an abstraction at the wrong level — a concept derived in three
  places that should be named once, or a duplicated invariant that should live
  with the thing it describes.
- **Severity:** a future fix landing twice, or complexity that hides behaviour →
  `HIGH`; otherwise `MEDIUM` or `LOW`.

When the same duplicate pattern spans several touched files, report it once with
all of its citations.

## 5. Security, architecture, and traceability

- **Security:** untrusted input flowing into a shell command, query, path, or
  log without validation; secrets or credentials in code or config.
- **Architecture compliance:** judge against the touched work item's acceptance
  criteria and, when present, `docs/blueprint/<area>.md`. A missing layer
  boundary, wrong dependency direction, or skipped required component is a
  finding only when the touched change should have satisfied that contract.
- **Traceability:** if the change claims to satisfy an acceptance criterion,
  point to the code and the proving test. A touched criterion with no proving
  code or no convincing test is a finding.
- **Severity:** security hole or must-have architectural/acceptance miss →
  `CRITICAL` or `HIGH`; looser maintainability drift → `MEDIUM`.

## 6. Tests, code quality, and size

- **Tests:** a changed behaviour with no meaningful assertion; a boundary or
  error path added here with no test; a test that would still pass if the code
  were wrong.
- **Code quality:** TODOs in live code, dead branches, unreachable paths,
  scaffolding, or error handling that only logs and continues.
- **Size thresholds:** `scripts/file-sizes.sh` prints them from the reviewed
  range. A new or grown file over **300 lines** is `HIGH` unless the PR
  explains why it must stay whole; over **500 lines** is always `HIGH`. A
  function over **50 lines** is `LOW` unless it also creates a clearer
  maintainability problem.

Do not ask for tests in the abstract. Name the missing changed behaviour or the
test that cannot fail.

## 7. Verify pass

Before finalising the report, reopen each cited file and check every draft
finding against the whole file, not only the diff hunk.

- The full file confirms it → keep the finding.
- The full file refutes it → drop it.
- The full file still leaves it uncertain → move it to **Unverified**.

This verify pass is mandatory. A plausible finding that the whole file disproves
must not survive.

## 8. Report format

Praise what is done well, specifically, before the list: the test that catches
the regression, the helper that removed three copies, the clean split of a
change. Vague praise is padding; skip it.

```markdown
### Verdict
Approve | Fix first — one sentence saying why.

### Strengths
- Specific, with file:line where it helps.

### Findings
#### CRITICAL
- `path/to/file.ts:42` — what — why (the input, state, sequence, or rule) — how to fix
#### HIGH
- ...
#### MEDIUM
- ...
#### LOW
- ...

### Unverified
- A low-confidence item, question, or missing trigger that the reviewer could not
  confirm from the code, with what would confirm or refute it.
```

Empty severity groups are omitted. An empty Findings section means Approve.
