'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build } = require('../lib/build');
const inst = require('../lib/install');
const upd = require('../lib/update');

const FIX = path.join(__dirname, 'fixtures', 'catalog');
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  fs.cpSync(FIX, root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', description: 'd' }));
  build({ root });
  const catalog = inst.loadCatalog(root);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const { plans } = inst.planInstall({ root, catalog, bundles: ['qa'], targets: ['claude'], scope: 'local' });
  const { record } = inst.applyInstall({ plan: plans[0], baseDir: base, catalog, bundles: ['qa'] });
  return { root, base, record };
}
function rebuild(root, version) {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version, description: 'd' }));
  build({ root });
  const catalog = inst.loadCatalog(root);
  return inst.planInstall({ root, catalog, bundles: ['qa'], targets: ['claude'], scope: 'local' }).plans[0];
}

test('diffUnits sees changed, added, removed and unchanged', () => {
  const { root, record } = setup();
  fs.appendFileSync(path.join(root, 'skills/qa/gamma/SKILL.md'), '\nMore.\n');
  fs.mkdirSync(path.join(root, 'skills/qa/eps'));
  fs.writeFileSync(path.join(root, 'skills/qa/eps/SKILL.md'), '---\nname: eps\ndescription: d\n---\nb\n');
  const b = JSON.parse(fs.readFileSync(path.join(root, 'bundles/qa.json'), 'utf8'));
  b.skills.push('eps'); b.workflows = [];
  fs.writeFileSync(path.join(root, 'bundles/qa.json'), JSON.stringify(b));
  const plan = rebuild(root, '1.1.0');
  const d = upd.diffUnits(record, plan);
  assert.deepEqual(d.changed.map((c) => c.unit.name), ['gamma']);
  assert.deepEqual(d.added.map((u) => u.name), ['eps']);
  assert.deepEqual(d.removed.map((u) => u.name), ['flow']);
  assert.ok(d.unchanged.some((u) => u.name === 'alpha'));
  assert.deepEqual(upd.staleFiles(record, plan), ['.claude/skills/flow/SKILL.md']);
});

test('detectLocalEdits finds hand-edited and missing files', () => {
  const { base, record } = setup();
  fs.appendFileSync(path.join(base, '.claude/skills/alpha/SKILL.md'), 'edited\n');
  fs.rmSync(path.join(base, '.claude/agents/helper.md'));
  const edits = upd.detectLocalEdits(record, base);
  assert.deepEqual(edits.map((e) => [e.name, e.status]), [['alpha', 'edited'], ['helper', 'missing']]);
});

test('compareVersions', () => {
  assert.equal(upd.compareVersions('1.2.0', '1.10.0'), -1);
  assert.equal(upd.compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(upd.compareVersions('1.0.0', '1.0.0'), 0);
});
