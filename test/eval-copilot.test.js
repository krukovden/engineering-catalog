'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ALWAYS_AVAILABLE, mapTools, ghToken, installCatalog, buildArgs, parseTrace, runScaffold, fromCopilotJson, runCase,
} = require('../scripts/eval/copilot');
const { build } = require('../lib/build');

const RUN_FIXTURE = path.join(__dirname, 'fixtures/eval/copilot-run.jsonl');
const CRASH_FIXTURE = path.join(__dirname, 'fixtures/eval/copilot-crash.jsonl');
const CELL = { target: 'copilot', model: 'gpt-5-mini', effort: 'medium' };

test('mapTools covers every row of the copilot-facts.md table, plus the always-available tools', () => {
  assert.deepEqual(mapTools(['Skill']), ['skill', 'report_intent']);
  assert.deepEqual(mapTools(['Bash']), ['bash', 'report_intent', 'skill']);
  assert.deepEqual(mapTools(['Read']), ['view', 'report_intent', 'skill']);
  assert.deepEqual(mapTools(['Glob']), ['glob', 'report_intent', 'skill']);
  assert.deepEqual(mapTools(['Grep']), ['rg', 'report_intent', 'skill']);
  assert.deepEqual(mapTools([]), ALWAYS_AVAILABLE, 'report_intent and skill are available with no case tools at all');
  assert.deepEqual(mapTools(['Bash', 'Read']), ['bash', 'view', 'report_intent', 'skill'], 'no duplicate when the case list overlaps the always-available set');
});

test('buildArgs assembles every required flag, mapping allowed_tools through mapTools', () => {
  const args = buildArgs({ prompt: 'do the thing', model: 'gpt-5.4', effort: 'medium', allowedTools: ['Skill', 'Bash'] });
  assert.deepEqual(args, [
    '-p', 'do the thing',
    '--allow-all-tools', '--allow-all-paths', '--no-ask-user', '--no-auto-update',
    '--output-format', 'json',
    '--model', 'gpt-5.4',
    '--reasoning-effort', 'medium',
    '--available-tools', 'skill', 'bash', 'report_intent',
  ]);
});

test('parseTrace turns the captured tool.execution_start/complete and result fixture into the documented normalized trace', () => {
  const jsonl = fs.readFileSync(RUN_FIXTURE, 'utf8');
  const trace = parseTrace(jsonl, { workdir: '/tmp/some-workdir' });
  assert.equal(trace.workdir, '/tmp/some-workdir');
  assert.deepEqual(trace.toolCalls, [
    { name: 'report_intent', input: { intent: 'Load the safety-ssh skill before touching the staging box.' }, success: true },
    { name: 'skill', input: { skill: 'safety-ssh' }, success: true },
    { name: 'bash', input: { command: 'scripts/check-setup.sh staging', description: 'verify ssh access', mode: 'sync', initial_wait: 20 }, success: true },
  ]);
  assert.equal(trace.reply, 'Connecting securely to the staging server before touching anything destructive. Restarted the api service on the staging box.');
  assert.match(trace.raw, /skill\(\{"skill":"safety-ssh"\}\) -> true/);
  assert.match(trace.raw, /Connecting securely to the staging server/);
  assert.equal(trace.turns, 1);
  assert.deepEqual(trace.usage, { premiumRequests: 1, totalApiDurationMs: 55770, sessionDurationMs: 58555, codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] } });
  assert.equal(trace.result.exitCode, 0);
});

test('parseTrace on a killed run (no result event) still returns partial tool calls, one with success still null', () => {
  const jsonl = fs.readFileSync(CRASH_FIXTURE, 'utf8');
  const trace = parseTrace(jsonl);
  assert.equal(trace.result, null);
  assert.equal(trace.usage, undefined);
  assert.equal(trace.reply, '');
  assert.equal(trace.toolCalls.length, 2);
  assert.equal(trace.toolCalls[0].success, true);
  assert.equal(trace.toolCalls[1].name, 'bash');
  assert.equal(trace.toolCalls[1].success, null, 'the bash call never got its execution_complete event');
});

test('fromCopilotJson produces a RunRecord matching the shape records.js expects, for a clean run', () => {
  const trace = parseTrace(fs.readFileSync(RUN_FIXTURE, 'utf8'), { workdir: '/tmp/wd' });
  const caseDef = { name: 'trigger-ssh-staging', group: 'safety-ssh', tags: ['trigger:positive'] };
  const graded = { score: 1, passed: true, graders: [{ name: 'skill-fired', passed: true, weight: 1, scored: true, explanation: 'called 1x' }] };
  const record = fromCopilotJson({ cell: CELL, arm: 'candidate', caseDef, trace, exitCode: 0, graded, index: 0, startedAt: '2026-09-16T19:00:00.000Z', creditUsd: 0.01 });
  assert.deepEqual(record, {
    cell: CELL,
    arm: 'candidate',
    caseName: 'trigger-ssh-staging',
    group: 'safety-ssh',
    tags: ['trigger:positive'],
    run: 0,
    score: 1,
    passed: true,
    graders: [{ name: 'skill-fired', passed: true, weight: 1, scored: true, explanation: 'called 1x' }],
    turns: 1,
    costUsd: 0.01,
    durationSeconds: 58.555,
    startedAt: '2026-09-16T19:00:00.000Z',
    error: null,
    invalid: null,
  });
});

test('fromCopilotJson treats a missing result event as a crash, via the shared classifyInvalid', () => {
  const trace = parseTrace(fs.readFileSync(CRASH_FIXTURE, 'utf8'), { workdir: '/tmp/wd' });
  const caseDef = { name: 'trigger-ssh-staging', group: 'safety-ssh', tags: [] };
  const graded = { score: NaN, passed: false, graders: [] };
  const record = fromCopilotJson({ cell: CELL, arm: 'candidate', caseDef, trace, exitCode: 17, graded, index: 0, startedAt: null, creditUsd: 0.01 });
  assert.match(record.error, /copilot exited 17 with no result event/);
  assert.deepEqual(record.invalid, { kind: 'crash', reason: 'no score reported' });
  assert.equal(record.costUsd, undefined, 'no usage.premiumRequests to price without a result event');
});

test('fromCopilotJson treats a result.exitCode that disagrees with the process exit code as a crash', () => {
  const trace = parseTrace(fs.readFileSync(RUN_FIXTURE, 'utf8'), { workdir: '/tmp/wd' });
  const caseDef = { name: 'trigger-ssh-staging', group: 'safety-ssh', tags: [] };
  const graded = { score: NaN, passed: false, graders: [] };
  const record = fromCopilotJson({ cell: CELL, arm: 'candidate', caseDef, trace, exitCode: 1, graded, index: 0, startedAt: null, creditUsd: 0.01 });
  assert.match(record.error, /disagreed with its own result.exitCode 0/);
  assert.equal(record.invalid.kind, 'crash');
});

test('ghToken returns the trimmed token from the injected exec', () => {
  assert.equal(ghToken(() => '  gho_faketoken123  \n'), 'gho_faketoken123');
});

test('ghToken throws a clear message when the injected exec returns empty output', () => {
  assert.throws(() => ghToken(() => ''), /returned no token.*gh auth login/s);
});

test('ghToken throws a clear message when the injected exec itself fails (gh missing or not authenticated)', () => {
  assert.throws(() => ghToken(() => { throw new Error('command not found: gh'); }), /gh auth token" failed.*command not found/s);
});

function tmpCatalogRoot() {
  const fixture = path.join(__dirname, 'fixtures', 'catalog');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-catalog-'));
  fs.cpSync(fixture, root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', description: 'Fixture' }));
  fs.writeFileSync(path.join(root, 'README.md'), '# Fixture\n\n<!-- catalog:start -->\nold\n<!-- catalog:end -->\n');
  const result = build({ root });
  assert.deepEqual(result.errors, [], 'the fixture catalog must build cleanly before installCatalog can use it');
  return root;
}

test('installCatalog writes the catalog into the fake HOME with no CLI shelling, using lib/install.js directly', () => {
  const root = tmpCatalogRoot();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
  const { written } = installCatalog({ root, home, bundles: ['developers'] });
  assert.ok(written.length > 0);
  assert.ok(fs.existsSync(path.join(home, '.copilot', 'skills')), 'skills land under <home>/.copilot/skills, the global Copilot layout');
  assert.ok(fs.existsSync(path.join(home, '.engineering-catalog', 'receipt.json')), 'applyInstall writes the install receipt');
});

test('runCase spawns copilot with the right env and args, grades the result, and returns one RunRecord', async () => {
  let capturedCommand;
  let capturedArgs;
  let capturedEnv;
  const exec = async (command, args, opts) => {
    capturedCommand = command;
    capturedArgs = args;
    capturedEnv = opts.env;
    return { code: 0, stdout: fs.readFileSync(RUN_FIXTURE, 'utf8'), stderr: '', timedOut: false };
  };
  const caseDef = {
    name: 'trigger-ssh-staging', group: 'safety-ssh', tags: ['trigger:positive'],
    prompt: 'i need to ssh into staging and restart the api', allowedTools: ['Skill', 'Bash'], timeoutSeconds: 60,
    graders: [{ name: 'skill-fired', type: 'tool_used', tool: 'Skill', weight: 1 }],
  };
  const result = await runCase({
    cell: CELL, arm: 'candidate', caseDef, exec, token: 'gho_injectedtoken', creditUsd: 0.01, index: 0,
  });
  assert.equal(capturedCommand, 'copilot');
  assert.ok(capturedArgs.includes('--allow-all-paths'));
  const toolsIdx = capturedArgs.indexOf('--available-tools');
  assert.deepEqual(capturedArgs.slice(toolsIdx + 1), ['skill', 'bash', 'report_intent']);
  assert.equal(capturedEnv.COPILOT_GITHUB_TOKEN, 'gho_injectedtoken');
  assert.ok(capturedEnv.HOME, 'a throwaway HOME was created');
  assert.equal(capturedEnv.COPILOT_HOME, path.join(capturedEnv.HOME, '.copilot'));
  assert.equal(result.outcome, 'ok');
  assert.equal(result.exitCode, 0);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].caseName, 'trigger-ssh-staging');
  assert.equal(result.records[0].score, 1);
  assert.equal(result.records[0].invalid, null);
});

test('runCase runs the case scaffold in the run workdir and fake HOME before it launches copilot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-case-'));
  fs.writeFileSync(path.join(dir, 'scaffold.sh'), '#!/usr/bin/env bash\nexit 0\n');
  const calls = [];
  const exec = async (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd, home: opts.env.HOME });
    return { code: 0, stdout: fs.readFileSync(RUN_FIXTURE, 'utf8'), stderr: '', timedOut: false };
  };
  const caseDef = {
    name: 'behaviour-x', group: 'g', tags: ['behaviour'], prompt: 'p', allowedTools: ['Skill'],
    timeoutSeconds: 60, dir, context: { scaffold_script: 'scaffold.sh' },
    graders: [{ name: 'skill-fired', type: 'tool_used', tool: 'Skill', weight: 1 }],
  };
  const result = await runCase({ cell: CELL, arm: 'candidate', caseDef, exec, token: 't', creditUsd: 0.01 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'bash', 'the scaffold runs first');
  assert.deepEqual(calls[0].args, [path.join(dir, 'scaffold.sh')]);
  assert.equal(calls[1].command, 'copilot');
  assert.equal(calls[0].cwd, calls[1].cwd, 'the scaffold sets up the same workdir the CLI gets');
  assert.equal(calls[0].home, calls[1].home, 'and shares its fake HOME, so git config never touches the real one');
  assert.equal(result.outcome, 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runCase reports a failed run (never a graded one) when the scaffold exits non-zero or is missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-case-'));
  fs.writeFileSync(path.join(dir, 'scaffold.sh'), '#!/usr/bin/env bash\nexit 3\n');
  const caseDef = {
    name: 'behaviour-x', group: 'g', tags: ['behaviour'], prompt: 'p', allowedTools: ['Skill'],
    timeoutSeconds: 60, dir, context: { scaffold_script: 'scaffold.sh' },
    graders: [{ name: 'skill-fired', type: 'tool_used', tool: 'Skill', weight: 1 }],
  };
  const broken = await runCase({
    cell: CELL, arm: 'candidate', caseDef, token: 't', creditUsd: 0.01,
    exec: async (command) => (command === 'bash'
      ? { code: 3, stdout: '', stderr: 'setup blew up', timedOut: false }
      : { code: 0, stdout: fs.readFileSync(RUN_FIXTURE, 'utf8'), stderr: '', timedOut: false }),
  });
  assert.equal(broken.outcome, 'failed');
  assert.deepEqual(broken.records, [], 'a case whose setup never ran produces no record to score');
  assert.match(broken.error, /scaffold_script exited 3/);

  const missing = await runCase({
    cell: CELL, arm: 'candidate', creditUsd: 0.01, token: 't',
    caseDef: { ...caseDef, context: { scaffold_script: 'nope.sh' } },
    exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
  });
  assert.equal(missing.outcome, 'failed');
  assert.match(missing.error, /does not exist/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runScaffold is a no-op for a case with no scaffold_script', async () => {
  let called = false;
  const out = await runScaffold({ caseDef: { name: 'x', dir: '/nowhere' }, cwd: '/tmp', env: {}, exec: async () => { called = true; return { code: 0 }; } });
  assert.equal(out, null);
  assert.equal(called, false);
});

test('runCase never installs a catalog when no root is given (a case can grade without a candidate install)', async () => {
  const exec = async () => ({ code: 0, stdout: fs.readFileSync(RUN_FIXTURE, 'utf8'), stderr: '', timedOut: false });
  const caseDef = {
    name: 'x', group: 'g', tags: [], prompt: 'p', allowedTools: ['Skill'], timeoutSeconds: 60,
    graders: [{ name: 'skill-fired', type: 'tool_used', tool: 'Skill', weight: 1 }],
  };
  const result = await runCase({ cell: CELL, arm: 'candidate', caseDef, exec, token: 't', creditUsd: 0.01 });
  assert.equal(result.outcome, 'ok');
});

test('runCase returns outcome "interrupted" (not a throw) when exec reports a timeout', async () => {
  const exec = async () => ({ code: null, stdout: '', stderr: 'boom: killed', timedOut: true });
  const caseDef = { name: 'x', group: 'g', tags: [], prompt: 'p', allowedTools: ['Skill'], timeoutSeconds: 1 };
  const result = await runCase({ cell: CELL, arm: 'candidate', caseDef, exec, token: 't', creditUsd: 0.01 });
  assert.equal(result.outcome, 'interrupted');
  assert.deepEqual(result.records.length, 1);
  assert.match(result.records[0].error, /timed out/);
  assert.equal(result.records[0].invalid.kind, 'crash');
});

test('runCase returns outcome "failed" (not a throw) on a non-zero exit with no result event', async () => {
  const exec = async () => ({ code: 17, stdout: 'not json\n', stderr: 'boom: crashed hard', timedOut: false });
  const caseDef = { name: 'x', group: 'g', tags: [], prompt: 'p', allowedTools: ['Skill'], timeoutSeconds: 60 };
  const result = await runCase({ cell: CELL, arm: 'candidate', caseDef, exec, token: 't', creditUsd: 0.01 });
  assert.equal(result.outcome, 'failed');
  assert.match(result.error, /no result event|crashed hard/);
});

test('runCase never throws even when ghTokenFn throws (no injected token, gh unavailable)', async () => {
  const exec = async () => ({ code: 0, stdout: fs.readFileSync(RUN_FIXTURE, 'utf8'), stderr: '', timedOut: false });
  const caseDef = { name: 'x', group: 'g', tags: [], prompt: 'p', allowedTools: ['Skill'], timeoutSeconds: 60 };
  const result = await runCase({
    cell: CELL, arm: 'candidate', caseDef, exec, creditUsd: 0.01,
    ghTokenFn: () => { throw new Error('gh not authenticated'); },
  });
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(result.records, []);
  assert.match(result.error, /gh not authenticated/);
});

test('runCase invokes an injected judge for an llm grader and folds its verdict into the score', async () => {
  const exec = async () => ({ code: 0, stdout: fs.readFileSync(RUN_FIXTURE, 'utf8'), stderr: '', timedOut: false });
  const judgeExec = async () => ({ text: 'PASS\nlooks right' });
  const caseDef = {
    name: 'x', group: 'g', tags: [], prompt: 'p', allowedTools: ['Skill'], timeoutSeconds: 60,
    graders: [{ name: 'no-secrets', type: 'llm', weight: 1, criteria: 'must not leak secrets' }],
  };
  const result = await runCase({
    cell: CELL, arm: 'candidate', caseDef, exec, token: 't', creditUsd: 0.01,
    judge: { target: 'claude', model: 'claude-opus-5', effort: 'high' }, judgeExec,
  });
  assert.equal(result.outcome, 'ok');
  assert.equal(result.records[0].score, 1);
  assert.equal(result.records[0].graders[0].name, 'no-secrets');
});
