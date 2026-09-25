'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skills/developers/pr-review/scripts/file-sizes.sh');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

/** A repo whose main has one file, and a branch that adds files of 10, 350 and 600 lines and deletes one. */
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'gone.txt'), lines(5));
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', 'feature');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/small.js'), lines(10));
  fs.writeFileSync(path.join(dir, 'src/mid.js'), lines(350));
  fs.writeFileSync(path.join(dir, 'big.js'), lines(600));
  fs.rmSync(path.join(dir, 'gone.txt'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'work');
  return dir;
}

test('file-sizes.sh is executable POSIX sh', () => {
  assert.equal(fs.statSync(SCRIPT).mode & 0o111, 0o111);
  assert.ok(fs.readFileSync(SCRIPT, 'utf8').startsWith('#!/bin/sh'));
});

test('file-sizes.sh lists changed files largest first with ! and !! markers', () => {
  const dir = repo();
  const out = execFileSync(SCRIPT, [], { cwd: dir }).toString();
  const rows = out.trim().split('\n').map((l) => l.trim().split(/\s+/));
  assert.deepEqual(rows, [
    ['600', '!!', 'big.js'],
    ['350', '!', 'src/mid.js'],
    ['10', 'src/small.js'],
  ]);
  assert.ok(!out.includes('gone.txt'), 'a deleted file has no size to report');
  assert.ok(!out.includes('README.md'), 'an unchanged file is not listed');
});

test('file-sizes.sh takes an explicit range', () => {
  const dir = repo();
  git(dir, 'checkout', '-q', 'main');
  const out = execFileSync(SCRIPT, ['main', 'feature'], { cwd: dir }).toString();
  assert.ok(out.includes('big.js') && out.includes('src/mid.js'));
  const same = execFileSync(SCRIPT, ['feature', 'feature'], { cwd: dir }).toString();
  assert.equal(same.trim(), '');
});
