'use strict';
require('./temp-cleanup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { build } = require('../lib/build');
const { run } = require('../cli/index');
const legacy = require('../lib/legacy');

const NOW = new Date('2026-10-12T10:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const OLD_CONFIG = {
  version: 1,
  activeContext: 'MPD-QA',
  contexts: [{
    name: 'MPD-QA', organization: 'https://dev.azure.com/ORG', project: 'Proj',
    workspaceRoot: 'C:\\QA\\MPD', repositories: [{ name: 'App', remoteUrl: 'u', path: 'p' }],
    systems: [], defaults: { workItemType: 'Bug' }, allowedFields: ['System.Title'],
  }],
};

test('retired skills move aside; every other skill directory stays where it is', () => {
  const home = tmp();
  put(path.join(home, '.copilot/skills/qa-ado-work-item-assistant/SKILL.md'), 'old');
  put(path.join(home, '.copilot/skills/test-plan/SKILL.md'), 'mine');
  put(path.join(home, '.claude/skills/qa-ado-work-item-assistant/SKILL.md'), 'old, other target');

  const moved = legacy.archiveRetiredSkills({ baseDir: home, targets: ['copilot'], scope: 'global', now: NOW });

  assert.deepEqual(moved.map((m) => m.from), ['.copilot/skills/qa-ado-work-item-assistant']);
  assert.ok(!fs.existsSync(path.join(home, '.copilot/skills/qa-ado-work-item-assistant')));
  assert.equal(fs.readFileSync(path.join(home, moved[0].to, 'SKILL.md'), 'utf8'), 'old');
  assert.ok(fs.existsSync(path.join(home, '.copilot/skills/test-plan/SKILL.md')));
  // Not the target being installed: left for the run that installs Claude.
  assert.ok(fs.existsSync(path.join(home, '.claude/skills/qa-ado-work-item-assistant/SKILL.md')));
  assert.deepEqual(legacy.archiveRetiredSkills({ baseDir: home, targets: ['copilot'], scope: 'global', now: NOW }), []);
});

test('the old Copilot instructions layout is retired in a project install', () => {
  const dir = tmp();
  put(path.join(dir, '.github/instructions/qa-ado-work-item-assistant.instructions.md'), 'x');
  put(path.join(dir, '.github/skillcatalog/qa-ado-work-item-assistant/scripts/setup.ps1'), 'x');
  const moved = legacy.archiveRetiredSkills({ baseDir: dir, targets: ['copilot'], scope: 'local', now: NOW });
  assert.equal(moved.length, 2);
  assert.ok(!fs.existsSync(path.join(dir, '.github/instructions/qa-ado-work-item-assistant.instructions.md')));
});

test('state: PAT, contexts split by field, drafts and git helper move; old folder is renamed', () => {
  const home = tmp();
  const old = path.join(home, '.qa-ado-assistant');
  put(path.join(old, 'ado-pat.xml'), 'protected');
  // PowerShell 5.1 writes a BOM and collapses a one-element array to an object.
  put(path.join(old, 'config.json'), `\uFEFF${JSON.stringify({ ...OLD_CONFIG, contexts: OLD_CONFIG.contexts[0] })}`);
  put(path.join(old, 'drafts/bug-1.json'), '{}');
  const getPat = path.join(tmp(), 'get-pat.ps1');
  put(getPat, '# get-pat');

  const r = legacy.migrateLegacyState({ home, getPatSource: getPat, now: NOW });

  assert.equal(r.pat, 'moved');
  assert.deepEqual(r.contexts, ['MPD-QA']);
  assert.equal(r.drafts, 1);
  const cred = readJson(path.join(home, '.ado-credentials/config.json'));
  assert.equal(cred.activeContext, 'MPD-QA');
  assert.deepEqual(cred.contexts, [{ name: 'MPD-QA', organization: 'https://dev.azure.com/ORG', project: 'Proj' }]);
  const ws = readJson(path.join(home, '.qa-ado-work-item/config.json'));
  assert.equal(ws.contexts[0].name, 'MPD-QA');
  assert.equal(ws.contexts[0].workspaceRoot, 'C:\\QA\\MPD');
  assert.equal(ws.contexts[0].organization, undefined);
  assert.equal(fs.readFileSync(path.join(home, '.ado-credentials/ado-pat.xml'), 'utf8'), 'protected');
  assert.ok(fs.existsSync(path.join(home, '.qa-ado-work-item/drafts/bug-1.json')));
  assert.ok(fs.existsSync(path.join(home, '.ado-credentials/get-pat.ps1')));
  assert.match(fs.readFileSync(path.join(home, '.ado-credentials/git-askpass.cmd'), 'utf8'), /get-pat\.ps1" "%~1"\r\n$/);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(path.join(home, r.archivedTo, 'ado-pat.xml')));
  assert.equal(legacy.migrateLegacyState({ home, getPatSource: getPat, now: NOW }), null);
});

test('state: what is already in the new layout wins over the old', () => {
  const home = tmp();
  put(path.join(home, '.qa-ado-assistant/ado-pat.xml'), 'old');
  put(path.join(home, '.qa-ado-assistant/config.json'), JSON.stringify({
    activeContext: 'MPD-QA',
    contexts: [...OLD_CONFIG.contexts, { name: 'Other', organization: 'https://dev.azure.com/O2', project: 'P2' }],
  }));
  put(path.join(home, '.ado-credentials/ado-pat.xml'), 'new');
  put(path.join(home, '.ado-credentials/config.json'), JSON.stringify({
    version: 1, activeContext: 'Current', contexts: [{ name: 'MPD-QA', organization: 'https://dev.azure.com/NEW', project: 'X' }],
  }));
  put(path.join(home, '.qa-ado-work-item/config.json'), JSON.stringify({ version: 1, contexts: [{ name: 'MPD-QA', workspaceRoot: 'D:\\new' }] }));

  const r = legacy.migrateLegacyState({ home, now: NOW });

  assert.equal(r.pat, 'kept-existing');
  assert.deepEqual(r.skipped, ['MPD-QA']);
  assert.deepEqual(r.contexts, ['Other']);
  assert.equal(fs.readFileSync(path.join(home, '.ado-credentials/ado-pat.xml'), 'utf8'), 'new');
  const cred = readJson(path.join(home, '.ado-credentials/config.json'));
  assert.equal(cred.activeContext, 'Current');
  assert.equal(cred.contexts.find((c) => c.name === 'MPD-QA').organization, 'https://dev.azure.com/NEW');
  assert.ok(cred.contexts.some((c) => c.name === 'Other'));
  assert.equal(readJson(path.join(home, '.qa-ado-work-item/config.json')).contexts[0].workspaceRoot, 'D:\\new');
});

test('state: a PAT with no config (setup that never finished) still moves', () => {
  const home = tmp();
  put(path.join(home, '.qa-ado-assistant/ado-pat.xml'), 'protected');
  const r = legacy.migrateLegacyState({ home, now: NOW });
  assert.equal(r.pat, 'moved');
  assert.deepEqual(r.contexts, []);
  assert.ok(!fs.existsSync(path.join(home, '.ado-credentials/config.json')));
  assert.equal(fs.readFileSync(path.join(home, '.ado-credentials/ado-pat.xml'), 'utf8'), 'protected');
});

test('engcat install runs the migration before installing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  fs.cpSync(path.join(__dirname, 'fixtures', 'catalog'), root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', description: 'd' }));
  build({ root });
  const home = tmp();
  put(path.join(home, '.copilot/skills/qa-ado-work-item-assistant/SKILL.md'), 'old');
  put(path.join(home, '.qa-ado-assistant/ado-pat.xml'), 'protected');

  const stdout = new PassThrough(); const stderr = new PassThrough(); const stdin = new PassThrough(); stdin.end('');
  let out = ''; stdout.on('data', (d) => { out += d; });
  const code = await run(['install', '--bundle', 'qa', '--target', 'copilot'], { root, cwd: home, home, stdin, stdout, stderr });

  assert.equal(code, 0);
  assert.match(out, /retired \.copilot\/skills\/qa-ado-work-item-assistant/);
  assert.match(out, /PAT moved/);
  assert.match(out, /ask it to add a project/);
  assert.ok(!fs.existsSync(path.join(home, '.copilot/skills/qa-ado-work-item-assistant')));
  assert.ok(fs.existsSync(path.join(home, '.ado-credentials/ado-pat.xml')));
});

test('a folder that cannot be moved stops the run with the cause, not a bare EPERM', { skip: process.platform === 'win32' || process.getuid() === 0 }, () => {
  const home = tmp();
  put(path.join(home, '.copilot/skills/qa-ado-work-item-assistant/SKILL.md'), 'old');
  fs.chmodSync(path.join(home, '.copilot/skills'), 0o555); // rename out of it is refused
  try {
    assert.throws(
      () => legacy.archiveRetiredSkills({ baseDir: home, targets: ['copilot'], scope: 'global', now: NOW }),
      /is in use \(EACCES\)\. Close GitHub Copilot/,
    );
  } finally { fs.chmodSync(path.join(home, '.copilot/skills'), 0o755); }
  assert.ok(fs.existsSync(path.join(home, '.copilot/skills/qa-ado-work-item-assistant/SKILL.md')));
});
