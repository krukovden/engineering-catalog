'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skills/developers/ado-pull-request/scripts/parse-branch.js');
const { parseBranch } = require(SCRIPT);
const cli = (...args) => execFileSync('node', [SCRIPT, ...args]).toString().trim();

test('parseBranch maps the convention to release-note types', () => {
  assert.deepEqual(parseBranch('feature/ADO-103520-x'), { type: 'feat', id: '103520' });
  assert.deepEqual(parseBranch('bug/ADO-103533-export-empty-file'), { type: 'fix', id: '103533' });
  assert.deepEqual(parseBranch('feature/ADO-42'), { type: 'feat', id: '42' });
  assert.equal(parseBranch('main'), null);
  assert.equal(parseBranch('feature/no-id-here'), null);
  assert.equal(parseBranch('hotfix/ADO-1-x'), null);
  assert.equal(parseBranch('feature/ADO-1x-y'), null);
});

test('CLI: parse, null outside the convention, usage without a branch', () => {
  assert.deepEqual(JSON.parse(cli('feature/ADO-103520-x')), { type: 'feat', id: '103520' });
  assert.equal(cli('main'), 'null');
  assert.throws(() => execFileSync('node', [SCRIPT], { stdio: 'pipe' }), /usage/);
});

// The convention lives in two self-contained skills (invariant 3 forbids sharing a file):
// ado-branch writes the name, ado-pull-request reads it. This keeps the two in step.
test('a name computed by ado-branch is parsed by ado-pull-request', () => {
  const { branchName } = require(path.join(__dirname, '..', 'skills/developers/ado-branch/scripts/branch-name.js'));
  assert.deepEqual(parseBranch(branchName({ type: 'Bug', id: 103533, title: 'Export: empty file' })), { type: 'fix', id: '103533' });
  assert.deepEqual(parseBranch(branchName({ type: 'Product Backlog Item', id: 103520, title: 'Add CSV export' })), { type: 'feat', id: '103520' });
  assert.deepEqual(parseBranch(branchName({ type: 'Task', id: 42, title: '!!!' })), { type: 'feat', id: '42' });
});
