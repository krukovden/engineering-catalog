'use strict';
require('./temp-cleanup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skills/shared/catalog-freshness/scripts/check-freshness.sh');
const { LINE, lineFor } = require(path.join(__dirname, '..', 'skills/shared/catalog-freshness/scripts/project-state.js'));
function home(version, lastChecked) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'));
  fs.mkdirSync(path.join(h, '.engineering-catalog'));
  fs.writeFileSync(path.join(h, '.engineering-catalog/receipt.json'), JSON.stringify({ schema: 1, installs: [{ target: 'claude', scope: 'global', catalogVersion: version, source: 'https://example/repo' }] }));
  if (lastChecked) fs.writeFileSync(path.join(h, '.engineering-catalog/freshness.json'), JSON.stringify({ lastChecked, latest: version }));
  return h;
}
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshproj-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', 'https://dev.azure.com/acme/Orion/_git/api'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.engineering-catalog'));
  fs.writeFileSync(path.join(dir, '.engineering-catalog/receipt.json'), JSON.stringify({ installs: [{ catalogVersion: '1.0.0', source: 'https://example/repo' }] }));
  return dir;
}
function fakeGit(tags) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-'));
  const f = path.join(bin, 'git');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(f, `#!/bin/sh
if [ "$1" = "ls-remote" ] || { [ "$1" = "-c" ] && [ "$3" = "ls-remote" ]; }; then
${tags.map((t) => `  echo "0000 refs/tags/${t}"`).join('\n') || '  :'}
  exit 0
fi
exec "${realGit}" "$@"
`);
  fs.chmodSync(f, 0o755);
  return bin;
}
// Offline by construction: credentials scrubbed, a fake `az` that only logs, and fetch
// replaced in every node child so the board nudge cannot reach Azure DevOps.
const CREDENTIAL_ENV = /^(AZURE_DEVOPS_|ADO_|AZURE_|SYSTEM_ACCESSTOKEN$|NODE_OPTIONS$)/;
const OFFLINE = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-offline-'));
const NET_LOG = path.join(OFFLINE, 'net.log');
fs.writeFileSync(path.join(OFFLINE, 'trap.js'), `globalThis.fetch = async (url) => {
  require('fs').appendFileSync(${JSON.stringify(NET_LOG)}, 'fetch ' + url + '\\n');
  throw new Error('network disabled in tests');
};
`);
fs.writeFileSync(path.join(OFFLINE, 'az'), `#!/bin/sh\necho "az $*" >> "${NET_LOG}"\nexit 1\n`);
fs.chmodSync(path.join(OFFLINE, 'az'), 0o755);
function offlineEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !CREDENTIAL_ENV.test(k)));
  return { ...env, HOME: OFFLINE, NODE_OPTIONS: `--require ${path.join(OFFLINE, 'trap.js')}`, ...extra };
}
const netCalls = () => (fs.existsSync(NET_LOG) ? fs.readFileSync(NET_LOG, 'utf8') : '');
const run = (h, bin, args = [], cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'freshcwd-'))) => execFileSync('sh', [SCRIPT, ...args], { cwd, env: offlineEnv({ ENGCAT_HOME: h, PATH: `${bin}:${OFFLINE}:${process.env.PATH}` }) }).toString();

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

test('--version answers from the receipt, inside the interval and without the network', () => {
  const recent = home('1.0.5', new Date().toISOString());
  const out = run(recent, fakeGit([]), ['--version', '--quiet']);
  assert.match(out, /^engineering-catalog 1\.0\.5 is installed \(on .*, from https:\/\/example\/repo\)\.\n$/);
  assert.equal(JSON.parse(run(recent, fakeGit([]), ['--version', '--json'])).additionalContext.startsWith('engineering-catalog 1.0.5 is installed'), true);
});

test('reports legacy project state once a day, then stays quiet until the throttle expires', () => {
  const h = home('1.0.0');
  const dir = project();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '<!-- engineering-catalog:memory:start -->\nold\n<!-- engineering-catalog:memory:end -->\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '<!-- engineering-catalog:memory:start v=1 -->\ncurrent\n<!-- engineering-catalog:memory:end -->\n');
  fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github/copilot-instructions.md'), '<!-- engineering-catalog:memory:start v=1 -->\ncurrent\n<!-- engineering-catalog:memory:end -->\n');
  fs.writeFileSync(path.join(dir, '.git/hooks/post-commit'), '#!/bin/sh\n# engineering-catalog:memory:start\nold\n# engineering-catalog:memory:end\n');
  const first = run(h, fakeGit([]), ['--quiet'], dir);
  assert.match(first, new RegExp(`^${LINE}$`, 'm'));
  assert.equal(run(h, fakeGit([]), ['--quiet'], dir), '');
  const cache = path.join(h, '.engineering-catalog/project-state.json');
  const keyed = JSON.parse(fs.readFileSync(cache, 'utf8'));
  keyed[Object.keys(keyed)[0]].lastNotified = '2000-01-01T00:00:00Z';
  fs.writeFileSync(cache, JSON.stringify(keyed));
  assert.match(run(h, fakeGit([]), ['--quiet'], dir), new RegExp(`^${LINE}$`, 'm'));
});

test('current project state stays silent', () => {
  const h = home('1.0.0');
  const dir = project();
  const current = '<!-- engineering-catalog:memory:start v=1 -->\ncurrent\n<!-- engineering-catalog:memory:end -->\n';
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), current);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), current);
  fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github/copilot-instructions.md'), current);
  fs.writeFileSync(path.join(dir, '.git/hooks/post-commit'), '#!/bin/sh\n# engineering-catalog:memory:start v=1\ncurrent\n# engineering-catalog:memory:end\n');
  const boardDir = path.join(h, '.engineering-catalog', 'ado-board', 'dev.azure.com-acme');
  fs.mkdirSync(boardDir, { recursive: true });
  fs.writeFileSync(path.join(boardDir, 'orion.json'), JSON.stringify({ version: 1, organization: 'https://dev.azure.com/acme', project: 'Orion', types: {} }));
  assert.equal(run(h, fakeGit([]), ['--quiet'], dir), '');
});

test('stays offline even when the caller has an Azure DevOps credential', () => {
  const saved = process.env.AZURE_DEVOPS_EXT_PAT;
  process.env.AZURE_DEVOPS_EXT_PAT = 'not-a-real-pat';
  fs.rmSync(NET_LOG, { force: true });
  try {
    const h = home('1.0.0');
    const dir = project();
    const boardDir = path.join(h, '.engineering-catalog', 'ado-board', 'dev.azure.com-acme');
    fs.mkdirSync(boardDir, { recursive: true });
    fs.writeFileSync(path.join(boardDir, 'orion.json'), JSON.stringify({ version: 1, organization: 'https://dev.azure.com/acme', project: 'Orion', types: {} }));
    run(h, fakeGit([]), ['--force'], dir);
    assert.equal(netCalls().split('\n').filter((l) => l.startsWith('fetch')).join('\n'), '');
  } finally {
    if (saved === undefined) delete process.env.AZURE_DEVOPS_EXT_PAT; else process.env.AZURE_DEVOPS_EXT_PAT = saved;
  }
});

test('names the repair command for each outdated component', () => {
  assert.equal(lineFor({ pointers: [0, 1], hook: 1, board: 1 }), LINE);
  assert.equal(lineFor({ pointers: [1], hook: 0, board: null }), LINE);
  assert.equal(lineFor({ pointers: [1], hook: 1, board: 0 }), 'project state behind: run ado-board states discover');
  assert.equal(lineFor({ pointers: [0], hook: 1, board: 0 }), 'project state behind: run memory-init and ado-board states discover');
  assert.equal(lineFor({ pointers: [1], hook: 1, board: 1 }), null);
});

test('an outdated board map alone asks for ado-board states discover, not memory-init', () => {
  const h = home('1.0.0');
  const dir = project();
  const current = '<!-- engineering-catalog:memory:start v=1 -->\ncurrent\n<!-- engineering-catalog:memory:end -->\n';
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), current);
  fs.writeFileSync(path.join(dir, '.git/hooks/post-commit'), '#!/bin/sh\n# engineering-catalog:memory:start v=1\ncurrent\n# engineering-catalog:memory:end\n');
  fs.writeFileSync(path.join(dir, '.engineering-catalog/ado-board.json'), JSON.stringify({ organization: 'https://dev.azure.com/acme', project: 'Orion', types: {} }));
  const out = run(h, fakeGit([]), ['--quiet'], dir);
  assert.match(out, /^project state behind: run ado-board states discover$/m);
  assert.doesNotMatch(out, /memory-init/);
});
