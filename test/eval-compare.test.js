'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { build, README_START, README_END } = require('../lib/build');
const { compare, planCells, caseGroup, cellId, gatedTools, loadConfig } = require('../scripts/eval/compare');
const { run } = require('../scripts/eval');

const FIX = path.join(__dirname, 'fixtures', 'catalog');
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

const CONFIG = {
  cells: {
    trigger: [{ target: 'claude', model: 'claude-haiku-4-5', effort: 'low' }],
    behaviour: [{ target: 'claude', model: 'claude-sonnet-5', effort: 'medium' }],
  },
  judge: { target: 'claude', model: 'claude-opus-5', effort: 'high' },
  runs: { trigger: 2, default: 3 },
  verdict: { delta: 0.15, minCases: 10, maxInvalidShare: 0.1, bootstrapResamples: 200, seed: 7 },
  guardrails: { costRatio: 1.2, durationRatio: 1.2 },
  budget: { maxCostUsd: 5 },
};

function writeCase(root, group, name, tags) {
  const dir = path.join(root, 'evals', group, name);
  fs.mkdirSync(path.join(dir, 'graders'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompt.md'), `---\ntags: [${tags.join(', ')}]\nmax_turns: 3\nallowed_tools: [Skill, Bash]\n---\n\ndo the ${name} thing\n`);
  fs.writeFileSync(path.join(dir, 'graders', 'fired.md'), '---\ntype: tool_used\ntool: Skill\nmin: 1\narm: both\n---\n');
}

/** A throwaway catalog that is also a git repo, with a committed base and a dirty candidate. */
function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-'));
  fs.cpSync(FIX, root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9', description: 'Fixture' }));
  fs.writeFileSync(path.join(root, 'README.md'), `# Fixture\n\n${README_START}\nold\n${README_END}\n`);
  fs.writeFileSync(path.join(root, '.gitignore'), 'evals/results/\n');
  fs.mkdirSync(path.join(root, 'evals'), { recursive: true });
  fs.writeFileSync(path.join(root, 'evals', 'eval.config.json'), JSON.stringify(CONFIG, null, 2));
  writeCase(root, 'alpha', 'trigger-one', ['trigger:positive', 'unit:alpha']);
  writeCase(root, 'alpha', 'trigger-two', ['trigger:negative', 'unit:alpha']);
  assert.deepEqual(build({ root }).errors, []);
  git(root, 'init', '-q', '-b', 'main');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  const baseSha = git(root, 'rev-parse', 'HEAD');
  return { root, baseSha };
}

/** Rewrites alpha's description — a behaviour change by this repo's own rules. */
function editCandidate(root) {
  const skill = path.join(root, 'skills/shared/alpha/SKILL.md');
  fs.writeFileSync(skill, fs.readFileSync(skill, 'utf8').replace('Alpha. Use when testing.', 'Alpha. Use when the user asks to test anything at all.'));
  assert.deepEqual(build({ root }).errors, []);
}

const flag = (args, name) => args[args.indexOf(name) + 1];

/** Stands in for `claude plugin eval`: writes the payload the real command would have written. */
function fakeExec({ root, scores, seen = [] }) {
  return async (command, argv, { env }) => {
    const args = argv.slice(2);
    const caseName = flag(args, '--case');
    const arm = args[0] === root ? 'candidate' : 'base';
    const runs = Number(flag(args, '--runs'));
    const score = scores[arm][caseName];
    seen.push({ arm, caseName, model: flag(args, '--model'), effort: env.CLAUDE_CODE_EFFORT_LEVEL, runs, allowTools: args.includes('--allow-tools') });
    const one = (i) => ({
      score, passed: score === 1, turns: 2, costUsd: arm === 'base' ? 0.01 : 0.011,
      judgeCostUsd: 0, durationSeconds: 10, startedAt: `2026-09-16T18:0${i}:00.000Z`,
      error: 'exit 1: Reached maximum number of turns (3)', tracePath: null, skippedPaidGraders: false,
      graders: [{ name: 'fired', passed: score === 1, weight: 1, explanation: '', withOnly: false, scored: true }],
    });
    fs.writeFileSync(flag(args, '--json'), JSON.stringify({
      schemaVersion: 1, claudeVersion: '2.1.273', startedAt: '2026-09-16T18:00:00.000Z',
      durationSeconds: 20, costUsd: 0.02, partial: false,
      suite: { root: args[0], ablation: 'none', plugins: [] },
      cases: [{
        name: caseName, dir: `evals/alpha/${caseName}`, runsPerCase: runs, graders: [],
        arms: { with: Array.from({ length: runs }, (_, i) => one(i)) },
        aggregates: { score, passRate: score },
      }],
      aggregates: { casesTotal: 1 },
    }));
    return { code: 0, stdout: 'Wrote result', stderr: '' };
  };
}

test('a case is routed to the cell group its tags name', () => {
  assert.equal(caseGroup({ tags: ['trigger:positive'] }), 'trigger');
  assert.equal(caseGroup({ tags: ['behaviour', 'unit:x'] }), 'behaviour');
  assert.equal(caseGroup({ tags: [] }), 'behaviour', 'an untagged case is a behaviour case, never a free trigger run');
  assert.equal(cellId({ target: 'claude', model: 'm', effort: 'low' }), 'claude:m:low');
});

test('only the tools the native runner gates need an operator grant', () => {
  assert.deepEqual(gatedTools(['Skill', 'Read', 'Glob', 'Grep']), []);
  assert.deepEqual(gatedTools(['Bash', 'Skill', 'Write', 'mcp__ado__x']), ['Bash', 'Write', 'mcp__ado__x']);
});

test('the plan pairs every cell with the cases of its group, and skips targets nobody asked for', () => {
  const cases = [
    { name: 'a', tags: ['trigger:positive'] }, { name: 'b', tags: ['behaviour'] },
  ];
  const config = { ...CONFIG, cells: { trigger: [...CONFIG.cells.trigger, { target: 'copilot', model: 'gpt-5-mini', effort: 'medium' }], behaviour: CONFIG.cells.behaviour } };
  const claudeOnly = planCells({ cases, config, targets: ['claude'] });
  assert.deepEqual(claudeOnly.map((e) => `${e.group}/${e.id}`), ['trigger/claude:claude-haiku-4-5:low', 'behaviour/claude:claude-sonnet-5:medium']);
  assert.deepEqual(claudeOnly.map((e) => e.runs), [2, 3], 'trigger cases run fewer times — they are short and there are many');
  assert.equal(planCells({ cases, config, targets: ['claude', 'copilot'] }).length, 3);
  assert.equal(planCells({ cases: [cases[1]], config, targets: ['claude'] }).length, 1, 'a group with no case contributes no cell');
});

test('compare runs both arms of every affected case and reports numbers without a verdict', async () => {
  const { root, baseSha } = tmpRepo();
  editCandidate(root);
  const seen = [];
  const out = [];
  const result = await compare({
    root, base: baseSha, tier: 1, targets: ['claude'], now: new Date('2026-09-16T12:00:00Z'),
    log: (s) => out.push(s), warn: (s) => out.push(s),
    exec: fakeExec({ root, scores: { base: { 'trigger-one': 0.5, 'trigger-two': 1 }, candidate: { 'trigger-one': 1, 'trigger-two': 1 } }, seen }),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(seen.length, 4, 'two cases x two arms');
  assert.deepEqual([...new Set(seen.map((s) => s.arm))].sort(), ['base', 'candidate']);
  assert.deepEqual([...new Set(seen.map((s) => s.model))], ['claude-haiku-4-5']);
  assert.deepEqual([...new Set(seen.map((s) => s.effort))], ['low'], 'the cell effort reaches the child session');
  assert.deepEqual([...new Set(seen.map((s) => s.runs))], [2]);
  assert.ok(seen.every((s) => s.allowTools), 'the cases name Bash, so the grant is passed through');
  // Both arms of one case run back to back, and which goes first alternates per case.
  assert.deepEqual(seen.map((s) => s.arm), ['base', 'candidate', 'candidate', 'base']);

  assert.equal(result.summaries.length, 1);
  const [cell] = result.summaries;
  assert.equal(cell.cellId, 'claude:claude-haiku-4-5:low');
  assert.equal(cell.n, 2);
  assert.equal(cell.meanDelta, 0.25);
  assert.equal(cell.hardRegression, false);
  assert.equal(cell.invalid.total, 0, 'a max-turns error is not an invalid run');
  assert.equal(cell.triggers.recall.base, 0.5);
  assert.equal(cell.triggers.recall.candidate, 1);
  assert.equal(cell.triggers.falseTrigger.candidate, 0);

  // Only 2 cases ran — below eval.config.json's minCases(10) — so the rule can only fall
  // through to "Not proven"; it never gets to see a confident interval either way.
  assert.equal(result.verdicts[0].verdict, 'Not proven');
  assert.match(out.join('\n'), /claude:claude-haiku-4-5:low/);
  assert.match(out.join('\n'), /Not proven/);

  assert.equal(result.fingerprint.baseSha, baseSha);
  assert.equal(result.fingerprint.candidateDirty, true, 'the candidate is the working tree, dirty and all');
  assert.ok(result.fingerprint.suiteHash);
  assert.ok(fs.existsSync(path.join(root, 'evals/results')), 'raw records are kept, and git-ignored');
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1, 'the base worktree is cleaned up');
  fs.rmSync(root, { recursive: true, force: true });
});

test('compare refuses a run it could not trust, and records an experiment when asked', async () => {
  const { root, baseSha } = tmpRepo();
  const out = [];
  const opts = {
    root, base: baseSha, tier: 1, targets: ['claude'], now: new Date('2026-09-16T12:00:00Z'),
    log: (s) => out.push(s), warn: (s) => out.push(s),
    exec: fakeExec({ root, scores: { base: { 'trigger-one': 1, 'trigger-two': 1 }, candidate: { 'trigger-one': 1, 'trigger-two': 1 } } }),
  };

  fs.writeFileSync(path.join(root, 'catalog.json'), '{"stale": true}');
  assert.match((await compare(opts)).error, /stale/, 'a stale artifact means the arms are not what they claim');
  assert.deepEqual(build({ root }).errors, []);

  assert.match((await compare(opts)).error, /no case is affected/, 'nothing changed, so there is nothing to measure');

  editCandidate(root);
  assert.match((await compare({ ...opts, targets: ['copilot'] })).error, /no cell/, 'no Copilot cell is wired yet');
  assert.match((await compare({ ...opts, caseFilter: 'nothing-like-this' })).error, /--case/, '--case narrows the affected set, it never widens it');
  assert.equal((await compare({ ...opts, caseFilter: 'trigger-one' })).summaries[0].n, 1);
  const result = await compare({ ...opts, record: 'alpha-description', hypothesis: 'a longer trigger phrase fires more often' });
  const recorded = JSON.parse(fs.readFileSync(path.join(root, result.recordPath), 'utf8'));
  assert.equal(result.recordPath, 'evals/experiments/2026-09-16-alpha-description.json');
  assert.equal(recorded.hypothesis, 'a longer trigger phrase fires more often');
  assert.equal(recorded.delta, 0.15, 'the margin is fixed before the run, not chosen after it');
  assert.deepEqual(Object.keys(recorded.cells[0].cases[0]).sort(), ['base', 'candidate', 'delta', 'name', 'regression']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a container-tagged case is skipped, and only that case, when --container off', async () => {
  const { root, baseSha } = tmpRepo();
  editCandidate(root);
  writeCase(root, 'alpha', 'container-one', ['trigger:positive', 'isolation:container', 'unit:alpha']);
  const seen = [];
  const out = [];
  const result = await compare({
    root, base: baseSha, tier: 1, targets: ['claude'], now: new Date('2026-09-16T12:00:00Z'),
    log: (s) => out.push(s), warn: (s) => out.push(s), container: 'off',
    exec: fakeExec({ root, scores: { base: { 'trigger-one': 1, 'trigger-two': 1 }, candidate: { 'trigger-one': 1, 'trigger-two': 1 } }, seen }),
  });
  assert.equal(result.exitCode, 0);
  assert.ok(!seen.some((s) => s.caseName === 'container-one'), 'the container case never reached exec at all');
  assert.match(out.join('\n'), /container-one.*skipped/, 'a clear skip message names the case');
  assert.match(out.join('\n'), /container isolation is off/);
  assert.equal(result.summaries[0].n, 2, 'the two ordinary cases still ran, unaffected');
  assert.equal(result.fingerprint.isolation.mode, 'native');
  assert.deepEqual(result.fingerprint.isolation.skipped, ['container-one']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a container-tagged case is skipped when the injected isolation module finds no runtime', async () => {
  const { root, baseSha } = tmpRepo();
  editCandidate(root);
  writeCase(root, 'alpha', 'container-one', ['trigger:positive', 'isolation:container', 'unit:alpha']);
  const seen = [];
  const out = [];
  const fakeIsolation = { detectRuntime: () => null, buildImage: async () => { throw new Error('should not be called'); }, runInContainer: async () => { throw new Error('should not be called'); } };
  const result = await compare({
    root, base: baseSha, tier: 1, targets: ['claude'], now: new Date('2026-09-16T12:00:00Z'),
    log: (s) => out.push(s), warn: (s) => out.push(s), isolation: fakeIsolation,
    exec: fakeExec({ root, scores: { base: { 'trigger-one': 1, 'trigger-two': 1 }, candidate: { 'trigger-one': 1, 'trigger-two': 1 } }, seen }),
  });
  assert.equal(result.exitCode, 0);
  assert.ok(!seen.some((s) => s.caseName === 'container-one'));
  assert.match(out.join('\n'), /no podman\/docker runtime available/);
  assert.equal(result.summaries[0].n, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('--container required fails the whole compare when no runtime is available, instead of skipping', async () => {
  const { root, baseSha } = tmpRepo();
  editCandidate(root);
  writeCase(root, 'alpha', 'container-one', ['trigger:positive', 'isolation:container', 'unit:alpha']);
  const fakeIsolation = { detectRuntime: () => null, buildImage: async () => { throw new Error('should not be called'); }, runInContainer: async () => { throw new Error('should not be called'); } };
  const result = await compare({
    root, base: baseSha, tier: 1, targets: ['claude'], now: new Date('2026-09-16T12:00:00Z'),
    log: () => {}, warn: () => {}, container: 'required', isolation: fakeIsolation,
    exec: fakeExec({ root, scores: { base: { 'trigger-one': 1, 'trigger-two': 1 }, candidate: { 'trigger-one': 1, 'trigger-two': 1 } } }),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.error, /no podman\/docker runtime available/);
  assert.match(result.error, /--container required/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a resolved container case is routed through the container adapter; a plain case in the same run is not', async () => {
  const { root, baseSha } = tmpRepo();
  editCandidate(root);
  writeCase(root, 'alpha', 'container-one', ['trigger:positive', 'isolation:container', 'unit:alpha']);
  const plainSeen = [];
  const containerCalls = [];
  const fakeIsolation = {
    detectRuntime: () => 'podman',
    buildImage: async () => {},
    runInContainer: async ({ runtime, command, args, cwd, env, mounts }) => {
      containerCalls.push({ runtime, command, args, cwd, env, mounts });
      const caseName = flag(args, '--case');
      fs.writeFileSync(flag(args, '--json'), JSON.stringify({
        schemaVersion: 1, claudeVersion: 'x', startedAt: new Date().toISOString(), durationSeconds: 1, costUsd: 0.01, partial: false,
        suite: { root: args[2], ablation: 'none', plugins: [] },
        cases: [{
          name: caseName, dir: `evals/alpha/${caseName}`, runsPerCase: Number(flag(args, '--runs')), graders: [],
          arms: { with: Array.from({ length: Number(flag(args, '--runs')) }, () => ({ score: 1, passed: true, turns: 1, costUsd: 0.01, judgeCostUsd: 0, durationSeconds: 1, startedAt: new Date().toISOString(), error: null, tracePath: null, skippedPaidGraders: false, graders: [] })) },
          aggregates: { score: 1, passRate: 1 },
        }],
        aggregates: { casesTotal: 1 },
      }));
      return { code: 0, stdout: 'Wrote result', stderr: '' };
    },
  };
  const result = await compare({
    root, base: baseSha, tier: 1, targets: ['claude'], now: new Date('2026-09-16T12:00:00Z'),
    log: () => {}, warn: () => {}, isolation: fakeIsolation,
    exec: fakeExec({ root, scores: { base: { 'trigger-one': 1, 'trigger-two': 1, 'container-one': 1 }, candidate: { 'trigger-one': 1, 'trigger-two': 1, 'container-one': 1 } }, seen: plainSeen }),
  });

  assert.equal(result.exitCode, 0);
  assert.ok(containerCalls.length > 0, 'the container case actually went through runInContainer');
  assert.ok(!plainSeen.some((s) => s.caseName === 'container-one'), 'the container case never reached the plain host exec');
  assert.ok(plainSeen.some((s) => s.caseName === 'trigger-one'), 'the ordinary case still went through the plain host exec');
  assert.ok(plainSeen.some((s) => s.caseName === 'trigger-two'));
  assert.ok(containerCalls.every((c) => c.runtime === 'podman'));
  assert.ok(containerCalls.every((c) => c.cwd === root), 'the container always runs cwd at the candidate worktree root');
  assert.ok(containerCalls.every((c) => c.env.CLAUDE_CODE_EFFORT_LEVEL === 'low'), 'the cell effort still reaches the container env');
  assert.ok(containerCalls.every((c) => !Object.prototype.hasOwnProperty.call(c.env, 'PATH')), 'the container env is a safelist, not the full merged host env');
  const baseCall = containerCalls.find((c) => c.args[2] !== root);
  assert.ok(baseCall, 'the base arm of the container case ran too');
  assert.ok(baseCall.mounts.some((m) => m.endsWith(':ro')), 'the base worktree is mounted read-only for the base arm');
  assert.equal(result.fingerprint.isolation.mode, 'container');
  assert.deepEqual(result.fingerprint.isolation.cases, ['container-one']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the CLI refuses a compare that cannot be honest about what it measured', async () => {
  assert.equal(await run(['compare']), 1, 'without --base there is nothing to compare against');
  assert.equal(await run(['compare', '--base', 'main', '--record', 'x']), 1, 'a record without a hypothesis is a result in search of a claim');
});

const COPILOT_CELL_CONFIG = (base) => ({
  ...base, cells: { ...base.cells, trigger: [{ target: 'copilot', model: 'gpt-5-mini', effort: 'medium' }] },
});

const COPILOT_JSONL = [
  { type: 'tool.execution_start', data: { toolCallId: '1', toolName: 'skill', arguments: { skill: 'alpha' } } },
  { type: 'tool.execution_complete', data: { toolCallId: '1', success: true } },
  { type: 'assistant.message', data: { content: 'done' } },
  { type: 'result', exitCode: 0, usage: { premiumRequests: 1, sessionDurationMs: 500 } },
].map((e) => JSON.stringify(e)).join('\n');

test('every Copilot run is containerized when a runtime exists, tagged or not — that arm has no sandbox of its own', async () => {
  const { root, baseSha } = tmpRepo();
  editCandidate(root);
  fs.writeFileSync(path.join(root, 'evals', 'eval.config.json'), JSON.stringify(COPILOT_CELL_CONFIG(CONFIG), null, 2));
  const containerCalls = [];
  let hostCalls = 0;
  const fakeIsolation = {
    detectRuntime: () => 'podman',
    buildImage: async () => {},
    runInContainer: async (opts) => {
      containerCalls.push(opts);
      return { code: 0, stdout: COPILOT_JSONL, stderr: '', timedOut: false };
    },
  };
  const result = await compare({
    root, base: baseSha, tier: 1, targets: ['copilot'], now: new Date('2026-09-16T12:00:00Z'),
    log: () => {}, warn: () => {}, isolation: fakeIsolation, ghTokenFn: () => 'fake-gh-token',
    copilotExec: async () => { hostCalls += 1; return { code: 0, stdout: COPILOT_JSONL, stderr: '', timedOut: false }; },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(hostCalls, 0, 'no Copilot run escaped to the host');
  assert.ok(containerCalls.length > 0, 'the untagged cases still went through the container');
  assert.ok(containerCalls.every((c) => c.command === 'copilot'));
  assert.ok(containerCalls.every((c) => c.env.COPILOT_GITHUB_TOKEN === 'fake-gh-token'), 'the token reaches the container');
  assert.ok(containerCalls.every((c) => c.env.HOME && c.env.COPILOT_HOME), 'the run keeps the fake HOME that holds its installed catalog');
  assert.ok(containerCalls.every((c) => !Object.prototype.hasOwnProperty.call(c.env, 'PATH')), 'still a safelist, not the merged host env');
  assert.ok(containerCalls.every((c) => c.mounts.includes(`${c.env.HOME}:${c.env.HOME}:rw`)), 'the fake HOME is mounted, or the installed catalog would not exist inside');
  assert.ok(containerCalls.every((c) => c.mounts.includes(`${root}:${root}:ro`)), 'the worktree comes along read-only — it holds the case scaffolds');
  assert.ok(containerCalls.every((c) => c.cwd !== root), 'the Copilot arm keeps its throwaway workdir as cwd, not the worktree');
  assert.ok(containerCalls.every((c) => typeof c.timeoutMs === 'number'), 'the wall-clock kill survives the wrapping — it is this arm only turn limit');
  assert.equal(result.fingerprint.isolation.mode, 'container');
  assert.deepEqual(result.fingerprint.isolation.targets, ['copilot']);
  assert.deepEqual(result.fingerprint.isolation.cases, [], 'no case asked for this — the arm did');
  fs.rmSync(root, { recursive: true, force: true });
});

test('--container required fails a Copilot compare with no runtime, even when no case is tagged', async () => {
  const { root, baseSha } = tmpRepo();
  editCandidate(root);
  fs.writeFileSync(path.join(root, 'evals', 'eval.config.json'), JSON.stringify(COPILOT_CELL_CONFIG(CONFIG), null, 2));
  const fakeIsolation = { detectRuntime: () => null, buildImage: async () => { throw new Error('should not be called'); }, runInContainer: async () => { throw new Error('should not be called'); } };
  const result = await compare({
    root, base: baseSha, tier: 1, targets: ['copilot'], now: new Date('2026-09-16T12:00:00Z'),
    log: () => {}, warn: () => {}, container: 'required', isolation: fakeIsolation, ghTokenFn: () => 't',
    copilotExec: async () => { throw new Error('should not be called'); },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.error, /--container required/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('without a runtime the Copilot arm falls back to the host and says so, and the fingerprint records the downgrade', async () => {
  const { root, baseSha } = tmpRepo();
  editCandidate(root);
  fs.writeFileSync(path.join(root, 'evals', 'eval.config.json'), JSON.stringify(COPILOT_CELL_CONFIG(CONFIG), null, 2));
  const out = [];
  const fakeIsolation = { detectRuntime: () => null, buildImage: async () => { throw new Error('should not be called'); }, runInContainer: async () => { throw new Error('should not be called'); } };
  const result = await compare({
    root, base: baseSha, tier: 1, targets: ['copilot'], now: new Date('2026-09-16T12:00:00Z'),
    log: () => {}, warn: (m) => out.push(m), isolation: fakeIsolation, ghTokenFn: () => 't',
    copilotExec: async () => ({ code: 0, stdout: COPILOT_JSONL, stderr: '', timedOut: false }),
  });
  assert.equal(result.exitCode, 0);
  assert.match(out.join('\n'), /Copilot arm runs on the host — no podman\/docker runtime available/);
  assert.equal(result.fingerprint.isolation.mode, 'native');
  assert.deepEqual(result.fingerprint.isolation.downgraded, ['copilot'], 'the fingerprint never claims isolation it did not get');
  fs.rmSync(root, { recursive: true, force: true });
});

test('compare installs the catalog into a fake home once per arm and routes a copilot cell there', async () => {
  const { root, baseSha } = tmpRepo();
  editCandidate(root);
  const copilotConfig = { ...CONFIG, cells: { ...CONFIG.cells, trigger: [...CONFIG.cells.trigger, { target: 'copilot', model: 'gpt-5-mini', effort: 'medium' }] } };
  fs.writeFileSync(path.join(root, 'evals', 'eval.config.json'), JSON.stringify(copilotConfig, null, 2));

  const installedHomes = [];
  const seen = [];
  const one = (score) => ({
    score, passed: score === 1, turns: 1,
    costUsd: undefined, judgeCostUsd: 0, durationSeconds: undefined,
    startedAt: new Date().toISOString(), error: null, tracePath: null, skippedPaidGraders: false,
    graders: [{ name: 'fired', passed: score === 1, weight: 1, explanation: '', withOnly: false, scored: true }],
  });
  const claudeExec = async (command, argv, { env }) => {
    const args = argv.slice(2);
    const flag = (name) => args[args.indexOf(name) + 1];
    const caseName = flag('--case');
    const arm = args[0] === root ? 'candidate' : 'base';
    seen.push({ target: 'claude', arm, caseName });
    fs.writeFileSync(flag('--json'), JSON.stringify({
      schemaVersion: 1, claudeVersion: 'x', startedAt: new Date().toISOString(), durationSeconds: 1, costUsd: 0.01, partial: false,
      suite: { root: args[0], ablation: 'none', plugins: [] },
      cases: [{ name: caseName, dir: `evals/alpha/${caseName}`, runsPerCase: 2, graders: [], arms: { with: [one(1), one(1)] }, aggregates: { score: 1, passRate: 1 } }],
      aggregates: { casesTotal: 1 },
    }));
    return { code: 0, stdout: 'Wrote result', stderr: '' };
  };
  const copilotExec = async (command, argv, { cwd, env }) => {
    // Check installation now, while the home still exists — compare() cleans it up once it
    // returns, so asserting on it afterward would always see an already-deleted directory.
    const installed = fs.existsSync(path.join(env.HOME, '.copilot', 'skills', 'alpha', 'SKILL.md'));
    seen.push({ target: 'copilot', home: env.HOME, cwd, model: argv[argv.indexOf('--model') + 1], token: env.COPILOT_GITHUB_TOKEN, installed });
    const jsonl = [
      { type: 'tool.execution_start', data: { toolCallId: '1', toolName: 'skill', arguments: { skill: 'alpha' } } },
      { type: 'tool.execution_complete', data: { toolCallId: '1', success: true } },
      { type: 'assistant.message', data: { content: 'done' } },
      { type: 'result', exitCode: 0, usage: { premiumRequests: 1, sessionDurationMs: 500 } },
    ].map((e) => JSON.stringify(e)).join('\n');
    return { code: 0, stdout: jsonl, stderr: '' };
  };

  const out = [];
  const result = await compare({
    root, base: baseSha, tier: 1, targets: ['claude', 'copilot'], now: new Date('2026-09-16T12:00:00Z'),
    log: () => {}, warn: (m) => out.push(m), exec: claudeExec, copilotExec, ghTokenFn: () => 'fake-gh-token',
    // The Copilot arm is containerized whenever a runtime exists, so the host path this test is
    // about has to be asked for explicitly — otherwise a machine with podman never reaches
    // `copilotExec` at all.
    container: 'off',
  });

  assert.equal(result.exitCode, 0);
  assert.match(out.join('\n'), /Copilot arm runs on the host/, 'the downgrade is announced, never silent');
  const copilotCalls = seen.filter((s) => s.target === 'copilot');
  assert.ok(copilotCalls.length > 0, 'the copilot cell actually ran');
  assert.ok(copilotCalls.every((c) => c.token === 'fake-gh-token'), 'the captured gh token reaches every copilot run');
  assert.ok(copilotCalls.every((c) => c.model === 'gpt-5-mini'));
  // Exactly one fake home per arm, reused across every case/run of that arm — not reinstalled per run.
  const homes = [...new Set(copilotCalls.map((c) => c.home))];
  assert.equal(homes.length, 2, 'one home for base, one for candidate');
  assert.ok(copilotCalls.every((c) => c.installed), 'the catalog was actually installed into the fake home before copilot ran');
  installedHomes.push(...homes);
  const copilotCell = result.summaries.find((s) => s.cellId.startsWith('copilot:'));
  assert.ok(copilotCell, 'a copilot CellSummary was produced alongside the claude one');
  assert.equal(result.summaries.find((s) => s.cellId.startsWith('claude:')).n, copilotCell.n === undefined ? undefined : copilotCell.n, 'both cells cover the same tier-1 cases');

  // The fake homes are cleaned up once the compare finishes, not left behind.
  for (const home of installedHomes) assert.ok(!fs.existsSync(home), 'a copilot home does not outlive the compare');
  fs.rmSync(root, { recursive: true, force: true });
});
