#!/usr/bin/env node
'use strict';
// The scenario list behind `npm run e2e:install`. Runs the real `bin/engcat.js` as a
// subprocess (not the in-process test harness in test/cli.test.js) against the real catalog
// built into this checkout (catalog.json is committed — engcat has zero runtime npm
// dependencies, so no `npm install` step is needed here or in the container that wraps this).
//
// Portable on purpose: this file has no podman/docker awareness at all, so it also runs
// directly on bare host (`node scripts/e2e/run-scenarios.js`) for a fast local loop.
// `scripts/e2e/install-smoke.js` is the thin wrapper that runs it inside a container to
// simulate an unrelated host machine installing the catalog for the first time.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ENGCAT = path.join(ROOT, 'bin/engcat.js');
const FOREIGN = 'hand-authored, never installed by engcat\n';

function engcat(args, { home, cwd, stdin = '' }) {
  const res = spawnSync(process.execPath, [ENGCAT, ...args], {
    cwd, env: { ...process.env, HOME: home }, input: stdin, encoding: 'utf8', timeout: 60000,
  });
  return { code: res.status, out: res.stdout || '', err: res.stderr || '' };
}

function scratch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engcat-e2e-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'engcat-e2e-cwd-'));
  return { home, cwd, cleanup: () => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); } };
}

/** ops/safety-ssh is a plain skill (no managed-block writes), so a whole-file clash is clean. */
function plantForeign(home) {
  const dir = path.join(home, '.claude/skills/safety-ssh');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, FOREIGN);
  return file;
}

const scenarios = [
  {
    name: 'fresh install writes files and a receipt',
    run(t) {
      const r = engcat(['install', '--bundle', 'ops', '--target', 'claude', '--global'], t);
      t.assert(r.code === 0, `exit 0, got ${r.code}: ${r.err}`);
      t.assert(fs.existsSync(path.join(t.home, '.claude/skills/safety-ssh/SKILL.md')), 'skill file written');
      t.assert(fs.existsSync(path.join(t.home, '.engineering-catalog/receipt.json')), 'receipt written');
    },
  },
  {
    name: 'install asks before overwriting a foreign file, declines, keeps it',
    run(t) {
      const file = plantForeign(t.home);
      const r = engcat(['install', '--bundle', 'ops', '--target', 'claude', '--global'], { ...t, stdin: 'n\n' });
      t.assert(r.code === 0, `exit 0, got ${r.code}: ${r.err}`);
      t.assert(/already exists and differs/.test(r.out), 'prompt shown');
      t.assert(/kept 1 file/.test(r.out), 'kept summary shown');
      t.assert(fs.readFileSync(file, 'utf8') === FOREIGN, 'foreign file untouched');
    },
  },
  {
    name: '--overwrite replaces a foreign file without asking',
    run(t) {
      const file = plantForeign(t.home);
      const r = engcat(['install', '--bundle', 'ops', '--target', 'claude', '--global', '--overwrite'], t);
      t.assert(r.code === 0, `exit 0, got ${r.code}: ${r.err}`);
      t.assert(fs.readFileSync(file, 'utf8') !== FOREIGN, 'foreign file replaced');
    },
  },
  {
    name: '--keep-local keeps a foreign file without asking',
    run(t) {
      const file = plantForeign(t.home);
      const r = engcat(['install', '--bundle', 'ops', '--target', 'claude', '--global', '--keep-local'], t);
      t.assert(r.code === 0, `exit 0, got ${r.code}: ${r.err}`);
      t.assert(fs.readFileSync(file, 'utf8') === FOREIGN, 'foreign file kept');
    },
  },
  {
    name: 'a file kept at install stays protected on the very next update',
    run(t) {
      const file = plantForeign(t.home);
      const ri = engcat(['install', '--bundle', 'ops', '--target', 'claude', '--global', '--keep-local'], t);
      t.assert(ri.code === 0, `install exit 0, got ${ri.code}: ${ri.err}`);
      const ru = engcat(['update', '--target', 'claude', '--global'], { ...t, stdin: 'n\n' });
      t.assert(ru.code === 0, `update exit 0, got ${ru.code}: ${ru.err}`);
      t.assert(/was edited locally/.test(ru.out), 'update flagged the kept file');
      t.assert(fs.readFileSync(file, 'utf8') === FOREIGN, 'foreign file still untouched after update');
    },
  },
  {
    name: 'status reports a clean install with no local edits',
    run(t) {
      engcat(['install', '--bundle', 'ops', '--target', 'claude', '--global'], t);
      const r = engcat(['status', '--global'], t);
      t.assert(r.code === 0, `exit 0, got ${r.code}: ${r.err}`);
      t.assert(/no local edits/.test(r.out), 'status reports clean');
    },
  },
];

let failures = 0;
for (const s of scenarios) {
  const t = scratch();
  const failed = [];
  t.assert = (ok, msg) => { if (!ok) failed.push(msg); };
  try {
    s.run(t);
  } catch (e) {
    failed.push(`threw: ${e.message}`);
  } finally {
    t.cleanup();
  }
  if (failed.length) {
    failures += 1;
    console.log(`FAIL  ${s.name}`);
    for (const m of failed) console.log(`      - ${m}`);
  } else {
    console.log(`PASS  ${s.name}`);
  }
}
console.log(`\n${scenarios.length - failures}/${scenarios.length} scenarios passed`);
process.exit(failures ? 1 : 0);
