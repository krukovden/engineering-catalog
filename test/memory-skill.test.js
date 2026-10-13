'use strict';
require('./temp-cleanup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('memory handoff names the installed memory-writer agent, not the catalog source path', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills/shared/memory/SKILL.md'), 'utf8');
  assert.match(skill, /\*\*Instruction target:\*\* the installed agent named `memory-writer`/);
  assert.doesNotMatch(skill, /agents\/shared\/memory-writer\.md/);
});
