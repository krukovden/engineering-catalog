#!/usr/bin/env node
'use strict';
// Branch names for the team convention:
//   feature/ADO-<id>-<kebab-title>   (any work item type except Bug)
//   bug/ADO-<id>-<kebab-title>       (Bug)
//
//   node branch-name.js --type "<work item type>" --id <id> --title "<title>"   → prints the branch name
//
// Self-contained: no require() outside this file.

const MAX_SLUG = 50;

/** Lowercase ASCII kebab-case, ≤ 50 chars, cut at a hyphen boundary, no leading/trailing hyphen. */
function slug(title) {
  let s = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > MAX_SLUG) {
    const cut = s.lastIndexOf('-', MAX_SLUG);
    s = cut > 0 ? s.slice(0, cut) : s.slice(0, MAX_SLUG);
    s = s.replace(/-+$/g, '');
  }
  return s;
}

/** `bug/…` for a Bug work item, `feature/…` for everything else. */
function branchName({ type, id, title }) {
  const idText = String(id ?? '').trim();
  if (!/^\d+$/.test(idText)) throw new Error(`id must be a work item number, got "${idText}"`);
  const prefix = String(type ?? '').trim().toLowerCase() === 'bug' ? 'bug' : 'feature';
  const s = slug(title);
  return `${prefix}/ADO-${idText}${s ? `-${s}` : ''}`;
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; } else args[key] = true;
    }
  }
  if (args.help || argv.length === 0) {
    process.stderr.write('usage: branch-name.js --type <work item type> --id <id> --title <title>\n');
    return argv.length === 0 ? 2 : 0;
  }
  process.stdout.write(branchName({ type: args.type, id: args.id, title: args.title }) + '\n');
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`branch-name: ${e.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { slug, branchName };
