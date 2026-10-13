'use strict';
require('./temp-cleanup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('AGENTS.md stays under the 32 KiB instruction-file hard limit', () => {
  const size = fs.statSync(path.join(__dirname, '..', 'AGENTS.md')).size;
  assert.ok(size < 32 * 1024, `AGENTS.md is ${size} bytes; keep it below 32768`);
});
