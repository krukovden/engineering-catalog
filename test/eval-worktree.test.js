'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  resolveRef, addWorktree, removeWorktree, syncCases, withBaseWorktree, currentSha, isDirty,
} = require('../scripts/eval/worktree');

const SHA_RE = /^[0-9a-f]{40}$/;

function sh(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// git resolves symlinks in worktree paths (e.g. macOS /var -> /private/var); compare on the
// resolved form so `worktree list` output can be matched against the `dir` we passed in.
const real = (p) => fs.realpathSync(p);

/** A throwaway repo under os.tmpdir() with one committed file, no git identity required. */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-worktree-'));
  sh(['init', '-q'], root);
  fs.writeFileSync(path.join(root, 'file.txt'), 'one\n');
  sh(['add', 'file.txt'], root);
  sh(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'first'], root);
  return root;
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('resolveRef returns a 40-hex SHA for HEAD and throws naming a nonsense ref', () => {
  const root = makeRepo();
  try {
    const sha = resolveRef({ root, ref: 'HEAD' });
    assert.match(sha, SHA_RE);
    assert.throws(() => resolveRef({ root, ref: 'not-a-real-ref' }), /not-a-real-ref/);
  } finally {
    rmrf(root);
  }
});

test('addWorktree + removeWorktree round-trip, second removal is a no-op', () => {
  const root = makeRepo();
  const dir = path.join(root, '..', `wt-${path.basename(root)}`);
  try {
    const head = resolveRef({ root, ref: 'HEAD' });
    const result = addWorktree({ root, ref: 'HEAD', dir });
    assert.equal(result.path, dir);
    assert.equal(result.sha, head);
    assert.equal(result.ref, 'HEAD');
    assert.ok(fs.existsSync(path.join(dir, 'file.txt')));
    assert.equal(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8'), 'one\n');

    const list = sh(['worktree', 'list', '--porcelain'], root);
    const entry = list.split('\n\n').find((block) => block.includes(`worktree ${real(dir)}`));
    assert.ok(entry, 'worktree list should show the added worktree');
    assert.match(entry, /\bdetached\b/);
    assert.ok(entry.includes(`HEAD ${head}`));

    removeWorktree({ root, dir });
    assert.ok(!fs.existsSync(dir));
    const listAfter = sh(['worktree', 'list', '--porcelain'], root);
    assert.ok(!listAfter.includes(path.basename(dir)), 'the removed worktree must not remain in the list');

    // second removal of an already-gone directory must not throw
    assert.doesNotThrow(() => removeWorktree({ root, dir }));
  } finally {
    rmrf(dir);
    rmrf(root);
  }
});

test('addWorktree detaches even when the same branch is checked out elsewhere', () => {
  const root = makeRepo();
  sh(['branch', 'feature'], root);
  const firstDir = path.join(root, '..', `wt-first-${path.basename(root)}`);
  const secondDir = path.join(root, '..', `wt-second-${path.basename(root)}`);
  try {
    // check the branch out normally in a first worktree
    sh(['worktree', 'add', firstDir, 'feature'], root);
    assert.ok(fs.existsSync(firstDir));

    // addWorktree for the same branch name must still succeed, by detaching
    const result = addWorktree({ root, ref: 'feature', dir: secondDir });
    assert.match(result.sha, SHA_RE);
    assert.ok(fs.existsSync(path.join(secondDir, 'file.txt')));

    const list = sh(['worktree', 'list', '--porcelain'], root);
    const entry = list.split('\n\n').find((block) => block.includes(`worktree ${real(secondDir)}`));
    assert.ok(entry, 'worktree list should show the second worktree');
    assert.match(entry, /\bdetached\b/);
  } finally {
    removeWorktree({ root, dir: secondDir });
    try { sh(['worktree', 'remove', '--force', firstDir], root); } catch { /* best effort */ }
    rmrf(firstDir);
    rmrf(secondDir);
    rmrf(root);
  }
});

test('syncCases replaces the destination tree, drops removed files, skips results/experiments', () => {
  const from = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-worktree-from-'));
  const to = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-worktree-to-'));
  try {
    // destination starts with a stale case the "candidate" no longer has, plus committed dirs
    fs.mkdirSync(path.join(to, 'evals', 'stale-group'), { recursive: true });
    fs.writeFileSync(path.join(to, 'evals', 'stale-group', 'case.md'), 'stale');
    fs.mkdirSync(path.join(to, 'evals', 'results'), { recursive: true });
    fs.writeFileSync(path.join(to, 'evals', 'results', 'old.json'), '{}');

    // source has a fresh case plus results/ and experiments/ that must never travel
    fs.mkdirSync(path.join(from, 'evals', 'safety-ssh'), { recursive: true });
    fs.writeFileSync(path.join(from, 'evals', 'safety-ssh', 'case.md'), 'fresh');
    fs.mkdirSync(path.join(from, 'evals', 'results'), { recursive: true });
    fs.writeFileSync(path.join(from, 'evals', 'results', 'new.json'), '{}');
    fs.mkdirSync(path.join(from, 'evals', 'experiments'), { recursive: true });
    fs.writeFileSync(path.join(from, 'evals', 'experiments', 'verdict.json'), '{}');

    const copied = syncCases({ from, to });

    assert.equal(copied, 1);
    assert.ok(fs.existsSync(path.join(to, 'evals', 'safety-ssh', 'case.md')));
    assert.ok(!fs.existsSync(path.join(to, 'evals', 'stale-group')), 'the stale case must be dropped');
    assert.ok(!fs.existsSync(path.join(to, 'evals', 'results')), 'results/ must not be copied');
    assert.ok(!fs.existsSync(path.join(to, 'evals', 'experiments')), 'experiments/ must not be copied');
  } finally {
    rmrf(from);
    rmrf(to);
  }
});

test('withBaseWorktree removes the worktree even when fn throws, and re-throws the error', async () => {
  const root = makeRepo();
  const dir = path.join(root, '..', `wt-throw-${path.basename(root)}`);
  try {
    await assert.rejects(
      withBaseWorktree({ root, ref: 'HEAD', dir }, async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.ok(!fs.existsSync(dir), 'the worktree should be removed after fn throws');
  } finally {
    rmrf(dir);
    rmrf(root);
  }
});

test('withBaseWorktree syncs cases from root and removes the worktree on success', async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'evals', 'safety-ssh'), { recursive: true });
  fs.writeFileSync(path.join(root, 'evals', 'safety-ssh', 'case.md'), 'fresh');
  const dir = path.join(root, '..', `wt-ok-${path.basename(root)}`);
  try {
    let seenPath;
    const result = await withBaseWorktree({ root, ref: 'HEAD', dir }, async (worktree) => {
      seenPath = worktree.path;
      assert.ok(fs.existsSync(path.join(dir, 'evals', 'safety-ssh', 'case.md')));
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(seenPath, dir);
    assert.ok(!fs.existsSync(dir));
  } finally {
    rmrf(dir);
    rmrf(root);
  }
});

test('isDirty is false on a clean repo and true after an untracked file, currentSha matches HEAD', () => {
  const root = makeRepo();
  try {
    assert.equal(isDirty({ root }), false);
    assert.equal(currentSha({ root }), resolveRef({ root, ref: 'HEAD' }));

    fs.writeFileSync(path.join(root, 'untracked.txt'), 'x');
    assert.equal(isDirty({ root }), true);
  } finally {
    rmrf(root);
  }
});
