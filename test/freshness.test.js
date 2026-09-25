'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skills/shared/catalog-freshness/scripts/check-freshness.sh');
function home(version, lastChecked) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'));
  fs.mkdirSync(path.join(h, '.engineering-catalog'));
  fs.writeFileSync(path.join(h, '.engineering-catalog/receipt.json'), JSON.stringify({ schema: 1, installs: [{ target: 'claude', scope: 'global', catalogVersion: version, source: 'https://example/repo' }] }));
  if (lastChecked) fs.writeFileSync(path.join(h, '.engineering-catalog/freshness.json'), JSON.stringify({ lastChecked, latest: version }));
  return h;
}
function fakeGit(tags) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-'));
  const f = path.join(bin, 'git');
  fs.writeFileSync(f, `#!/bin/sh\n${tags.map((t) => `echo "0000 refs/tags/${t}"`).join('\n')}\n`);
  fs.chmodSync(f, 0o755);
  return bin;
}
const run = (h, bin, args = []) => execFileSync('sh', [SCRIPT, ...args], { env: { ...process.env, ENGCAT_HOME: h, PATH: `${bin}:${process.env.PATH}` } }).toString();

test('reports a newer tag and records the check', () => {
  const h = home('1.0.0');
  const out = run(h, fakeGit(['v1.0.0', 'v1.2.0', 'v1.10.0']));
  assert.match(out, /1\.0\.0 → 1\.10\.0 available/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h, '.engineering-catalog/freshness.json'), 'utf8')).latest, '1.10.0');
});

test('quiet when current, and skips inside the interval', () => {
  const h = home('1.2.0');
  assert.equal(run(h, fakeGit(['v1.2.0']), ['--quiet']), '');
  const recent = home('1.0.0', new Date().toISOString());
  assert.equal(run(recent, fakeGit(['v9.0.0']), ['--quiet']), '');
  assert.match(run(recent, fakeGit(['v9.0.0']), ['--force']), /9\.0\.0 available/);
});

test('no receipt → says so unless quiet, exit 0', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'));
  assert.match(run(h, fakeGit([])), /not installed/);
  assert.equal(run(h, fakeGit([]), ['--quiet']), '');
});

test('reads source and version from the FIRST install in the receipt', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'));
  fs.mkdirSync(path.join(h, '.engineering-catalog'));
  fs.writeFileSync(path.join(h, '.engineering-catalog/receipt.json'), JSON.stringify({
    schema: 1,
    installs: [
      { target: 'claude', scope: 'global', catalogVersion: '1.0.0', source: 'https://example/first', units: [] },
      { target: 'copilot', scope: 'global', catalogVersion: '3.0.0', source: 'https://example/second', units: [] },
    ],
  }));  // compact, one line: a greedy sed would pick the LAST install
  const out = run(h, fakeGit(['v2.0.0']));
  assert.match(out, /1\.0\.0 → 2\.0\.0 available/);
  assert.match(out, /https:\/\/example\/first/);
});

test('git never prompts for credentials', () => {
  const h = home('1.0.0');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-'));
  const log = path.join(bin, 'git.log');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT" "GCM_INTERACTIVE=$GCM_INTERACTIVE" "$@" > "${log}"\necho "0000 refs/tags/v1.0.0"\n`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  run(h, bin);
  const seen = fs.readFileSync(log, 'utf8').split('\n');
  assert.ok(seen.includes('GIT_TERMINAL_PROMPT=0'), seen.join(' '));
  assert.ok(seen.includes('GCM_INTERACTIVE=never'), seen.join(' '));
  assert.ok(seen.includes('-c') && seen.includes('credential.interactive=false'), seen.join(' '));
});
