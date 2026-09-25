'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claude = require('../lib/adapters/claude');
const u = require('../lib/units');

const FIX = path.join(__dirname, 'fixtures', 'catalog');
const alpha = () => u.loadSkillFromDir(path.join(FIX, 'skills/shared/alpha'), 'shared');
const beta = () => u.loadSkillFromDir(path.join(FIX, 'skills/shared/beta'), 'shared');
const helper = () => u.loadAgentFromFile(path.join(FIX, 'agents/shared/helper.md'), 'shared');
const flow = () => u.loadWorkflowFromFile(path.join(FIX, 'workflows/qa/flow.md'), 'qa');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-'));

test('skill outputs are the whole tree with modes', () => {
  const out = claude.outputs(alpha(), 'local');
  assert.deepEqual(out.map((o) => o.path), ['.claude/skills/alpha/SKILL.md', '.claude/skills/alpha/references/notes.md', '.claude/skills/alpha/scripts/run.sh']);
  assert.equal(out[2].mode & 0o111, 0o111);
  assert.equal(out[0].content.toString(), fs.readFileSync(path.join(FIX, 'skills/shared/alpha/SKILL.md'), 'utf8'));
});

test('a user-invoked skill gets disable-model-invocation, and only SKILL.md changes', () => {
  const out = claude.outputs(beta(), 'global');
  assert.ok(out[0].content.toString().includes('disable-model-invocation: true'));
});

test('agents and workflows install where Claude reads them', () => {
  const [agent] = claude.outputs(helper(), 'local');
  assert.equal(agent.path, '.claude/agents/helper.md');
  assert.ok(agent.content.toString().includes('\nmodel: opus\n'), 'the Claude side of the model map');
  assert.ok(!agent.content.toString().includes('gemini'));
  const w = claude.outputs(flow(), 'local');
  assert.deepEqual(w.map((o) => o.path), ['.claude/skills/flow/SKILL.md']);
  assert.ok(w[0].content.toString().includes('1. agent: triager'));
});

test('install writes files and preserves the executable bit', () => {
  const base = tmp();
  const written = claude.install(alpha(), base, 'local');
  assert.equal(written.length, 3);
  const mode = fs.statSync(path.join(base, '.claude/skills/alpha/scripts/run.sh')).mode & 0o111;
  assert.equal(mode, 0o111);
});

test('skipReason honours platforms.claude: skip', () => {
  const s = alpha(); s.platforms = { claude: 'skip' };
  assert.match(claude.skipReason(s), /opts out of Claude/);
  assert.equal(claude.skipReason(beta()), null);
});
