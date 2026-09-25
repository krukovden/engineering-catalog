'use strict';
// coding-agent-parity is a repo-local dev skill (.claude/skills/, not skills/<owner>/<name>/):
// it has no `.claude-plugin/plugin.json`, so it doesn't qualify as a `claude plugin eval`
// target (a manifest-less SKILL.md is a "plain skill", not a "skills-directory plugin" —
// https://code.claude.com/docs/en/plugins-reference), and it's `disable-model-invocation:
// true`, so there's no model trigger-choice to measure anyway. Its correctness is 100%
// deterministic code, which the eval cookbook's own guidance puts ahead of a model grader:
// code-based grading "is by far the best grading method if you can design an eval that
// allows for it" (platform.claude.com/cookbook/misc-building-evals). Hence a plain node:test
// file here, staged the same way test/hooks.test.js stages a fake home for lib/hooks.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runChecks, extractReminderMessage } = require('../.claude/skills/coding-agent-parity/scripts/check-parity');

const REAL_ROOT = path.join(__dirname, '..');
const noopNpmCheck = () => {};

/** A temp root pre-loaded with this repo's real, current, known-good files. */
function stageClean() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parityroot-'));
  for (const rel of ['.claude/hooks', '.github/hooks']) fs.mkdirSync(path.join(root, rel), { recursive: true });
  for (const rel of [
    '.claude/hooks/remind-rebuild.js',
    '.claude/hooks/block-generated.js',
    '.claude/settings.json',
    '.github/hooks/remind-rebuild.js',
    '.github/hooks/remind-rebuild.json',
    '.github/hooks/block-generated.js',
    '.github/hooks/block-generated.json',
    'copilot-facts.md',
  ]) {
    fs.copyFileSync(path.join(REAL_ROOT, rel), path.join(root, rel));
  }
  return root;
}

test('a clean, unmodified checkout reports no drift', () => {
  const root = stageClean();
  const failures = runChecks({ root, runNpmCheck: noopNpmCheck });
  assert.deepEqual(failures, []);
});

test('the real repository itself reports no drift (npm run check included)', () => {
  const failures = runChecks({ root: REAL_ROOT });
  assert.deepEqual(failures, []);
});

test('drifted reminder text is caught', () => {
  const root = stageClean();
  const file = path.join(root, '.github/hooks/remind-rebuild.js');
  // Keep both "Source unit changed" and "before committing." intact — those are
  // extractReminderMessage's anchors — and only change the text between them, so this
  // exercises the "drifted" comparison rather than the "template not found" fallback.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('npm run build', 'npm run rebuild'));
  const failures = runChecks({ root, runNpmCheck: noopNpmCheck });
  assert.ok(failures.some((f) => f.check === 'hook-scripts' && /drifted/.test(f.detail)));
});

test('a Claude-shaped payload on the Copilot script is caught', () => {
  const root = stageClean();
  const file = path.join(root, '.github/hooks/remind-rebuild.js');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
    'additionalContext:', 'hookSpecificOutput: {}, additionalContext:',
  ));
  const failures = runChecks({ root, runNpmCheck: noopNpmCheck });
  assert.ok(failures.some((f) => f.check === 'hook-scripts' && /Claude's shape/.test(f.detail)));
});

test('the Copilot matcher silently regressing to Claude tool names is caught', () => {
  const root = stageClean();
  const file = path.join(root, '.github/hooks/remind-rebuild.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.hooks.postToolUse[0].matcher = 'Edit|Write';
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  const failures = runChecks({ root, runNpmCheck: noopNpmCheck });
  assert.ok(failures.some((f) => f.check === 'hook-wiring' && /never fires here/.test(f.detail)));
});

test('the known-good asymmetric matchers are NOT flagged as drift', () => {
  const root = stageClean();
  const failures = runChecks({ root, runNpmCheck: noopNpmCheck });
  assert.ok(!failures.some((f) => /matcher/.test(f.detail) && /asymmet/i.test(f.detail)));
  assert.deepEqual(failures, []);
});

test('a missing .github/hooks/remind-rebuild.json version key is caught', () => {
  const root = stageClean();
  const file = path.join(root, '.github/hooks/remind-rebuild.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete manifest.version;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  const failures = runChecks({ root, runNpmCheck: noopNpmCheck });
  assert.ok(failures.some((f) => f.check === 'hook-wiring' && /"version"/.test(f.detail)));
});

test('a drifted timeout between the two wiring files is caught', () => {
  const root = stageClean();
  const file = path.join(root, '.github/hooks/remind-rebuild.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.hooks.postToolUse[0].timeoutSec = 999;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  const failures = runChecks({ root, runNpmCheck: noopNpmCheck });
  assert.ok(failures.some((f) => f.check === 'hook-wiring' && /timeout has drifted/.test(f.detail)));
});

test('a drifted guarded-path list between the two guard scripts is caught', () => {
  const root = stageClean();
  const file = path.join(root, '.github/hooks/block-generated.js');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
    "/^catalog\\.json$/,", "/^catalog\\.json$/,\n  /^extra\\.json$/,",
  ));
  const failures = runChecks({ root, runNpmCheck: noopNpmCheck });
  assert.ok(failures.some((f) => f.check === 'guard-scripts' && /guarded-path list has drifted/.test(f.detail)));
});

test('a Claude-shaped payload on the Copilot guard script is caught', () => {
  const root = stageClean();
  const file = path.join(root, '.github/hooks/block-generated.js');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
    "permissionDecision: 'deny',", "hookSpecificOutput: {}, permissionDecision: 'deny',",
  ));
  const failures = runChecks({ root, runNpmCheck: noopNpmCheck });
  assert.ok(failures.some((f) => f.check === 'guard-scripts' && /Claude's shape/.test(f.detail)));
});

test('the guard missing from .claude/settings.json PreToolUse is caught', () => {
  const root = stageClean();
  const file = path.join(root, '.claude/settings.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete settings.hooks.PreToolUse;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  const failures = runChecks({ root, runNpmCheck: noopNpmCheck });
  assert.ok(failures.some((f) => f.check === 'guard-wiring' && /not wired up at all/.test(f.detail)));
});

test('a dropped `if` prefilter on the PreToolUse guard is caught', () => {
  const root = stageClean();
  const file = path.join(root, '.claude/settings.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete settings.hooks.PreToolUse[0].hooks[0].if;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  const failures = runChecks({ root, runNpmCheck: noopNpmCheck });
  assert.ok(failures.some((f) => f.check === 'guard-wiring' && /no `if` prefilter/.test(f.detail)));
});

test('an `if` prefilter narrowed to drop a GENERATED canary is caught', () => {
  const root = stageClean();
  const file = path.join(root, '.claude/settings.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  settings.hooks.PreToolUse[0].hooks[0].if = 'Edit(catalog.json)|Write(catalog.json)';
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  const failures = runChecks({ root, runNpmCheck: noopNpmCheck });
  assert.ok(failures.some((f) => f.check === 'guard-wiring' && /no longer covers everything GENERATED does/.test(f.detail)));
});

test('a missing copilot-facts.md is caught', () => {
  const root = stageClean();
  fs.rmSync(path.join(root, 'copilot-facts.md'));
  const failures = runChecks({ root, runNpmCheck: noopNpmCheck });
  assert.ok(failures.some((f) => f.check === 'copilot-facts' && /missing/.test(f.detail)));
});

test('a renamed copilot-facts.md section anchor is caught', () => {
  const root = stageClean();
  const file = path.join(root, 'copilot-facts.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('### 6.5', '### 6.6'));
  const failures = runChecks({ root, runNpmCheck: noopNpmCheck });
  assert.ok(failures.some((f) => f.check === 'copilot-facts' && /### 6\.5/.test(f.detail)));
});

test('a failing `npm run check` is surfaced, not swallowed', () => {
  const root = stageClean();
  const failing = () => { const err = new Error('stale'); err.stdout = Buffer.from(''); err.stderr = Buffer.from('catalog.json is stale'); throw err; };
  const failures = runChecks({ root, runNpmCheck: failing });
  assert.ok(failures.some((f) => f.check === 'generator-freshness' && /stale/.test(f.detail)));
});

test('extractReminderMessage tolerates the escaped backticks inside the template literal', () => {
  const src = 'const x = `Source unit changed (${rel}) — run \\`npm run build\\` before committing.`;';
  const msg = extractReminderMessage(src);
  assert.ok(msg && msg.startsWith('Source unit changed') && msg.endsWith('before committing.'));
});
