'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { build } = require('../lib/build');
const { parseArgs, run } = require('../cli/index');

const FIX = path.join(__dirname, 'fixtures', 'catalog');
function catalogRoot(version = '1.0.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  fs.cpSync(FIX, root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version, description: 'd' }));
  build({ root });
  return root;
}
async function exec(argv, { root, cwd, home, input = '' }) {
  const stdout = new PassThrough(); const stderr = new PassThrough();
  let out = '', err = '';
  stdout.on('data', (d) => { out += d; }); stderr.on('data', (d) => { err += d; });
  const stdin = new PassThrough(); stdin.end(input);
  const code = await run(argv, { root, cwd, home, stdin, stdout, stderr });
  return { code, out, err };
}

test('parseArgs', () => {
  const a = parseArgs(['install', '--bundle', 'qa,developers', '--target', 'both', '--local', '--yes']);
  assert.equal(a.command, 'install');
  assert.deepEqual(a.bundles, ['qa', 'developers']);
  assert.deepEqual(a.targets, ['claude', 'copilot']);
  assert.equal(a.scope, 'local');
  assert.equal(a.yes, true);
  assert.deepEqual(parseArgs(['update', '--keep-local']).keepLocal, true);
  assert.ok(parseArgs(['install', '--bogus']).errors.length === 1);
  assert.equal(parseArgs(['install', '--version=1.2.0']).version, '1.2.0');
  assert.equal(parseArgs(['-h']).help, true);
});

test('non-interactive install writes files and receipt; scope defaults to global', async () => {
  const root = catalogRoot();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-'));
  const r = await exec(['install', '--bundle', 'qa', '--target', 'claude'], { root, cwd, home });
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(path.join(home, '.claude/skills/alpha/SKILL.md')));
  assert.ok(fs.existsSync(path.join(home, '.engineering-catalog/receipt.json')));
  assert.ok(!fs.existsSync(path.join(cwd, '.claude')));
});

test('interactive install asks for bundle, target and scope', async () => {
  const root = catalogRoot();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-'));
  const r = await exec(['install'], { root, cwd, home, input: '2\n2\n2\n' }); // qa (2nd bundle), copilot, local
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(path.join(cwd, '.github/skills/alpha/SKILL.md')));
  assert.ok(r.out.includes('skipped') && r.out.includes('beta'));
});

test('a second install at the same target and scope keeps the first bundle in the receipt', async () => {
  const root = catalogRoot();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  await exec(['install', '--bundle', 'qa', '--target', 'claude'], { root, cwd: home, home });
  const r = await exec(['install', '--bundle', 'developers', '--target', 'claude'], { root, cwd: home, home });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('adding to: qa'), r.out);
  const receipt = JSON.parse(fs.readFileSync(path.join(home, '.engineering-catalog/receipt.json'), 'utf8'));
  assert.equal(receipt.installs.length, 1);
  const record = receipt.installs[0];
  assert.deepEqual(record.bundles, ['qa', 'developers']);
  const names = record.units.map((u) => u.name);
  for (const qaUnit of ['gamma', 'triager', 'flow']) assert.ok(names.includes(qaUnit), `${qaUnit} dropped from the receipt`);
  assert.ok(names.includes('delta'));
  assert.ok(fs.existsSync(path.join(home, '.claude/skills/gamma/SKILL.md')));
});

test('install asks before overwriting a foreign file already at a catalog path', async () => {
  const root = catalogRoot();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  fs.mkdirSync(path.join(home, '.claude/skills/alpha'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/skills/alpha/SKILL.md'), 'hand-authored, never installed by engcat\n');
  const r = await exec(['install', '--bundle', 'qa', '--target', 'claude'], { root, cwd: home, home, input: 'n\n' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /already exists and differs/);
  assert.match(r.out, /kept 1 file/);
  assert.equal(fs.readFileSync(path.join(home, '.claude/skills/alpha/SKILL.md'), 'utf8'), 'hand-authored, never installed by engcat\n');
  // Kept but still recorded, with the foreign file's own hash — so a later `update` still flags it.
  const receipt = JSON.parse(fs.readFileSync(path.join(home, '.engineering-catalog/receipt.json'), 'utf8'));
  const alpha = receipt.installs[0].units.find((u) => u.name === 'alpha');
  assert.notEqual(alpha.files['.claude/skills/alpha/SKILL.md'], undefined);
});

test('install --overwrite replaces a foreign file without asking; --keep-local always keeps it', async () => {
  const root = catalogRoot();
  const conflict = (home) => {
    fs.mkdirSync(path.join(home, '.claude/skills/alpha'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude/skills/alpha/SKILL.md'), 'foreign\n');
  };

  const home1 = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  conflict(home1);
  const r1 = await exec(['install', '--bundle', 'qa', '--target', 'claude', '--overwrite'], { root, cwd: home1, home: home1 });
  assert.equal(r1.code, 0, r1.err);
  assert.notEqual(fs.readFileSync(path.join(home1, '.claude/skills/alpha/SKILL.md'), 'utf8'), 'foreign\n');

  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  conflict(home2);
  const r2 = await exec(['install', '--bundle', 'qa', '--target', 'claude', '--keep-local'], { root, cwd: home2, home: home2 });
  assert.equal(r2.code, 0, r2.err);
  assert.equal(fs.readFileSync(path.join(home2, '.claude/skills/alpha/SKILL.md'), 'utf8'), 'foreign\n');
});

test('a file kept at install stays protected on the very next update, unchanged', async () => {
  // Regression: applyInstall used to record a kept file's own disk hash in the receipt,
  // which matched itself and made detectLocalEdits see "no edit" — so cmdUpdate's write
  // loop (which only skips files detectLocalEdits flags) silently overwrote it one command
  // later, even though nothing had touched it since install.
  const root = catalogRoot();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  fs.mkdirSync(path.join(home, '.claude/skills/alpha'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/skills/alpha/SKILL.md'), 'foreign\n');
  const ri = await exec(['install', '--bundle', 'qa', '--target', 'claude', '--keep-local'], { root, cwd: home, home });
  assert.equal(ri.code, 0, ri.err);

  const ru = await exec(['update', '--target', 'claude', '--global'], { root, cwd: home, home, input: 'n\n' });
  assert.equal(ru.code, 0, ru.err);
  assert.match(ru.out, /was edited locally/);
  assert.equal(fs.readFileSync(path.join(home, '.claude/skills/alpha/SKILL.md'), 'utf8'), 'foreign\n');
});

test('--version pins and refuses a mismatch', async () => {
  const root = catalogRoot('1.0.0');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const r = await exec(['install', '--bundle', 'qa', '--target', 'claude', '--version', '2.0.0'], { root, cwd: home, home });
  assert.equal(r.code, 1);
  assert.match(r.err, /is 1\.0\.0, not 2\.0\.0/);
});

test('update reinstalls changed units, asks about local edits, removes stale files', async () => {
  const root = catalogRoot('1.0.0');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  await exec(['install', '--bundle', 'qa', '--target', 'claude'], { root, cwd: home, home });
  fs.appendFileSync(path.join(home, '.claude/skills/alpha/SKILL.md'), '\nlocal edit\n');
  fs.appendFileSync(path.join(root, 'skills/qa/gamma/SKILL.md'), '\nMore.\n');
  fs.appendFileSync(path.join(root, 'skills/shared/alpha/SKILL.md'), '\nUpstream.\n');
  const b = JSON.parse(fs.readFileSync(path.join(root, 'bundles/qa.json'), 'utf8')); b.workflows = [];
  fs.writeFileSync(path.join(root, 'bundles/qa.json'), JSON.stringify(b));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.1.0', description: 'd' }));
  build({ root });
  const r = await exec(['update', '--global', '--keep-local'], { root, cwd: home, home });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /~ skill gamma/);
  assert.ok(fs.readFileSync(path.join(home, '.claude/skills/alpha/SKILL.md'), 'utf8').includes('local edit'), 'kept local edit');
  assert.ok(fs.readFileSync(path.join(home, '.claude/skills/gamma/SKILL.md'), 'utf8').includes('More.'));
  assert.ok(!fs.existsSync(path.join(home, '.claude/skills/flow/SKILL.md')), 'stale workflow removed');
  const receipt = JSON.parse(fs.readFileSync(path.join(home, '.engineering-catalog/receipt.json'), 'utf8'));
  assert.equal(receipt.installs[0].catalogVersion, '1.1.0');
  const r2 = await exec(['update', '--global', '--overwrite'], { root, cwd: home, home });
  assert.equal(r2.code, 0);
  assert.ok(!fs.readFileSync(path.join(home, '.claude/skills/alpha/SKILL.md'), 'utf8').includes('local edit'));
});

test('update refuses to downgrade', async () => {
  const root = catalogRoot('2.0.0');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  await exec(['install', '--bundle', 'qa', '--target', 'claude'], { root, cwd: home, home });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', description: 'd' }));
  build({ root });
  const r = await exec(['update', '--global'], { root, cwd: home, home });
  assert.equal(r.code, 1);
  assert.match(r.err, /newer than this catalog/);
});

test('update asks to delete an edited stale file; kept files are reported as unmanaged', async () => {
  const root = catalogRoot('1.0.0');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  await exec(['install', '--bundle', 'qa', '--target', 'claude'], { root, cwd: home, home });
  const flow = path.join(home, '.claude/skills/flow/SKILL.md');
  fs.appendFileSync(flow, '\nlocal edit\n');
  const b = JSON.parse(fs.readFileSync(path.join(root, 'bundles/qa.json'), 'utf8')); b.workflows = [];
  fs.writeFileSync(path.join(root, 'bundles/qa.json'), JSON.stringify(b));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.1.0', description: 'd' }));
  build({ root });
  const r = await exec(['update', '--global', '--keep-local'], { root, cwd: home, home });
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(flow), 'kept stale file still on disk');
  assert.match(r.out, /no longer managed/);
  assert.ok(!r.out.includes('Overwrite .claude/skills/flow/SKILL.md'), 'stale file is not offered for overwrite');
  const receipt = JSON.parse(fs.readFileSync(path.join(home, '.engineering-catalog/receipt.json'), 'utf8'));
  assert.ok(!receipt.installs[0].units.some((u) => u.name === 'flow'), 'flow dropped from receipt');
  // A kept file is unmanaged, so a later run cannot reach it; --overwrite deletes when asked at the time.
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const root2 = catalogRoot('1.0.0');
  await exec(['install', '--bundle', 'qa', '--target', 'claude'], { root: root2, cwd: home2, home: home2 });
  const flow2 = path.join(home2, '.claude/skills/flow/SKILL.md');
  fs.appendFileSync(flow2, '\nlocal edit\n');
  const r2 = await exec(['update', '--global', '--overwrite'], { root, cwd: home2, home: home2 });
  assert.equal(r2.code, 0, r2.err);
  assert.ok(!fs.existsSync(flow2), 'stale file deleted with --overwrite');
});

test('status and list', async () => {
  const root = catalogRoot();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  await exec(['install', '--bundle', 'qa', '--target', 'claude'], { root, cwd: home, home });
  const s = await exec(['status', '--global'], { root, cwd: home, home });
  assert.match(s.out, /claude.*global.*1\.0\.0/s);
  const l = await exec(['list'], { root, cwd: home, home });
  assert.ok(l.out.includes('beta [type it]') && l.out.includes('qa:'));
});

test('--bundle all installs every bundle; an empty picker answer does the same', async () => {
  const root = catalogRoot();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const r = await exec(['install', '--bundle', 'all', '--target', 'claude'], { root, cwd: home, home });
  assert.equal(r.code, 0, r.err);
  const receipt = JSON.parse(fs.readFileSync(path.join(home, '.engineering-catalog/receipt.json'), 'utf8'));
  assert.deepEqual(receipt.installs[0].bundles, ['developers', 'qa']);
  assert.ok(fs.existsSync(path.join(home, '.claude/skills/delta/SKILL.md')), 'developers-only skill present');
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const r2 = await exec(['install'], { root, cwd: home2, home: home2, input: '\n3\n\n' }); // all bundles, both tools, global
  assert.equal(r2.code, 0, r2.err);
  assert.ok(fs.existsSync(path.join(home2, '.claude/skills/delta/SKILL.md')));
  assert.ok(fs.existsSync(path.join(home2, '.copilot/skills/gamma/SKILL.md')));
});
