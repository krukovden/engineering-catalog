# Subagent Encapsulation and Diff Verification

When an orchestrator coordinates subagents, clear encapsulation and empirical verification prevent context bloat and unverified completion claims.

## The Three-Part Dispatch Contract

An orchestrator dispatches a subagent using strictly three items:

1. **Instruction path**: The file path the subagent must read and follow (e.g. an SOP or step instructions file).
2. **Structured inputs**: The parameters or arguments the subagent needs to perform the work.
3. **Return contract**: The path to the schema or contract defining the structured report the subagent must return.

### Boundary Rules

- **Never inline task instructions into the spawn prompt.** Put instructions in the referenced step file; the spawn prompt should only state the instruction path, inputs, and return contract.
- **The orchestrator never reads internal draft artifacts.** Intermediate files created by the subagent (e.g. `plan.md`, `draft.md`, scratchpads) remain inside the subagent's context. The structured return report is the orchestrator's only routing surface.
- **The subagent never reads orchestrator routing logic.** Cross-file links from a subagent's instruction file back to orchestrator routing files leak the boundary and must be stripped.
- **Sequencing belongs to the orchestrator; execution belongs to the subagent.** If the orchestrator is reading detailed step execution instructions, dispatch the subagent instead.

## Verifying Claims Against the Diff

Sub-agent completion reports describe what they *intended* to do — not necessarily what they did. Even passing reports can omit unintended edits, leave uncommitted changes, or miss files entirely. The git diff is authoritative; the report is auxiliary.

Before accepting a subagent's completion report, the orchestrator must execute this 5-step verification:

1. **Check working tree status**: Run `git status --short` to identify every modified, untracked, and deleted file.
2. **Inspect diff statistics**: Run `git diff --stat` to verify file counts and line deltas align with the reported work.
3. **Verify claimed files**: Confirm each file the subagent claimed to modify appears in the diff.
4. **Inspect unclaimed changes**: For every file appearing in the diff that the subagent did not claim to touch, evaluate whether the change is intentional (keep and commit) or accidental (revert).
5. **Reconcile unexpected state**: If untracked files or changes outside the delegated scope exist, resolve them before committing.
