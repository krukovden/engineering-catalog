#!/usr/bin/env node
'use strict';
// Reads the release-note type and the work item id off a branch name that follows the
// team convention:
//   feature/ADO-<id>-<kebab-title>   → {"type":"feat","id":"<id>"}
//   bug/ADO-<id>-<kebab-title>       → {"type":"fix","id":"<id>"}
//   anything else                    → null
//
//   node parse-branch.js "<branch>"
//
// Self-contained: no require() outside this file.

/** `{ type: 'feat'|'fix', id }` for a branch that follows the convention, else `null`. */
function parseBranch(name) {
  const m = /^(feature|bug)\/ADO-(\d+)(?:-|$)/.exec(String(name ?? '').trim());
  if (!m) return null;
  return { type: m[1] === 'bug' ? 'fix' : 'feat', id: m[2] };
}

function main(argv) {
  if (argv[0] === '--help') {
    process.stderr.write('usage: parse-branch.js <branch>\n');
    return 0;
  }
  if (argv.length === 0) {
    process.stderr.write('usage: parse-branch.js <branch>\n');
    return 2;
  }
  process.stdout.write(JSON.stringify(parseBranch(argv[0])) + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { parseBranch };
