'use strict';
require('./temp-cleanup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL = path.join(__dirname, '..', 'skills/shared/ado-credentials/SKILL.md');
const CHECK_SH = path.join(__dirname, '..', 'skills/shared/ado-credentials/scripts/check.sh');

// Runs check.sh with only the tools it uses on PATH (a real az, curl or node on the machine must
// not leak in), plus the stubs given: { az, curl, node } are script bodies, or `true` for a
// symlink to the real tool. `env` is added to a scrubbed environment.
function runCheckSh(stubs = {}, { args = [], env = {} } = {}) {
  if (typeof stubs === 'string') stubs = { az: stubs };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-credentials-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const real = (tool) => spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
  for (const tool of ['sh', 'sed', 'head', 'printf', 'cat']) {
    const found = real(tool);
    if (found.startsWith('/')) fs.symlinkSync(found, path.join(bin, tool));
  }
  for (const [tool, body] of Object.entries(stubs)) {
    if (!body) continue;
    const to = path.join(bin, tool);
    if (body === true) fs.symlinkSync(process.execPath, to);
    else { fs.writeFileSync(to, body); fs.chmodSync(to, 0o755); }
  }
  const base = { ...process.env };
  for (const k of ['AZURE_DEVOPS_EXT_PAT', 'ADO_PAT', 'ADO_ORG', 'ADO_PROJECT']) delete base[k];
  const run = spawnSync('sh', [CHECK_SH, ...args], {
    env: { ...base, PATH: bin, STUB_LOG: path.join(dir, 'log'), STUB_DIR: dir, ...env },
    encoding: 'utf8',
  });
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
  return { status: run.status, json: JSON.parse(run.stdout.trim()), argv: read('log'), stdin: read('stdin'), env: read('env') };
}

test('ado-credentials owns the az CLI readiness contract for az-based skills', () => {
  const text = fs.readFileSync(SKILL, 'utf8');
  assert.match(text, /## Azure CLI readiness for `az`-based skills/);
  assert.match(text, /`absent`/);
  assert.match(text, /`present but not logged in`/);
  assert.match(text, /`working`/);
  assert.match(text, /az login/);
  assert.match(text, /az extension add --name azure-devops/);
  assert.match(text, /az devops configure --defaults organization=https:\/\/dev\.azure\.com\/<ORG> project=<PROJECT>/);
});

test('check.sh distinguishes missing az, logged-out az, and a working az session', () => {
  const missing = runCheckSh();
  assert.equal(missing.status, 3);
  assert.equal(missing.json.outcome, 'absent');
  assert.match(missing.json.detail, /az CLI not installed/);

  const loggedOut = runCheckSh(`#!/usr/bin/env sh
case "$1 $2 $3" in
  "account show -o") exit 1 ;;
  *) exit 0 ;;
esac
`);
  assert.equal(loggedOut.status, 3);
  assert.equal(loggedOut.json.outcome, 'absent');
  assert.match(loggedOut.json.detail, /not logged in to az/);

  const working = runCheckSh(`#!/usr/bin/env sh
case "$1 $2 $3 $4" in
  "account show -o none") exit 0 ;;
  "extension show --name azure-devops") exit 0 ;;
  "devops configure --list ")
    printf 'organization = https://dev.azure.com/ORG\nproject = PROJ\n'
    exit 0
    ;;
  "devops project show --project")
    exit 0
    ;;
  *) exit 0 ;;
esac
`);
  assert.equal(working.status, 0);
  assert.equal(working.json.outcome, 'ok');
  assert.match(working.json.detail, /^sign-in works for https:\/\/dev\.azure\.com\/ORG \/ PROJ; permissions are checked when a skill first uses them$/);
});

const CHECK_PS1 = path.join(__dirname, '..', 'skills/shared/ado-credentials/scripts/check.ps1');
const PWSH = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;

test('check.ps1 carries the same az probe as check.sh, with identical detail and step text', () => {
  const ps1 = fs.readFileSync(CHECK_PS1, 'utf8');
  const sh = fs.readFileSync(CHECK_SH, 'utf8');
  const shown = [
    'az CLI not installed', 'not logged in to az', 'azure-devops extension missing', 'no default organization/project',
    'Install the Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli',
    'Then run: az login', 'Then run: az extension add --name azure-devops',
    'Run: az login  (or: az login --use-device-code)', 'Then re-run this check',
    'Run: az extension add --name azure-devops',
    'Run: az devops configure --defaults organization=https://dev.azure.com/<ORG> project=<PROJECT>',
  ];
  for (const text of shown) {
    assert.ok(sh.includes(text), `check.sh lacks: ${text}`);
    assert.ok(ps1.includes(text), `check.ps1 lacks: ${text}`);
  }
  const probe = ps1.indexOf('Test-AzReady', ps1.indexOf('function Test-AzReady') + 1);
  assert.ok(probe > 0 && probe < ps1.indexOf('Out-Result "ok" "sign-in works for'), 'the az probe runs before the ok result');
});

test('check.ps1 probes az only for callers that pass -RequireAz', () => {
  const ps1 = fs.readFileSync(CHECK_PS1, 'utf8');
  assert.match(ps1, /param\(\[string\]\$ContextName, \[switch\]\$RequireAz\)/);
  assert.match(ps1, /\$az = if \(\$RequireAz\) \{ Test-AzReady \} else \{ \$null \}/);
  for (const rel of ['skills/developers/ado-branch/SKILL.md', 'skills/developers/ado-pull-request/SKILL.md', 'skills/developers/git-sync/SKILL.md']) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'), /-RequireAz/, `${rel} runs az and must ask for it`);
  }
  for (const rel of ['skills/qa/qa-ado-work-item/SKILL.md', 'skills/shared/ado-board/SKILL.md']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'), /-RequireAz/, `${rel} is REST-only`);
  }
});

test('check.ps1 reports absent, not ok, when the PAT works but az is missing (pwsh)', { skip: !PWSH && 'pwsh not installed' }, () => {
  // Dot-source only the probe so no PAT or network is needed; PATH holds no az.
  const src = fs.readFileSync(CHECK_PS1, 'utf8');
  const start = src.indexOf('function Test-AzReady');
  const end = src.indexOf('# Even the platform refusal');
  const run = spawnSync('pwsh', ['-NoProfile', '-Command', `$env:PATH = ''; ${src.slice(start, end)}; (Test-AzReady) | ConvertTo-Json -Compress`], { encoding: 'utf8' });
  assert.match(run.stdout, /az CLI not installed/);
});

// --- check.sh with a PAT (the REST/git-only callers need no az) --------------------------

const PAT = 'pat-SECRET-1234567890';
// A stub that logs every argument, its stdin and whether it saw the PAT in its env, then answers.
const stub = (answer) => `#!/usr/bin/env sh
printf '%s\\n' "$0" "$@" >> "$STUB_LOG"
cat > "$STUB_DIR/stdin"
[ -n "\${ADO_CHECK_PAT:-}" ] && printf '%s' "$ADO_CHECK_PAT" > "$STUB_DIR/env"
${answer}
`;
const curlAnswers = (body, code) => stub(`printf '%s\\n%s\\n' '${body}' '${code}'`);
const AZ_READY = `#!/usr/bin/env sh
case "$1 $2" in
  "devops configure") printf 'organization = https://dev.azure.com/AzOrg\\nproject = AzProj\\n' ;;
esac
exit 0
`;

test('check.sh: a working PAT is ok without az, and reaches curl only through stdin', () => {
  const r = runCheckSh({ curl: curlAnswers('{"count":1,"value":[]}', 200) }, { args: ['--org', 'https://dev.azure.com/ORG/'], env: { AZURE_DEVOPS_EXT_PAT: PAT } });
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.equal(r.json.outcome, 'ok');
  assert.equal(r.json.detail, 'sign-in works for https://dev.azure.com/ORG; permissions are checked when a skill first uses them');
  assert.ok(r.argv.includes('https://dev.azure.com/ORG/_apis/projects?$top=1&api-version=7.1'), r.argv);
  assert.ok(!r.argv.includes(PAT), 'the PAT is never in argv');
  assert.match(r.stdin, new RegExp(`user = ":${PAT}"`));
});

test('check.sh: a rejected PAT is expired; no answer is error; plain steps', () => {
  const env = { ADO_PAT: PAT, ADO_ORG: 'ORG' };
  for (const [body, code] of [['', 401], ['<html>Sign in</html>', 200], ['', 203]]) {
    const r = runCheckSh({ curl: curlAnswers(body, code) }, { env });
    assert.equal(r.status, 4, `${code}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.outcome, 'expired');
    assert.match(r.json.steps.join(' '), /Personal access tokens -> New Token/);
    assert.match(r.json.steps.join(' '), /ADO_PAT/);
    assert.ok(!JSON.stringify(r.json).includes(PAT));
  }
  const down = runCheckSh({ curl: stub(`echo 'curl: (6) Could not resolve host' >&2; printf '\\n000\\n'; exit 6`) }, { env });
  assert.equal(down.status, 1);
  assert.equal(down.json.outcome, 'error');
  assert.match(down.json.detail, /could not reach https:\/\/dev\.azure\.com\/ORG: curl: \(6\)/);
});

test('check.sh: without curl, node carries the PAT in its env, never in argv', () => {
  const r = runCheckSh({ node: stub(`printf '{"count":0}\\n200\\n'`) }, { args: ['--org', 'ORG'], env: { AZURE_DEVOPS_EXT_PAT: PAT } });
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.equal(r.json.outcome, 'ok');
  assert.ok(!r.argv.includes(PAT), 'the PAT is never in argv');
  assert.equal(r.env, PAT);
  // The real node probe parses and reports an unreachable organization as error (no network used).
  const real = runCheckSh({ node: true }, { args: ['--org', 'https://127.0.0.1.visualstudio.com'], env: { AZURE_DEVOPS_EXT_PAT: PAT } });
  assert.equal(real.json.outcome, 'error', JSON.stringify(real.json));
  assert.match(real.json.detail, /not an Azure DevOps organization URL|could not reach/);
});

test('check.sh: the PAT is never sent over http or to a non-Azure DevOps host', () => {
  for (const org of [
    'https://attacker.example', 'http://dev.azure.com/ORG', 'https://dev.azure.com', 'https://dev.azure.com/',
    'https://dev.azure.com@attacker.example/ORG', 'https://attacker.example/x.visualstudio.com', 'https://evil.com/dev.azure.com/ORG',
    'https://dev.azure.com.attacker.example/ORG', 'https://a.visualstudio.com.attacker.example', 'https://a.b.visualstudio.com',
  ]) {
    const r = runCheckSh({ curl: curlAnswers('{"count":1}', 200) }, { args: ['--org', org], env: { AZURE_DEVOPS_EXT_PAT: PAT } });
    assert.deepEqual([r.json.outcome, r.json.detail], ['error', 'not an Azure DevOps organization URL'], org);
    assert.equal(r.argv, '', `no request for ${org}`);
    assert.equal(r.stdin, '', `PAT not sent for ${org}`);
  }
  for (const org of ['https://dev.azure.com/ORG/proj', 'HTTPS://Dev.Azure.com/ORG', 'https://ORG.visualstudio.com', 'https://org.visualstudio.com/DefaultCollection']) {
    const r = runCheckSh({ curl: curlAnswers('{"count":1}', 200) }, { args: ['--org', org], env: { AZURE_DEVOPS_EXT_PAT: PAT } });
    assert.equal(r.json.outcome, 'ok', `${org}: ${JSON.stringify(r.json)}`);
  }
});

test('check.sh: a PAT with no organization asks for --org; the az default fills it when present', () => {
  const none = runCheckSh({ curl: curlAnswers('{"count":1}', 200) }, { env: { AZURE_DEVOPS_EXT_PAT: PAT } });
  assert.equal(none.status, 3);
  assert.deepEqual(none.json, { outcome: 'absent', detail: 'no organization to check the PAT against', steps: ['Re-run with --org https://dev.azure.com/<ORG>'] });
  const fromAz = runCheckSh({ curl: curlAnswers('{"count":1}', 200), az: AZ_READY }, { env: { AZURE_DEVOPS_EXT_PAT: PAT } });
  assert.equal(fromAz.json.detail, 'sign-in works for https://dev.azure.com/AzOrg; permissions are checked when a skill first uses them');
});

test('check.sh --require-az: a working PAT still needs a ready az', () => {
  const opts = { args: ['--org', 'ORG', '--require-az'], env: { AZURE_DEVOPS_EXT_PAT: PAT } };
  const noAz = runCheckSh({ curl: curlAnswers('{"count":1}', 200) }, opts);
  assert.equal(noAz.status, 3);
  assert.equal(noAz.json.outcome, 'absent');
  assert.equal(noAz.json.missing, 'az');
  assert.match(noAz.json.detail, /az CLI not installed/);
  const ready = runCheckSh({ curl: curlAnswers('{"count":1}', 200), az: AZ_READY }, opts);
  assert.equal(ready.status, 0, JSON.stringify(ready.json));
  assert.equal(ready.json.outcome, 'ok');
});

test('callers that run az pass --require-az to check.sh; REST-only callers do not', () => {
  for (const rel of ['skills/developers/ado-branch/SKILL.md', 'skills/developers/ado-pull-request/SKILL.md', 'skills/developers/git-sync/SKILL.md']) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'), /--require-az/, `${rel} runs az and must ask for it`);
  }
  for (const rel of ['skills/qa/qa-ado-work-item/SKILL.md', 'skills/shared/ado-board/SKILL.md', 'skills/shared/project-workspace/SKILL.md', 'skills/shared/catalog-feedback/SKILL.md', 'skills/shared/ado-backlog-placement/SKILL.md', 'skills/developers/ado-pr-feedback/SKILL.md']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'), /--require-az/, `${rel} is REST-only`);
  }
});

test('every ado.js copy refuses to send the credential outside Azure DevOps over https', async () => {
  const files = ['developers/ado-pr-feedback', 'shared/ado-board', 'shared/ado-backlog-placement', 'shared/catalog-feedback', 'shared/project-workspace']
    .map((d) => path.join(__dirname, '..', 'skills', d, 'scripts', 'ado.js'));
  for (const f of files) {
    const ado = require(f);
    let sent = 0;
    const stub = async () => { sent++; return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}' }; };
    const call = (url) => (/opts = \{\}/.test(ado.request.toString())
      ? ado.request({ header: 'Basic x' }, 'GET', url, undefined, { fetch: stub })
      : ado.request({ header: 'Basic x' }, 'GET', url, undefined, stub));
    for (const url of ['https://attacker.example/_apis/x', 'http://dev.azure.com/o/_apis/x', 'https://dev.azure.com@attacker.example/o', 'https://dev.azure.com.attacker.example/o'])
      await assert.rejects(call(url), /not an Azure DevOps organization URL/, `${f} ${url}`);
    assert.equal(sent, 0, f);
    await call('https://dev.azure.com/o/_apis/x').catch(() => {});
    await call('https://o.visualstudio.com/_apis/x').catch(() => {});
    assert.equal(sent, 2, f);
  }
});
