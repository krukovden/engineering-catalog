#!/usr/bin/env node
'use strict';
const { build } = require('../lib/build');
const check = process.argv.includes('--check');
const r = build({ check });
r.warnings.forEach((w) => console.warn(`⚠ ${w}`));
if (r.errors.length) {
  r.errors.forEach((e) => console.error(`✗ ${e}`));
  process.exit(1);
}
const changes = [...r.written, ...r.removed.map((p) => `${p} (stale — no longer generated)`)];
if (check) {
  if (changes.length) { console.error(`✗ generated files are stale — run npm run build:\n  ${changes.join('\n  ')}`); process.exit(1); }
  console.log('✓ generated artifacts are current');
} else {
  console.log(changes.length ? `Wrote ${r.written.length} file(s), removed ${r.removed.length}:\n  ${changes.join('\n  ')}` : 'Nothing to write — artifacts current.');
}
