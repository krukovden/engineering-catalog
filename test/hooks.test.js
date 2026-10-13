'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const {
  scanHooks, hookId, claudeCommand, copilotCommands, claudeHooksFile, copilotHooksFile,
} = require('../lib/hooks');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'hooks');
const HOOKS = scanHooks({ root: ROOT });
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0;

/** A home with the state the scenario asks for, and a fake `git` that answers ls-remote. */
function stage(setup = {}) {
  const writeTree = (root, files = {}) => {
    for (const [rel, value] of Object.entries(files)) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value);
    }
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hookhome-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hookproj-'));
  if (setup.receipt) {
    fs.mkdirSync(path.join(home, '.engineering-catalog'));
    fs.writeFileSync(path.join(home, '.engineering-catalog/receipt.json'),
      JSON.stringify({ schema: 1, installs: [{ target: 'claude', scope: 'global', ...setup.receipt }] }));
  }
  writeTree(home, setup.homeFiles);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hookbin-'));
  // `repo`: the project is a git repository on `branch`, optionally with an `origin` and a catalog receipt.
  if (setup.repo) {
    const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
    git('init', '-q');
    git('symbolic-ref', 'HEAD', `refs/heads/${setup.repo.branch}`);
    if (setup.repo.remote) git('remote', 'add', 'origin', setup.repo.remote);
    if (setup.repo.receipt) {
      fs.mkdirSync(path.join(project, '.engineering-catalog'));
      fs.writeFileSync(path.join(project, '.engineering-catalog/receipt.json'), '{}');
    }
  }
  writeTree(project, setup.projectFiles);
  const tags = (setup.fakeGitTags || []).map((t) => `echo "0000 refs/tags/${t}"`).join('\n');
  if (!setup.repo) {
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n${tags}\n`);
    fs.chmodSync(path.join(bin, 'git'), 0o755);
  }
  // `noGit`: PATH is this directory alone, holding `sh` and `node` — no `git`.
  if (setup.noGit) {
    fs.symlinkSync(execFileSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).trim(), path.join(bin, 'sh'));
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  }
  // `noNode`: PATH is this directory alone, holding `sh` and the fake `git` — no `node`.
  if (setup.noNode) fs.symlinkSync(execFileSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).trim(), path.join(bin, 'sh'));
  return { home, project, bin, path: setup.noNode || setup.noGit ? bin : `${bin}:${process.env.PATH}` };
}

const PWSH = hasPwsh ? execFileSync('sh', ['-c', 'command -v pwsh'], { encoding: 'utf8' }).trim() : null;

function runCommand(command, { cwd, env, input, shell = 'sh' }) {
  const started = Date.now();
  const r = shell === 'pwsh'
    ? spawnSync(PWSH, ['-NoProfile', '-Command', command], { cwd, env, input, encoding: 'utf8' })
    : spawnSync('sh', ['-c', command], { cwd, env, input, encoding: 'utf8' });
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

/**
 * What a deny hook decided, read the way each CLI reads it: Claude from
 * `hookSpecificOutput.permissionDecision`, Copilot from a flat `permissionDecision`
 * (copilot-facts.md §4.1). No JSON decision means the call goes ahead.
 */
function decision(stdout, { platform }) {
  const text = stdout.trim();
  if (text === '') return { decision: 'allow', reason: '' };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { decision: 'allow', reason: '' }; }
  const d = platform === 'claude' ? (parsed.hookSpecificOutput || {}) : parsed;
  if (platform === 'claude' && d.hookEventName !== 'PreToolUse') return { decision: 'allow', reason: '' };
  return { decision: d.permissionDecision || 'allow', reason: d.permissionDecisionReason || '' };
}

function checkOutcome(result, expect, { platform, hook, label }) {
  assert.equal(result.status, expect.exit, `${label}: exit code (stderr: ${result.stderr.trim()})`);
  if (expect.decision) {
    const got = decision(result.stdout, { platform });
    assert.equal(got.decision, expect.decision, `${label}: permission decision (stdout: ${result.stdout.trim()})`);
    if (expect.reason) assert.match(got.reason, new RegExp(expect.reason), `${label}: the reason the model is given`);
  } else {
    const said = spoken(result.stdout, { platform, hook, label });
    if (expect.stdout === 'empty') assert.equal(said, '', `${label}: expected to say nothing`);
    else assert.match(said, new RegExp(expect.stdout), `${label}: what the session receives`);
    if (expect.maxOutputChars != null) {
      assert.ok(said.length <= expect.maxOutputChars,
        `${label}: injected ${said.length} chars of context, budget ${expect.maxOutputChars}`);
    }
  }
  if (expect.maxMs) assert.ok(result.ms <= expect.maxMs, `${label}: took ${result.ms}ms, budget ${expect.maxMs}ms`);
}

/** A scenario's stdin: one payload for both CLIs, or `{ claude, copilot }` when their shapes differ. */
function stdinFor(scenario, platform) {
  const s = scenario.stdin;
  if (s === undefined) return undefined;
  const payload = s && typeof s === 'object' && ('claude' in s || 'copilot' in s) ? s[platform] : s;
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

/**
 * One scenario on one platform, through the command that platform's manifest actually carries.
 * `root` is the plugin root; `scenario.env` may override anything, including PATH and the
 * project directory, which is how the fail-open cases take `node` or the `cd` target away.
 */
function runScenario(hook, scenario, platform, root = ROOT, { shell = 'sh' } = {}) {
  const { home, project, path: PATH } = stage(scenario.setup);
  const env = { ...process.env, ENGCAT_HOME: home, PATH };
  const where = platform === 'claude'
    ? { cwd: project, env: { ...env, CLAUDE_PLUGIN_ROOT: root, ...(scenario.env || {}) } }
    : { cwd: root, env: { ...env, COPILOT_PLUGIN_ROOT: root, COPILOT_PROJECT_DIR: project, ...(scenario.env || {}) } };
  const copilot = copilotCommands(hook);
  const command = platform === 'claude' ? claudeCommand(hook) : shell === 'pwsh' ? copilot.powershell : copilot.bash;
  const result = runCommand(command, { ...where, shell, input: stdinFor(scenario, platform) });
  checkOutcome(result, scenario.expect, { platform, hook, label: `${platform}${shell === 'pwsh' ? ' (powershell)' : ''}: ${scenario.name}` });
  for (const rel of scenario.expect.writes || []) {
    assert.ok(fs.existsSync(path.join(home, rel)), `${platform}: expected ${rel} under the home`);
  }
  return result;
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
        if (!scenario.platforms || scenario.platforms.includes(platform)) runScenario(hook, scenario, platform);
      }
    });
  }

  // The PowerShell twin is a separate implementation: hold it to the same contract as the shell one.
  for (const scenario of fixture.scenarios) {
    const applies = hook.platforms.includes('copilot') && (!scenario.platforms || scenario.platforms.includes('copilot'));
    test(`${hookId(hook)} — ${scenario.name} (PowerShell)`, { skip: !applies ? 'not a Copilot scenario' : !hasPwsh ? 'pwsh not installed' : false }, () => {
      runScenario(hook, scenario, 'copilot', ROOT, { shell: 'pwsh' });
    });
  }
}

/**
 * §2.3: a denial is three lines — WHAT, WHY, FIX — and the FIX must be runnable as written.
 * Returns what is wrong with a denial's text; empty when it is fine. A regex, not an AST.
 */
function denialProblems(reason) {
  const lines = String(reason).split('\n');
  const problems = [];
  if (lines.length !== 3 || !/^WHAT: \S/.test(lines[0]) || !/^WHY: \S/.test(lines[1]) || !/^FIX: \S/.test(lines[2])) {
    return ['needs exactly three lines: WHAT, WHY, FIX'];
  }
  const fix = lines[2].slice('FIX: '.length);
  if (/<[^>\n]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|\[(?:TODO|FIXME|XXX)\]/i.test(fix)) problems.push('FIX has a placeholder');
  if (/\sor\s/i.test(fix)) problems.push('FIX offers alternatives');
  if (/^(?:read|use|consider|try)\s/i.test(fix)) problems.push('FIX opens with advice, not a command');
  return problems;
}

test('every deny hook says what, why and fix, and the fix is actionable', () => {
  const denyHooks = HOOKS.filter((h) => h.denies);
  assert.ok(denyHooks.length > 0, 'the catalog ships at least one deny hook');
  for (const hook of denyHooks) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${hookId(hook)}.json`), 'utf8'));
    const denials = fixture.scenarios.filter((s) => s.expect.decision === 'deny');
    assert.ok(denials.length > 0, `${hookId(hook)}: a deny hook needs a scenario that denies`);
    for (const scenario of denials) {
      const result = runScenario(hook, scenario, hook.platforms[0]);
      const { reason } = decision(result.stdout, { platform: hook.platforms[0] });
      assert.deepEqual(denialProblems(reason), [], `${hookId(hook)} — ${scenario.name}: ${reason}`);
    }
  }
});

test('the denial check rejects a vague fix', () => {
  const deny = (fix) => `WHAT: w.\nWHY: y.\nFIX: ${fix}`;
  assert.deepEqual(denialProblems(deny('git switch -c feature/x')), []);
  assert.match(denialProblems(deny('git switch -c <branch>'))[0], /placeholder/);
  assert.match(denialProblems(deny('git switch -c a or git checkout -b a'))[0], /alternatives/);
  assert.match(denialProblems(deny('Use git switch'))[0], /opens with advice/);
  assert.match(denialProblems('just one line')[0], /three lines/);
});

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

// A deny hook, staged as a tiny plugin root of its own (test/hooks/deny-probe/) so no shipped
// hook is needed to prove the machinery. Copilot is exercised by rendering the same source as if
// it shipped there: the loader refuses that until a live capture exists (copilot-facts.md §6).
const PROBE_ROOT = path.join(FIXTURES, 'deny-probe');
const PROBE = scanHooks({ root: PROBE_ROOT })[0];
const PROBE_BOTH = { ...PROBE, platforms: ['claude', 'copilot'] };
const PROBE_CONTRACT = JSON.parse(fs.readFileSync(path.join(PROBE_ROOT, 'contract.json'), 'utf8'));

test('the deny probe contract is the probe hook\'s', () => {
  assert.equal(PROBE_CONTRACT.id, hookId(PROBE));
  assert.equal(PROBE.denies, true);
});

for (const scenario of PROBE_CONTRACT.scenarios) {
  test(`deny hook — ${scenario.name}`, () => {
    for (const platform of PROBE_BOTH.platforms) {
      if (!scenario.platforms || scenario.platforms.includes(platform)) runScenario(PROBE_BOTH, scenario, platform, PROBE_ROOT);
    }
  });
}

test('deny hook — the script itself is absent: fails open on both CLIs', () => {
  const absent = { ...PROBE_BOTH, script: 'scripts/absent' };
  const scenario = { name: 'script absent', ...PROBE_CONTRACT.scenarios[0], expect: { exit: 0, decision: 'allow' } };
  for (const platform of absent.platforms) runScenario(absent, scenario, platform, PROBE_ROOT);
});

test('without `denies`, the same failure would deny every call on Copilot', () => {
  // The reason the wrapper exists: today's context-hook command exits non-zero when `cd` fails,
  // and Copilot reads any non-zero preToolUse exit as a deny (copilot-facts.md §4.1).
  const plain = { ...PROBE_BOTH, denies: false };
  const r = runCommand(copilotCommands(plain).bash, {
    cwd: PROBE_ROOT, input: '{}',
    env: { ...process.env, COPILOT_PLUGIN_ROOT: PROBE_ROOT, COPILOT_PROJECT_DIR: '/nonexistent/engcat-probe' },
  });
  assert.notEqual(r.status, 0);
});

test('a deny hook asks for Copilot\'s deny shape on Copilot only, and its PowerShell twin fails open too', () => {
  assert.ok(!claudeCommand(PROBE_BOTH).includes('--copilot'), 'Claude gets the hookSpecificOutput shape, the script default');
  assert.match(copilotCommands(PROBE_BOTH).bash, / --copilot; exit 0$/);
  const ps = copilotCommands(PROBE_BOTH).powershell;
  assert.match(ps, /^try \{ .* -Copilot \} catch \{ \}; exit 0$/);
  assert.match(ps, /Set-Location -ErrorAction Stop/, 'a failed Set-Location must throw into the catch, not run the script elsewhere');
});

if (hasPwsh) {
  test('deny hook — PowerShell twin exits 0 when its script is absent', () => {
    const r = spawnSync('pwsh', ['-NoProfile', '-Command', copilotCommands({ ...PROBE_BOTH, script: 'scripts/absent' }).powershell], {
      cwd: PROBE_ROOT, encoding: 'utf8', env: { ...process.env, COPILOT_PLUGIN_ROOT: PROBE_ROOT, COPILOT_PROJECT_DIR: '/nonexistent/engcat-probe' },
    });
    assert.equal(r.status, 0, r.stderr);
  });
}

test('a matcher renders Claude tool names on Claude and runtime names on Copilot', () => {
  const edit = { ...PROBE_BOTH, denies: false, matcher: ['Edit', 'Write'] };
  const bash = { ...PROBE_BOTH, denies: false, matcher: ['Bash'] };
  const claude = claudeHooksFile([edit, bash]).hooks.PreToolUse;
  assert.deepEqual(claude.map((g) => g.matcher), ['Edit|Write', 'Bash'], 'one Claude group per distinct matcher');
  const copilot = copilotHooksFile([edit, bash]).hooks.preToolUse;
  assert.deepEqual(copilot.map((e) => e.matcher), ['create|edit|str_replace_editor|apply_patch', 'bash|powershell']);
});

test('a hook without a matcher renders exactly as before', () => {
  const hook = HOOKS.find((h) => h.name === 'catalog-freshness');
  assert.deepEqual(Object.keys(claudeHooksFile([hook]).hooks.SessionStart[0]), ['hooks']);
  assert.deepEqual(Object.keys(copilotHooksFile([hook]).hooks.sessionStart[0]), ['type', 'bash', 'powershell', 'timeoutSec']);
  assert.ok(!claudeCommand(hook).includes('exit 0'), 'only a deny hook gets the fail-open wrapper');
});

test('matcher and denies are validated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hooksrc-'));
  fs.mkdirSync(path.join(root, 'hooks'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/ok.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(root, 'scripts/ok.ps1'), '');
  const write = (body) => fs.writeFileSync(path.join(root, 'hooks/probe.json'), JSON.stringify(body));
  const base = { name: 'probe', description: 'd', event: 'PreToolUse', script: 'scripts/ok', platforms: ['claude'] };

  write({ ...base, matcher: ['Bash'], denies: true });
  assert.deepEqual(scanHooks({ root })[0].matcher, ['Bash']);

  write({ ...base, event: 'SessionStart', matcher: ['Bash'] });
  assert.throws(() => scanHooks({ root }), /only PreToolUse and PostToolUse take one/);

  write({ ...base, matcher: 'Bash' });
  assert.throws(() => scanHooks({ root }), /non-empty list of Claude tool names/);

  write({ ...base, matcher: ['MultiEdit'], platforms: ['claude', 'copilot'] });
  assert.throws(() => scanHooks({ root }), /no Copilot runtime name/);

  write({ ...base, event: 'PostToolUse', denies: true });
  assert.throws(() => scanHooks({ root }), /only for a PreToolUse hook/);

  write({ ...base, denies: 'yes' });
  assert.throws(() => scanHooks({ root }), /"denies" is true or false/);

  write({ ...base, denies: true, platforms: ['claude', 'copilot'] });
  assert.throws(() => scanHooks({ root }), /live capture/);
});

test('a second context-emitting SessionStart hook is refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hooksrc-'));
  fs.mkdirSync(path.join(root, 'hooks'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/ok.sh'), '#!/bin/sh\n');
  const base = { description: 'd', event: 'SessionStart', script: 'scripts/ok', platforms: ['claude'], emitsContext: true };
  fs.writeFileSync(path.join(root, 'hooks/one.json'), JSON.stringify({ ...base, name: 'one' }));
  assert.equal(scanHooks({ root }).length, 1);
  fs.writeFileSync(path.join(root, 'hooks/two.json'), JSON.stringify({ ...base, name: 'two', emitsContext: false }));
  assert.equal(scanHooks({ root }).length, 2, 'a silent second hook is fine');
  fs.writeFileSync(path.join(root, 'hooks/two.json'), JSON.stringify({ ...base, name: 'two' }));
  assert.throws(() => scanHooks({ root }), /one context-emitting SessionStart hook/);
});
