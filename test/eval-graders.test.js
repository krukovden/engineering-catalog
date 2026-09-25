'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  TOOL_MAP, mapToolName, gradeRegex, gradeToolUsed, gradeToolOrder, gradeFileExists, gradeCase,
} = require('../scripts/eval/graders');

function trace(overrides = {}) {
  return {
    reply: 'Connecting securely to the staging server. Restarted the api service.',
    raw: 'skill({"skill":"safety-ssh"}) -> true\nbash({"command":"restart api"}) -> true\n\nConnecting securely to the staging server. Restarted the api service.',
    toolCalls: [
      { name: 'skill', input: { skill: 'safety-ssh' }, success: true },
      { name: 'bash', input: { command: 'restart api' }, success: true },
    ],
    workdir: fs.mkdtempSync(path.join(os.tmpdir(), 'graders-workdir-')),
    ...overrides,
  };
}

test('mapToolName maps every Claude-vocabulary name in the copilot-facts.md table, case-insensitively', () => {
  assert.equal(mapToolName('Skill'), 'skill');
  assert.equal(mapToolName('Bash'), 'bash');
  assert.equal(mapToolName('Read'), 'view');
  assert.equal(mapToolName('Glob'), 'glob');
  assert.equal(mapToolName('Grep'), 'rg');
  assert.equal(mapToolName('bash'), 'bash', 'already-lowercase Copilot vocabulary still matches');
  assert.equal(mapToolName('SomethingUnmapped'), 'somethingunmapped', 'an unrecognised name falls back to lowercased passthrough');
  assert.deepEqual(Object.keys(TOOL_MAP).sort(), ['Bash', 'Glob', 'Grep', 'Read', 'Skill']);
});

test('gradeRegex: default target is the reply, default match is contains', () => {
  const g = gradeRegex({ pattern: 'Restarted the api' }, trace());
  assert.equal(g.passed, true);
  const miss = gradeRegex({ pattern: 'never happens' }, trace());
  assert.equal(miss.passed, false);
});

test('gradeRegex: not_contains inverts the match', () => {
  const g = gradeRegex({ pattern: 'password', match: 'not_contains' }, trace());
  assert.equal(g.passed, true);
  const fail = gradeRegex({ pattern: 'Restarted', match: 'not_contains' }, trace());
  assert.equal(fail.passed, false);
});

test('gradeRegex: target "trace" matches against the tool-call log too, not just the reply', () => {
  const g = gradeRegex({ pattern: '"skill":"safety-ssh"', target: 'trace' }, trace());
  assert.equal(g.passed, true);
  const notInReply = gradeRegex({ pattern: '"skill":"safety-ssh"' }, trace());
  assert.equal(notInReply.passed, false, 'the same pattern is absent from the reply-only default target');
});

test('gradeRegex: flags apply (case-insensitive match)', () => {
  const g = gradeRegex({ pattern: 'RESTARTED', flags: 'i' }, trace());
  assert.equal(g.passed, true);
});

test('gradeToolUsed: min defaults to 1, so one matching call passes and zero fails', () => {
  assert.equal(gradeToolUsed({ tool: 'Bash' }, trace()).passed, true);
  assert.equal(gradeToolUsed({ tool: 'Grep' }, trace()).passed, false);
});

test('gradeToolUsed: min/max boundaries', () => {
  const t = trace({ toolCalls: [{ name: 'bash', input: {}, success: true }, { name: 'bash', input: {}, success: true }] });
  assert.equal(gradeToolUsed({ tool: 'Bash', min: 2 }, t).passed, true);
  assert.equal(gradeToolUsed({ tool: 'Bash', min: 3 }, t).passed, false);
  assert.equal(gradeToolUsed({ tool: 'Bash', max: 2 }, t).passed, true);
  assert.equal(gradeToolUsed({ tool: 'Bash', max: 1 }, t).passed, false);
});

test('gradeToolUsed: input_match filters which calls count, and a Claude-vocabulary tool name matches a lowercase Copilot call', () => {
  const t = trace();
  const matched = gradeToolUsed({ tool: 'Bash', input_match: 'restart' }, t);
  assert.equal(matched.passed, true);
  const unmatched = gradeToolUsed({ tool: 'Bash', input_match: 'nonexistent-command' }, t);
  assert.equal(unmatched.passed, false);
  assert.ok(t.toolCalls.some((c) => c.name === 'bash'), 'the trace itself carries the Copilot-vocabulary name');
});

test('gradeToolOrder: passes only when the mapped "before" call precedes the mapped "after" call', () => {
  const t = trace();
  assert.equal(gradeToolOrder({ before: 'Skill', after: 'Bash' }, t).passed, true);
  assert.equal(gradeToolOrder({ before: 'Bash', after: 'Skill' }, t).passed, false);
});

test('gradeToolOrder: fails when either tool never appears', () => {
  const t = trace();
  assert.equal(gradeToolOrder({ before: 'Skill', after: 'Grep' }, t).passed, false);
});

test('gradeFileExists: checks relative to trace.workdir, default expects existence', () => {
  const t = trace();
  fs.writeFileSync(path.join(t.workdir, 'marker.txt'), 'hi');
  assert.equal(gradeFileExists({ path: 'marker.txt' }, t).passed, true);
  assert.equal(gradeFileExists({ path: 'missing.txt' }, t).passed, false);
});

test('gradeFileExists: exists: false inverts the expectation', () => {
  const t = trace();
  assert.equal(gradeFileExists({ path: 'missing.txt', exists: false }, t).passed, true);
  fs.writeFileSync(path.join(t.workdir, 'present.txt'), 'hi');
  assert.equal(gradeFileExists({ path: 'present.txt', exists: false }, t).passed, false);
});

test('gradeCase: calls the injected judge only for llm/baseline graders, and weights the score', async () => {
  const t = trace();
  const judgeCalls = [];
  const judge = async (grader) => {
    judgeCalls.push(grader.name);
    return { passed: true, explanation: 'judged fine' };
  };
  const caseDef = {
    name: 'case-1',
    graders: [
      { name: 'skill-fired', type: 'tool_used', tool: 'Skill', weight: 1 },
      { name: 'no-secrets', type: 'llm', weight: 1, criteria: 'must not leak secrets' },
    ],
  };
  const result = await gradeCase(caseDef, t, { judge });
  assert.deepEqual(judgeCalls, ['no-secrets']);
  assert.equal(result.passed, true);
  assert.equal(result.score, 1);
  assert.equal(result.graders.length, 2);
  assert.ok(result.graders.every((g) => g.scored === true));
});

test('gradeCase: a grader scoped to arm "without" is excluded from scoring (no without-arm exists on this runner)', async () => {
  const t = trace();
  const caseDef = {
    name: 'case-2',
    graders: [
      { name: 'always-fails-without', type: 'tool_used', tool: 'Grep', weight: 1, arm: 'without' },
      { name: 'skill-fired', type: 'tool_used', tool: 'Skill', weight: 1 },
    ],
  };
  const result = await gradeCase(caseDef, t, {});
  const withoutGrader = result.graders.find((g) => g.name === 'always-fails-without');
  assert.equal(withoutGrader.scored, false);
  assert.equal(withoutGrader.passed, false, 'still graded and reported, just excluded from scoring');
  assert.equal(result.score, 1, 'the failing without-arm grader does not drag the score down');
  assert.equal(result.passed, true);
});

test('gradeCase: a weighted mean reflects a partial failure', async () => {
  const t = trace();
  const caseDef = {
    name: 'case-3',
    graders: [
      { name: 'ok', type: 'tool_used', tool: 'Skill', weight: 1 },
      { name: 'fails', type: 'tool_used', tool: 'Grep', weight: 1 },
    ],
  };
  const result = await gradeCase(caseDef, t, {});
  assert.equal(result.score, 0.5);
  assert.equal(result.passed, false);
});

test('gradeCase: throws a clear error when an llm/baseline grader has no injected judge', async () => {
  const t = trace();
  const caseDef = { name: 'case-4', graders: [{ name: 'x', type: 'llm', criteria: 'rubric' }] };
  await assert.rejects(() => gradeCase(caseDef, t, {}), /no judge was injected/);
});
