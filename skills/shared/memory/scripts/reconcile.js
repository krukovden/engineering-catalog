#!/usr/bin/env node
'use strict';
// reconcile.js — which commits has memory not caught up with? (DESIGN §8.8)
//   node reconcile.js --memory <dir> [--repo <dir>] [--json]      list them
//   node reconcile.js --memory <dir> [--repo <dir>] --mark <sha>  record catch-up through <sha>
const fs = require('fs');
const path = require('path');
const lib = require('./memory-lib');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const memory = opt('--memory');
if (!memory) { console.error('usage: reconcile.js --memory <dir> [--repo <dir>] [--json] [--mark <sha>]'); process.exit(2); }
const repo = opt('--repo') || path.resolve(memory, '..');
const indexFile = path.join(memory, 'index.md');
const pendingFile = path.join(memory, '.pending');
const index = lib.parseIndex(fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '');
const pending = lib.readPending(pendingFile);
const range = index.reconciledSha ? `${index.reconciledSha}..HEAD` : 'HEAD';
let reachable;
try { reachable = lib.git(['rev-list', '--reverse', range], repo).split('\n').filter(Boolean); }
catch (err) { console.error(`cannot list ${range}: ${err.message.split('\n')[0]}`); process.exit(1); }
if (!index.reconciledSha) reachable = reachable.filter((s) => pending.includes(s)); // no baseline: the queue is the set
const { queued, unqueued } = lib.computeUnrecorded({ pending, reachable });

const mark = opt('--mark');
if (mark) {
  const text = fs.readFileSync(indexFile, 'utf8');
  fs.writeFileSync(indexFile, lib.setReconciledSha(text, mark));
  // Prune .pending against what is still unrecorded from the NEW baseline —
  // never against the old (possibly baseline-less) `reachable` list. This
  // drops both ancestors of `mark` and anything unreachable from HEAD
  // entirely, so nothing is orphaned in the queue forever.
  let afterReachable;
  try { afterReachable = lib.git(['rev-list', `${mark}..HEAD`], repo).split('\n').filter(Boolean); }
  catch (err) { console.error(`cannot list ${mark}..HEAD: ${err.message.split('\n')[0]}`); process.exit(1); }
  const stillQueued = pending.filter((s) => afterReachable.includes(s));
  // What was dropped splits in two: ancestors of `mark` were just reconciled;
  // anything else is no longer reachable from HEAD (rebased or squashed away).
  let ancestors;
  try { ancestors = lib.git(['rev-list', mark], repo).split('\n').filter(Boolean); }
  catch (err) { console.error(`cannot list ${mark}: ${err.message.split('\n')[0]}`); process.exit(1); }
  const reconciled = pending.filter((s) => ancestors.includes(s));
  const unreachable = pending.filter((s) => !afterReachable.includes(s) && !ancestors.includes(s));
  lib.writePending(pendingFile, stillQueued);
  const short = (list) => list.map((s) => s.slice(0, 12)).join(' ');
  console.log(`reconciled through ${mark.slice(0, 12)}; ${stillQueued.length} still queued`);
  if (reconciled.length) console.log(`reconciled: ${short(reconciled)}`);
  if (unreachable.length) console.log(`unreachable from HEAD: ${short(unreachable)}`);
  process.exit(0);
}
const commits = reachable.map((sha) => {
  const [date, ...subject] = lib.git(['show', '-s', '--format=%as %s', sha], repo).split(' ');
  return { sha, date, subject: subject.join(' '), queued: queued.includes(sha) };
});
if (args.includes('--json')) { console.log(JSON.stringify({ reconciledSha: index.reconciledSha, commits, stale: pending.filter((s) => !reachable.includes(s)) })); process.exit(0); }
if (!commits.length) { console.log('memory is caught up.'); process.exit(0); }
for (const c of commits) console.log(`${c.sha.slice(0, 12)}  ${c.date}  ${c.subject}${c.queued ? '' : '  (not in queue)'}`);
void unqueued;
