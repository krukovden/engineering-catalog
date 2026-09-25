#!/usr/bin/env node
'use strict';
// Drift check between this repository's own Claude Code dev-side config and its GitHub
// Copilot CLI dev-side twin. Claude Code is the source of truth: when the two disagree,
// the fix is almost always to bring Copilot's side back in line, not the reverse.
//
// This is repo-local dev tooling. It never touches skills/, agents/, workflows/, bundles/
// and is not part of `npm run build` — those own the catalog's shipped artifacts, this
// owns the two hand-written dev-side hook twins AGENTS.md documents as "deliberately
// outside the generator".
//
// Tested by test/coding-agent-parity.test.js, not by a `claude plugin eval` suite: this
// skill is `disable-model-invocation: true` (only a literal /name fires it — there is no
// model trigger-choice to measure) and is a bare `.claude/skills/` directory with no
// `.claude-plugin/plugin.json`, so it does not qualify as an eval target at all — per
// https://code.claude.com/docs/en/plugins-reference, a SKILL.md with no manifest is a
// "plain skill", and only a folder with the manifest is a "skills-directory plugin" that
// `claude plugin eval` can load. runChecks() below is exported so the test suite can run
// it against a synthetic root instead of duplicating its logic.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_ROOT = path.join(__dirname, '..', '..', '..', '..');

// Copilot only ever sees runtime tool names in a PostToolUse-equivalent matcher — `Edit|Write`
// never fires there, per copilot-facts.md §6.1 (captured live on Copilot CLI 1.0.85). So the
// two matchers are SUPPOSED to differ; this is the one known-good asymmetry, not drift.
const CLAUDE_MATCHER = 'Edit|Write';
const COPILOT_MATCHER = 'create|edit|str_replace_editor|apply_patch';
const SOURCE_PATH_REGEX = '/^(skills|agents|workflows|bundles)\\//';

const read = (root, p) => fs.readFileSync(path.join(root, p), 'utf8');
const readJson = (root, p) => JSON.parse(read(root, p));

function extractReminderMessage(src) {
  // Non-greedy + [\s\S] because the template literal itself contains escaped backticks
  // (`\`npm run build\``) — a `[^`]*` class would stop at the first one of those.
  const m = src.match(/Source unit changed[\s\S]*?before committing\./);
  return m ? m[0] : null;
}

function checkHookScripts(root, fail) {
  const claudeSrc = read(root, '.claude/hooks/remind-rebuild.js');
  const copilotSrc = read(root, '.github/hooks/remind-rebuild.js');

  const claudeMsg = extractReminderMessage(claudeSrc);
  const copilotMsg = extractReminderMessage(copilotSrc);
  if (!claudeMsg) fail('hook-scripts', '.claude/hooks/remind-rebuild.js: could not find the reminder message template — did it get rewritten?');
  if (!copilotMsg) fail('hook-scripts', '.github/hooks/remind-rebuild.js: could not find the reminder message template — did it get rewritten?');
  if (claudeMsg && copilotMsg && claudeMsg !== copilotMsg) {
    fail('hook-scripts', `reminder text has drifted:\n  claude:  ${claudeMsg}\n  copilot: ${copilotMsg}`);
  }

  if (!claudeSrc.includes(SOURCE_PATH_REGEX)) fail('hook-scripts', `.claude/hooks/remind-rebuild.js: expected the literal regex ${SOURCE_PATH_REGEX} — it changed shape`);
  if (!copilotSrc.includes(SOURCE_PATH_REGEX)) fail('hook-scripts', `.github/hooks/remind-rebuild.js: expected the literal regex ${SOURCE_PATH_REGEX} — it changed shape`);

  // Claude's shape is nested (hookSpecificOutput.additionalContext); Copilot's is flat
  // (additionalContext at the top level) — see copilot-facts.md §6.2. Only check that each
  // still writes JSON, not that the shapes match each other.
  if (!claudeSrc.includes('hookSpecificOutput')) fail('hook-scripts', '.claude/hooks/remind-rebuild.js: no longer emits hookSpecificOutput — Claude will not surface this to the model');
  if (copilotSrc.includes('hookSpecificOutput')) fail('hook-scripts', ".github/hooks/remind-rebuild.js: emits hookSpecificOutput — that's Claude's shape; Copilot reads a flat additionalContext (copilot-facts.md §6.2)");
}

function extractGeneratedList(src) {
  const m = src.match(/const GENERATED = \[[\s\S]*?\n\];/);
  return m ? m[0] : null;
}

function checkGuardScripts(root, fail) {
  const claudeSrc = read(root, '.claude/hooks/block-generated.js');
  const copilotSrc = read(root, '.github/hooks/block-generated.js');

  const claudeList = extractGeneratedList(claudeSrc);
  const copilotList = extractGeneratedList(copilotSrc);
  if (!claudeList) fail('guard-scripts', '.claude/hooks/block-generated.js: could not find the GENERATED pattern list — did it get rewritten?');
  if (!copilotList) fail('guard-scripts', '.github/hooks/block-generated.js: could not find the GENERATED pattern list — did it get rewritten?');
  if (claudeList && copilotList && claudeList !== copilotList) {
    fail('guard-scripts', 'the guarded-path list has drifted between the claude and copilot scripts — they must match, or the two platforms protect different files');
  }

  if (!claudeSrc.includes('permissionDecision')) fail('guard-scripts', '.claude/hooks/block-generated.js: no longer emits permissionDecision — Claude will not deny the edit');
  if (!copilotSrc.includes('permissionDecision')) fail('guard-scripts', '.github/hooks/block-generated.js: no longer emits permissionDecision — Copilot will not deny the edit');

  // Claude's deny payload is nested (hookSpecificOutput.permissionDecision); Copilot's is flat
  // (permissionDecision at the top level) — copilot-facts.md §4.1.
  if (!claudeSrc.includes('hookSpecificOutput')) fail('guard-scripts', '.claude/hooks/block-generated.js: no longer wraps output in hookSpecificOutput — that shape is required for Claude to read a PreToolUse decision');
  if (copilotSrc.includes('hookSpecificOutput')) fail('guard-scripts', ".github/hooks/block-generated.js: emits hookSpecificOutput — that's Claude's shape; Copilot's preToolUse deny is flat (copilot-facts.md §4.1)");

  if (!claudeSrc.includes('process.exit(2)')) fail('guard-scripts', '.claude/hooks/block-generated.js: no longer exits 2 on a match — PreToolUse only blocks on exit code 2');
  if (!copilotSrc.includes('process.exit(2)')) fail('guard-scripts', '.github/hooks/block-generated.js: no longer exits 2 on a match — preToolUse only denies unconditionally on exit code 2 (copilot-facts.md §4.1)');
}

function checkGuardWiring(root, fail) {
  const settings = readJson(root, '.claude/settings.json');
  const claudeHook = settings.hooks && settings.hooks.PreToolUse && settings.hooks.PreToolUse[0];
  if (!claudeHook) return fail('guard-wiring', '.claude/settings.json: no hooks.PreToolUse[0] — the generated-file guard is not wired up at all');
  if (claudeHook.matcher !== CLAUDE_MATCHER) fail('guard-wiring', `.claude/settings.json PreToolUse: matcher is "${claudeHook.matcher}", expected "${CLAUDE_MATCHER}"`);
  const claudeCmd = claudeHook.hooks && claudeHook.hooks[0] && claudeHook.hooks[0].command;
  if (!claudeCmd || !claudeCmd.includes('.claude/hooks/block-generated.js')) fail('guard-wiring', `.claude/settings.json: PreToolUse command does not invoke .claude/hooks/block-generated.js (got "${claudeCmd}")`);

  // The `if` prefilter is what lets Claude Code skip the Node spawn on an ordinary edit —
  // losing it silently degrades to "run on every Edit/Write", so check for a couple of the
  // GENERATED list's canaries rather than trusting the field merely exists.
  const claudeIf = claudeHook.hooks && claudeHook.hooks[0] && claudeHook.hooks[0].if;
  if (!claudeIf) fail('guard-wiring', '.claude/settings.json: PreToolUse hook has no `if` prefilter — block-generated.js will now spawn on every Edit/Write, not just candidate paths');
  else for (const canary of ['Edit(catalog.json)', 'Write(catalog.json)', 'Edit(skills/*/README.md)']) {
    if (!claudeIf.includes(canary)) fail('guard-wiring', `.claude/settings.json: PreToolUse \`if\` is missing "${canary}" — the prefilter no longer covers everything GENERATED does`);
  }

  const copilotManifest = readJson(root, '.github/hooks/block-generated.json');
  if (copilotManifest.version !== 1) fail('guard-wiring', `.github/hooks/block-generated.json: "version" is ${JSON.stringify(copilotManifest.version)}, must be 1 (missing/wrong version means Copilot never loads the file)`);
  const copilotHook = copilotManifest.hooks && copilotManifest.hooks.preToolUse && copilotManifest.hooks.preToolUse[0];
  if (!copilotHook) return fail('guard-wiring', '.github/hooks/block-generated.json: no hooks.preToolUse[0] — the generated-file guard is not wired up at all');
  if (copilotHook.matcher !== COPILOT_MATCHER) {
    fail('guard-wiring', `.github/hooks/block-generated.json: matcher is "${copilotHook.matcher}", expected the runtime-name list "${COPILOT_MATCHER}" (copilot-facts.md §6.1 — "Edit|Write" silently never fires here)`);
  }
  if (!copilotHook.command || !copilotHook.command.includes('.github/hooks/block-generated.js')) fail('guard-wiring', `.github/hooks/block-generated.json: command does not invoke .github/hooks/block-generated.js (got "${copilotHook.command}")`);
}

function checkHookWiring(root, fail) {
  const settings = readJson(root, '.claude/settings.json');
  const claudeHook = settings.hooks && settings.hooks.PostToolUse && settings.hooks.PostToolUse[0];
  if (!claudeHook) return fail('hook-wiring', '.claude/settings.json: no hooks.PostToolUse[0] — the reminder hook is not wired up at all');
  if (claudeHook.matcher !== CLAUDE_MATCHER) fail('hook-wiring', `.claude/settings.json: matcher is "${claudeHook.matcher}", expected "${CLAUDE_MATCHER}"`);
  const claudeCmd = claudeHook.hooks && claudeHook.hooks[0] && claudeHook.hooks[0].command;
  if (!claudeCmd || !claudeCmd.includes('.claude/hooks/remind-rebuild.js')) fail('hook-wiring', `.claude/settings.json: command does not invoke .claude/hooks/remind-rebuild.js (got "${claudeCmd}")`);
  const claudeTimeout = claudeHook.hooks && claudeHook.hooks[0] && claudeHook.hooks[0].timeout;

  const copilotManifest = readJson(root, '.github/hooks/remind-rebuild.json');
  if (copilotManifest.version !== 1) fail('hook-wiring', `.github/hooks/remind-rebuild.json: "version" is ${JSON.stringify(copilotManifest.version)}, must be 1 (missing/wrong version means Copilot never loads the file)`);
  const copilotHook = copilotManifest.hooks && copilotManifest.hooks.postToolUse && copilotManifest.hooks.postToolUse[0];
  if (!copilotHook) return fail('hook-wiring', '.github/hooks/remind-rebuild.json: no hooks.postToolUse[0] — the reminder hook is not wired up at all');
  if (copilotHook.matcher !== COPILOT_MATCHER) {
    fail('hook-wiring', `.github/hooks/remind-rebuild.json: matcher is "${copilotHook.matcher}", expected the runtime-name list "${COPILOT_MATCHER}" (copilot-facts.md §6.1 — "Edit|Write" silently never fires here)`);
  }
  if (!copilotHook.command || !copilotHook.command.includes('.github/hooks/remind-rebuild.js')) fail('hook-wiring', `.github/hooks/remind-rebuild.json: command does not invoke .github/hooks/remind-rebuild.js (got "${copilotHook.command}")`);
  const copilotTimeout = copilotHook.timeoutSec;

  if (typeof claudeTimeout === 'number' && typeof copilotTimeout === 'number' && claudeTimeout !== copilotTimeout) {
    fail('hook-wiring', `timeout has drifted: claude .claude/settings.json timeout=${claudeTimeout}s, copilot .github/hooks/remind-rebuild.json timeoutSec=${copilotTimeout}s`);
  }
}

function checkCopilotFactsAnchors(root, fail) {
  let facts;
  try {
    facts = read(root, 'copilot-facts.md');
  } catch {
    return fail('copilot-facts', 'copilot-facts.md is missing — AGENTS.md\'s Hooks section cites it by section number (§4, §6, §6.5)');
  }
  for (const anchor of ['## 4.', '### 4.1', '## 5.', '### 5.1', '## 6.', '### 6.5']) {
    if (!facts.includes(anchor)) fail('copilot-facts', `copilot-facts.md: expected a "${anchor}" section — AGENTS.md cites it and it appears to have moved or been renamed`);
  }
}

function defaultRunNpmCheck(root) {
  execFileSync('npm', ['run', 'check'], { cwd: root, stdio: 'pipe' });
}

function checkGeneratorFreshness(root, runNpmCheck, fail) {
  try {
    runNpmCheck(root);
  } catch (err) {
    const output = (err.stdout ? err.stdout.toString() : '') + (err.stderr ? err.stderr.toString() : '');
    fail('generator-freshness', `\`npm run check\` failed — a committed artifact (catalog.json, plugin manifests, hooks/hooks.json, .copilot-plugin/hooks.json, or the generated blocks in .github/copilot-instructions.md) is stale. Run \`npm run build\`.\n${output.trim().split('\n').slice(-10).join('\n')}`);
  }
}

/** Runs every check against `root` (defaults to this repository) and returns the failure list. */
function runChecks({ root = DEFAULT_ROOT, runNpmCheck = defaultRunNpmCheck } = {}) {
  const failures = [];
  const fail = (check, detail) => failures.push({ check, detail });
  checkHookScripts(root, fail);
  checkHookWiring(root, fail);
  checkGuardScripts(root, fail);
  checkGuardWiring(root, fail);
  checkCopilotFactsAnchors(root, fail);
  checkGeneratorFreshness(root, runNpmCheck, fail);
  return failures;
}

function main() {
  const failures = runChecks({});
  if (failures.length === 0) {
    console.log('coding-agent-parity: Claude Code and Copilot CLI dev-side config match. Nothing drifted.');
    process.exit(0);
  }
  console.error(`coding-agent-parity: ${failures.length} drift ${failures.length === 1 ? 'issue' : 'issues'} found\n`);
  for (const { check, detail } of failures) {
    console.error(`[${check}] ${detail}\n`);
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = { runChecks, CLAUDE_MATCHER, COPILOT_MATCHER, SOURCE_PATH_REGEX, extractReminderMessage };
