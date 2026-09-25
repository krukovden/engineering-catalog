'use strict';
// Materialises the "before" side of a compare: a detached checkout of the base ref, beside the
// candidate worktree, running the candidate's own eval cases. This repo is itself a worktree
// (main is already checked out at the primary checkout), so a branch checkout of `ref` would
// collide — everything here resolves to a SHA first and adds the worktree `--detached`.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** The one git entry point; tests inject a fake to drive the logic without a real repo. */
function gitRun(args, { cwd }) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** `ref` resolved to its 40-hex commit SHA. Throws naming `ref` when it doesn't resolve. */
function resolveRef({ root, ref, git = gitRun }) {
  let out;
  try {
    out = git(['rev-parse', `${ref}^{commit}`], { cwd: root });
  } catch (e) {
    throw new Error(`could not resolve ref "${ref}": ${e.message}`);
  }
  return out.trim();
}

/** Adds a detached worktree for `ref` at `dir`. Returns before any case copying. */
function addWorktree({ root, ref, dir, git = gitRun }) {
  if (fs.existsSync(dir)) throw new Error(`worktree dir already exists: ${dir}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const sha = resolveRef({ root, ref, git });
  git(['worktree', 'add', '--detach', dir, sha], { cwd: root });
  return { path: dir, sha, ref };
}

/** Removes a worktree and prunes stale metadata. Never throws — cleanup runs in a `finally`. */
function removeWorktree({ root, dir, git = gitRun }) {
  try {
    git(['worktree', 'remove', '--force', dir], { cwd: root });
  } catch {
    // already gone, or never registered — fall through to prune so it doesn't linger in git's list
  }
  try {
    git(['worktree', 'prune'], { cwd: root });
  } catch {
    // best-effort
  }
}

const SKIP = new Set(['results', 'experiments']);

function rmEvalsDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function copyEvalsTree(from, to) {
  let count = 0;
  const walk = (src, dest) => {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (src === from && SKIP.has(entry.name)) continue;
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, destPath);
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath);
        count += 1;
      }
    }
  };
  if (fs.existsSync(from)) walk(from, to);
  return count;
}

/**
 * Copies the candidate's `evals/` tree over the base worktree's, so both arms run identical
 * cases. The destination is wiped first — a case the candidate deleted must not survive in the
 * base — and `results/`/`experiments/` (transient output, committed verdicts) never travel.
 */
function syncCases({ from, to }) {
  const fromDir = path.join(from, 'evals');
  const toDir = path.join(to, 'evals');
  rmEvalsDir(toDir);
  return copyEvalsTree(fromDir, toDir);
}

/** Add, sync cases from `root`, run `fn`, remove — always, even when `fn` throws. */
async function withBaseWorktree({ root, ref, dir, git = gitRun }, fn) {
  const worktree = addWorktree({ root, ref, dir, git });
  syncCases({ from: root, to: dir });
  try {
    return await fn(worktree);
  } finally {
    removeWorktree({ root, dir, git });
  }
}

/** The candidate side's provenance for the fingerprint. */
function currentSha({ root, git = gitRun }) {
  return resolveRef({ root, ref: 'HEAD', git });
}

function isDirty({ root, git = gitRun }) {
  return git(['status', '--porcelain'], { cwd: root }).trim().length > 0;
}

module.exports = { gitRun, resolveRef, addWorktree, removeWorktree, syncCases, withBaseWorktree, currentSha, isDirty };
