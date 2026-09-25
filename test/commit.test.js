'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skills/developers/commit/scripts/hunks.js');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const hunks = (cwd, ...args) => execFileSync('node', [SCRIPT, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const ids = (out) => out.trim().split('\n').map((l) => l.split(/\s+/)[0]);

const BASE = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);

/** A repository with one committed 40-line file, then edits near the top and near the bottom. */
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-hunks-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'tester@example.com');
  git(dir, 'config', 'user.name', 'tester');
  fs.writeFileSync(path.join(dir, 'file.txt'), BASE.join('\n') + '\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  const edited = BASE.slice();
  edited[2] = 'line 3 — the fix';
  edited[35] = 'line 36 — the rename';
  fs.writeFileSync(path.join(dir, 'file.txt'), edited.join('\n') + '\n');
  return dir;
}

test('list prints one id per hunk; stage puts only the named hunk into the index', () => {
  const dir = repo();
  const [top, bottom] = ids(hunks(dir, 'list', 'file.txt'));
  assert.match(top, /^[0-9a-f]{7}$/);
  assert.notEqual(top, bottom);

  assert.match(hunks(dir, 'stage', 'file.txt', top), /staged 1 of 2/);
  const staged = git(dir, 'diff', '--staged');
  assert.match(staged, /the fix/);
  assert.doesNotMatch(staged, /the rename/);
  // the working tree still holds both edits
  assert.match(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8'), /the rename/);
});

test('an id survives the other hunk being committed first', () => {
  const dir = repo();
  const [top, bottom] = ids(hunks(dir, 'list', 'file.txt'));
  hunks(dir, 'stage', 'file.txt', top);
  git(dir, 'commit', '-q', '-m', 'first');
  assert.deepEqual(ids(hunks(dir, 'list', 'file.txt')), [bottom]);
  hunks(dir, 'stage', 'file.txt', bottom);
  git(dir, 'commit', '-q', '-m', 'second');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.match(git(dir, 'show', '--format=', 'HEAD~1'), /the fix/);
  assert.match(git(dir, 'show', '--format=', 'HEAD'), /the rename/);
});

test('--fine separates two edits that share one hunk', () => {
  const dir = repo();
  const edited = BASE.slice();
  edited[9] = 'line 10 — change A';
  edited[11] = 'line 12 — change B';
  fs.writeFileSync(path.join(dir, 'file.txt'), edited.join('\n') + '\n');
  assert.equal(ids(hunks(dir, 'list', 'file.txt')).length, 1);
  const fine = ids(hunks(dir, 'list', '--fine', 'file.txt'));
  assert.equal(fine.length, 2);
  hunks(dir, 'stage', '--fine', 'file.txt', fine[1]);
  const staged = git(dir, 'diff', '--staged');
  assert.match(staged, /change B/);
  assert.doesNotMatch(staged, /change A/);
});

test('twin hunks share an id; list marks the later one #2; a bare id takes the first', () => {
  const dir = repo();
  const edited = BASE.slice();
  edited.splice(30, 0, 'same insert');
  edited.splice(5, 0, 'same insert');
  fs.writeFileSync(path.join(dir, 'file.txt'), edited.join('\n') + '\n');
  const [a, b] = ids(hunks(dir, 'list', '--fine', 'file.txt'));
  assert.equal(b, `${a}#2`);
  assert.match(hunks(dir, 'stage', '--fine', 'file.txt', a), /staged 1 of 2/);
  assert.equal((git(dir, 'diff', '--staged').match(/^\+same insert$/gm) || []).length, 1);
});

test('id#2 takes the second twin and leaves the first', () => {
  const dir = repo();
  const edited = BASE.slice();
  edited.splice(30, 0, 'same insert');
  edited.splice(5, 0, 'same insert');
  fs.writeFileSync(path.join(dir, 'file.txt'), edited.join('\n') + '\n');
  const [a] = ids(hunks(dir, 'list', '--fine', 'file.txt'));
  hunks(dir, 'stage', '--fine', 'file.txt', `${a}#2`);
  // the insert lands after line 30, where the working tree has it — not one line lower
  assert.deepEqual(git(dir, 'show', ':file.txt').split('\n').slice(29, 32), ['line 30', 'same insert', 'line 31']);
  assert.doesNotMatch(git(dir, 'diff', '--staged', '-U0'), /^@@ -5,0 /m);
  assert.throws(() => hunks(dir, 'stage', '--fine', 'file.txt', `${a}#3`), (e) => /known ids/.test(e.stderr.toString()));
});

test('--fine: a later hunk staged alone lands where the working tree has it, for inserts, deletes and edits', () => {
  const dir = repo();
  const edited = BASE.slice();
  edited.splice(34, 1);                       // delete line 35
  edited[24] = 'line 25 — edited';            // edit
  edited.splice(14, 0, 'insert A', 'insert B'); // insert after line 14
  edited.splice(3, 2);                        // delete lines 4-5, left out of the commit
  fs.writeFileSync(path.join(dir, 'file.txt'), edited.join('\n') + '\n');
  const all = ids(hunks(dir, 'list', '--fine', 'file.txt'));
  assert.equal(all.length, 4);
  hunks(dir, 'stage', '--fine', 'file.txt', ...all.slice(1));
  const expected = BASE.slice();
  expected.splice(34, 1);
  expected[24] = 'line 25 — edited';
  expected.splice(14, 0, 'insert A', 'insert B');
  assert.equal(git(dir, 'show', ':file.txt'), expected.join('\n') + '\n');
  // what is left unstaged is exactly the first hunk
  assert.deepEqual(ids(hunks(dir, 'list', '--fine', 'file.txt')).length, 4);
  git(dir, 'commit', '-q', '-m', 'three of four');
  assert.deepEqual(ids(hunks(dir, 'list', '--fine', 'file.txt')), [all[0]]);
});

test('show prints the hunk; an unknown id fails and names the known ones', () => {
  const dir = repo();
  const [top] = ids(hunks(dir, 'list', 'file.txt'));
  assert.match(hunks(dir, 'show', 'file.txt', top), /^@@ .*\n[\s\S]*the fix/);
  assert.throws(() => hunks(dir, 'stage', 'file.txt', 'fffffff'), (e) => e.status === 1 && /known ids/.test(e.stderr.toString()));
  assert.equal(git(dir, 'diff', '--staged'), '');
});

test('files without hunks to pick are reported as whole-file', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'new.txt'), 'x\n');
  assert.match(hunks(dir, 'list', 'new.txt'), /^whole-file {2}untracked file/);
  git(dir, 'add', 'new.txt');
  assert.match(hunks(dir, 'list', 'new.txt'), /^whole-file {2}new file/);
  assert.throws(() => hunks(dir, 'stage', 'new.txt', 'abcdef0'), (e) => /stage it whole/.test(e.stderr.toString()));
});

test('usage error exits 2', () => {
  assert.throws(() => hunks(os.tmpdir(), 'stage', 'file.txt'), (e) => e.status === 2);
});
