'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skills/developers/ado-branch/scripts/branch-name.js');
const { branchName, slug } = require(SCRIPT);
const cli = (...args) => execFileSync('node', [SCRIPT, ...args]).toString().trim();

test('Bug → bug/, slug drops punctuation and non-ASCII', () => {
  assert.equal(branchName({ type: 'Bug', id: 103533, title: 'Export: empty file when >10 MB!' }), 'bug/ADO-103533-export-empty-file-when-10-mb');
  assert.equal(branchName({ type: 'bug', id: '7', title: 'Крах при экспорте — crash on export' }), 'bug/ADO-7-crash-on-export');
});

test('PBI, Task, Feature and unknown types → feature/', () => {
  for (const type of ['Product Backlog Item', 'Task', 'Feature', 'User Story', '']) {
    assert.equal(branchName({ type, id: 103520, title: 'Add CSV export' }), 'feature/ADO-103520-add-csv-export', type);
  }
});

test('long title is cut to 50 chars at a hyphen boundary, no trailing hyphen', () => {
  const title = 'Implement the new configuration screen for the elevation view widget with validation';
  const name = branchName({ type: 'Task', id: 1, title });
  const s = name.slice('feature/ADO-1-'.length);
  assert.ok(s.length <= 50, s);
  assert.ok(!s.endsWith('-') && !s.startsWith('-'), s);
  assert.equal(s, 'implement-the-new-configuration-screen-for-the');
  assert.equal(slug('a'.repeat(60)).length, 50);
});

test('slug is lowercase ASCII with single hyphens, trimmed', () => {
  assert.equal(slug('  --Hello,   World__(v2)--  '), 'hello-world-v2');
  assert.equal(slug('!!!'), '');
});

test('branchName rejects a missing or non-numeric id', () => {
  assert.throws(() => branchName({ type: 'Bug', id: 'abc', title: 'x' }), /id/);
  assert.throws(() => branchName({ type: 'Bug', id: '', title: 'x' }), /id/);
});

test('CLI: compute, and a missing id fails', () => {
  assert.equal(cli('--type', 'Bug', '--id', '103533', '--title', 'Export: empty file when >10 MB!'), 'bug/ADO-103533-export-empty-file-when-10-mb');
  assert.throws(() => execFileSync('node', [SCRIPT, '--type', 'Bug'], { stdio: 'pipe' }), /id/);
});
