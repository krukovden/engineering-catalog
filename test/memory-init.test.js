'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skills/shared/memory-init/scripts/memory-init.js');
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Rules\n\nKeep tests green.\n');
  return dir;
}
const run = (dir, extra = [], home = fs.mkdtempSync(path.join(os.tmpdir(), 'h-'))) => JSON.parse(execFileSync('node', [SCRIPT, '--project', dir, '--json', ...extra], { env: { ...process.env, ENGCAT_HOME: home } }).toString());

test('first run does every step; second run keeps them', () => {
  const dir = repo();
  const first = run(dir);
  assert.deepEqual(first.steps.map((s) => [s.name, s.state]), [['folder', 'done'], ['index', 'done'], ['pointers', 'done'], ['hook', 'done'], ['gitignore', 'done']]);
  assert.ok(fs.existsSync(path.join(dir, 'memory/units')));
  const index = fs.readFileSync(path.join(dir, 'memory/index.md'), 'utf8');
  assert.ok(index.includes('reconciled-sha: none') && index.includes('store: committed'));
  const claude = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.ok(claude.startsWith('# Rules') && claude.includes('<!-- engineering-catalog:memory:start -->') && claude.includes('memory/index.md'));
  assert.ok(fs.readFileSync(path.join(dir, '.github/copilot-instructions.md'), 'utf8').includes('memory/index.md'));
  assert.ok(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').includes('memory/index.md'));
  const hook = path.join(dir, '.git/hooks/post-commit');
  const hookText = fs.readFileSync(hook, 'utf8');
  // Committed store: the hook resolves the repo at run time and commits nothing machine-specific.
  assert.ok(hookText.includes('git rev-parse --show-toplevel'), hookText);
  assert.ok(hookText.includes('/memory/.pending'), hookText);
  assert.ok(!hookText.includes(dir), `hook hard-codes ${dir}`);
  assert.equal(fs.statSync(hook).mode & 0o111, 0o111);
  const store = JSON.parse(fs.readFileSync(path.join(dir, 'memory/.store.json'), 'utf8'));
  assert.equal(store.store, 'committed');
  assert.equal(store.dir, 'memory');
  assert.ok(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').includes('memory/.pending'));
  const second = run(dir);
  assert.ok(second.steps.every((s) => s.state === 'kept'), JSON.stringify(second));
});

test('the hook appends the commit sha to .pending', () => {
  const dir = repo();
  run(dir);
  fs.writeFileSync(path.join(dir, 'f'), 'x');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['add', '.'], { cwd: dir, env });
  execFileSync('git', ['commit', '-qm', 'c'], { cwd: dir, env });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  assert.equal(fs.readFileSync(path.join(dir, 'memory/.pending'), 'utf8').trim(), sha);
});

test('an existing post-commit hook keeps its own content', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, '.git/hooks/post-commit'), '#!/bin/sh\necho mine\n');
  run(dir); run(dir);
  const hook = fs.readFileSync(path.join(dir, '.git/hooks/post-commit'), 'utf8');
  assert.ok(hook.includes('echo mine'));
  assert.equal(hook.split('engineering-catalog:memory:start').length, 2);
});

test('local store lives outside the project and pointers use the absolute path', () => {
  const dir = repo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h-'));
  const r = run(dir, ['--store', 'local'], home);
  assert.ok(!r.memoryDir.startsWith(dir));
  assert.ok(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').includes(r.memoryDir));
  assert.equal(r.steps.find((s) => s.name === 'gitignore').state, 'skipped');
  const posixDir = r.memoryDir.split(path.sep).join('/');
  const hookText = fs.readFileSync(path.join(dir, '.git/hooks/post-commit'), 'utf8');
  assert.ok(hookText.includes(`"${posixDir}/.pending"`), hookText);
  assert.ok(!hookText.includes('--show-toplevel'));
  const store = JSON.parse(fs.readFileSync(path.join(r.memoryDir, '.store.json'), 'utf8'));
  assert.equal(store.store, 'local');
  assert.equal(store.dir, r.memoryDir);
  assert.ok(r.steps.every((s) => s.name === 'gitignore' || s.state === 'done'), JSON.stringify(r));
  const again = run(dir, ['--store', 'local'], home);
  assert.ok(again.steps.every((s) => s.name === 'gitignore' || s.state === 'kept'), JSON.stringify(again));
});

test('outside a git repository the hook step is skipped, everything else done', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-'));
  const r = run(dir);
  assert.equal(r.steps.find((s) => s.name === 'hook').state, 'skipped');
  assert.ok(fs.existsSync(path.join(dir, 'memory/index.md')));
});

test('a file that only mentions the markers in prose gets the block appended, not spliced', () => {
  const dir = repo();
  const prose = '# Rules\n\nOnly the block between `<!-- engineering-catalog:memory:start -->` /\n`<!-- engineering-catalog:memory:end -->` is rewritten; everything else survives.\n';
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), prose);
  run(dir);
  const out = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.ok(out.startsWith(prose), 'prose untouched');
  assert.equal(out.split('## Project memory').length, 2, 'block appended once');
  run(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').split('## Project memory').length, 2, 'still once');
});
