'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { scanHooks, hookId, claudeCommand, copilotCommands } = require('../lib/hooks');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'hooks');
const HOOKS = scanHooks({ root: ROOT });
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0;

/** A home with the state the scenario asks for, and a fake `git` that answers ls-remote. */
function stage(setup = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hookhome-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hookproj-'));
  if (setup.receipt) {
    fs.mkdirSync(path.join(home, '.engineering-catalog'));
    fs.writeFileSync(path.join(home, '.engineering-catalog/receipt.json'),
      JSON.stringify({ schema: 1, installs: [{ target: 'claude', scope: 'global', ...setup.receipt }] }));
  }
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hookbin-'));
  const tags = (setup.fakeGitTags || []).map((t) => `echo "0000 refs/tags/${t}"`).join('\n');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n${tags}\n`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  return { home, project, bin };
}

function runCommand(command, { cwd, env }) {
  const started = Date.now();
  const r = spawnSync('sh', ['-c', command], { cwd, env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', ms: Date.now() - started };
}

/**
 * What the session actually receives, which is not the same text on both CLIs. Claude adds a
 * SessionStart hook's plain stdout to the session; Copilot parses stdout as JSON and reads
 * `additionalContext`, dropping plain text without a word. Asserting on the raw bytes would
 * pass on both platforms while only one of them said anything, which is the failure this
 * file exists to prevent — so unwrap first, then compare.
 */
function spoken(stdout, { platform, hook, label }) {
  const text = stdout.trim();
  if (platform !== 'copilot' || !hook.emitsContext || text === '') return text;
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    return assert.fail(`${label}: copilot reads hook stdout as JSON and drops anything else — got ${text}`);
  }
  return typeof parsed.additionalContext === 'string' ? parsed.additionalContext : '';
}

function checkOutcome(result, expect, { platform, hook, label }) {
  assert.equal(result.status, expect.exit, `${label}: exit code (stderr: ${result.stderr.trim()})`);
  const said = spoken(result.stdout, { platform, hook, label });
  if (expect.stdout === 'empty') assert.equal(said, '', `${label}: expected to say nothing`);
  else assert.match(said, new RegExp(expect.stdout), `${label}: what the session receives`);
  if (expect.maxMs) assert.ok(result.ms <= expect.maxMs, `${label}: took ${result.ms}ms, budget ${expect.maxMs}ms`);
  if (expect.maxOutputChars != null) {
    assert.ok(said.length <= expect.maxOutputChars,
      `${label}: injected ${said.length} chars of context, budget ${expect.maxOutputChars}`);
  }
}

test('every hook source has a contract fixture', () => {
  assert.ok(HOOKS.length > 0, 'the catalog ships at least one hook');
  for (const hook of HOOKS) {
    const file = path.join(FIXTURES, `${hookId(hook)}.json`);
    assert.ok(fs.existsSync(file), `hook "${hook.name}" has no contract: write ${path.relative(ROOT, file)}`);
    const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(fixture.id, hookId(hook), `${path.relative(ROOT, file)}: id must be ${hookId(hook)}`);
    assert.ok(Array.isArray(fixture.scenarios) && fixture.scenarios.length, `${fixture.id}: needs scenarios`);
  }
});

for (const hook of HOOKS) {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${hookId(hook)}.json`), 'utf8'));
  for (const scenario of fixture.scenarios) {
    // The same scenario must hold for every platform the hook declares: one behaviour, two wrappers.
    test(`${hookId(hook)} — ${scenario.name}`, () => {
      for (const platform of hook.platforms) {
        const { home, project, bin } = stage(scenario.setup);
        const env = { ...process.env, ENGCAT_HOME: home, PATH: `${bin}:${process.env.PATH}`, ...(scenario.env || {}) };
        const command = platform === 'claude'
          ? claudeCommand(hook)
          : copilotCommands(hook).bash;
        const where = platform === 'claude'
          ? { cwd: project, env: { ...env, CLAUDE_PLUGIN_ROOT: ROOT } }
          : { cwd: ROOT, env: { ...env, COPILOT_PLUGIN_ROOT: ROOT, COPILOT_PROJECT_DIR: project } };
        checkOutcome(runCommand(command, where), scenario.expect, { platform, hook, label: `${platform}: ${scenario.name}` });
        for (const rel of scenario.expect.writes || []) {
          assert.ok(fs.existsSync(path.join(home, rel)), `${platform}: expected ${rel} under the home`);
        }
      }
    });
  }

  if (hook.platforms.includes('copilot') && hasPwsh) {
    test(`${hookId(hook)} — PowerShell twin runs`, () => {
      const { home, project, bin } = stage(fixture.scenarios[0].setup);
      const r = spawnSync('pwsh', ['-NoProfile', '-Command', copilotCommands(hook).powershell], {
        cwd: ROOT, encoding: 'utf8',
        env: { ...process.env, ENGCAT_HOME: home, PATH: `${bin}:${process.env.PATH}`, COPILOT_PLUGIN_ROOT: ROOT, COPILOT_PROJECT_DIR: project },
      });
      assert.equal(r.status, 0, `PowerShell twin failed: ${r.stderr}`);
    });
  }
}

test('a hook whose output is meant to be read gets the JSON shape on Copilot only', () => {
  const hook = HOOKS.find((h) => h.emitsContext);
  assert.ok(hook, 'the catalog ships at least one hook that speaks to the model');
  assert.ok(!claudeCommand(hook).includes('--json'), 'Claude takes plain stdout as context on SessionStart');
  assert.match(copilotCommands(hook).bash, /--json$/, 'Copilot drops plain text; it reads stdout as JSON');
  assert.match(copilotCommands(hook).powershell, /-Json$/, 'the PowerShell twin needs the same shape');
});

test('hook sources are validated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hooksrc-'));
  fs.mkdirSync(path.join(root, 'hooks'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/ok.sh'), '#!/bin/sh\n');
  const write = (name, body) => fs.writeFileSync(path.join(root, 'hooks', `${name}.json`), JSON.stringify(body));
  const base = { name: 'probe', description: 'd', event: 'SessionStart', script: 'scripts/ok', platforms: ['claude'] };

  write('probe', base);
  assert.equal(scanHooks({ root })[0].name, 'probe');

  write('probe', { ...base, name: 'other' });
  assert.throws(() => scanHooks({ root }), /is named probe\.json/);

  write('probe', { ...base, event: 'WheneverIFeelLikeIt' });
  assert.throws(() => scanHooks({ root }), /is not one of/);

  write('probe', { ...base, event: 'Stop', platforms: ['claude', 'copilot'] });
  assert.throws(() => scanHooks({ root }), /no Copilot equivalent/);

  write('probe', { ...base, script: 'scripts/missing' });
  assert.throws(() => scanHooks({ root }), /does not exist/);

  write('probe', { ...base, script: 'scripts/ok.sh' });
  assert.throws(() => scanHooks({ root }), /without its extension/);
});
