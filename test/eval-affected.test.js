'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanUnits, FOLDERS } = require('../lib/units');
const { affectedUnits, affectedHooks, selectCases } = require('../scripts/eval/affected');

const FIX = path.join(__dirname, 'fixtures', 'catalog');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'affected-'));
fs.cpSync(FIX, root, { recursive: true });
const { units } = scanUnits({ root, folders: FOLDERS });
const HOOKS = [{ name: 'alpha-start', path: 'hooks/alpha-start.json', script: 'scripts/fixture-hook', event: 'SessionStart' }];

const mkCase = (group, name, tags) => ({ group, name, tags, relDir: path.join('evals', group, name) });
const CASES = [
  mkCase('alpha', 'alpha-trigger', ['trigger:positive']),
  mkCase('alpha', 'alpha-behaviour', ['behaviour']),
  mkCase('beta', 'beta-trigger', ['trigger:positive']),
  mkCase('gamma', 'gamma-behaviour', ['behaviour']),
  mkCase('scenarios', 'memory-flow', ['scenario', 'unit:delta']),
  mkCase('hooks', 'freshness-notice', ['SessionStart.fixture-hook'.startsWith('x') ? 'behaviour' : 'hook:SessionStart.fixture-hook']),
];

test('a change reaches the units that lean on the changed one', () => {
  // The fixture: alpha and gamma require beta; helper names alpha; triager names gamma and
  // beta; flow steps through triager and gamma. A change to beta therefore reaches all of them.
  const names = affectedUnits({ units, changed: ['skills/shared/beta/SKILL.md'] });
  assert.deepEqual([...names].sort(), ['alpha', 'beta', 'flow', 'gamma', 'helper', 'triager']);
  assert.deepEqual([...affectedUnits({ units, changed: ['skills/developers/delta/SKILL.md'] })], ['delta'],
    'a unit nothing depends on reaches only itself');
  assert.deepEqual([...affectedUnits({ units, changed: ['lib/build.js'] })], [], 'a change outside the units reaches none');
});

test('a hook is affected by its source and by either script twin', () => {
  assert.deepEqual([...affectedHooks({ hooks: HOOKS, changed: ['hooks/alpha-start.json'] })], ['SessionStart.fixture-hook']);
  assert.deepEqual([...affectedHooks({ hooks: HOOKS, changed: ['scripts/fixture-hook.ps1'] })], ['SessionStart.fixture-hook']);
  assert.deepEqual([...affectedHooks({ hooks: HOOKS, changed: ['README.md'] })], []);
});

test('tier 1 keeps trigger cases of affected units only', () => {
  const r = selectCases({ cases: CASES, units, hooks: HOOKS, changed: ['skills/shared/beta/SKILL.md'], tier: 1 });
  assert.deepEqual(r.cases.map((c) => c.name), ['alpha-trigger', 'beta-trigger']);
});

test('tier 2 drops scenarios; a scenario is reached through its unit: tag at tier 3', () => {
  const changed = ['skills/developers/delta/SKILL.md'];
  assert.deepEqual(selectCases({ cases: CASES, units, hooks: HOOKS, changed, tier: 2 }).cases.map((c) => c.name), []);
  const tier3 = selectCases({ cases: CASES, units, hooks: HOOKS, changed, tier: 3 });
  assert.ok(tier3.cases.some((c) => c.name === 'memory-flow'), 'tier 3 runs everything');
});

test('a changed hook selects its behaviour case; a changed case selects itself', () => {
  const hookRun = selectCases({ cases: CASES, units, hooks: HOOKS, changed: ['scripts/fixture-hook.sh'], tier: 2 });
  assert.deepEqual(hookRun.cases.map((c) => c.name), ['freshness-notice']);
  const caseRun = selectCases({ cases: CASES, units, hooks: HOOKS, changed: [path.join('evals', 'gamma', 'gamma-behaviour', 'prompt.md')], tier: 2 });
  assert.deepEqual(caseRun.cases.map((c) => c.name), ['gamma-behaviour']);
});
