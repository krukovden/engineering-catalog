'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build } = require('../lib/build');
const inst = require('../lib/install');
const { readReceipt } = require('../lib/receipt');

const FIX = path.join(__dirname, 'fixtures', 'catalog');
function builtCatalog() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'));
  fs.cpSync(FIX, root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.2.3', description: 'd' }));
  const r = build({ root });
  assert.deepEqual(r.errors, []);
  return { root, catalog: inst.loadCatalog(root) };
}

test('resolveBundleUnits pulls in requirements transitively and dedupes', () => {
  const { catalog } = builtCatalog();
  const r = inst.resolveBundleUnits(catalog, ['qa']);
  assert.deepEqual(r.skills.map((s) => s.name), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(r.agents.map((s) => s.name), ['helper', 'triager']);
  assert.deepEqual(r.workflows.map((s) => s.name), ['flow']);
  const both = inst.resolveBundleUnits(catalog, ['qa', 'developers']);
  assert.deepEqual(both.skills.map((s) => s.name), ['alpha', 'beta', 'delta', 'gamma']);
  assert.throws(() => inst.resolveBundleUnits(catalog, ['nope']), /no such bundle "nope"/);
});

test('resolveBundleUnits carries the steps of a named workflow (agents, their skills, requires)', () => {
  const { catalog } = builtCatalog();
  // A bundle naming only the workflow: install must still bring every step and its closure.
  catalog.bundles.push({ name: 'flow-only', audience: 'qa', description: '', skills: [], agents: [], workflows: ['flow'] });
  const r = inst.resolveBundleUnits(catalog, ['flow-only']);
  assert.deepEqual(r.workflows.map((w) => w.name), ['flow']);
  assert.deepEqual(r.agents.map((a) => a.name), ['triager']);
  assert.deepEqual(r.skills.map((s) => s.name), ['beta', 'gamma']);
});

test('planInstall produces per-target outputs and records skips', () => {
  const { root, catalog } = builtCatalog();
  const { plans } = inst.planInstall({ root, catalog, bundles: ['qa'], targets: ['claude', 'copilot'], scope: 'local' });
  assert.equal(plans.length, 2);
  const claude = plans.find((p) => p.target === 'claude');
  assert.equal(claude.items.length, 6);
  const copilot = plans.find((p) => p.target === 'copilot');
  assert.deepEqual(copilot.skipped.map((s) => s.unit.name), ['beta']);
  assert.equal(copilot.items.length, 5);
});

test('applyInstall writes files and a receipt', () => {
  const { root, catalog } = builtCatalog();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const { plans } = inst.planInstall({ root, catalog, bundles: ['qa'], targets: ['claude'], scope: 'local' });
  const { written, record } = inst.applyInstall({ plan: plans[0], baseDir: base, catalog, bundles: ['qa'], date: '2026-09-14T00:00:00.000Z' });
  assert.ok(written.includes('.claude/skills/alpha/scripts/run.sh'));
  assert.ok(fs.existsSync(path.join(base, '.claude/agents/triager.md')));
  assert.ok(fs.existsSync(path.join(base, '.claude/skills/flow/SKILL.md')));
  const receipt = readReceipt(base);
  assert.equal(receipt.installs[0].catalogVersion, '1.2.3');
  assert.deepEqual(receipt.installs[0].bundles, ['qa']);
  assert.equal(record.units.find((u) => u.name === 'alpha').files['.claude/skills/alpha/SKILL.md'].slice(0, 7), 'sha256:');
});

test('baseDirFor', () => {
  assert.equal(inst.baseDirFor('global', '/p', '/h'), '/h');
  assert.equal(inst.baseDirFor('local', '/p', '/h'), '/p');
});
