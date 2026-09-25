'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { nextVersion } = require('../scripts/next-version');

test('same major.minor: highest patch + 1, numerically', () => {
  assert.equal(nextVersion({ current: '1.0.0', tags: ['v1.0.0', 'v1.0.2', 'v1.0.10', 'v-main-1.0.3'] }), '1.0.11');
});
test('a new major.minor starts at .0', () => {
  assert.equal(nextVersion({ current: '1.1.0', tags: ['v1.0.4'] }), '1.1.0');
  assert.equal(nextVersion({ current: '2.0.7', tags: ['v1.9.9'] }), '2.0.0');
});
test('idempotent once the version is written', () => {
  const tags = ['v1.0.4'];
  const first = nextVersion({ current: '1.0.4', tags });
  assert.equal(first, '1.0.5');
  assert.equal(nextVersion({ current: first, tags }), '1.0.5');
});
test('no tags at all → X.Y.0', () => {
  assert.equal(nextVersion({ current: '1.0.0', tags: [] }), '1.0.0');
});
