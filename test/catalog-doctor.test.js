'use strict';
require('./temp-cleanup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const doctor = require('../skills/shared/catalog-doctor/scripts/doctor.js');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-root-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  write(path.join(root, 'CLAUDE.md'), '<!-- engineering-catalog:memory:start -->\n<!-- engineering-catalog:memory:end -->\n');
  write(path.join(root, 'AGENTS.md'), '<!-- engineering-catalog:memory:start -->\n<!-- engineering-catalog:memory:end -->\n');
  write(path.join(root, '.github', 'copilot-instructions.md'), '<!-- engineering-catalog:memory:start -->\n<!-- engineering-catalog:memory:end -->\n');
  write(path.join(root, 'memory', '.pending'), '');
  return root;
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-home-'));
}

function cleanupDirs(t, ...dirs) {
  t.after(() => {
    for (const dir of dirs) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('copilotCollision fails when plugin and engcat copilot installs coexist', (t) => {
  const root = tempRoot();
  const home = tempHome();
  cleanupDirs(t, root, home);
  write(path.join(home, '.copilot', 'config.json'), JSON.stringify({ installedPlugins: ['engineering-catalog@engineering-catalog'], trustedFolders: [root] }));
  write(path.join(root, '.engineering-catalog', 'receipt.json'), JSON.stringify({ schema: 1, installs: [{ target: 'copilot', scope: 'local', catalogVersion: '1.0.6' }] }));
  const check = doctor.copilotCollision(root, home);
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /plugin and as a local engcat Copilot install/);
});

test('memoryState warns on missing pointers and a backed-up pending queue', (t) => {
  const root = tempRoot();
  cleanupDirs(t, root);
  fs.unlinkSync(path.join(root, 'AGENTS.md'));
  write(path.join(root, 'memory', '.pending'), 'a\nb\nc\n');
  const check = doctor.memoryState(root, 2);
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /missing pointers: AGENTS\.md/);
  assert.match(check.detail, /memory\/\.pending has 3 entries/);
});

test('sessionStartHooks warns on repository-owned sessionStart hooks', (t) => {
  const root = tempRoot();
  cleanupDirs(t, root);
  write(path.join(root, '.github', 'hooks', 'speak.json'), JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: 'command', command: 'echo hi' }] } }));
  write(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
  const check = doctor.sessionStartHooks(root);
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /\.github\/hooks\/speak\.json/);
  assert.match(check.detail, /\.claude\/settings\.json/);
});

test('collectChecks reports ok for a healthy local setup', (t) => {
  const root = tempRoot();
  const home = tempHome();
  cleanupDirs(t, root, home);
  write(path.join(home, '.copilot', 'config.json'), JSON.stringify({ trustedFolders: [root], installedPlugins: [] }));
  const checks = doctor.collectChecks(
    { root, home, pendingLimit: 20 },
    { adoState: () => ({ status: 'ok', id: 'ado-credentials', detail: 'Reached org/project.', fix: 'none' }) },
  );
  assert.ok(checks.some((item) => item.id === 'copilot-trusted-folder' && item.status === 'ok'));
  assert.ok(checks.some((item) => item.id === 'memory-pointers' && item.status === 'ok'));
});

test('stripJsonComments strips full-line // and /* */ comments without touching // in strings', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'catalog-doctor', 'copilot-config.jsonc');
  const raw = fs.readFileSync(fixturePath, 'utf8');
  const stripped = doctor.stripJsonComments(raw);
  assert.doesNotThrow(() => JSON.parse(stripped));
  const parsed = JSON.parse(stripped);
  assert.deepEqual(parsed.trustedFolders, [
    '/Users/example/project',
    'https://github.com/example/repo',
  ]);

  // Test edge cases: escaped quotes, URLs, and comments
  const complex = [
    '// line comment 1',
    '  // indented line comment',
    '/*',
    '   multi-line block comment',
    '*/',
    '{',
    '  "url": "https://example.com/repo//nested",',
    '  "message": "He said: \\"Hello // world\\" /* not a comment */",',
    '  /* inline block comment */ "nested": {',
    '    // another comment',
    '    "key": "value"',
    '  }',
    '}',
  ].join('\n');
  const strippedComplex = doctor.stripJsonComments(complex);
  const parsedComplex = JSON.parse(strippedComplex);
  assert.equal(parsedComplex.url, 'https://example.com/repo//nested');
  assert.equal(parsedComplex.message, 'He said: "Hello // world" /* not a comment */');
  assert.equal(parsedComplex.nested.key, 'value');
});

test('copilotTrusted parses JSONC ~/.copilot/config.json with comments and recognizes trusted folder', (t) => {
  const root = tempRoot();
  const home = tempHome();
  cleanupDirs(t, root, home);
  const fixturePath = path.join(__dirname, 'fixtures', 'catalog-doctor', 'copilot-config.jsonc');
  const rawFixture = fs.readFileSync(fixturePath, 'utf8');
  // Include root in the JSONC trustedFolders
  const jsoncWithRoot = rawFixture.replace('/Users/example/project', root);
  write(path.join(home, '.copilot', 'config.json'), jsoncWithRoot);

  const check = doctor.copilotTrusted(root, home);
  assert.equal(check.status, 'ok');
  assert.equal(check.id, 'copilot-trusted-folder');
  assert.match(check.detail, /Repository path is present in Copilot trustedFolders/);
});

test('hasPointerBlock and memoryState recognize both legacy and versioned pointer blocks', (t) => {
  const root = tempRoot();
  cleanupDirs(t, root);

  // 1. Legacy format
  write(path.join(root, 'CLAUDE.md'), '<!-- engineering-catalog:memory:start -->\nlegacy content\n<!-- engineering-catalog:memory:end -->\n');
  assert.equal(doctor.hasPointerBlock(path.join(root, 'CLAUDE.md')), true);

  // 2. Versioned format (e.g. v=1 or v=2)
  write(path.join(root, 'AGENTS.md'), '<!-- engineering-catalog:memory:start v=1 -->\nversioned content\n<!-- engineering-catalog:memory:end -->\n');
  assert.equal(doctor.hasPointerBlock(path.join(root, 'AGENTS.md')), true);

  write(path.join(root, '.github', 'copilot-instructions.md'), '<!-- engineering-catalog:memory:start v=42 -->\nversioned content\n<!-- engineering-catalog:memory:end -->\n');
  assert.equal(doctor.hasPointerBlock(path.join(root, '.github', 'copilot-instructions.md')), true);

  // Both forms produce ok in memoryState
  const checkOk = doctor.memoryState(root, 20);
  assert.equal(checkOk.status, 'ok');
  assert.match(checkOk.detail, /Memory pointer blocks are present/);

  // Malformed or missing marker triggers warning
  write(path.join(root, 'CLAUDE.md'), '<!-- other:start -->\nno catalog pointer\n<!-- other:end -->\n');
  assert.equal(doctor.hasPointerBlock(path.join(root, 'CLAUDE.md')), false);
  const checkWarn = doctor.memoryState(root, 20);
  assert.equal(checkWarn.status, 'warn');
  assert.match(checkWarn.detail, /missing pointers: CLAUDE\.md/);
});

test('memoryState follows a pointer to a local memory store before counting pending entries', (t) => {
  const root = tempRoot();
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-memory-'));
  cleanupDirs(t, root, memoryDir);
  write(path.join(memoryDir, '.pending'), 'a\nb\nc\n');
  const pointer = [
    '<!-- engineering-catalog:memory:start v=1 -->',
    '## Project memory',
    `Read \`${path.join(memoryDir, 'index.md')}\` first. Load \`${path.join(memoryDir, 'units')}/<slug>.md\` only when work touches that unit.`,
    '<!-- engineering-catalog:memory:end -->',
    '',
  ].join('\n');
  write(path.join(root, 'CLAUDE.md'), pointer);
  write(path.join(root, 'AGENTS.md'), pointer);
  write(path.join(root, '.github', 'copilot-instructions.md'), pointer);
  write(path.join(root, 'memory', '.pending'), '');

  const check = doctor.memoryState(root, 2);
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /doctor-memory-.*\/\.pending has 3 entries/);
  assert.equal(check.fix, 'Drain the memory queue when the task is done.');
});

test('memoryState follows a pointer to a custom committed memory directory', (t) => {
  const root = tempRoot();
  cleanupDirs(t, root);
  const custom = path.join(root, 'notes-memory');
  write(path.join(custom, '.pending'), 'a\nb\nc\n');
  const pointer = [
    '<!-- engineering-catalog:memory:start v=1 -->',
    '## Project memory',
    'Read `notes-memory/index.md` first. Load `notes-memory/units/<slug>.md` only when work touches that unit.',
    '<!-- engineering-catalog:memory:end -->',
    '',
  ].join('\n');
  write(path.join(root, 'CLAUDE.md'), pointer);
  write(path.join(root, 'AGENTS.md'), pointer);
  write(path.join(root, '.github', 'copilot-instructions.md'), pointer);

  const check = doctor.memoryState(root, 2);
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /notes-memory\/\.pending has 3 entries/);
});

test('doctor PowerShell wrapper keeps the -Home flag without declaring $Home', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'skills/shared/catalog-doctor/scripts/doctor.ps1'), 'utf8');
  assert.doesNotMatch(script, /\[string\]\$Home\b/);
  assert.match(script, /\[Alias\('Home'\)\]\s*\[string\]\$HomeDir/);
  assert.match(script, /\$args \+= @\('--home', \$HomeDir\)/);
});

test('memoryState outside a git repository is skip, not a warning about missing pointers', (t) => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-plain-'));
  cleanupDirs(t, plain);
  const notRepo = () => { throw new Error('fatal: not a git repository'); };
  const check = doctor.memoryState(plain, 20, { git: notRepo });
  assert.equal(check.status, 'skip');
  assert.match(check.detail, /Not a git repository/);
  assert.doesNotMatch(check.detail, /missing pointers/);
});

test('adoContext: ADO_ORG first, then the Azure origin, then the one board repos.json maps', (t) => {
  const home = tempHome();
  cleanupDirs(t, home);
  const noOrigin = () => { throw new Error('no origin'); };
  const origin = () => 'https://Contoso@dev.azure.com/Contoso/Platform/_git/api';
  assert.deepEqual(doctor.adoContext('/r', home, { ADO_ORG: 'acme', ADO_PROJECT: 'P' }, origin), { org: 'acme', project: 'P', source: 'ADO_ORG' });
  assert.deepEqual(doctor.adoContext('/r', home, {}, origin), { org: 'Contoso', project: 'Platform', source: 'origin' });
  assert.equal(doctor.adoContext('/r', home, {}, noOrigin), null);
  const repos = path.join(home, '.engineering-catalog', 'repos.json');
  write(repos, JSON.stringify({
    'https://dev.azure.com/Contoso/Platform/_git/api': { name: 'api', board: { org: 'Contoso', project: 'Platform' } },
    'https://dev.azure.com/Contoso/Platform/_git/web': { name: 'web', board: { org: 'https://dev.azure.com/Contoso', project: 'Platform' } },
  }));
  assert.deepEqual(doctor.adoContext('/r', home, {}, noOrigin), { org: 'Contoso', project: 'Platform', source: 'repos.json' });
  write(repos, JSON.stringify({ a: { board: { org: 'Contoso', project: 'Platform' } }, b: { board: { org: 'Contoso', project: 'Other' } } }));
  assert.equal(doctor.adoContext('/r', home, {}, noOrigin), null);
});

test('collectChecks passes the known organization to the ado-credentials check', (t) => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-plain-'));
  cleanupDirs(t, plain);
  let seen;
  const checks = doctor.collectChecks(
    { root: plain, home: tempHome(), pendingLimit: 20 },
    { env: { ADO_ORG: 'Contoso', ADO_PROJECT: 'Platform' }, git: () => { throw new Error('not a repo'); }, adoState: (ctx) => { seen = ctx; return { status: 'ok', id: 'ado-credentials', detail: 'x', fix: 'none' }; } },
  );
  assert.deepEqual(seen, { org: 'Contoso', project: 'Platform', source: 'ADO_ORG' });
  assert.equal(checks.find((c) => c.id === 'memory-pointers').status, 'skip');
});

test('adoState: a PAT with no organization gets a fix a non-developer can follow', { skip: process.platform === 'win32' }, (t) => {
  const saved = { ...process.env };
  const empty = tempHome();
  const fakeAzDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-azbin-'));
  cleanupDirs(t, empty, fakeAzDir);
  const fakeAz = path.join(fakeAzDir, 'az');
  fs.writeFileSync(fakeAz, '#!/usr/bin/env sh\nexit 1\n');
  fs.chmodSync(fakeAz, 0o755);
  try {
    process.env.AZURE_DEVOPS_EXT_PAT = 'not-a-real-pat';
    delete process.env.ADO_PAT; delete process.env.ADO_ORG; delete process.env.ADO_PROJECT;
    process.env.PATH = `${fakeAzDir}${path.delimiter}${saved.PATH || ''}`;
    // No az config: check.sh stops before any network call.
    process.env.HOME = empty;
    process.env.AZURE_CONFIG_DIR = empty;
    const check = doctor.adoState(null);
    assert.match(check.detail, /no organization/);
    assert.equal(check.status, 'warn');
    assert.match(check.fix, /copy its link \(https:\/\/dev\.azure\.com\/<organization>\/<project>\)/);
    assert.doesNotMatch(check.fix, /--org/);
  } finally {
    process.env = saved;
  }
});
