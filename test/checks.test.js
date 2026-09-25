'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanUnits, FOLDERS } = require('../lib/units');
const { checkCatalog, resolveRequires, scanEvalGroups } = require('../lib/checks');

const FIX = path.join(__dirname, 'fixtures', 'catalog');
function withCatalog(mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-'));
  fs.cpSync(FIX, root, { recursive: true });
  mutate(root);
  const scanned = scanUnits({ root, folders: FOLDERS });
  return { root, ...scanned, ...checkCatalog({ ...scanned, evalGroups: scanEvalGroups(root) }) };
}
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('the fixture catalog is clean', () => {
  const r = withCatalog();
  assert.deepEqual(r.errors, []);
});

test('duplicate names across kinds are an error', () => {
  const r = withCatalog((root) => {
    fs.writeFileSync(path.join(root, 'agents/qa/alpha.md'), '---\nname: alpha\ndescription: d\n---\nb\n');
  });
  assert.ok(r.errors.some((e) => e.includes('duplicate name "alpha"')));
});

test('unresolved requires, agent skills, steps and bundle names', () => {
  const r = withCatalog((root) => {
    fs.writeFileSync(path.join(root, 'skills/qa/gamma/SKILL.md'), '---\nname: gamma\ndescription: d\nrequires:\n  - nope\n---\nb\n');
    fs.writeFileSync(path.join(root, 'agents/qa/triager.md'), '---\nname: triager\ndescription: d\nskills:\n  - nope2\n---\nb\n');
    fs.writeFileSync(path.join(root, 'workflows/qa/flow.md'), '---\nname: flow\ndescription: d\nsteps:\n  - agent: nope3\n---\nb\n');
    const b = readJson(path.join(root, 'bundles/qa.json')); b.skills.push('nope4'); writeJson(path.join(root, 'bundles/qa.json'), b);
  });
  for (const s of ['requires "nope"', 'skill "nope2"', 'agent "nope3"', 'skill "nope4"']) {
    assert.ok(r.errors.some((e) => e.includes(s)), `expected an error mentioning ${s}: ${r.errors}`);
  }
});

test('a bundle naming an unpromoted unit is an error', () => {
  const r = withCatalog((root) => {
    const b = readJson(path.join(root, 'bundles/qa.json')); b.skills.push('wip'); writeJson(path.join(root, 'bundles/qa.json'), b);
  });
  assert.ok(r.errors.some((e) => e.includes('"wip"') && e.includes('does not ship')));
});

test('a bundle must carry the requirements of what it names (inv. 7)', () => {
  const r = withCatalog((root) => {
    const b = readJson(path.join(root, 'bundles/qa.json')); b.skills = b.skills.filter((s) => s !== 'beta'); writeJson(path.join(root, 'bundles/qa.json'), b);
  });
  assert.ok(r.errors.some((e) => e.includes('bundle "qa" names "alpha" but not its requirement "beta"')));
});

test('a bundle must carry the steps of a workflow it names, and their requirements (inv. 7)', () => {
  const r = withCatalog((root) => {
    const b = readJson(path.join(root, 'bundles/qa.json')); b.agents = b.agents.filter((a) => a !== 'triager'); writeJson(path.join(root, 'bundles/qa.json'), b);
  });
  assert.ok(r.errors.some((e) => e.includes('bundle "qa" names "flow" but not its requirement "triager"')), r.errors.join('\n'));
  const noBeta = withCatalog((root) => {
    const b = readJson(path.join(root, 'bundles/qa.json')); b.skills = b.skills.filter((s) => s !== 'beta'); writeJson(path.join(root, 'bundles/qa.json'), b);
  });
  // gamma (a step) requires beta; triager (a step) names beta — both surface through the workflow.
  assert.ok(noBeta.errors.some((e) => e.includes('bundle "qa" names "flow" but not its requirement "beta"')), noBeta.errors.join('\n'));
});

test('resolveRequires is transitive', () => {
  const byName = new Map([
    ['a', { kind: 'skill', name: 'a', requires: ['b'] }],
    ['b', { kind: 'skill', name: 'b', requires: ['c'] }],
    ['c', { kind: 'skill', name: 'c', requires: ['a'] }],
  ]);
  assert.deepEqual(resolveRequires('a', byName), ['b', 'c']);
});

test('shared rule: in shared but claimed by one audience', () => {
  const r = withCatalog((root) => {
    const b = readJson(path.join(root, 'bundles/developers.json')); b.skills = b.skills.filter((s) => s !== 'alpha'); writeJson(path.join(root, 'bundles/developers.json'), b);
  });
  assert.ok(r.errors.some((e) => e.includes('skill "alpha" is in shared but only qa bundles claim it — move it to qa')));
});

test('shared rule: in an audience folder but claimed by another audience', () => {
  const r = withCatalog((root) => {
    const b = readJson(path.join(root, 'bundles/developers.json')); b.skills.push('gamma'); writeJson(path.join(root, 'bundles/developers.json'), b);
  });
  assert.ok(r.errors.some((e) => e.includes('skill "gamma" is in qa but a developers bundle also claims it — move it to shared')));
});

test('shared rule is silent when nothing claims the unit', () => {
  const r = withCatalog((root) => {
    fs.mkdirSync(path.join(root, 'skills/shared/orphan'));
    fs.writeFileSync(path.join(root, 'skills/shared/orphan/SKILL.md'), '---\nname: orphan\ndescription: d\n---\nb\n');
  });
  assert.ok(!r.errors.some((e) => e.includes('orphan')));
});

test('secrets and ../ references are errors', () => {
  const r = withCatalog((root) => {
    fs.writeFileSync(path.join(root, 'skills/qa/gamma/scripts.env'), 'PAT=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF\n');
    fs.writeFileSync(path.join(root, 'skills/shared/alpha/references/notes.md'), 'see [beta](../beta/SKILL.md)\n');
  });
  assert.ok(r.errors.some((e) => e.includes('skills/qa/gamma/scripts.env') && e.includes('secret')));
  assert.ok(r.errors.some((e) => e.includes('skills/shared/alpha/references/notes.md') && e.includes('outside its directory')));
});

test('an evals/ group must name a unit that ships', () => {
  const r = withCatalog((root) => {
    fs.mkdirSync(path.join(root, 'evals/alpha'), { recursive: true });   // a real skill
    fs.mkdirSync(path.join(root, 'evals/scenarios'), { recursive: true }); // reserved
    fs.mkdirSync(path.join(root, 'evals/renamed-away'), { recursive: true });
    fs.mkdirSync(path.join(root, 'evals/wip'), { recursive: true });      // in-progress skill
  });
  assert.ok(r.errors.some((e) => e === 'evals/renamed-away names "renamed-away", which is not a unit in the catalog'));
  assert.ok(r.errors.some((e) => e.includes('evals/wip names skill "wip"') && e.includes('does not ship')));
  assert.ok(!r.errors.some((e) => e.includes('evals/alpha') || e.includes('evals/scenarios')));
});
