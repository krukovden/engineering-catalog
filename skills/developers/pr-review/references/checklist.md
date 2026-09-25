# Review checklist

Apply the rules in this order. Correctness comes first because a beautifully
structured change that returns the wrong answer is still wrong; style comes last
because it never blocks a merge on its own. Each rule says how to recognise a
violation and what severity it carries by default — calibrate with rule 10.

Every finding is `file:line — what — why — how to fix`. "Why" means the input,
state or sequence that makes it fail, or the concrete rule it breaks. A finding
without one is an opinion; leave it out or put it under Unverified.

## 1. Correctness first

Bugs, races, error handling, boundaries.

- **Recognise:** an off-by-one at a boundary; a null or empty input the code never
  considered; an error caught and swallowed, or a failure path that leaves state
  half-written; two writers to one resource with nothing serialising them; a retry
  without a cap; a result that is right for the happy path and wrong for the one
  the tests skip.
- **Say:** the file:line and the exact input or state that breaks it. "This could
  fail" is not a finding; "an empty list reaches line 42 and `items[0]` throws" is.
- **Severity:** wrong result or data loss → Critical; wrong behaviour on a real
  input → Important; a theoretical edge nobody can reach → Minor.

## 2. Do not trust the description

Verify every claim in the commit messages and the PR description against the code.

- **Recognise:** "tested locally" with no test in the diff; "no behaviour change"
  next to a changed condition; "kept simple per YAGNI" — that is a claim about a
  decision, not a rationale for it; "handles the error" where the handler only logs.
- **Say:** the claim, where the code contradicts it, and what the code actually does.
- **Severity:** a claim that would have hidden a Critical or Important finding
  carries that finding's severity; a harmless overstatement is Minor.

## 3. Security

- **Recognise:** a secret, token or connection string in code or config; input from
  a request, a file or an environment variable used in a shell command, a query or a
  path without validation; credentials, tokens or personal data written to a log;
  an external response trusted as if the process wrote it.
- **Say:** the sink (what the untrusted value reaches) and the source (where it came
  from), both with file:line.
- **Severity:** Critical.

## 4. Reuse and simplification

- **Recognise:** the same logic written twice in the diff, or once in the diff and
  once already in the repository; a helper introduced for one caller when an existing
  one would do; an abstraction with a single implementation; code that nothing
  reaches any more after this change.
- **Say:** the two places (or the existing helper) with file:line, and the one that
  should survive.
- **Severity:** Important when a future fix would have to land twice; otherwise Minor.

## 5. SOLID — recognisable violations only

Name the principle only when the symptom is concrete. Do not audit the whole design.

- **SRP:** a module or class with two reasons to change — persistence and
  formatting in one file, a handler that also parses config.
- **OCP:** a `switch` or `if` chain on a type or kind where a polymorphic call already
  exists on that type.
- **LSP:** a subclass or implementation that weakens the contract — throws where the
  parent returns, ignores an argument the parent honours, returns null where the
  parent never does.
- **ISP:** an interface whose clients each use a fraction of it, forcing stubs.
- **DIP:** high-level code importing a concrete low-level module — a database client,
  an HTTP library — that it could take as a parameter.
- **Severity:** Important when it makes the change fragile or hard to test; Minor when
  it is contained.

## 6. KISS

- **Recognise:** a solution more complex than the problem it solves; configurability
  nobody asked for (a flag with one value in use); three layers where one would do;
  a generic engine built to run one case.
- **Say:** the simpler shape that would meet the same requirement.
- **Severity:** Important when the complexity hides behaviour; otherwise Minor.

## 7. YAGNI

- **Recognise:** code nothing calls; parameters nothing passes; a branch marked "for
  later" or guarded by a condition that cannot be true today; a type with fields
  nothing reads.
- **Say:** the unused element and the evidence it is unused (the search you ran).
- **Severity:** Minor — unless the unused code is also a maintenance trap, then
  Important.

## 8. Small files and functions

Thresholds, applied to the state of the file after the change
(`scripts/file-sizes.sh` prints them):

- A new or grown file **over 300 lines** → Important, unless the PR description says
  why it must be one file.
- A file **over 500 lines** → Important, always.
- A function **over 50 lines** → Minor.
- A file that mixes two responsibilities → an SRP finding (rule 5), regardless of
  size.

## 9. Tests

- **Recognise:** a test that asserts on a mock's call rather than on the behaviour
  the user sees; a test with no assertion (it passes because nothing checks); a
  change to error handling, boundaries or concurrency with no test on that edge; a
  test that prints, warns or leaves files behind — pristine output is part of the
  contract.
- **Say:** which behaviour of the change has no test, or which test would still pass
  if the code were wrong.
- **Severity:** a test that cannot fail → Important; a missing edge-case test →
  Important when the edge is one the change introduced, otherwise Minor. "Could have
  more tests" is always Minor.

## 10. Calibration

- **Critical** — data loss, a security hole, a wrong result. Blocks the merge.
- **Important** — wrong or fragile behaviour, a missed requirement, or maintainability
  you would block a merge over.
- **Minor** — polish. Worth a line, never a blocker.

Praise what is done well, specifically, before the list: the test that catches the
regression, the helper that removed three copies, the commit that was split cleanly.
Vague praise is padding; skip it.

Do not pad with style nits when there are real findings. If the only findings are
Minor, say so in the verdict.

## Report format

```markdown
### Verdict
Approve | Fix first — one sentence saying why.

### Strengths
- Specific, with file:line where it applies.

### Findings
#### Critical
- `path/to/file.ts:42` — what — why (the input or rule) — how to fix
#### Important
- ...
#### Minor
- ...

### Unverified
- A claim or suspicion the reviewer could not confirm from the code, with what would
  confirm it. Never stated as a finding.
```

An empty severity group is omitted. An empty Findings section means Approve.
