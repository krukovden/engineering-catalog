'use strict';

const fs = require('node:fs');

const tmpdir = process.argv[2];
if (!tmpdir) {
  console.error('usage: node test/tmpdir-leak-guard.js <tmpdir>');
  process.exit(2);
}

const entries = fs.readdirSync(tmpdir, { withFileTypes: true })
  .filter((entry) => entry.name !== 'node-compile-cache')
  .map((entry) => entry.name);

if (entries.length) {
  console.error(`TMPDIR leak: ${entries.length} entries left in ${tmpdir}: ${entries.slice(0, 20).join(', ')}`);
  process.exit(1);
}

console.log(`TMPDIR leak guard: ${tmpdir} is clean (entries: ${entries.length})`);
