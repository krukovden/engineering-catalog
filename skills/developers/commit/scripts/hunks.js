#!/usr/bin/env node
'use strict';
// Stage part of a file without an interactive prompt. `git add -p` asks questions on a
// terminal; this lists the hunks of one file with stable ids and stages the ones named.
//
//   node hunks.js list  [--fine] <file>            one line per hunk: id, @@ header, +/- counts, first changed line
//   node hunks.js show  [--fine] <file> <id>...    the full text of those hunks
//   node hunks.js stage [--fine] <file> <id>...    put exactly those hunks into the index
//
// An id is a hash of the hunk's added and removed lines, so it survives other hunks of
// the same file being committed first. Hunks with identical changes share an id; list
// marks the later ones id#2, id#3, counted among the hunks still uncommitted. A bare id
// takes the first such hunk not taken yet, id#n takes exactly the n-th.
// --fine asks git for zero context lines, which separates changes that sit close
// together; use the same flag for list and stage.
// Only the index changes. The working tree is never touched.
//
// Self-contained: no require() outside Node's own modules.

const { execFileSync } = require('child_process');
const crypto = require('crypto');

function git(args, input) {
  return execFileSync('git', args, { input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString();
}

function hasHead() {
  try { git(['rev-parse', '-q', '--verify', 'HEAD']); return true; } catch { return false; }
}

/** Split one file's diff into its header and its hunks. */
function parseDiff(text) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const header = [];
  const hunks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      current = { header: line, lines: [] };
      hunks.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      header.push(line);
    }
  }
  for (const h of hunks) {
    const changed = h.lines.filter((l) => l.startsWith('+') || l.startsWith('-'));
    h.id = crypto.createHash('sha1').update(changed.join('\n')).digest('hex').slice(0, 7);
    h.added = changed.filter((l) => l.startsWith('+')).length;
    h.removed = changed.length - h.added;
    h.first = (changed[0] || '').slice(0, 70);
  }
  const seen = new Map();
  for (const h of hunks) {
    h.nth = (seen.get(h.id) || 0) + 1;
    seen.set(h.id, h.nth);
    h.label = h.nth === 1 ? h.id : `${h.id}#${h.nth}`;
  }
  return { header, hunks };
}

/** Why this file can only be committed whole, or null when it can be split. */
function wholeFileReason(file, header, hunkCount) {
  const h = header.join('\n');
  if (/^new file mode/m.test(h)) return 'new file';
  if (/^deleted file mode/m.test(h)) return 'deleted file';
  if (/^Binary files /m.test(h) || /^GIT binary patch/m.test(h)) return 'binary file';
  if (hunkCount === 0) {
    const untracked = git(['ls-files', '--others', '--exclude-standard', '--', file]).trim();
    return untracked ? 'untracked file' : 'no changes';
  }
  return null;
}

function readFileDiff(file, { fine, against }) {
  const args = ['diff', '--no-color', '--no-ext-diff', fine ? '-U0' : '-U3'];
  if (against === 'HEAD' && hasHead()) args.push('HEAD');
  args.push('--', file);
  return parseDiff(git(args));
}

/** `id#n` takes exactly the n-th hunk with that id; a bare id takes the first one not taken yet. */
function pick(hunks, ids) {
  const taken = new Set();
  for (const wanted of ids) {
    const [id, nth] = wanted.split('#');
    const i = hunks.findIndex((h, n) => h.id === id && !taken.has(n) && (nth === undefined || h.nth === Number(nth)));
    if (i < 0) throw new Error(`no hunk ${wanted} left in this file; run "list" again — known ids: ${hunks.map((h) => h.label).join(', ') || 'none'}`);
    taken.add(i);
  }
  return hunks.filter((_, n) => taken.has(n));
}

/**
 * Headers for a subset of hunks. The new-side line numbers in the full diff count every
 * hunk before them; with some left out they are wrong, and a zero-context patch is
 * placed by exactly those numbers. Recompute them from the old side and the hunks taken.
 */
function renumber(chosen) {
  let delta = 0;
  return chosen.map((h) => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(h.header);
    if (!m) throw new Error(`cannot read hunk header: ${h.header}`);
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    // git's convention: an empty side points at the line before the change
    const anchor = oldCount === 0 ? oldStart + 1 : oldStart;
    const newStart = newCount === 0 ? anchor - 1 + delta : anchor + delta;
    delta += newCount - oldCount;
    return { ...h, header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${m[5]}` };
  });
}

function main(argv) {
  const fine = argv.includes('--fine');
  const [cmd, file, ...ids] = argv.filter((a) => a !== '--fine');
  if (!['list', 'show', 'stage'].includes(cmd) || !file || (cmd !== 'list' && ids.length === 0)) {
    process.stderr.write('usage: hunks.js list [--fine] <file>\n       hunks.js show|stage [--fine] <file> <id>...\n');
    return 2;
  }
  // list and show describe everything that differs from the last commit; stage works
  // against the index, because that is what the patch is applied to.
  const { header, hunks } = readFileDiff(file, { fine, against: cmd === 'stage' ? 'index' : 'HEAD' });
  const whole = wholeFileReason(file, header, hunks.length);
  if (whole) {
    if (cmd === 'list') { process.stdout.write(`whole-file  ${whole}: stage it with git add, it has no hunks to pick\n`); return 0; }
    throw new Error(`${file} is a ${whole}; stage it whole with git add`);
  }
  if (cmd === 'list') {
    for (const h of hunks) process.stdout.write(`${h.label}  ${h.header.replace(/^(@@ [^@]+ @@).*/, '$1')}  +${h.added} -${h.removed}  ${h.first}\n`);
    return 0;
  }
  const chosen = cmd === 'stage' ? renumber(pick(hunks, ids)) : pick(hunks, ids);
  const text = chosen.map((h) => [h.header, ...h.lines].join('\n')).join('\n') + '\n';
  if (cmd === 'show') { process.stdout.write(text); return 0; }
  const patch = header.join('\n') + '\n' + text;
  git(['apply', '--cached', '--recount', ...(fine ? ['--unidiff-zero'] : []), '-'], patch);
  process.stdout.write(`staged ${chosen.length} of ${hunks.length} hunk(s) of ${file}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    const detail = e.stderr && e.stderr.length ? e.stderr.toString().trim() : e.message;
    process.stderr.write(`hunks: ${detail}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseDiff, pick, renumber };
