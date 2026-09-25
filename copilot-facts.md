# GitHub Copilot CLI — what this repository has verified

The Copilot side of this catalog leans on behaviour that either is not documented or is
documented wrongly. Every line below is either **captured live** against a named CLI version or
**read from GitHub's own reference** on a named date, and each says which. Code that depends on
one of these facts cites this file instead of restating it.

When a fact here and the CLI's `--help` disagree, the live capture wins — that is why the capture
is recorded at all. Re-verify a live-captured row before trusting it on a much newer CLI.

---

## 1. Running a case (live, Copilot CLI 1.0.83–1.0.85)

| Fact | Consequence for `scripts/eval/copilot.js` |
|---|---|
| `--plugin-dir` does **not** load plugin skills at all | The only path that works is installing the *global* layout (`<home>/.copilot/skills`, `<home>/.copilot/agents`) straight through `lib/install.js`. No CLI is involved in the install. |
| `-C <dir>` is documented but errors at runtime | The child process's own `cwd` is used instead. |
| `--usage-output-file` is documented but broken | Never passed — the `result` event on stdout already carries everything it would have written. |
| There is no `max_turns` equivalent | `timeout_seconds`, enforced by killing the process, is the only limit this arm can honour. That is also why a containerized Copilot run must keep its wall-clock kill (`scripts/eval/isolation.js`). |
| Installing into a real project directory triggers an interactive "Trust this directory?" prompt | Installing into a throwaway `HOME` sidesteps it entirely. |
| `gh auth token` inherits whatever `HOME` its process sees | It must be captured in the parent's **real** environment, once per compare, *before* any fake `HOME` exists. Building a shell command that sets `HOME=<tmp>` first makes `gh` look in the wrong keychain and fail. |

### Tool names for `--available-tools`

A case names its tools in Claude vocabulary; the CLI wants its own. The map lives in
`scripts/eval/graders.js` (`TOOL_MAP`) and is asserted row by row in `test/eval-graders.test.js`:

| Claude | Copilot |
|---|---|
| `Skill` | `skill` |
| `Bash` | `bash` |
| `Read` | `view` |
| `Glob` | `glob` |
| `Grep` | `rg` |

`report_intent` and `skill` are available to every run regardless of what a case asks for:
`report_intent` is Copilot's own reasoning-display mechanism and was never a case-grantable tool,
and without `skill` no skill loads at all.

### `--output-format json` is JSONL, not one document

One JSON object per line. The events this harness reads: `tool.execution_start` (`toolCallId`,
`toolName`, `arguments`), `tool.execution_complete` (`toolCallId`, `success`),
`assistant.message` (`content`), `assistant.turn_start`, and `result` (`exitCode`, `usage`).
A run with no `result` event is a crash, not a zero score — see `classifyInvalid`.

Captured fixtures: `test/fixtures/eval/copilot-run.jsonl` (clean run),
`test/fixtures/eval/copilot-crash.jsonl` (killed mid-tool).

---

## 2. Installing skills (live, Copilot CLI 1.0.83)

`disable-model-invocation: true` hides a skill from the model **and** from `/name`. Copilot has no
user-invocation dialect, so the Copilot adapter omits the flag and a user-invoked skill's
`description` says in words that it only runs when asked. This is why `lib/adapters/copilot.js`
and `lib/adapters/claude.js` differ on exactly one line.

Copilot runs plugin hooks with `cwd` = the plugin root and exports `COPILOT_PLUGIN_ROOT` and
`COPILOT_PROJECT_DIR`, which is why the generated hook command steps into the project dir first.

---

## 3. Model policy (live, this organization)

Copilot Business policy here refuses Anthropic, Google and xAI models, and `gpt-5.5`/`gpt-5.6`,
at the server. The cells pinned in `evals/eval.config.json` are what the policy actually allows —
a model id that works on a personal seat may not work here.

---

## 4. Hooks (GitHub reference, read 2026-09-17)

Source: <https://docs.github.com/en/copilot/reference/hooks-reference> and
<https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks>.

**Location.** Repository hooks: `.github/hooks/<name>.json`. Personal hooks:
`~/.copilot/hooks/*.json`.

**Shape.** A `"version": 1` key and a `"hooks"` wrapper are both required. A file that omits
either does not load, and nothing announces that it did not:

```json
{
  "version": 1,
  "hooks": {
    "postToolUse": [
      { "type": "command", "command": "node .github/hooks/example.js", "matcher": "Edit|Write", "timeoutSec": 5 }
    ]
  }
}
```

**Events.** `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `userPromptTransformed`,
`preToolUse`, `postToolUse`, `postToolUseFailure`, `preCompact`, `permissionRequest`, `agentStop`,
`subagentStart`, `subagentStop`, `errorOccurred`, `notification`. PascalCase spellings are
accepted for VS Code compatibility.

**Command fields.** `bash`, `powershell`, `command` (cross-platform fallback), or `exec` + `args`
(CLI only, mutually exclusive with the other three), plus `cwd`, `env`, `timeoutSec`.

**Matchers are the trap.** A matcher is a case-sensitive regex anchored as `^(?:PATTERN)$`. The
reference says a token fires when it equals the **runtime** tool name *or* its **Claude**
equivalent — but the second half of that does not hold on 1.0.85; see §6.1, which is the row to
trust. The mapping is still worth having, because it names every runtime variant to cover:

| Runtime tool(s) | Claude name |
|---|---|
| `bash`, `powershell` | `Bash` |
| `view` | `Read` |
| `create` | `Write` |
| `edit`, `str_replace_editor`, `apply_patch` | `Edit` |
| `grep`, `rg` | `Grep` |
| `glob` | `Glob` |
| `web_fetch` | `WebFetch` |
| `web_search` | `WebSearch` |
| `ask_user` | `AskUserQuestion` |
| `update_todo` | `TodoWrite` |
| `task` | `Agent` |

A matcher must therefore spell out the runtime names —
`create|edit|str_replace_editor|apply_patch` — and not the two Claude names that would cover them
on paper. Note that this table is **not** the `--available-tools` table in §1: that one takes
runtime names only, and so, in practice, does a matcher.

**`postToolUse` payload** (camelCase form): `sessionId`, `timestamp`, `cwd`, `toolName`,
`toolArgs`, `toolResult`. `toolArgs` is typed `unknown` in the reference — the shape is not
specified and may arrive as a JSON string — which is why `.github/hooks/remind-rebuild.js` parses
defensively and tries several plausible path keys.

### 4.1 Denying a tool call (GitHub reference, read 2026-09-21)

Source: same two pages as above. A `preToolUse` hook denies the call with a flat JSON object on
stdout — no `hookSpecificOutput` wrapper, that is Claude's shape only:

```json
{ "permissionDecision": "deny", "permissionDecisionReason": "explanation of why denied" }
```

`permissionDecisionReason` is required when the decision is `deny`. Exit code 2 denies the call
regardless of what stdout says — even a JSON `permissionDecision: "allow"` is overridden — and
any other non-zero exit also denies, with a generic "hook errored" reason instead of the one the
hook wrote. A hook that times out is the one exception: `preToolUse` fails **open** on a timeout,
logging a warning and letting the call proceed. This is doc-sourced only, unlike §6 — it has not
yet been captured live against a running Copilot CLI, so `.github/hooks/block-generated.js`
(which relies on it) carries the same caveat and should be re-verified live before being trusted
on a materially newer CLI.

---

## 5. Instruction files (GitHub reference, read 2026-09-17)

Source:
<https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions>.

Copilot CLI reads and **merges** all of these, with **no defined precedence order** between them:

- `$HOME/.copilot/copilot-instructions.md`
- `$HOME/.copilot/instructions/**/*.instructions.md`
- `.github/copilot-instructions.md`
- `.github/instructions/**/*.instructions.md`
- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`
- any directory named in `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`

Two consequences for this repository. First, Copilot CLI reads `AGENTS.md` (the contract) and
`CLAUDE.md` (a one-line `@AGENTS.md` import) both natively, so the contract already reaches
Copilot without being duplicated — `.github/copilot-instructions.md` only needs to carry what
is genuinely Copilot-specific; it also carries its own `@../AGENTS.md` pointer (§5.1) for any
Copilot surface that reads only this file and not `AGENTS.md` independently. Second, because
nothing defines precedence, conflicting instructions across these files are a real hazard
rather than a resolved override: keep them consistent instead of relying on one to win.

### 5.1 `@` file references (live, Copilot CLI 1.0.87)

The same reference page states, without a live capture behind it before this entry: in
`.github/copilot-instructions.md`, `AGENTS.md`, or `CLAUDE.md`, `@` followed by a relative path
includes another file, recursively, with absolute paths and `~/`-paths rejected and no
expansion inside `GEMINI.md` or `*.instructions.md`. Verified live in three throwaway repos:

- `@imported.md` inside a root `AGENTS.md` — the imported file's content reached the model
  (a planted token round-tripped through `copilot -p`).
- `@shared-contract.md` inside `.github/copilot-instructions.md`, with the target at the repo
  root — did **not** expand. The model's own reasoning trace showed it saw the literal
  `@shared-contract.md` text and treated it as inert prose, not a directive.
- The same reference, retargeted to `.github/shared-contract.md` (same directory as
  `copilot-instructions.md`) — expanded correctly. Confirmed again with `@../AGENTS.md` from
  `.github/copilot-instructions.md` reaching the repository-root `AGENTS.md`.

So a `@` reference resolves relative to **the file that contains it**, not the repository
root — the opposite of what the reference page's phrasing ("a relative path") leaves ambiguous,
and the reason this repository's own `.github/copilot-instructions.md` writes `@../AGENTS.md`,
never bare `@AGENTS.md`. `CLAUDE.md`'s expansion and the `GEMINI.md`/`*.instructions.md`
exclusion are doc-sourced only here, not independently live-tested.

---

## 6. Hooks, captured live (Copilot CLI 1.0.85)

§4 is GitHub's reference. This section is what the CLI actually did, on 2026-09-17, in a
throwaway git repository with one `.github/hooks/probe.json`. Each row was wrong or unstated in
the reference, and each one fails **silently** — the hook simply has no effect and nothing says
so. That is why they are captured rather than assumed.

### 6.1 A matcher matches the runtime name only

`{"matcher": "Edit|Write"}` on `postToolUse` never fired while the model created a file.
`{"matcher": "create|edit|str_replace_editor|apply_patch"}` fired on the same prompt. A run with
no matcher at all reported `toolName: "create"`.

So the reference's "runtime name *or* Claude equivalent" is not what 1.0.85 does, and the
Claude-name spelling is the one that looks right and does nothing.

### 6.2 Stdout is read as JSON; plain text is dropped

Three `sessionStart` runs, same repository, same prompt ("print the unusual token you were given"):

| Hook stdout | Debug log | What the model saw |
|---|---|---|
| `{"additionalContext": "ZORBLAT-JSON-7781 …"}` | `[hook stdout] {"additionalContext": …}` | the token |
| `ZORBLAT-PLAIN-9932 …` (plain) | `[hook stdout] ZORBLAT-PLAIN-9932 …` | `NONE` |
| `{}` | `[hook stdout] {}` | nothing, as intended |

The hook ran in every case — the plain-text run also wrote its marker file. Its output was
captured, logged, and discarded. The same holds for `postToolUse`, where `additionalContext`
reached the model after the write.

This is the one place the two CLIs genuinely differ: Claude Code adds a `SessionStart` hook's
**plain** stdout to the session as context, so one script has to produce both shapes. `lib/hooks.js`
renders the Copilot command with the flag that asks for the JSON one, and `test/hooks.test.js`
asserts on what each host consumes rather than on the bytes, because the bytes are identical.

### 6.3 Repository hooks load only in a trusted folder

With the repository absent from `trustedFolders` in `~/.copilot/config.json`, the hook did not
run at all: no marker file, no `[hook stdout]` line, only the personal hooks from
`~/.copilot/hooks/`. Adding the path to `trustedFolders` and changing nothing else made the same
hook run on the next invocation.

A dev-side repository hook is therefore per-machine opt-in, and its absence is indistinguishable
from a hook that ran and stayed quiet. Never let one be the enforcement for anything.

### 6.4 The `postToolUse` payload, as it actually arrives

```json
{ "sessionId": "…", "timestamp": "…", "cwd": "/abs/path",
  "toolName": "create", "toolArgs": { "path": "/abs/path/hello.txt", "file_text": "hi\n" },
  "toolResult": … }
```

`toolArgs` arrived as an **object**, not the JSON string §4 warns it might be. Both are still
handled in `.github/hooks/remind-rebuild.js`: the reference types it `unknown`, and one capture
of one tool does not make that a guarantee.

### 6.5 Two hooks that both speak cancel each other out

Four runs on the same prompt, varying only how many `sessionStart` hooks returned a non-empty
`additionalContext`:

| Hooks returning context | `[hook stdout]` in the debug log | What the model saw |
|---|---|---|
| repository (`.github/hooks/`) only | the payload | the token |
| plugin (installed catalog) only | the payload | the line, quoted back verbatim |
| both | **both** payloads | `NONE` |

A hook that returns `{}` does not count — the personal hooks in `~/.copilot/hooks/` returned `{}`
throughout and delivery worked. So it is not "a plugin hook cannot speak" and not "headless drops
context": **two or more hooks answering the same event with `additionalContext` lose all of it.**
Every payload is still run, still captured, still logged. Nothing reports the loss.

This is the same failure §6.2 records, one layer up, and it is worse: §6.2 is ours to fix, this
one fires because of a hook we do not own, in a repository we did not write, on a machine we
never see. Treat a `sessionStart` message as best-effort delivery. Nothing may depend on it
arriving.

## 7. Plugin installation (live, Copilot CLI 1.0.85)

The catalog installed as a real plugin, from this repository's own `marketplace.json`, both from
a local directory and from the Azure DevOps URL:

```
copilot plugin marketplace add https://github.com/krukovden/engineering-catalog
copilot plugin install engineering-catalog@engineering-catalog
```

What loaded, and how it is named:

- **Skills are flat, agents are namespaced.** The catalog's skills joined the session's global
  skill list under their bare names — `memory`, `catalog-freshness`, `ado-credentials`,
  `memory-init`, and the workflows installed as skills. The agents arrived as
  `engineering-catalog:code-reviewer`, `:qa-triage`, `:memory-writer`. Claude Code namespaces
  both (`/engineering-catalog:memory`). So a skill name is a claim on a name shared with every
  other plugin the person has installed, and `memory` is the one most likely to be claimed twice.
- **A local-directory marketplace is loaded live, never copied.** `plugin list` says so:
  "loaded live from …, so edits take effect on the next session — nothing was copied." A URL
  marketplace copies into `~/.copilot/installed-plugins/`.
- **A bare repository URL still installs** but warns: "Direct plugin installs (repos, URLs,
  local paths) are deprecated. Only `plugin@marketplace` installs will be supported in a future
  release."
- **There is no repository-level pre-configuration.** Marketplaces and installed plugins live in
  `~/.copilot/config.json` (`installedPlugins`), per person. Claude Code's
  `extraKnownMarketplaces` / `enabledPlugins` in `.claude/settings.json` has no counterpart.
- **Agent Plugins 1.0 is Copilot's, not Claude's.** A manifest whose `$schema` is
  `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` gets fixed discovery —
  `skills/<name>/SKILL.md` one level deep, agents and hooks under `com.github.copilot/`. Claude
  Code's reference does not mention the standard. Adopting it would flatten the owner-folder axis
  (`skills/shared/memory/`) that the whole ownership model rests on, to gain nothing on Claude.
  Legacy manifests — what this repository ships — keep configurable paths and are what loaded
  above.
