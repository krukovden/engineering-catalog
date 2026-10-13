---
name: implementation-discipline
description: "Developer reference for implementation work — verify sub-agent diffs, re-run affected tests after base merges, think before coding, and keep a single source of truth. Use when the user asks for implementation discipline or coding principles, or when checking a sub-agent diff or what to do after merging main into a branch."
---

# Implementation Discipline

Behavioral principles for implementation work: diff verification, coding discipline, and testing discipline.

Principles §3–6 are derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876) on common LLM coding failures.

## 1. Verify Sub-Agent Reports Against the Diff (CRITICAL)

**Sub-agent summaries describe what they intended to do — not necessarily what they did.**

When an orchestrator or developer delegates implementation to a sub-agent and the sub-agent returns a completion report, the report is unreliable as a sole source of truth. Sub-agents have been observed to:
- Report "no files changed" while their working tree contains substantial uncommitted changes.
- Report a narrow file list (e.g. "only README modified") while the diff touches unrelated files in scope.
- Mutate session state or introduce unintended edits, formatting changes, or side effects without mentioning them.

Before trusting a sub-agent's completion summary, the orchestrator MUST:
1. Run `git status --short` to inspect all staged, unstaged, and untracked changes.
2. Run `git diff --stat` to confirm file counts and line deltas match the report.
3. For each file the sub-agent claimed to modify, verify it appears in the diff and that the diff matches the claim.
4. For each file in the diff that the sub-agent did NOT claim to modify, decide: intentional (keep) or accidental (revert before commit).
5. If unexpected state is found (untracked files, modified files outside delegated scope), stop and reconcile before committing.

**The diff is authoritative; the report is auxiliary.**

## 2. Re-Run Affected Tests After Mid-Cycle Base Merge (CRITICAL)

**When merging `main` or the base branch into a working branch mid-cycle, re-run the affected test group before continuing new work.**

A base merge can introduce silent regressions or broken contracts in the same domain even when `git merge` succeeds with zero textual conflicts (e.g., an upstream signature change or behavior shift in a dependency). A quick targeted test run surfaces these before the next commit compounds the scope.

## 3. Think Before Coding (Karpathy §1)

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before writing code:
- State assumptions explicitly. If uncertain about requirements or scope, ask.
- If multiple interpretations exist, present them — do not pick silently.
- If a simpler approach exists, propose it. Push back when warranted.
- If something is unclear, stop, name what is confusing, and clarify.

## 4. Single Source of Truth (Karpathy §2)

**Every concept lives in exactly one place. Find it, reuse it, extend it.**

LLMs fail more often by duplicating logic than by over-abstracting. The primary discipline is DRY:
- Search for existing implementations of a concept before writing new code.
- If a pattern exists, follow it. Do not rewrite a "simpler" version in your file.
- If two tasks need the same logic, extract it into a shared location immediately — do not write it twice planning to "clean up later".
- When modifying behavior, change it in the one place it lives. Consolidate duplicated logic first.

**The Duplication Test:** Before committing, ask: *"If this behavior needs to change tomorrow, how many files do I touch?"* If more than one, you have a duplication problem.

**Speculative Feature Detection:** Guard against building things nobody asked for:
- No features beyond what was requested.
- No defensive handling for impossible scenarios.
- No "flexibility" or "configurability" that was not asked for. Three concrete uses justify an abstraction; one does not.

## 5. Surgical Changes (Karpathy §3)

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Do not "improve" adjacent code, comments, or formatting.
- Do not refactor things that are not broken.
- Match existing style, even if you would write it differently.
- If you notice unrelated dead code, mention it — do not delete it in the same change.
- Remove imports, variables, and functions that YOUR changes made unused; do not delete pre-existing dead code unless asked.

**The Test:** Every changed line must trace directly to the user's request.

## 6. Goal-Driven Execution (Karpathy §4)

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → write tests for invalid inputs, then make them pass.
- "Fix the bug" → write a test that reproduces it, then make it pass.
- "Refactor X" → ensure tests pass before and after.

For multi-step tasks, state a brief plan with verifiable checkpoints:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

## 7. Command-Specific Git Operand Safety

When a subprocess passes a user-controlled branch, ref, or path to git, match the guard to the command:

- **Validate branch names before switching branches:**
  ```sh
  git check-ref-format --branch "$branch"
  git switch "$branch"
  ```
- **Use `--end-of-options` only on commands that support it** when the operand is a ref-like token, for example:
  ```sh
  git show --end-of-options "$ref"
  ```
- **Use `--` only when the command is switching from refs/options to paths**, for example:
  ```sh
  git checkout -- "$path"
  ```

Do not cargo-cult one sentinel into every git command. Branch switches need branch-aware commands; path operations need path separators.

## When NOT to use

- Trivial single-line typo, documentation, or comment fixes where multi-step verification and hypothesis generation overhead is unwarranted.
- Purely exploratory prototyping in a temporary scratchpad where code will not be committed or merged.
