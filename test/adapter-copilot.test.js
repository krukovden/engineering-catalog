'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const copilot = require('../lib/adapters/copilot');
const u = require('../lib/units');

const FIX = path.join(__dirname, 'fixtures', 'catalog');
const alpha = () => u.loadSkillFromDir(path.join(FIX, 'skills/shared/alpha'), 'shared');
const beta = () => u.loadSkillFromDir(path.join(FIX, 'skills/shared/beta'), 'shared');
const helper = () => u.loadAgentFromFile(path.join(FIX, 'agents/shared/helper.md'), 'shared');
const flow = () => u.loadWorkflowFromFile(path.join(FIX, 'workflows/qa/flow.md'), 'qa');

test('local and global layouts differ (§7.1)', () => {
  assert.deepEqual(copilot.outputs(alpha(), 'local').map((o) => o.path)[0], '.github/skills/alpha/SKILL.md');
  assert.deepEqual(copilot.outputs(alpha(), 'global').map((o) => o.path)[0], '.copilot/skills/alpha/SKILL.md');
  assert.deepEqual(copilot.outputs(helper(), 'local').map((o) => o.path), ['.github/agents/helper.agent.md']);
  assert.deepEqual(copilot.outputs(helper(), 'global').map((o) => o.path), ['.copilot/agents/helper.agent.md']);
  assert.deepEqual(copilot.outputs(flow(), 'local').map((o) => o.path), ['.github/skills/flow/SKILL.md']);
});

test('an agent carries the Copilot side of its model map', () => {
  const [agent] = copilot.outputs(helper(), 'local');
  assert.ok(agent.content.toString().includes('\nmodel: gemini-3.8-flash\n'));
  assert.ok(!agent.content.toString().includes('opus'));
  const triager = u.loadAgentFromFile(path.join(FIX, 'agents/qa/triager.md'), 'qa');
  assert.ok(copilot.outputs(triager, 'local')[0].content.toString().includes('\nmodel: sonnet\n'), 'a string hint reaches every platform');
});

test('the whole tree travels with modes; user-invoked flag applied', () => {
  const out = copilot.outputs(alpha(), 'local');
  assert.equal(out.length, 3);
  assert.equal(out.find((o) => o.path.endsWith('run.sh')).mode & 0o111, 0o111);
  const b = copilot.outputs(beta(), 'local');
  assert.equal(b.length, 0, 'beta opts out of copilot in the fixture');
});

test('user-invoked skills and workflows carry no disable-model-invocation flag on Copilot', () => {
  const gamma = u.loadSkillFromDir(path.join(FIX, 'skills/qa/gamma'), 'qa');
  gamma.invocation = 'user';
  const out = copilot.outputs(gamma, 'local');
  assert.ok(!out[0].content.toString().includes('disable-model-invocation'));
  assert.ok(!copilot.outputs(flow(), 'local')[0].content.toString().includes('disable-model-invocation'));
});

test('skipReason and install', () => {
  assert.match(copilot.skipReason(beta()), /opts out of Copilot/);
  assert.equal(copilot.skipReason(alpha()), null);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-'));
  const written = copilot.install(alpha(), base, 'global');
  assert.ok(fs.existsSync(path.join(base, '.copilot/skills/alpha/scripts/run.sh')));
  assert.equal(written.length, 3);
});

test('a session-start skill gets a Copilot instructions file that runs it, in both scopes', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-')), 'warmup');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: warmup\nsession-start: true\ndescription: d\n---\nbody\n');
  const unit = u.loadSkillFromDir(dir, 'shared');
  assert.equal(unit.sessionStart, true);
  const global = copilot.outputs(unit, 'global').find((o) => o.path === '.copilot/instructions/warmup.instructions.md');
  const local = copilot.outputs(unit, 'local').find((o) => o.path === '.github/instructions/warmup.instructions.md');
  assert.ok(global && local);
  const text = global.content.toString();
  assert.match(text, /run the `warmup` skill/);
  assert.match(text, /begin your reply with that line, word for word/);
  assert.equal(copilot.outputs(alpha(), 'global').filter((o) => o.path.includes('/instructions/')).length, 0, 'only session-start skills get one');
  assert.equal(require('../lib/adapters/claude').outputs(unit, 'global').filter((o) => o.path.includes('instructions')).length, 0, 'Claude has its own SessionStart hook');
});

test('session-start accepts only true or false', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-')), 'bad');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: bad\nsession-start: always\ndescription: d\n---\nbody\n');
  assert.throws(() => u.loadSkillFromDir(dir, 'shared'), /session-start to "always"/);
});
