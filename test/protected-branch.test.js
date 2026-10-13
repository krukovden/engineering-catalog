'use strict';
require('./temp-cleanup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { decide, isGitCommit, stripHeredocBodies, targets } = require('../hooks/protected-branch.js');

test('git global options with a separate argument still detect a commit', () => {
  for (const c of [
    'git -c user.name=x commit -m m',
    'git -c "a=b c" commit -m m',
    'git -C /tmp/r commit -m m',
    'git --git-dir /tmp/r/.git commit -m m',
    'git --work-tree /tmp/r commit -m m',
    'git --namespace ns -c a=b -C . commit',
    'git --exec-path=/x --git-dir=/y commit',
  ]) assert.ok(isGitCommit(c), c);
  for (const c of [
    'command git commit -m m',
    'GIT_AUTHOR_DATE=2020-01-01 git commit -m m',
    'A=1 B="x y" env git commit',
    'sudo git commit',
    'echo hi && X= git commit',
    '/usr/bin/git commit -m m',
    'C:\\Git\\cmd\\git.exe commit',
    './bin/git -C r commit',
    'if true; then git commit -m x; fi',
    'while x; do git commit; done',
    '! git commit',
    "'git' commit -m x",
    '"/usr/bin/git" commit',
    'git -C/r commit',
    'g\\it commit -m x',
    "gi''t commit",
    'echo "a" ; git commit',
    'echo "$(git commit -m x)"',
    'g"i"t commit -m x',
    '"gi"t commit',
    'env -u UNUSED git commit -m x',
    'sudo -u root git commit',
    'time -p git commit',
    'env -i A=1 nice -n 5 git commit',
    'case x in x) git commit -m x;; esac',
    'GIT.EXE commit',
    'echo "`git commit -m x`"',
    'x=`git commit`',
    'echo $(git commit)',
    '{ git commit; }',
    'f() { git commit -m x; }; f',
  ]) assert.ok(isGitCommit(c), c);
  assert.ok(!isGitCommit('command git status'));
  assert.ok(!isGitCommit('/usr/bin/legit commit'));
  // Text that only looks like a command: quoted, escaped, or commented out.
  assert.ok(!isGitCommit('echo "example; git commit -m x"'));
  assert.ok(!isGitCommit("echo 'a && git commit'"));
  assert.ok(!isGitCommit("echo '$(git commit)'"));
  assert.ok(!isGitCommit('echo $(ls) git commit'));
  assert.ok(!isGitCommit('gitx commit'));
  assert.ok(!isGitCommit('echo commit'));
  assert.ok(!isGitCommit('echo "$(ls) ; git commit"'));
  assert.ok(!isGitCommit('echo a\\; git commit'));
  assert.ok(!isGitCommit('ls # ; git commit'));
  assert.ok(isGitCommit('ls # x\ngit commit'));
  assert.ok(!isGitCommit('git -c a=b status'));
  assert.ok(!isGitCommit('git -c a=b log --grep commit'));
});

test('the commit regex does not backtrack exponentially', () => {
  const t0 = Date.now();
  isGitCommit(`git ${'-C a '.repeat(30)}status`);
  isGitCommit(`git ${'-x '.repeat(30)}status`);
  isGitCommit(`${'A=1 '.repeat(30)}${'env '.repeat(30)}git status`);
  isGitCommit(`${'A=b=c '.repeat(30)}x`);
  isGitCommit(`${'a/'.repeat(5000)}gitx commit`);
  isGitCommit(`${"\\''".repeat(3000)}x commit`);
  isGitCommit(`env ${'-a b '.repeat(3000)}x`);
  isGitCommit(`${'env -i '.repeat(3000)}x`);
  isGitCommit(`${'"a"'.repeat(5000)} x`);
  assert.ok(Date.now() - t0 < 500);
});

test('heredoc ends only on a line equal to the delimiter', () => {
  const body = (end) => `cat <<EOF\nEOFX\n  EOF\ngit commit -m x\n${end}`;
  assert.ok(!isGitCommit(body('')));
  assert.ok(!isGitCommit(body('EOF')) === true);
  assert.ok(isGitCommit(`${body('EOF')}\ngit commit -m y`));
  assert.ok(!isGitCommit('cat <<EOF\nEOF.txt\ngit commit\n'));
  assert.ok(isGitCommit('cat <<EOF\nEOF\ngit commit\n'));
  assert.ok(isGitCommit('cat <<\\EOF\nbody\nEOF\ngit commit\n'));
  assert.ok(isGitCommit('cat <<E\\OF\nbody\nEOF\ngit commit\n'));
});

test('heredoc: <<- strips leading tabs only; quoted delimiters; here-strings', () => {
  assert.ok(isGitCommit('cat <<-EOF\n\tgit commit\n\tEOF\ngit commit'));
  assert.ok(!isGitCommit('cat <<-EOF\n\tgit commit\n\tEOF\n'));
  assert.ok(!isGitCommit('cat <<EOF\n\tEOF\ngit commit\n'));
  assert.ok(!isGitCommit("cat <<'END-1'\ngit commit\nEND-1\n"));
  assert.ok(!isGitCommit('cat <<"a b"\ngit commit\na b\n'));
  assert.ok(isGitCommit('cat <<<EOF\ngit commit'));
});

test('stripHeredocBodies keeps the command line itself', () => {
  assert.strictEqual(stripHeredocBodies('cat <<EOF\nx\nEOF\necho hi'), 'cat <<EOF\necho hi');
});

test('targets resolves the repository from the command', () => {
  const base = path.resolve('/w');
  assert.deepStrictEqual(targets('git commit', base), [{ cwd: base, gitArgs: [] }]);
  assert.strictEqual(targets('git -C sub commit', base)[0].cwd, path.resolve(base, 'sub'));
  assert.strictEqual(targets('git -Csub commit', base)[0].cwd, path.resolve(base, 'sub'));
  assert.strictEqual(targets('cd /r && git commit', base)[0].cwd, path.resolve('/r'));
  assert.strictEqual(targets('cd a; cd b && git -C c commit', base)[0].cwd, path.resolve(base, 'a/b/c'));
  assert.strictEqual(targets('cd a; git commit', base)[0].cwd, path.resolve(base, 'a'));
  assert.strictEqual(targets('cd a&&git commit', base)[0].cwd, path.resolve(base, 'a'));
  assert.strictEqual(targets('(cd a)|git commit', base)[0].cwd, base);
  assert.strictEqual(targets('(cd a && true); git commit', base)[0].cwd, base);
  assert.strictEqual(targets('(cd a && git commit)', base)[0].cwd, path.resolve(base, 'a'));
  assert.strictEqual(targets('cd a && cd - && git commit', base), null);
  assert.strictEqual(targets('cd a; cd && git commit', base), null);
  // A cd not followed by && may fail, and the commit then runs where the shell already was.
  const dirs = (c) => targets(c, base).map((t) => t.cwd).sort();
  // `cd x || git commit` commits only when the cd failed: never in x.
  assert.deepStrictEqual(dirs('cd nope || git commit'), [base]);
  assert.deepStrictEqual(dirs('cd a || true && git commit'), [base, path.resolve(base, 'a')].sort());
  assert.deepStrictEqual(dirs('cd a; git commit'), [base, path.resolve(base, 'a')].sort());
  assert.deepStrictEqual(dirs('cd a && git commit'), [path.resolve(base, 'a')]);
  assert.deepStrictEqual(dirs('cd nope && true || git commit'), [base, path.resolve(base, 'nope')].sort());
  assert.deepStrictEqual(dirs('X=1 command git commit'), [base]);
  assert.deepStrictEqual(targets('GIT_DIR=/g/.git git commit', base)[0].gitArgs, [`--git-dir=${path.resolve('/g/.git')}`]);
  assert.deepStrictEqual(targets('env GIT_WORK_TREE=wt git -C sub commit', base)[0].gitArgs, [`--work-tree=${path.resolve(base, 'sub/wt')}`]);
  assert.deepStrictEqual(targets('GIT_DIR=/e git --git-dir=/o commit', base)[0].gitArgs, [`--git-dir=${path.resolve('/o')}`]);
  assert.strictEqual(targets('GIT_DIR=$X git commit', base), null);
  assert.deepStrictEqual(targets('git --git-dir=/g/.git commit', base)[0].gitArgs, [`--git-dir=${path.resolve('/g/.git')}`]);
  assert.strictEqual(targets('git -c "a=b c" commit', base)[0].cwd, base);
  assert.strictEqual(targets('cd "$X" && git commit', base), null);
  assert.strictEqual(targets('git -C ~/r commit', base), null);
  assert.deepStrictEqual(targets('git -C commit', base), []);
});

function repo(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  fs.mkdirSync(path.join(dir, '.engineering-catalog'));
  fs.writeFileSync(path.join(dir, '.engineering-catalog', 'receipt.json'), '{}');
  return dir;
}

test('decision follows -C, --git-dir and cd, not the tool cwd', () => {
  const hook = path.join(__dirname, '..', 'hooks', 'protected-branch.js');
  const run = (command, cwd) => execFileSync('node', [hook], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }), encoding: 'utf8',
  });
  const main = repo('main');
  const feat = repo('feature/x');
  try {
    assert.match(run(`git -C ${main} commit -m x`, feat), /deny/);
    assert.match(run(`git -C${main} commit -m x`, feat), /deny/);
    assert.match(run("'git' commit -m x", main), /deny/);
    assert.match(run('g\\it commit -m x', main), /deny/);
    assert.strictEqual(run('echo "example; git commit -m x"', main), '');
    assert.match(run('echo "$(git commit -m x)"', main), /deny/);
    assert.match(run('echo "`git commit -m x`"', main), /deny/);
    assert.match(run('g"i"t commit -m x', main), /deny/);
    assert.match(run('env -u UNUSED git commit -m x', main), /deny/);
    assert.match(run('case x in x) git commit -m x;; esac', main), /deny/);
    assert.match(run(`cd "${feat}" ; echo "x;y" && git -C "${main}" commit`, feat), /deny/);
    assert.match(run(`cd ${main} && git commit -m x`, feat), /deny/);
    assert.match(run(`git --git-dir ${main}/.git -c a=b commit -m x`, feat), /deny/);
    assert.strictEqual(run(`git -C ${feat} commit -m x`, main), '');
    assert.strictEqual(run(`cd ${feat} && git commit -m x`, main), '');
    assert.strictEqual(run('cd "$NOPE" && git commit -m x', main), '');
    assert.match(run('git -c a=b commit -m x', main), /deny/);
    // A failed cd falls through to the protected repository the shell is still in.
    assert.match(run(`cd ${main}/missing || git commit -m x`, main), /deny/);
    assert.match(run(`cd ${main}/missing; git commit -m x`, main), /deny/);
    assert.strictEqual(run(`cd ${main}/missing && git commit -m x`, feat), '');
    assert.match(run(`cd ${feat}/missing && true || git commit -m x`, main), /deny/);
    assert.match(run('command git commit -m x', main), /deny/);
    assert.match(run(`GIT_DIR=${main}/.git git commit -m x`, feat), /deny/);
    assert.match(run('if true; then git commit -m x; fi', main), /deny/);
    assert.match(run('/opt/tools/git commit -m x', main), /deny/);
    assert.strictEqual(run(`cd ${main} || git commit -m x`, feat), '');
    assert.match(run(`cd ${feat}/missing || git commit -m x`, main), /deny/);
    assert.match(run('GIT_AUTHOR_DATE=2020-01-01 git commit -m x', main), /deny/);
  } finally {
    fs.rmSync(main, { recursive: true, force: true });
    fs.rmSync(feat, { recursive: true, force: true });
  }
});

// A git stub: `aliases` maps a name to its configured value, `branch` is HEAD everywhere, and the
// repository carries a receipt only when `governed`. Every alias lookup is recorded.
function stubGit({ aliases = {}, branch = 'main', top = '/r' } = {}) {
  const calls = [];
  const run = (cwd, gitArgs, ...args) => {
    calls.push({ cwd, gitArgs, args });
    if (args[0] === 'config' && args[2].startsWith('alias.')) {
      const v = aliases[args[2].slice(6)];
      if (v === undefined) throw new Error('unset');
      return v;
    }
    if (args[0] === 'config') return 'https://dev.azure.com/o/p/_git/r';
    if (args[0] === 'symbolic-ref') return branch;
    return top;
  };
  run.lookups = () => calls.filter((c) => c.args[0] === 'config' && c.args[2].startsWith('alias.'));
  run.calls = calls;
  return run;
}
const bash = (command, cwd = '/r') => ({ tool_name: 'Bash', tool_input: { command }, cwd });

test('a git alias that expands to commit is a commit', () => {
  assert.ok(isGitCommit('git -c alias.ci=commit ci -m x'));
  assert.ok(isGitCommit('git -c "alias.ci=commit -m x" ci'));
  assert.ok(isGitCommit('git -c alias.CI=commit CI'));
  assert.ok(isGitCommit('git -c alias.a=b -c alias.b=commit a'));
  assert.ok(isGitCommit("git -c 'alias.ci=!git commit -m x' ci"));
  assert.ok(!isGitCommit("git -c 'alias.ci=!echo commit' ci"));
  assert.ok(!isGitCommit('git -c alias.ci=status ci'));
  // git never lets an alias shadow a built-in.
  assert.ok(!isGitCommit('git -c alias.status=commit status'));
  assert.ok(!isGitCommit('git commit-tree HEAD^{tree}'));
  const run = stubGit({ aliases: { ci: 'commit' } });
  assert.match(decide(bash('git -c alias.ci=commit ci -m x'), false, { git: run }), /^WHAT: /);
  assert.strictEqual(run.lookups().length, 0);
});

test('a repository alias is looked up in the repository the command runs in', () => {
  const run = stubGit({ aliases: { ci: 'commit' } });
  assert.match(decide(bash('cd /other && git ci -m x'), false, { git: run }), /^WHAT: /);
  assert.deepStrictEqual(run.lookups().map((c) => [c.cwd, c.args[2]]), [[path.resolve('/other'), 'alias.ci']]);
  const chained = stubGit({ aliases: { a: 'b', b: ' -c x=y c', c: 'commit --amend' } });
  assert.match(decide(bash('git a'), false, { git: chained }), /^WHAT: /);
  assert.strictEqual(chained.lookups().length, 3);
  const deep = stubGit({ aliases: { a1: 'a2', a2: 'a3', a3: 'a4', a4: 'a5', a5: 'a6', a6: 'commit' } });
  assert.strictEqual(decide(bash('git a1'), false, { git: deep }), null);
  assert.strictEqual(deep.lookups().length, 5);
  const loop = stubGit({ aliases: { a: 'b', b: 'a' } });
  assert.strictEqual(decide(bash('git a'), false, { git: loop }), null);
  assert.match(decide(bash('git ci'), false, { git: stubGit({ aliases: { ci: '!git add . && git commit -m wip' } }) }), /^WHAT: /);
  assert.match(decide(bash('git ci'), false, { git: stubGit({ aliases: { ci: '!f() { git commit "$@"; }; f' } }) }), /^WHAT: /);
  assert.strictEqual(decide(bash('git hi'), false, { git: stubGit({ aliases: { hi: '!echo git commit' } }) }), null);
  assert.strictEqual(decide(bash('git st'), false, { git: stubGit({ aliases: { st: 'status' } }) }), null);
  assert.strictEqual(decide(bash('git ci'), false, { git: stubGit({ aliases: { ci: 'commit' }, branch: 'feature/x' }) }), null);
});

test('built-ins and unresolvable targets spawn no alias lookup', () => {
  const run = stubGit();
  for (const c of ['git status', 'git -C sub log --oneline', 'git push origin HEAD', 'git add . && git diff',
    'git cherry-pick x', 'git stash pop', 'echo ci', 'cd "$X" && git ci']) {
    assert.strictEqual(decide(bash(c), false, { git: run }), null, c);
  }
  assert.deepStrictEqual(run.calls, []);
  // Lookups are cached per repository and capped per run, so a long command stays bounded.
  const many = stubGit();
  decide(bash(Array.from({ length: 50 }, () => 'git ci').join('; ')), false, { git: many });
  assert.strictEqual(many.lookups().length, 1);
  const distinct = stubGit();
  const t0 = Date.now();
  decide(bash(Array.from({ length: 200 }, (_, i) => `git x${i}`).join('; ')), false, { git: distinct });
  assert.ok(distinct.lookups().length <= 8);
  assert.ok(Date.now() - t0 < 500);
});

test('a non-git command does not hide the git commit after it', () => {
  assert.ok(isGitCommit('ls -la\ngit commit'));
  assert.ok(isGitCommit('ls -la;git commit'));
  const t0 = Date.now();
  isGitCommit(`${'x -a '.repeat(3000)}y`);
  isGitCommit(`${'x y;'.repeat(3000)}z`);
  isGitCommit(`git ${'-c a=b '.repeat(3000)}`);
  assert.ok(Date.now() - t0 < 500);
});

test('Windows paths resolve on Windows or under PowerShell and fail open elsewhere', () => {
  const win = { shell: 'bash', platform: 'win32', win: true };
  const pwsh = { shell: 'powershell', platform: 'darwin', win: true };
  const posix = { shell: 'bash', platform: 'linux', win: false };
  const base = 'C:\\w';
  const cwd = (c, ctx) => { const t = targets(c, base, ctx); return t && t.map((x) => x.cwd); };
  assert.deepStrictEqual(cwd('git -C C:\\work\\repo commit', pwsh), ['C:\\work\\repo']);
  assert.deepStrictEqual(cwd('git -C C:/work/repo commit', win), ['C:\\work\\repo']);
  assert.deepStrictEqual(cwd('git -C C:/work/repo commit', pwsh), ['C:\\work\\repo']);
  assert.deepStrictEqual(cwd("git -C 'C:\\work\\repo' commit", win), ['C:\\work\\repo']);
  assert.deepStrictEqual(cwd('git -C "C:\\work\\repo" commit', win), ['C:\\work\\repo']);
  assert.deepStrictEqual(cwd('git -C \\\\server\\share\\repo commit', pwsh), ['\\\\server\\share\\repo']);
  assert.deepStrictEqual(cwd('git -C sub\\repo commit', pwsh), ['C:\\w\\sub\\repo']);
  assert.deepStrictEqual(cwd('cd C:\\work\\repo; git commit', pwsh).sort(), ['C:\\w', 'C:\\work\\repo']);
  assert.deepStrictEqual(cwd('cd C:\\work\\repo && git commit', pwsh), ['C:\\work\\repo']);
  assert.deepStrictEqual(cwd('cd C:/ && git commit', win), ['C:\\']);
  assert.deepStrictEqual(targets('git --git-dir=C:\\r\\.git commit', base, pwsh)[0].gitArgs, ['--git-dir=C:\\r\\.git']);
  assert.deepStrictEqual(targets('GIT_DIR=C:/r/.git git commit', base, win)[0].gitArgs, ['--git-dir=C:\\r\\.git']);
  // To bash an unquoted backslash is an escape: `C:\work\repo` reaches git as `C:workrepo`.
  assert.strictEqual(targets('git -C C:\\work\\repo commit', base, win), null);
  assert.strictEqual(targets('git -C C:repo commit', base, pwsh), null);
  for (const c of ['git -C C:\\work\\repo commit', 'git -C C:/work/repo commit', "git -C '\\\\server\\share\\repo' commit",
    'cd C:/work/repo && git commit', 'git --work-tree=C:/r commit']) {
    assert.strictEqual(targets(c, '/w', posix), null, c);
  }
  // The tool name picks the shell: Copilot's powershell tool reads backslashes as separators.
  const run = stubGit();
  const input = { toolName: 'powershell', toolArgs: { command: 'git -C C:\\work\\repo commit -m x' }, cwd: base };
  assert.match(decide(input, true, { git: run, platform: 'win32' }), /^WHAT: /);
  assert.strictEqual(run.calls[0].cwd, 'C:\\work\\repo');
  const viaBash = stubGit();
  assert.strictEqual(decide({ ...input, toolName: 'bash' }, true, { git: viaBash, platform: 'linux' }), null);
  assert.deepStrictEqual(viaBash.calls, []);
});

test('a repository alias commits on main in a real repository', () => {
  const hook = path.join(__dirname, '..', 'hooks', 'protected-branch.js');
  const run = (command, cwd) => execFileSync('node', [hook], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }), encoding: 'utf8',
  });
  const main = repo('main');
  const feat = repo('feature/x');
  try {
    execFileSync('git', ['-C', main, 'config', 'alias.ci', 'commit']);
    execFileSync('git', ['-C', feat, 'config', 'alias.ci', 'commit']);
    assert.match(run('git ci -m x', main), /deny/);
    assert.match(run(`git -C ${main} ci -m x`, feat), /deny/);
    assert.strictEqual(run('git ci -m x', feat), '');
    assert.strictEqual(run(`git -C ${feat} ci -m x`, main), '');
  } finally {
    fs.rmSync(main, { recursive: true, force: true });
    fs.rmSync(feat, { recursive: true, force: true });
  }
});
