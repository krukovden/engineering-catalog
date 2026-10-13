'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skills/shared/memory/scripts/lint.js');

function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memlint-'));
  fs.mkdirSync(path.join(root, 'memory', 'units'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory', '.store.json'), JSON.stringify({ store: 'committed', dir: 'memory' }));
  fs.writeFileSync(path.join(root, 'memory', 'index.md'), '<!-- memory:index -->\n# x\n\nreconciled-sha: none\nstore: committed\n\n## Units\n| Unit | Summary |\n|---|---|\n| [[alpha]] | A |\n');
  fs.writeFileSync(path.join(root, 'memory', 'units', 'alpha.md'), '<!-- memory:unit alpha — x -->\n# Alpha\n\n## Entries\n\nThis predates tracking; history before 2026-10-12 is not recorded.\n');
  return root;
}

test('lint warns when AGENTS.md crosses the advisory line', () => {
  const root = setupRepo();
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'a'.repeat(25 * 1024));
  const r = spawnSync('node', [SCRIPT, '--memory', path.join(root, 'memory')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning: AGENTS\.md is/);
  assert.match(r.stdout, /memory is clean\./);
});

test('lint warns when CLAUDE.md crosses the hard instruction budget in a consumer project', () => {
  const root = setupRepo();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'a'.repeat(33 * 1024));
  const r = spawnSync('node', [SCRIPT, '--memory', path.join(root, 'memory')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning: CLAUDE\.md is .* hard line is 32768 bytes \(32 KiB\) in consumer projects/);
  assert.match(r.stdout, /memory is clean\./);
});
