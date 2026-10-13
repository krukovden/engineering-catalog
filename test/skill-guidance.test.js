'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('git-sync declares its Azure preflight and uses safe base/behind guidance', () => {
  const skill = read('skills/developers/git-sync/SKILL.md');
  assert.match(skill, /requires:\s*\n\s*-\s*ado-credentials/, 'git-sync should declare its Azure preflight');
  assert.doesNotMatch(skill, /git show-ref --verify --quiet refs\/heads\/main && echo "main" \|\| echo "master"/,
    'base detection should not ignore origin/HEAD or origin/main');
  assert.match(skill, /git symbolic-ref(?: --quiet)? --short refs\/remotes\/origin\/HEAD/,
    'base detection should consult the remote default branch');
  assert.doesNotMatch(skill, /local_sha=\$\(git rev-parse refs\/remotes\/origin\/<base> 2>\/dev\/null \|\| git rev-parse HEAD\)/,
    'behind mode should not treat the tracking ref as proof that HEAD is current');
  assert.match(skill, /git merge-base --is-ancestor HEAD origin\/<base>/,
    'behind mode should compare HEAD ancestry against the fetched remote-tracking ref');
  assert.match(skill, /git rev-list --left-right --count HEAD\.\.\.origin\/<base>/,
    'behind mode should count ahead and behind, so a diverged branch still gets a behind count');
  const base = skill.slice(skill.indexOf('**Default to main.**'), skill.indexOf('## Syncing'));
  assert.ok(base.indexOf('refs/remotes/origin/HEAD') < base.indexOf('refs/heads/main'),
    'the remote default branch should win over a local main');
  const safe = skill.slice(skill.indexOf('- **SAFE**'), skill.indexOf('- **KEEP**'));
  assert.doesNotMatch(safe, /\[gone\]/, '[gone] alone must not make a branch SAFE');
  assert.doesNotMatch(safe, /closed/, 'a closed-unmerged PR must not make a branch SAFE');
  assert.match(skill, /- \*\*ASK\*\*:[\s\S]*\[gone\][\s\S]*closed without merging/,
    '[gone] and closed-unmerged branches go to ASK');
  assert.doesNotMatch(skill, /regenerate using local tooling if available/,
    'generated-file conflicts should require regeneration or escalation');
  assert.match(skill, /If regeneration is not possible, classify the conflict as \*\*ASK-USER\*\*\./,
    'generated-file conflicts should escalate when regeneration cannot run');
});

test('git-sync base detection asks the server for its default when origin/HEAD is absent', () => {
  const { execFileSync } = require('child_process');
  const os = require('os');
  const skill = read('skills/developers/git-sync/SKILL.md');
  const section = skill.slice(skill.indexOf('**Default to main.**'), skill.indexOf('## Syncing'));
  const snippet = section.match(/```sh\n([\s\S]*?)```/)[1].replace(/^ {3}/gm, '');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-base-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  try {
    const bare = path.join(root, 'remote.git');
    git(root, 'init', '-q', '--bare', '-b', 'develop', bare);
    const seed = path.join(root, 'seed');
    git(root, 'clone', '-q', bare, seed);
    fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'init');
    git(seed, 'push', '-q', 'origin', 'HEAD:develop', 'HEAD:main');
    const work = path.join(root, 'work');
    git(root, 'clone', '-q', bare, work);
    git(work, 'remote', 'set-head', 'origin', '--delete');
    const base = execFileSync('bash', ['-c', snippet], { cwd: work, env }).toString().trim();
    assert.equal(base, 'develop', 'the server default wins over a common name like main');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('git-sync tidy accepts a completed PR only when it targets the exact base', () => {
  const skill = read('skills/developers/git-sync/SKILL.md');
  const safe = skill.slice(skill.indexOf('- **SAFE**'), skill.indexOf('- **KEEP**'));
  assert.match(safe, /az repos pr list --source-branch <branch> --target-branch <base> --status completed/);
  assert.match(safe, /\[\?targetRefName=='refs\/heads\/<base>'\]\.lastMergeSourceCommit\.commitId/);
  assert.match(safe, /gh pr list --head <branch> --base <base> --state merged/);
  assert.match(safe, /select\(\.baseRefName == "<base>"\)/);
  assert.match(safe, /exactly `refs\/heads\/<base>`/);
});

// A PAT assigned to $env: outlives the command in a persistent PowerShell session unless removed.
for (const rel of ['skills/shared/project-workspace/SKILL.md', 'skills/shared/ado-board/SKILL.md']) {
  test(`${rel}: the Windows PAT snippet removes the PAT in finally`, () => {
    const block = read(rel).match(/```powershell\n([\s\S]*?)```/)[1];
    assert.match(block, /^try \{\n  \$env:AZURE_DEVOPS_EXT_PAT = [^\n]+\n  node [^\n]+\n\} finally \{\n  Remove-Item Env:\\AZURE_DEVOPS_EXT_PAT -ErrorAction SilentlyContinue\n\}\n$/);
  });
}

test('project-workspace runs ado-credentials before any search that may refresh, and falls back to offline copies', () => {
  const skill = read('skills/shared/project-workspace/SKILL.md');
  assert.doesNotMatch(skill, /Copies already on the computer need nothing/);
  assert.match(skill, /Before the first `search` or `ensure` of a session, and before `link-board`, run\s+`ado-credentials`/);
  assert.match(skill, /refresh one already on the computer/);
  assert.match(skill, /does not answer `ok`, do not offer downloads; a `search` may still run over the copies already on\s+the computer, which come back `offline: true`/);
});

test('implementation-discipline stays a developer reference and gives command-specific git safety guidance', () => {
  const skill = read('skills/developers/implementation-discipline/SKILL.md');
  assert.doesNotMatch(skill, /auditing diffs, or reviewing sub-agent reports/i,
    'the description should not broaden this reference into an audit/review skill');
  assert.doesNotMatch(skill, /## 7\. Write Code That Reads Like Prose/,
    'non-spec mandates should not ship in this reference');
  assert.doesNotMatch(skill, /spawnSync\("git", \["checkout", "--", branchName\]\);/,
    'branch switching guidance must not use path checkout');
  assert.match(skill, /git check-ref-format --branch/,
    'git safety guidance should validate branch names');
  assert.match(skill, /git switch/,
    'git safety guidance should use branch-aware switching');
});

test('diagnosing-bugs requires a red loop before the fix, not a committed red commit', () => {
  const skill = read('skills/developers/diagnosing-bugs/SKILL.md');
  assert.doesNotMatch(skill, /Commit an integration test or regression test oracle in a \*\*failing \(red\) state\*\* before the `fix:` or `feat:` commit/,
    'the oracle rule should not require a separate committed red state');
  assert.match(skill, /Get the oracle failing before you apply the fix/,
    'the oracle rule should still require observing the bug before the fix');
});

test('onboard-project is self-contained about branch-policy checks', () => {
  const workflow = read('workflows/shared/onboard-project.md');
  assert.doesNotMatch(workflow, /against the template in `ado-pull-request`/,
    'the onboarding workflow should not rely on a developers-only reference');
  assert.match(workflow, /Check branch policies on `main` against the catalog's recommended baseline/,
    'the workflow should carry its own branch-policy checklist');
});

test('git-sync ships negative trigger cases for its explicit exclusions', () => {
  for (const name of [
    'trigger-not-sync-dirty-tree',
    'trigger-not-sync-on-main',
    'trigger-not-sync-specialized-merge-tool',
  ]) {
    const prompt = read(`evals/git-sync/${name}/prompt.md`);
    assert.match(prompt, /trigger:negative/, `${name} should be a negative trigger case`);
  }
});

test('every Windows PAT snippet clears the variable when the command ends', () => {
  const { execFileSync } = require('child_process');
  const files = execFileSync('git', ['ls-files', 'skills/*SKILL.md'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  let seen = 0;
  for (const rel of files) {
    const text = read(rel);
    for (const m of text.matchAll(/^([ \t]*)\$env:AZURE_DEVOPS_EXT_PAT = & .*get-pat\.ps1.*$/gm)) {
      seen++;
      const after = text.slice(m.index, m.index + 400);
      assert.match(text.slice(Math.max(0, m.index - 40), m.index), /try \{\s*$/, `${rel}: the PAT assignment must sit inside try { }`);
      assert.match(after, /finally \{\s*\n\s*Remove-Item Env:\\AZURE_DEVOPS_EXT_PAT/, `${rel}: finally must remove the PAT`);
    }
  }
  assert.ok(seen >= 5, `expected the PAT snippets to be found, saw ${seen}`);
});
