#!/usr/bin/env node
'use strict';
// ado-board CLI: states discover, move, reconcile, nudge. Decisions live in board-logic.js,
// REST calls in board-rest.js. Prints one JSON object on stdout (`--json` is accepted and changes
// nothing); human text goes to stderr. Never prompts, so `--non-interactive` changes nothing either.
// Exit codes: 0 done or nothing to do, 1 a call failed, 2 a person must decide (a state choice,
// a required field), 3 refused by a rule. board.js is an alias of this file.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ado = require('./ado.js');
const L = require('./board-logic.js');
const R = require('./board-rest.js');

function defaultDeps() {
  return {
    fetch: (...a) => fetch(...a),
    env: process.env,
    now: () => new Date().toISOString(),
    // az is the macOS/Linux credential; bounded so a hung CLI cannot stall a session.
    runAz: (args, timeout = 8000) => execFileSync('az', args, { stdio: ['ignore', 'pipe', 'ignore'], timeout }).toString(),
    git: (args, cwd = process.cwd()) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim(),
  };
}

const stateHome = (env) => path.join(env.ENGCAT_HOME || os.homedir(), '.engineering-catalog');
const slug = (s) => String(s).toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

// Per-project map. Default: under the user's home, outside every repository. Opt-in
// (`states discover --in-repo`): <repo>/.engineering-catalog/ado-board.json, read first when present.
function mapPaths(ctx, env, repoRoot) {
  const home = path.join(stateHome(env), 'ado-board', slug(ctx.org), `${slug(ctx.project)}.json`);
  const repo = repoRoot ? path.join(repoRoot, '.engineering-catalog', 'ado-board.json') : null;
  return { home, repo };
}

function readMap(ctx, env, repoRoot) {
  const p = mapPaths(ctx, env, repoRoot);
  for (const file of [p.repo, p.home].filter(Boolean)) {
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (m.organization === ctx.org && m.project === ctx.project) return { map: m, file };
    } catch { /* absent or unreadable */ }
  }
  return null;
}

function writeJsonIfChanged(file, value, { current = null, mode = null } = {}) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  const previous = current == null
    ? (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)
    : current;
  if (previous === next) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.engcat-tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, next);
  if (mode != null) fs.chmodSync(tmp, mode);
  try {
    fs.renameSync(tmp, file);
    if (mode != null) fs.chmodSync(file, mode);
  } catch (err) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    throw err;
  }
  return true;
}

function repoFacts(deps) {
  const out = { root: null, remote: null, branch: null, head: null };
  try { out.root = deps.git(['rev-parse', '--show-toplevel']); } catch { return out; }
  try { out.remote = L.parseRemoteUrl(deps.git(['remote', 'get-url', 'origin'])); } catch { /* no origin */ }
  try { out.branch = deps.git(['rev-parse', '--abbrev-ref', 'HEAD']); } catch { /* detached */ }
  try { out.head = deps.git(['rev-parse', 'HEAD']); } catch { /* empty repo */ }
  return out;
}

function context(args, deps, repo) {
  const fallback = repo.remote ? { org: repo.remote.org, project: repo.remote.project } : {};
  return ado.resolveContext(args, deps.env, { fallback, home: deps.home, runAz: deps.runAz });
}

// --- commands --------------------------------------------------------------------------

async function cmdDiscover(args, deps) {
  const repo = repoFacts(deps);
  const ctx = context(args, deps, repo);
  const auth = ado.resolveAuth(deps.env, deps.runAz);
  if (args['in-repo'] && !repo.root) throw new Error('--in-repo needs a git repository');
  const p = mapPaths(ctx, deps.env, repo.root);
  const file = args['in-repo'] ? p.repo : p.home;
  // Read first: the new map is merged into the existing one (earlier choices, other types,
  // unknown fields), so rediscovery and a version bump are migrations, not rewrites.
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const names = args.types ? String(args.types).split(',').map((s) => s.trim()).filter(Boolean) : L.boardTypes(await R.getTypes(ctx, auth, deps));
  const types = {};
  for (const t of names) types[t] = await R.getStates(ctx, auth, t, deps);
  const { map, ambiguous } = L.buildMap({ organization: ctx.org, project: ctx.project, types, choices: L.parseChoices(args.choose), now: deps.now(), existing });
  if (ambiguous.length) {
    const example = ambiguous.map((a) => `${a.type}:${a.bucket}=${a.states[0]}`).join(';');
    return { code: 2, out: { outcome: 'needs-choice', ambiguous, next: `Ask the user once which state each bucket moves to, then re-run: states discover --choose "${example}"` } };
  }
  const summary = Object.fromEntries(Object.entries(map.types).map(([t, v]) => [t, v.targets]));
  const result = { path: file, types: summary, stateMap: L.stateMap(map) };
  if (L.sameMap(existing, map)) return { code: 0, out: { outcome: 'kept', ...result } };
  writeJsonIfChanged(file, map);
  return { code: 0, out: { outcome: 'written', ...result } };
}

const MOVE_CODE = { moved: 0, unchanged: 0, 'field-required': 2, refused: 3, conflict: 3, error: 1 };

function needMap(ctx, deps, repo) {
  const found = readMap(ctx, deps.env, repo.root);
  if (!found) throw Object.assign(new Error(`no state map for ${ctx.org} / ${ctx.project}: run states discover first`), { code: 2 });
  return found.map;
}

async function cmdMove(args, deps) {
  const [id, bucket] = [Number(args._[1]), args._[2]];
  if (!id || !bucket) throw new Error('usage: move <id> <todo|doing|testing|verify|done> [--comment "<evidence>"] [--allow-idp]');
  // --idp is the earlier spelling of --allow-idp.
  const allowIdp = !!(args['allow-idp'] || args.idp);
  const repo = repoFacts(deps);
  const ctx = context(args, deps, repo);
  const map = needMap(ctx, deps, repo);
  const auth = ado.resolveAuth(deps.env, deps.runAz);
  const d = L.checkMove({ map, item: await R.getItem(ctx, auth, id, deps), bucket, allowIdp });
  if (!d.ok) return { code: d.code === 'same' ? 0 : 3, out: { outcome: d.code === 'same' ? 'unchanged' : 'refused', ...d } };
  let evidence = typeof args.comment === 'string' ? args.comment : '';
  if (!evidence && repo.branch && repo.head) evidence = `branch ${repo.branch} at ${repo.head.slice(0, 7)}`;
  if (!evidence) return { code: 3, out: { outcome: 'refused', id, reason: 'no evidence: pass --comment naming the branch, PR or witness' } };
  const describe = (m) => `ado-board: ${m.fromState} → ${m.toState}. Evidence: ${evidence}`;
  if (args['dry-run']) return { code: 0, out: { outcome: 'planned', ...d, comment: describe(d) } };
  const r = await R.applyMove(ctx, auth, map, d, describe, deps, { allowIdp });
  return { code: MOVE_CODE[r.outcome], out: r };
}

async function gatherReconcile(args, deps, { timeoutMs } = {}) {
  const repo = repoFacts(deps);
  if (!repo.remote) throw new Error('reconcile runs inside a clone of an Azure Repos repository (origin is not dev.azure.com)');
  const ctx = context(args, deps, repo);
  const map = needMap(ctx, deps, repo);
  const auth = ado.resolveAuth(deps.env, deps.runAz);
  const nowMs = Date.parse(deps.now());
  const since = nowMs - Number(args.since || 30) * 86400000;
  const { repoId, defaultBranch, branches: all } = await R.getBranches(ctx, auth, repo.remote.repo, deps, timeoutMs);
  const branches = all.filter((b) => L.branchWorkItemId(b.name) || Date.parse(b.date) >= since);
  const { prs, coverage } = args.nudge ? { prs: [], coverage: null } : await R.getCompletedPrs(ctx, auth, repoId, since, deps);
  const doing = await R.queryDoing(ctx, auth, map, deps, { everyone: !!args.everyone, timeoutMs });
  const ids = new Set(doing);
  if (!args.nudge) {
    for (const b of branches) { const id = L.branchWorkItemId(b.name); if (id) ids.add(id); }
    for (const p of prs) { for (const id of p.workItemIds) ids.add(id); for (const id of L.titleWorkItemIds(p.title)) ids.add(id); const b = L.branchWorkItemId(p.sourceRefName); if (b) ids.add(b); }
  }
  const items = ids.size ? await R.getItems(ctx, auth, [...ids], deps, timeoutMs) : {};
  return { ctx, map, auth, defaultBranch, branches, prs, coverage, items };
}

async function cmdReconcile(args, deps) {
  const g = await gatherReconcile(args, deps);
  const plan = L.planReconcile({
    map: g.map, branches: g.branches, prs: g.prs, items: g.items, now: deps.now(), defaultBranch: g.defaultBranch,
    staleDays: Number(args['stale-days'] || 5), graceMinutes: Number(args.grace || 10),
  });
  const coverage = { pullRequests: g.coverage };
  if (args['dry-run']) return { code: 0, out: { dryRun: true, ...plan, coverage } };
  const applied = [];
  for (const m of plan.moves) {
    const describe = (x) => `ado-board reconcile: ${x.fromState} → ${x.toState}. Evidence: ${m.evidence}.`;
    applied.push(await R.applyMove(g.ctx, g.auth, g.map, m, describe, deps));
  }
  // A card someone else moved on (to this bucket or past it) while reconcile ran is settled.
  const settled = (a) => a.outcome === 'moved' || a.outcome === 'unchanged' || (a.outcome === 'refused' && a.code === 'backwards');
  const codes = applied.filter((a) => !settled(a)).map((a) => MOVE_CODE[a.outcome] || 1);
  const code = codes.includes(1) ? 1 : codes.includes(2) ? 2 : codes.length ? 3 : 0;
  return { code, out: { dryRun: false, ...plan, coverage, applied } };
}

// For catalog-freshness: at most once per --hours, silent on every problem, bounded in time.
// `--due` answers by exit code alone (0 = a check is due), with no network: the PowerShell
// twin asks it before unwrapping the Windows PAT.
async function cmdNudge(args, outer) {
  const deps = { ...outer, runAz: (a) => outer.runAz(a, 3000) };
  const hours = Number(args.hours || 24);
  const staleDays = Number(args['stale-days'] || 5);
  const repo = repoFacts(deps);
  const idle = { code: args.due ? 1 : 0, out: null };
  if (!repo.remote) return idle;
  const key = `${repo.remote.org}/${repo.remote.project}`;
  const ctx = { org: repo.remote.org, project: repo.remote.project };
  if (!readMap(ctx, deps.env, repo.root)) return idle;
  const cacheFile = path.join(stateHome(deps.env), 'board-nudge.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* first run */ }
  const nowIso = deps.now();
  const due = L.isDue(cache, key, Date.parse(nowIso), hours);
  if (args.due) return { code: due ? 0 : 1, out: null };
  if (!due) return { code: 0, out: null };
  // Stamp before the network: a failing call is not retried every session.
  cache[key] = { lastChecked: nowIso, count: cache[key] ? cache[key].count : null };
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + '\n');
  const g = await gatherReconcile({ ...args, nudge: true, org: ctx.org, project: ctx.project }, deps, { timeoutMs: 4000 });
  const plan = L.planReconcile({ map: g.map, branches: g.branches, items: g.items, now: nowIso, staleDays, defaultBranch: g.defaultBranch });
  cache[key].count = plan.reports.staleDoing.length;
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + '\n');
  return { code: 0, out: L.nudgeLine(plan.reports.staleDoing, staleDays) || null };
}

// Every value of a repeatable flag, in order: `--choose A --choose B` and `--choose=A`.
function allValues(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out.push(argv[++i]);
    else if (argv[i].startsWith(`--${name}=`)) out.push(argv[i].slice(name.length + 3));
  }
  return out;
}

async function main(argv, deps = defaultDeps()) {
  const args = ado.parseArgs(argv);
  const chooses = allValues(argv, 'choose');
  if (chooses.length) args.choose = chooses.join(';');
  const [cmd, sub] = args._;
  if (cmd === 'nudge') {
    // Never block a session: a hard ceiling, and silence on any error.
    const timer = setTimeout(() => process.exit(0), 9000); timer.unref();
    try {
      const r = await cmdNudge(args, deps);
      if (typeof r.out === 'string' && r.out) process.stdout.write((args.json ? JSON.stringify({ message: r.out }) : r.out) + '\n');
      return r.code;
    } catch { return args.due ? 1 : 0; }
  }
  try {
    let r;
    if (cmd === 'states' && sub === 'discover') r = await cmdDiscover(args, deps);
    else if (cmd === 'move') r = await cmdMove(args, deps);
    else if (cmd === 'reconcile') r = await cmdReconcile(args, deps);
    else throw new Error('usage: ado-board.js states discover | move <id> <bucket> | reconcile [--dry-run] | nudge');
    process.stdout.write(JSON.stringify(r.out, null, 2) + '\n');
    return r.code;
  } catch (e) {
    process.stderr.write(`ado-board: ${e.message}\n`);
    return e.code === 2 ? 2 : 1;
  }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = {
  main, cmdMove, cmdReconcile, cmdDiscover, cmdNudge,
  mapPaths, readMap, writeJsonIfChanged, slug,
};
