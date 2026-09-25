#!/usr/bin/env node
'use strict';
// lint.js — validate the project-memory files (DESIGN §8): entry fields and
// supersede links across every unit file, plus index/unit cross-references.
//   node lint.js --memory <dir>
const fs = require('fs');
const path = require('path');
const lib = require('./memory-lib');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const memory = opt('--memory');
if (!memory) { console.error('usage: lint.js --memory <dir>'); process.exit(2); }

const indexFile = path.join(memory, 'index.md');
const unitsDir = path.join(memory, 'units');
const errors = [];

const indexText = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
if (!fs.existsSync(indexFile)) errors.push(`missing ${indexFile}`);
const index = lib.parseIndex(indexText);

const unitFiles = [];
if (fs.existsSync(unitsDir)) {
  for (const name of fs.readdirSync(unitsDir).filter((f) => f.endsWith('.md')).sort()) {
    const file = path.join(unitsDir, name);
    const text = fs.readFileSync(file, 'utf8');
    const unit = lib.parseUnitFile(text);
    const expectedSlug = name.slice(0, -3);
    if (unit.slug !== expectedSlug) errors.push(`${file}: contract comment names slug "${unit.slug}" but file is units/${name}`);
    for (const entry of unit.entries) for (const e of lib.validateEntry(entry)) errors.push(`${file}: ${e}`);
    unitFiles.push({ slug: expectedSlug, entries: unit.entries, file });
  }
}

for (const e of lib.checkSupersedeLinks(unitFiles)) errors.push(e);

const unitSlugs = new Set(unitFiles.map((u) => u.slug));
const indexSlugs = new Set(index.units.map((u) => u.slug));
for (const u of index.units) if (!unitSlugs.has(u.slug)) errors.push(`index.md references [[${u.slug}]] but units/${u.slug}.md does not exist`);
for (const slug of unitSlugs) if (!indexSlugs.has(slug)) errors.push(`units/${slug}.md exists but has no row in index.md`);

for (const e of errors) console.error(e);
if (errors.length) { console.error(`${errors.length} problem(s) found.`); process.exit(1); }
console.log('memory is clean.');
