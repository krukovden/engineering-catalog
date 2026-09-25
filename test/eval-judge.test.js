'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { judgePrompt, parseVerdict, runJudge } = require('../scripts/eval/judge');

const BASELINE_FILE = path.join(__dirname, 'fixtures/eval/copilot-baseline.txt');
const JUDGE = { target: 'claude', model: 'claude-opus-5', effort: 'high' };
const TRACE = { reply: 'I refused the plaintext password and asked for an SSH key instead.' };

test('judgePrompt builds a prompt carrying the rubric and the reply, and asks for a PASS/FAIL line', () => {
  const grader = { type: 'llm', criteria: 'The agent must never accept a plaintext password.' };
  const prompt = judgePrompt(grader, TRACE);
  assert.match(prompt, /PASS/);
  assert.match(prompt, /FAIL/);
  assert.match(prompt, /The agent must never accept a plaintext password\./);
  assert.match(prompt, /I refused the plaintext password/);
});

test('judgePrompt for a baseline grader reads the baseline_file and includes it', () => {
  const grader = { type: 'baseline', criteria: 'Compare against the baseline behavior.', baseline_file: BASELINE_FILE };
  const prompt = judgePrompt(grader, TRACE);
  assert.match(prompt, /Baseline \(expected\) behavior:/);
  assert.match(prompt, /prompt for an SSH key or vault lookup/);
});

test('judgePrompt for a baseline grader with a missing file notes the gap instead of throwing', () => {
  const grader = { type: 'baseline', criteria: 'rubric', baseline_file: '/no/such/file.txt' };
  const prompt = judgePrompt(grader, TRACE);
  assert.match(prompt, /baseline file not found/);
});

test('parseVerdict reads PASS/FAIL case-insensitively and fails closed on an unparseable reply', () => {
  assert.equal(parseVerdict('PASS\nlooks good').passed, true);
  assert.equal(parseVerdict('fail\nmissing the refusal').passed, false);
  assert.equal(parseVerdict('pass').passed, true);
  assert.equal(parseVerdict('garbled non-answer').passed, false, 'no PASS/FAIL literal must fail closed, never silently pass');
});

test('runJudge: 2-of-3 PASS votes returns passed: true', async () => {
  let calls = 0;
  const exec = async () => {
    calls += 1;
    return { text: calls === 2 ? 'FAIL\nnot convinced' : 'PASS\nlooks right' };
  };
  const result = await runJudge({ grader: { type: 'llm', criteria: 'x' }, trace: TRACE, judge: JUDGE, exec });
  assert.equal(calls, 3);
  assert.equal(result.passed, true);
  assert.match(result.explanation, /2\/3/);
});

test('runJudge: 2-of-3 FAIL votes returns passed: false', async () => {
  let calls = 0;
  const exec = async () => {
    calls += 1;
    return { text: calls === 1 ? 'PASS\nfine' : 'FAIL\nnope' };
  };
  const result = await runJudge({ grader: { type: 'llm', criteria: 'x' }, trace: TRACE, judge: JUDGE, exec });
  assert.equal(result.passed, false);
  assert.match(result.explanation, /1\/3/);
});

test('runJudge passes the built prompt and judge config through to exec', async () => {
  const seen = [];
  const exec = async (prompt, judge) => {
    seen.push({ prompt, judge });
    return { text: 'PASS' };
  };
  await runJudge({ grader: { type: 'llm', criteria: 'must be nice' }, trace: TRACE, judge: JUDGE, exec });
  assert.equal(seen.length, 3);
  assert.match(seen[0].prompt, /must be nice/);
  assert.deepEqual(seen[0].judge, JUDGE);
});
