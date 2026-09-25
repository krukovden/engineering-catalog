'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const u = require('../lib/units');

const FIX = path.join(__dirname, 'fixtures', 'catalog');

test('constants are consistent', () => {
  assert.deepEqual(u.OWNER_FOLDERS, ['shared', 'developers', 'qa', 'product', 'ops']);
  assert.deepEqual(u.LIFECYCLE_FOLDERS, ['in-progress', 'deprecated']);
  assert.deepEqual(u.TARGETS, ['claude', 'copilot']);
});

test('loadSkillFromDir reads frontmatter, files, requires, version', () => {
  const s = u.loadSkillFromDir(path.join(FIX, 'skills/shared/alpha'), 'shared');
  assert.equal(s.kind, 'skill');
  assert.equal(s.name, 'alpha');
  assert.deepEqual(s.requires, ['beta']);
  assert.equal(s.invocation, 'model');
  assert.deepEqual(s.files, ['SKILL.md', 'references/notes.md', 'scripts/run.sh']);
  assert.equal(s.path, 'skills/shared/alpha');
  assert.equal(s.promoted, true);
  assert.match(s.version, /^[0-9a-f]{12}$/);
});

test('skill name must match folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'units-'));
  const dir = path.join(root, 'wrong');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: other\ndescription: d\n---\nb\n');
  assert.throws(() => u.loadSkillFromDir(dir, null), /must match folder name/);
});

test('unknown invocation and platform values are rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'units-'));
  const dir = path.join(root, 'x');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: d\ninvocation: auto\n---\nb\n');
  assert.throws(() => u.loadSkillFromDir(dir, null), /invocation/);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: d\nplatforms:\n  codex: skip\n---\nb\n');
  assert.throws(() => u.loadSkillFromDir(dir, null), /unknown platform/);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: d\nplatforms:\n  copilot: never\n---\nb\n');
  assert.throws(() => u.loadSkillFromDir(dir, null), /only supported value/);
});

test('loadAgentFromFile and loadWorkflowFromFile', () => {
  const a = u.loadAgentFromFile(path.join(FIX, 'agents/qa/triager.md'), 'qa');
  assert.equal(a.kind, 'agent');
  assert.deepEqual(a.skills, ['gamma', 'beta']);
  assert.equal(a.model, 'sonnet');
  assert.deepEqual(a.files, ['triager.md']);
  assert.equal(a.path, 'agents/qa/triager.md');
  const w = u.loadWorkflowFromFile(path.join(FIX, 'workflows/qa/flow.md'), 'qa');
  assert.equal(w.kind, 'workflow');
  assert.deepEqual(w.steps, [{ agent: 'triager' }, { skill: 'gamma' }]);
  assert.equal(w.path, 'workflows/qa/flow.md');
});

test('agent model may be one hint or a per-platform map; unknown platforms and non-strings are rejected', () => {
  const h = u.loadAgentFromFile(path.join(FIX, 'agents/shared/helper.md'), 'shared');
  assert.deepEqual(h.model, { claude: 'opus', copilot: 'gemini-3.8-flash' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'units-'));
  const f = path.join(root, 'a.md');
  fs.writeFileSync(f, '---\nname: a\ndescription: d\n---\nb\n');
  assert.equal(u.loadAgentFromFile(f, null).model, null);
  fs.writeFileSync(f, '---\nname: a\ndescription: d\nmodel:\n  claude: opus\n---\nb\n');
  assert.deepEqual(u.loadAgentFromFile(f, null).model, { claude: 'opus' });
  fs.writeFileSync(f, '---\nname: a\ndescription: d\nmodel:\n  codex: gpt-5.6\n---\nb\n');
  assert.throws(() => u.loadAgentFromFile(f, null), /model.*unknown platform "codex"/);
  fs.writeFileSync(f, '---\nname: a\ndescription: d\nmodel:\n  claude: [opus, sonnet]\n---\nb\n');
  assert.throws(() => u.loadAgentFromFile(f, null), /model\.claude must be a single model name/);
  fs.writeFileSync(f, '---\nname: a\ndescription: d\nmodel: [opus, sonnet]\n---\nb\n');
  assert.throws(() => u.loadAgentFromFile(f, null), /model must be/);
});

test('agent/workflow name must match file name; steps must be agent or skill', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'units-'));
  const f = path.join(root, 'a.md');
  fs.writeFileSync(f, '---\nname: b\ndescription: d\n---\nb\n');
  assert.throws(() => u.loadAgentFromFile(f, null), /must match file name/);
  fs.writeFileSync(f, '---\nname: a\ndescription: d\nsteps:\n  - tool: x\n---\nb\n');
  assert.throws(() => u.loadWorkflowFromFile(f, null), /step 1/);
});

test('loadBundle defaults and validation', () => {
  const b = u.loadBundle(path.join(FIX, 'bundles/developers.json'));
  assert.equal(b.audience, 'developers');
  assert.deepEqual(b.workflows, []);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'units-'));
  const f = path.join(root, 'backend.json');
  fs.writeFileSync(f, JSON.stringify({ name: 'backend', description: 'd', skills: ['x'] }));
  assert.throws(() => u.loadBundle(f), /audience/);
  fs.writeFileSync(f, JSON.stringify({ name: 'backend', audience: 'developers', description: 'd', skills: ['x'] }));
  assert.equal(u.loadBundle(f).audience, 'developers');
  fs.writeFileSync(f, JSON.stringify({ name: 'other', audience: 'developers', description: 'd' }));
  assert.throws(() => u.loadBundle(f), /must match file name/);
});

test('scanUnits returns promoted units in kind/folder/name order and all bundles', () => {
  const { units, bundles, warnings } = u.scanUnits({ root: FIX });
  assert.deepEqual(warnings, []);
  assert.deepEqual(units.map((x) => `${x.kind}:${x.folder}/${x.name}`), [
    'skill:shared/alpha', 'skill:shared/beta', 'skill:developers/delta', 'skill:qa/gamma',
    'agent:shared/helper', 'agent:qa/triager', 'workflow:qa/flow',
  ]);
  assert.deepEqual(bundles.map((b) => b.name), ['developers', 'qa']);
});

test('lifecycle folders are reachable only when asked', () => {
  const all = u.scanUnits({ root: FIX, folders: u.FOLDERS });
  assert.ok(all.units.some((x) => x.name === 'wip' && x.promoted === false));
});

test('a unit outside any folder is reported, not ignored', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'units-'));
  fs.cpSync(FIX, root, { recursive: true });
  fs.mkdirSync(path.join(root, 'skills/stray'));
  fs.writeFileSync(path.join(root, 'skills/stray/SKILL.md'), '---\nname: stray\ndescription: d\n---\nb\n');
  fs.writeFileSync(path.join(root, 'agents/loose.md'), '---\nname: loose\ndescription: d\n---\nb\n');
  const { warnings } = u.scanUnits({ root });
  assert.ok(warnings.some((w) => w.includes('skills/stray') && w.includes('outside')));
  assert.ok(warnings.some((w) => w.includes('agents/loose.md') && w.includes('outside')));
});

test('unitVersion changes when any file changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'units-'));
  fs.cpSync(path.join(FIX, 'skills/shared/alpha'), path.join(root, 'alpha'), { recursive: true });
  const before = u.loadSkillFromDir(path.join(root, 'alpha'), null).version;
  fs.appendFileSync(path.join(root, 'alpha/references/notes.md'), 'more\n');
  const after = u.loadSkillFromDir(path.join(root, 'alpha'), null).version;
  assert.notEqual(before, after);
});
