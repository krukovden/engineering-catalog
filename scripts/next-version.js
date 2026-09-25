#!/usr/bin/env node
'use strict';
// Prints the version the current change will release, from the `v*` tags reachable in the
// repository (fetch main's tags first): same major.minor as package.json → highest patch + 1;
// a major.minor with no tag yet → X.Y.0. Deterministic and idempotent — a second run after
// the version was written prints the same number.
const { execFileSync } = require('child_process');
const path = require('path');
const { compareVersions } = require('../lib/update');

function nextVersion({ current, tags }) {
  const [major, minor] = current.split('.').slice(0, 2);
  const mm = `${major}.${minor}`;
  const patches = tags
    .map((t) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(t))
    .filter((m) => m && `${m[1]}.${m[2]}` === mm)
    .map((m) => `${m[1]}.${m[2]}.${m[3]}`)
    .sort(compareVersions);
  if (!patches.length) return `${mm}.0`;
  const last = patches[patches.length - 1].split('.')[2];
  return `${mm}.${Number(last) + 1}`;
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const current = require(path.join(root, 'package.json')).version;
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  process.stdout.write(`${nextVersion({ current, tags })}\n`);
}

module.exports = { nextVersion };
