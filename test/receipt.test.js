'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const r = require('../lib/receipt');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-'));

test('read returns an empty receipt when absent and round-trips', () => {
  const base = tmp();
  assert.deepEqual(r.readReceipt(base), { schema: 1, installs: [] });
  const rec = r.makeInstall({ target: 'claude', scope: 'global', catalogVersion: '1.0.0', source: 's', bundles: ['qa'], units: [], date: '2026-09-14T00:00:00.000Z' });
  r.writeReceipt(base, r.upsertInstall(r.readReceipt(base), rec));
  assert.equal(r.readReceipt(base).installs[0].date, '2026-09-14T00:00:00.000Z');
  assert.ok(fs.existsSync(path.join(base, '.engineering-catalog/receipt.json')));
});

test('upsert replaces the same target+scope and keeps others', () => {
  let rec = { schema: 1, installs: [] };
  rec = r.upsertInstall(rec, r.makeInstall({ target: 'claude', scope: 'global', catalogVersion: '1', source: 's', bundles: [], units: [] }));
  rec = r.upsertInstall(rec, r.makeInstall({ target: 'copilot', scope: 'global', catalogVersion: '1', source: 's', bundles: [], units: [] }));
  rec = r.upsertInstall(rec, r.makeInstall({ target: 'claude', scope: 'global', catalogVersion: '2', source: 's', bundles: [], units: [] }));
  assert.equal(rec.installs.length, 2);
  assert.equal(r.findInstall(rec, 'claude', 'global').catalogVersion, '2');
  assert.equal(r.findInstall(rec, 'claude', 'local'), null);
});

test('recordFromOutputs hashes every planned file', () => {
  const planned = [{ unit: { kind: 'skill', name: 'a', version: 'abc' }, outputs: [{ path: '.claude/skills/a/SKILL.md', content: Buffer.from('x') }] }];
  const rec = r.recordFromOutputs({ target: 'claude', scope: 'local', catalogVersion: '1', source: 's', bundles: ['qa'], planned });
  assert.equal(rec.units[0].files['.claude/skills/a/SKILL.md'], r.hashContent(Buffer.from('x')));
  assert.equal(rec.units[0].version, 'abc');
});

test('invalid receipt json names the file', () => {
  const base = tmp();
  fs.mkdirSync(path.join(base, '.engineering-catalog'));
  fs.writeFileSync(path.join(base, '.engineering-catalog/receipt.json'), '{');
  assert.throws(() => r.readReceipt(base), /receipt\.json/);
});
