'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { contextBudget, compareBudgets } = require('../scripts/eval/static');
const { run } = require('../scripts/eval');

const unit = (name, over = {}) => ({
  name, kind: 'skill', description: 'x'.repeat(40), promoted: true, invocation: 'model', platforms: {}, ...over,
});

test('a user-invoked skill costs context on Copilot but not on Claude', () => {
  const units = [unit('model-fired'), unit('person-fired', { invocation: 'user' })];
  const b = contextBudget({ units });
  assert.equal(b.claude.items.map((i) => i.name).join(), 'model-fired');
  assert.deepEqual(b.copilot.items.map((i) => i.name).sort(), ['model-fired', 'person-fired']);
  assert.equal(b.claude.chars, 40);
  assert.equal(b.copilot.chars, 80);
  assert.equal(b.copilot.tokens, 20);
});

test('unpromoted units and per-platform skips cost nothing', () => {
  const units = [
    unit('shipped'),
    unit('in-progress', { promoted: false }),
    unit('copilot-skips', { platforms: { copilot: 'skip' } }),
  ];
  const b = contextBudget({ units });
  assert.deepEqual(b.claude.items.map((i) => i.name).sort(), ['copilot-skips', 'shipped']);
  assert.deepEqual(b.copilot.items.map((i) => i.name), ['shipped']);
});

test('comparing two budgets reports the per-unit differences', () => {
  const base = contextBudget({ units: [unit('a'), unit('b')] });
  const candidate = contextBudget({ units: [unit('a', { description: 'x'.repeat(100) }), unit('c')] });
  const [claude] = compareBudgets(base, candidate);
  assert.equal(claude.target, 'claude');
  assert.equal(claude.chars.delta, 100 + 40 - 80);
  assert.deepEqual(claude.changed.map((c) => c.name).sort(), ['a', 'b', 'c']);
  assert.deepEqual(claude.changed.find((c) => c.name === 'b'), { name: 'b', before: 40, after: 0 });
});

test('lint fails on a broken case and passes on the real suite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcli-'));
  fs.mkdirSync(path.join(root, 'evals/alpha/broken'), { recursive: true });
  fs.writeFileSync(path.join(root, 'evals/alpha/broken/prompt.md'), '---\nnope: 1\n---\n\nhi\n');
  assert.equal(run(['lint'], { root }), 1);
  assert.equal(run(['lint']), 0, 'the repository’s own suite lints clean');
  assert.equal(run(['affected'], { root }), 1, 'affected without --base is refused');
  assert.equal(run(['nonsense'], { root }), 1);
});
