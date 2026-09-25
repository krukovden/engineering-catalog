'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  classifyInvalid, fromClaudeJson, validRuns, invalidRuns, writeRecords, readRecords, hashSuite, fingerprint,
} = require('../scripts/eval/records');

const FIXTURE = path.join(__dirname, 'fixtures/eval/claude-eval-shape.json');
const shape = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const CELL = { target: 'claude', model: 'claude-haiku-4-5', effort: 'low' };

test('the captured payload becomes one RunRecord, despite its max-turns error string', () => {
  const cases = new Map([['trigger-ssh-staging-box-restart-api', { name: 'trigger-ssh-staging-box-restart-api', group: 'safety-ssh', tags: ['trigger:positive'] }]]);
  const records = fromClaudeJson(shape(), { cell: CELL, arm: 'candidate', cases });
  assert.equal(records.length, 1);
  const [r] = records;
  assert.deepEqual(r.cell, CELL);
  assert.equal(r.arm, 'candidate');
  assert.equal(r.caseName, 'trigger-ssh-staging-box-restart-api');
  assert.equal(r.group, 'safety-ssh');
  assert.deepEqual(r.tags, ['trigger:positive']);
  assert.equal(r.run, 0);
  assert.equal(r.score, 1);
  assert.equal(r.passed, true);
  assert.equal(r.turns, 4);
  assert.equal(r.costUsd, 0.04687510000000001);
  assert.equal(r.error, 'exit 1: Reached maximum number of turns (3)');
  assert.equal(r.invalid, null);
  assert.deepEqual(r.graders, [{ name: 'skill-fired', passed: true, weight: 1, scored: true, explanation: 'Skill called 2x (expected 1..∞)' }]);
});

test('classifyInvalid: a plain error string is not invalidity', () => {
  assert.equal(classifyInvalid({ error: 'exit 1: Reached maximum number of turns (3)', partial: false, score: 1 }), null);
});

test('classifyInvalid: every invalid kind is recognised, case-insensitively', () => {
  assert.deepEqual(classifyInvalid({ error: null, partial: true, score: 1 }), { kind: 'partial', reason: 'run payload marked partial' });
  assert.equal(classifyInvalid({ error: 'HTTP 429 Too Many Requests', partial: false, score: 0 }).kind, 'rate-limit');
  assert.equal(classifyInvalid({ error: 'Overloaded, try again', partial: false, score: 0 }).kind, 'rate-limit');
  assert.equal(classifyInvalid({ error: 'Usage limit reached for this month', partial: false, score: 0 }).kind, 'usage-limit');
  assert.equal(classifyInvalid({ error: 'Your credit balance is too low', partial: false, score: 0 }).kind, 'usage-limit');
  assert.equal(classifyInvalid({ error: 'Authentication failed: invalid api key', partial: false, score: 0 }).kind, 'auth');
  assert.equal(classifyInvalid({ error: 'You are not logged in', partial: false, score: 0 }).kind, 'auth');
  assert.equal(classifyInvalid({ error: null, partial: false, score: NaN }).kind, 'crash');
  assert.equal(classifyInvalid({ error: null, partial: false, score: undefined }).kind, 'crash');
});

test('partial at the top level invalidates every run in the payload', () => {
  const json = shape();
  json.partial = true;
  json.cases[0].arms.with.push({ ...json.cases[0].arms.with[0], score: 0, error: null });
  const records = fromClaudeJson(json, { cell: CELL, arm: 'candidate', cases: [] });
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.invalid && r.invalid.kind === 'partial'));
});

test('arms.without always yields arm "none", regardless of the passed arm', () => {
  const json = shape();
  json.cases[0].arms.without = [{ ...json.cases[0].arms.with[0], score: 0, passed: false, error: null }];
  const records = fromClaudeJson(json, { cell: CELL, arm: 'candidate', cases: [] });
  const withoutRun = records.find((r) => r.score === 0);
  assert.equal(withoutRun.arm, 'none');
  const withRun = records.find((r) => r.score === 1);
  assert.equal(withRun.arm, 'candidate');
});

test('a case missing from the suite map derives its group from the payload dir', () => {
  const records = fromClaudeJson(shape(), { cell: CELL, arm: 'base', cases: new Map() });
  assert.equal(records[0].group, 'safety-ssh');
  assert.deepEqual(records[0].tags, []);
});

test('JSONL round-trips: write then read returns the same records', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'records-')), 'nested', 'run.jsonl');
  const records = fromClaudeJson(shape(), { cell: CELL, arm: 'candidate', cases: new Map() });
  writeRecords(file, records);
  assert.deepEqual(readRecords(file), records);
});

test('a missing file reads as an empty array', () => {
  assert.deepEqual(readRecords(path.join(os.tmpdir(), 'does-not-exist-eval-records.jsonl')), []);
});

test('writeRecords appends without rewriting what is already there', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'records-')), 'run.jsonl');
  const a = fromClaudeJson(shape(), { cell: CELL, arm: 'base', cases: new Map() });
  const b = fromClaudeJson(shape(), { cell: CELL, arm: 'candidate', cases: new Map() });
  writeRecords(file, a);
  writeRecords(file, b);
  const all = readRecords(file);
  assert.equal(all.length, 2);
  assert.equal(all[0].arm, 'base');
  assert.equal(all[1].arm, 'candidate');
});

test('a malformed line throws naming the file and line number', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'records-')), 'broken.jsonl');
  fs.writeFileSync(file, '{"ok":true}\nnot json\n');
  assert.throws(() => readRecords(file), new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:2`));
});

test('validRuns and invalidRuns split on the invalid flag', () => {
  const json = shape();
  json.cases[0].arms.with.push({ ...json.cases[0].arms.with[0], score: NaN, error: null });
  const records = fromClaudeJson(json, { cell: CELL, arm: 'candidate', cases: new Map() });
  assert.equal(validRuns(records).length, 1);
  assert.equal(invalidRuns(records).length, 1);
  assert.equal(invalidRuns(records)[0].invalid.kind, 'crash');
});

test('hashSuite is stable under reordering and changes when a prompt changes', () => {
  const a = [{ relDir: 'evals/x/one', prompt: 'do a', graders: [{ type: 'regex', pattern: 'a' }] },
    { relDir: 'evals/x/two', prompt: 'do b', graders: [] }];
  const reordered = [a[1], a[0]];
  assert.equal(hashSuite(a), hashSuite(reordered));
  assert.equal(hashSuite(a).length, 12);
  const changed = [{ ...a[0], prompt: 'do a differently' }, a[1]];
  assert.notEqual(hashSuite(a), hashSuite(changed));
});

test('fingerprint drops undefined keys and sorts the rest so key order does not matter', () => {
  const one = fingerprint({ baseSha: 'a', candidateSha: 'b', judge: undefined, os: 'darwin' });
  const two = fingerprint({ os: 'darwin', candidateSha: 'b', baseSha: 'a' });
  assert.deepEqual(Object.keys(one), ['baseSha', 'candidateSha', 'os']);
  assert.equal(JSON.stringify(one), JSON.stringify(two));
});
