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
const repo = opt('--repo');
const warnKiB = Number(opt('--instruction-warn-kib') || 24);
const hardKiB = Number(opt('--instruction-hard-kib') || 32);
const warnBytes = warnKiB * 1024;
const hardBytes = hardKiB * 1024;

const indexFile = path.join(memory, 'index.md');
const unitsDir = path.join(memory, 'units');
const errors = [];
const warnings = [];

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

function projectRoot() {
  if (repo) return repo;
  try {
    const storeFile = path.join(memory, '.store.json');
    if (fs.existsSync(storeFile)) {
      const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      if (store && store.store === 'committed') return path.dirname(memory);
    }
  } catch { /* advisory only */ }
  return null;
}

const root = projectRoot();
if (root) {
  for (const rel of ['CLAUDE.md', 'AGENTS.md']) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const size = fs.statSync(file).size;
    if (size > hardBytes) {
      warnings.push(`${rel} is ${size} bytes; the advisory line is ${warnBytes} bytes (${warnKiB} KiB) and the hard line is ${hardBytes} bytes (${hardKiB} KiB) in consumer projects`);
    } else if (size > warnBytes) {
      warnings.push(`${rel} is ${size} bytes; the advisory line is ${warnBytes} bytes (${warnKiB} KiB) and the hard limit is ${hardBytes} bytes (${hardKiB} KiB)`);
    }
  }
}

for (const w of warnings) console.error(`warning: ${w}`);
for (const e of errors) console.error(e);
if (errors.length) { console.error(`${errors.length} problem(s) found.`); process.exit(1); }
console.log('memory is clean.');
