'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skills/developers/ado-pull-request/scripts/parse-branch.js');
const SKILL = path.join(__dirname, '..', 'skills/developers/ado-pull-request/SKILL.md');
const UPDATE_REF = path.join(__dirname, '..', 'skills/developers/ado-pull-request/references/pr-update.md');
const POLICY_REF = path.join(__dirname, '..', 'skills/developers/ado-pull-request/references/branch-policy-template.md');
const { parseBranch } = require(SCRIPT);
const cli = (...args) => execFileSync('node', [SCRIPT, ...args]).toString().trim();

function prPrelude() {
  const text = fs.readFileSync(SKILL, 'utf8');
  const block = text.match(/```sh\n([\s\S]*?)```/g).find((candidate) => candidate.includes('az repos pr create'));
  const body = block.replace(/^```sh\n|\n```$/g, '');
  const lines = body.split('\n');
  return lines.slice(0, lines.findIndex((line) => line.trimStart().startsWith('az repos pr create'))).join('\n');
}

// `head` is HEAD when the snippet runs, `remoteHead` the server's tip; the local tracking ref
// always claims the reviewed commit, so only a real ls-remote check can catch a drift.
function runCreatePrelude({ remoteExists = true, pushOk = true, head = 'reviewed-sha', remoteHead = 'reviewed-sha' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-pr-snippet-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash
case "$*" in
  "branch --show-current")
    echo "feature/ADO-12345-sample"
    ;;
  "rev-parse HEAD")
    echo "${head}"
    ;;
  "rev-parse --verify --quiet refs/remotes/origin/feature/ADO-12345-sample")
    exit ${remoteExists ? 0 : 1}
    ;;
  "push origin feature/ADO-12345-sample"|"push -u origin feature/ADO-12345-sample")
    echo "fixture: push reached"
    ${pushOk ? 'exit 0' : 'echo "fixture: push rejected" >&2\n    exit 1'}
    ;;
  "rev-parse refs/remotes/origin/feature/ADO-12345-sample")
    echo "reviewed-sha"
    ;;
  "ls-remote origin refs/heads/feature/ADO-12345-sample")
    printf '%s\trefs/heads/feature/ADO-12345-sample\n' "${remoteHead}"
    ;;
  *)
    echo "unexpected git invocation: $*" >&2
    exit 99
    ;;
esac
`);
  fs.writeFileSync(path.join(bin, 'az'), '#!/usr/bin/env bash\necho "fixture: ADO create reached"\n');
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  fs.chmodSync(path.join(bin, 'az'), 0o755);
  const script = `${prPrelude().replace('<REVIEWED_SHA>', 'reviewed-sha')}\naz repos pr create\n`;
  return spawnSync('bash', ['-c', script], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
}

test('parseBranch maps the convention to release-note types', () => {
  assert.deepEqual(parseBranch('feature/ADO-103520-x'), { type: 'feat', id: '103520' });
  assert.deepEqual(parseBranch('bug/ADO-103533-export-empty-file'), { type: 'fix', id: '103533' });
  assert.deepEqual(parseBranch('feature/ADO-42'), { type: 'feat', id: '42' });
  assert.equal(parseBranch('main'), null);
  assert.equal(parseBranch('feature/no-id-here'), null);
  assert.equal(parseBranch('hotfix/ADO-1-x'), null);
  assert.equal(parseBranch('feature/ADO-1x-y'), null);
});

test('CLI: parse, null outside the convention, usage without a branch', () => {
  assert.deepEqual(JSON.parse(cli('feature/ADO-103520-x')), { type: 'feat', id: '103520' });
  assert.equal(cli('main'), 'null');
  assert.throws(() => execFileSync('node', [SCRIPT], { stdio: 'pipe' }), /usage/);
});

// The convention lives in two self-contained skills (invariant 3 forbids sharing a file):
// ado-branch writes the name, ado-pull-request reads it. This keeps the two in step.
test('a name computed by ado-branch is parsed by ado-pull-request', () => {
  const { branchName } = require(path.join(__dirname, '..', 'skills/developers/ado-branch/scripts/branch-name.js'));
  assert.deepEqual(parseBranch(branchName({ type: 'Bug', id: 103533, title: 'Export: empty file' })), { type: 'fix', id: '103533' });
  assert.deepEqual(parseBranch(branchName({ type: 'Product Backlog Item', id: 103520, title: 'Add CSV export' })), { type: 'feat', id: '103520' });
  assert.deepEqual(parseBranch(branchName({ type: 'Task', id: 42, title: '!!!' })), { type: 'feat', id: '42' });
});

test('ado-pull-request documents negative boundaries, az readiness, and push verification', () => {
  const text = fs.readFileSync(SKILL, 'utf8');
  assert.match(text, /## When NOT to use/);
  assert.match(text, /reviewing someone else's PR/i);
  assert.match(text, /what squash merge means/i);
  assert.match(text, /That\s+preflight also owns the Azure CLI\s+readiness for this skill/);
  assert.doesNotMatch(text, /command -v az/);
  assert.doesNotMatch(text, /az account show -o none/);
  assert.doesNotMatch(text, /az extension show --name azure-devops -o none/);
  assert.doesNotMatch(text, /az devops configure --list/);
  assert.match(text, /always push the current branch after approval/i);
  assert.match(text, /verify the remote tip equals the reviewed HEAD/i);
  assert.match(text, /git push origin "\$branch" \|\| exit 1/);
  assert.match(text, /git push -u origin "\$branch" \|\| exit 1/);
  assert.match(text, /\[ "\$\(git ls-remote origin "refs\/heads\/\$branch" \| cut -f1\)" = "\$reviewed" \] \|\| \{ echo "remote branch does not match the reviewed commit"; exit 1; \}/);
  const step7 = text.slice(text.indexOf('7. **Show it'), text.indexOf('8. **Create it'));
  assert.ok(step7.indexOf('git rev-parse HEAD') > -1 && step7.indexOf('git rev-parse HEAD') < step7.indexOf('wait for two explicit answers'),
    'the reviewed SHA is saved when the review finishes, before approval is asked');
  assert.doesNotMatch(text, /reviewed="\$\(git rev-parse HEAD\)"/, 'HEAD at push time is not the reviewed commit');
});

test('the PR snippet stops before az repos pr create when push fails', () => {
  const run = runCreatePrelude({ pushOk: false, remoteHead: 'reviewed-sha' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /fixture: push rejected/);
  assert.doesNotMatch(run.stdout + run.stderr, /fixture: ADO create reached/);
});

test('the PR snippet stops before az repos pr create when the remote tip drifted', () => {
  const run = runCreatePrelude({ pushOk: true, remoteHead: 'other-sha' });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /remote branch does not match the reviewed commit/);
  assert.doesNotMatch(run.stdout + run.stderr, /fixture: ADO create reached/);
});

test('the PR snippet pushes and reaches az repos pr create when HEAD and the server tip are the reviewed commit', () => {
  const run = runCreatePrelude();
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /fixture: push reached/);
  assert.match(run.stdout, /fixture: ADO create reached/);
});

test('the PR snippet does not push a commit added after the review', () => {
  const run = runCreatePrelude({ head: 'later-sha' });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /HEAD moved since the review/);
  assert.doesNotMatch(run.stdout + run.stderr, /fixture: push reached|fixture: ADO create reached/);
});

test('pr-update reads the PR first, diffs its real refs, and preserves user text', () => {
  const text = fs.readFileSync(UPDATE_REF, 'utf8');
  assert.match(text, /az repos pr show --id <id> -o json/);
  assert.match(text, /sourceRefName/);
  assert.match(text, /targetRefName/);
  assert.match(text, /use the PR's real source and target refs/i);
  assert.match(text, /Preserve user-written details from the current title\/body that are still true/);
});

test('branch policy template covers both artifact stores and deployment of stored versions', () => {
  const text = fs.readFileSync(POLICY_REF, 'utf8');
  assert.match(text, /stores it both in blob and as pipeline\s+artifacts/i);
  assert.match(text, /deploys any stored version forward or backward/i);
});
