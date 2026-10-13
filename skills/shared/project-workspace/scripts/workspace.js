#!/usr/bin/env node
'use strict';
// project-workspace CLI: setup, where, register, ensure, search, link-board.
// Prints one JSON object. A decision the person must make comes back as
// { needs, ask, options, then } with exit 0; nothing ever reads stdin. Exit 1 = a call failed.
// Rules (spec §4): a path in `paths` is only fetched; the store copy sits detached at
// origin/<default> and is never reset without --reset; search reads the ref, never the work tree.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('./workspace-logic.js');
const G = require('./git.js');
const ado = require('./ado.js');

const BOOLEAN = new Set(['approved', 'fresh', 'reset', 'all', 'move-qa']);
const CONCURRENCY = 4;
const MAX_HITS = 200;
const MAX_COMMITS = 50;

function defaultDeps() {
  return {
    env: process.env,
    cwd: process.cwd(),
    now: () => new Date().toISOString(),
    fetch: (...a) => fetch(...a),
    runAz: (args, timeout = 8000) => execFileSync('az', args, { stdio: ['ignore', 'pipe', 'ignore'], timeout }).toString(),
  };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 2) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (BOOLEAN.has(key) || next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

// --- state files -----------------------------------------------------------------------

const homeOf = (env) => path.resolve(env.ENGCAT_HOME || os.homedir());
function files(env) {
  const dir = path.join(homeOf(env), '.engineering-catalog');
  return { dir, config: path.join(dir, 'workspace.json'), map: path.join(dir, 'repos.json') };
}
// Only a missing file gives the fallback. A damaged or unreadable one throws: no command may
// write state derived from a file it could not read. `lenient` is for files this skill only peeks at.
function readJson(file, fallback, { lenient = false } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT' || lenient) return fallback;
    throw new Error(`could not read ${file}: ${e.message}. Nothing was changed; fix or remove that file and try again`);
  }
  try { return JSON.parse(raw); } catch (e) {
    if (lenient) return fallback;
    throw new Error(`${file} is damaged (it is not valid JSON: ${e.message}). Nothing was changed; fix or remove that file and try again`);
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Exclusive lock: `file` created with wx and holding { token, pid, host, at }. The holder rewrites
// `at` every staleMs/3 while it holds the lock; the returned release removes the file only while
// it still carries this holder's token. A lock is taken over only when `at` is older than
// `staleMs` and, on this host, its pid is no longer alive. Waits up to `waitMs`; null when held.
const HOST = os.hostname();
function readLock(file) {
  let raw, mtimeMs;
  try { raw = fs.readFileSync(file, 'utf8'); mtimeMs = fs.statSync(file).mtimeMs; } catch { return null; }
  let info = {};
  try { info = JSON.parse(raw) || {}; } catch { /* half-written or from an older version */ }
  const at = Date.parse(info.at);
  return { ...info, at: Number.isFinite(at) ? at : mtimeMs };
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
function isStale(info, staleMs) {
  if (Date.now() - info.at <= staleMs) return false;
  return !(info.host === HOST && pidAlive(info.pid));
}
// Moves a stale lock aside and deletes it only if it is still the one judged stale; a lock a
// competing process created in between is put back.
function breakLock(file, token) {
  const aside = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
  try { fs.renameSync(file, aside); } catch { return; }
  const moved = readLock(aside);
  if (moved && moved.token !== token) { try { fs.linkSync(aside, file); } catch { /* a newer lock is there */ } }
  fs.rmSync(aside, { force: true });
}
async function acquireLock(file, { staleMs, waitMs = 0 }) {
  const start = Date.now();
  const token = crypto.randomBytes(16).toString('hex');
  const body = () => JSON.stringify({ token, pid: process.pid, host: HOST, at: new Date().toISOString() });
  for (let delay = 25; ; delay = Math.min(delay * 2, 500)) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, body()); } finally { fs.closeSync(fd); }
      const owned = () => { const l = readLock(file); return Boolean(l && l.token === token); };
      const beat = setInterval(() => { try { if (owned()) fs.writeFileSync(file, body()); } catch { /* next beat */ } }, Math.max(250, Math.floor(staleMs / 3)));
      beat.unref();
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        clearInterval(beat);
        if (owned()) fs.rmSync(file, { force: true });
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const info = readLock(file);
    if (!info) continue;
    if (isStale(info, staleMs)) { breakLock(file, info.token); continue; }
    if (Date.now() - start >= waitMs) return null;
    await sleep(delay);
  }
}

function expandHome(p, env) {
  if (typeof p !== 'string' || !p) return null;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return path.join(homeOf(env), p.slice(1));
  return path.resolve(p);
}

// --- git helpers -----------------------------------------------------------------------

const ok = (r) => r.code === 0;
async function gitOut(args, cwd, opts) {
  const r = await G.git(args, { cwd, ...opts });
  return ok(r) ? r.stdout.trim() : null;
}
const isRepo = (dir) => fs.existsSync(path.join(dir, '.git'));

// Paths are compared by their real location: a symlink, junction or differently cased
// spelling of a working folder is that working folder.
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
function realpath(p) {
  const abs = path.resolve(p);
  const rest = [];
  for (let head = abs; ;) {
    try { return path.join(fs.realpathSync.native(head), ...rest); } catch { /* not there yet */ }
    const up = path.dirname(head);
    if (up === head) return abs;
    rest.unshift(path.basename(head));
    head = up;
  }
}
const inside = (child, parent) => L.isInside(realpath(child), realpath(parent), FOLD);
const overlaps = (a, b) => inside(a, b) || inside(b, a);
const workingPaths = (map) => Object.values(map).flatMap((e) => [...((e && e.paths) || []), ...((e && e.stale) || [])]);

// Why `dir` may not be used as a store copy, or null when it may. A store copy is under the
// shared folder, outside the working folder, and neither is, holds nor sits inside a path the
// map lists as a working copy.
function notStore(ctx, dir) {
  const refRoot = ctx.config && ctx.config.referenceRoot;
  if (!refRoot || !inside(dir, refRoot)) return `${dir} is outside the shared folder`;
  const work = ctx.config.workingRoot;
  if (work && inside(dir, work)) return `${dir} is inside the working folder`;
  for (const p of workingPaths(ctx.map)) {
    if (overlaps(dir, p)) return `${dir} is, holds or sits inside the working copy ${p}`;
  }
  return null;
}

// The configured URL, not `remote get-url`, which applies insteadOf rewrites.
async function originKey(dir) {
  const url = await gitOut(['config', '--get', 'remote.origin.url'], dir);
  return url ? L.normaliseUrl(url) : null;
}

// origin/<default> from origin/HEAD, when that still resolves to a commit; main/master otherwise.
// `full` is what git is given: a short `origin/main` loses to a local branch of that name.
const commitOf = (dir, ref) => gitOut(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], dir);
async function readHead(dir) {
  const head = await gitOut(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], dir);
  if (head && head.startsWith('refs/remotes/') && await commitOf(dir, head)) return { name: head.slice('refs/remotes/'.length), full: head };
  return null;
}
// A dangling origin/HEAD (the server dropped its old default branch) is refreshed: on a store copy
// by git itself; on a working copy the server's default is only read, and nothing is written
// outside refs/remotes/origin/*.
async function defaultRef(dir, ctx, copy = 'store') {
  let found = await readHead(dir);
  const hasHead = await gitOut(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], dir);
  if (!found && hasHead && ctx) {
    const url = await gitOut(['config', '--get', 'remote.origin.url'], dir);
    const env = url ? authEnv(ctx.env, url) : ctx.env;
    if (copy === 'store') {
      await G.git(['remote', 'set-head', 'origin', '--auto'], { cwd: dir, env, timeoutMs: ctx.timeoutMs });
      found = await readHead(dir);
    } else if (url) {
      const r = await G.git(['ls-remote', '--symref', url, 'HEAD'], { cwd: dir, env, timeoutMs: ctx.timeoutMs });
      const m = ok(r) && /^ref:\s*refs\/heads\/(\S+)\s+HEAD/m.exec(r.stdout);
      const full = m && `refs/remotes/origin/${m[1]}`;
      if (full && await commitOf(dir, full)) found = { name: `origin/${m[1]}`, full };
    }
  }
  if (found) return found;
  for (const b of ['main', 'master']) {
    if (await gitOut(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}^{commit}`], dir)) return { name: `origin/${b}`, full: `refs/remotes/origin/${b}` };
  }
  return null;
}

// A PAT in the environment reaches git through env-only config, never a file or argv.
function authEnv(env, key) {
  const found = ado.patFromEnv(env);
  if (!found || !/^https:\/\/dev\.azure\.com\//.test(key)) return env;
  const n = Number(env.GIT_CONFIG_COUNT || 0);
  return { ...env, GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'http.extraHeader', [`GIT_CONFIG_VALUE_${n}`]: `Authorization: ${ado.basicAuthHeader(found.pat)}` };
}

// git reports a PAT without Code (Read) as 403 / "not authorized"; say so plainly.
const GIT_FORBIDDEN = /\b403\b|not authorized/i;
const forbiddenText = (stderr) => (GIT_FORBIDDEN.test(stderr || '')
  ? 'the token can sign in but is not allowed to read this repository: create a new PAT with Code (Read)' : null);

// Fetch only: never checkout, merge, reset or stash. Git also maps what it fetched through the
// configured remote.origin.fetch (even one aimed at refs/heads), so the fetch goes to the
// configured URL, not the remote name: only the refspec on the command line applies, and nothing
// outside refs/remotes/origin/* is written. Sets origin/HEAD when it is missing.
const FETCH_ARGS = ['fetch', '--prune', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules'];
async function fetchCopy(dir, key, ctx, copy = 'store') {
  const env = authEnv(ctx.env, key);
  const url = await gitOut(['config', '--get', 'remote.origin.url'], dir);
  if (!url) return { ok: false, error: 'no origin remote' };
  const r = await G.git([...FETCH_ARGS, url, '+refs/heads/*:refs/remotes/origin/*'], { cwd: dir, env, timeoutMs: ctx.timeoutMs });
  if (!ok(r)) return { ok: false, error: forbiddenText(r.stderr) || G.firstLine(r.stderr) || 'fetch failed' };
  // Missing everywhere; dangling only on a store copy (a working copy's origin/HEAD is left to the person).
  const missing = !(await gitOut(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], dir));
  if (missing || (copy === 'store' && !(await readHead(dir)))) {
    await G.git(['remote', 'set-head', 'origin', '--auto'], { cwd: dir, env, timeoutMs: ctx.timeoutMs });
  }
  return { ok: true };
}

// Local edits, untracked or ignored files, or commits that exist nowhere on the server.
// Ignored files count: a checkout silently overwrites one the server has started to track.
async function localState(dir) {
  const st = await G.git(['status', '--porcelain', '-z', '--untracked-files=all', '--ignored'], { cwd: dir });
  const files = [];
  const parts = st.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].length < 4) continue;
    files.push(parts[i].slice(3));
    if (/[RC]/.test(parts[i].slice(0, 2))) i++;
  }
  const unpushed = await gitOut(['rev-list', '--count', 'HEAD', '--branches', '--not', '--remotes'], dir);
  // A failed inspection proves nothing is safe to discard: treat it as local work (fail closed).
  const unknown = !ok(st) || unpushed === null;
  return { changes: !ok(st) || files.length > 0, commits: unpushed === null || Number(unpushed) > 0, files, unknown };
}

async function dropLocalBranches(dir) {
  const heads = await gitOut(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], dir);
  for (const b of (heads || '').split('\n').filter(Boolean)) await G.git(['branch', '-D', '--quiet', b], { cwd: dir });
}

// Store copy only: detached at ref. Callers guarantee `dir` is the store copy, never a path.
async function detachAt(dir, ref, { discard = false } = {}) {
  if (discard) {
    await G.git(['reset', '--hard', '--quiet'], { cwd: dir });
    await G.git(['clean', '-fdxq'], { cwd: dir });
  }
  const r = await G.git(['checkout', '--quiet', '--detach', ref], { cwd: dir });
  if (!ok(r)) return G.firstLine(r.stderr) || 'checkout failed';
  await dropLocalBranches(dir);
  return null;
}

// --- ensure ----------------------------------------------------------------------------

// The project the person named (--org/--project); strings only.
function namedProject(args) {
  const str = (v) => (v && v !== true ? String(v).trim() : '');
  return { org: str(args.org), project: str(args.project) };
}

// --org/--project for a continuation, so the answer to a question resolves the same way.
function namedFlags(args) {
  const { org, project } = namedProject(args);
  return [org ? `--org ${L.quote(org)}` : '', project ? `--project ${L.quote(project)}` : ''].filter(Boolean).join(' ');
}

function makeCtx(args, deps) {
  const env = deps.env;
  const f = files(env);
  const config = readJson(f.config, null);
  const timeoutMs = Number(args.timeout ? Number(args.timeout) * 1000 : env.PROJECT_WORKSPACE_TIMEOUT_MS || G.DEFAULT_TIMEOUT_MS);
  const map = readJson(f.map, {});
  return { env, deps, files: f, config, map, base: JSON.parse(JSON.stringify(map)), now: deps.now(), home: homeOf(env), timeoutMs, fresh: Boolean(args.fresh), named: namedProject(args) };
}

const MAP_LOCK = { staleMs: 30000, waitMs: 5000 };

// Read-modify-write under repos.json.lock: the map is re-read inside the lock and only this
// command's changes are applied, so a concurrent command's registrations are never lost.
async function saveMap(ctx) {
  const release = await acquireLock(`${ctx.files.map}.lock`, MAP_LOCK);
  if (!release) throw new Error('the repository list is busy with another command; try again in a moment');
  try {
    const merged = L.mergeMapChanges(readJson(ctx.files.map, {}), ctx.base, ctx.map, realpath);
    writeJson(ctx.files.map, merged);
    ctx.map = merged;
    ctx.base = JSON.parse(JSON.stringify(merged));
  } finally {
    release();
  }
}

// "Contoso", "https://dev.azure.com/Contoso/" or "https://Contoso.visualstudio.com" → "Contoso".
function orgName(org) {
  const raw = String(org || '').trim();
  const url = /dev\.azure\.com\/([^/]+)/i.exec(raw) || /^https?:\/\/([^./]+)\.visualstudio\.com/i.exec(raw);
  return url ? url[1] : raw;
}

// An ordered, deduplicated list of { org, project }.
function projectList() {
  const seen = new Map();
  return {
    add(org, project) {
      const o = orgName(org), p = String(project || '').trim();
      if (o && p && !o.includes('/') && !seen.has(`${o}/${p}`.toLowerCase())) seen.set(`${o}/${p}`.toLowerCase(), { org: o, project: p });
    },
    list: () => [...seen.values()],
  };
}

// Azure DevOps projects a bare repository name may live in, deduplicated: ADO_ORG/ADO_PROJECT,
// boards in the map, the current folder's origin, the ado-credentials active context, az
// defaults (best effort).
async function candidateProjects(ctx) {
  const c = projectList();
  c.add(ctx.env.ADO_ORG, ctx.env.ADO_PROJECT);
  for (const e of Object.values(ctx.map)) if (e && e.board) c.add(e.board.org, e.board.project);
  const url = await gitOut(['config', '--get', 'remote.origin.url'], ctx.deps.cwd);
  const here = url && L.parseRepoUrl(url);
  if (here && here.kind === 'ado') c.add(here.org, here.project);
  const cred = readJson(path.join(ctx.home, '.ado-credentials', 'config.json'), null, { lenient: true });
  const active = cred && Array.isArray(cred.contexts) && cred.contexts.find((x) => x && x.name === cred.activeContext);
  if (active) c.add(active.organization, active.project);
  try {
    const out = ctx.deps.runAz(['devops', 'configure', '--list']);
    const get = (k) => (new RegExp(`^\\s*${k}\\s*=\\s*(.+?)\\s*$`, 'mi').exec(out) || [])[1];
    c.add(get('organization'), get('project'));
  } catch { /* az missing or not configured */ }
  return c.list();
}

// The projects named in this request, which win over every other source: --org and --project
// together (the person named the project), else the Azure DevOps links given in the same
// --repos list. `--org` or `--project` alone narrows whichever list applies.
function requestProjects(ctx, specs = []) {
  const { org, project } = ctx.named;
  if (org && project) return [{ org: orgName(org), project }];
  const c = projectList();
  for (const s of specs) {
    const p = L.parseRepoUrl(s);
    if (p && p.kind === 'ado') c.add(p.org, p.project);
  }
  return c.list();
}

// A bare name that is not in the map: the one project it can live in, or a question.
async function resolveBareName(ctx, spec) {
  let list = ctx.requestProjects && ctx.requestProjects.length ? ctx.requestProjects : null;
  if (!list) {
    if (!ctx.candidates) ctx.candidates = candidateProjects(ctx);
    list = await ctx.candidates;
  }
  const { org, project } = ctx.named;
  const narrowed = list.filter((c) => (!org || c.org.toLowerCase() === orgName(org).toLowerCase()) && (!project || c.project.toLowerCase() === project.toLowerCase()));
  if (narrowed.length) list = narrowed;
  if (list.length === 1) return { key: L.normaliseUrl(`${list[0].org}/${list[0].project}/${spec}`) };
  if (list.length) return { needs: 'which-project', repo: spec, projects: list.map((c) => `${c.org}/${c.project}`) };
  return { needs: 'repo-link', repo: spec };
}

// The normalised URL a link, org/project/repo or name stands for. { key } | { needs, ... } | { error }.
async function resolveKey(ctx, spec) {
  const found = L.findEntry(ctx.map, spec);
  const key = found ? found.key : L.normaliseUrl(spec);
  if (key) return { key };
  if (/^[^\s/\\:@]+$/.test(spec)) return resolveBareName(ctx, spec);
  return { error: `unknown repository "${spec}": give its link`, repo: spec };
}

const CLONE_LOCK_STALE_MS = 10 * 60000;

// Clones `key` into the store folder `dir` under `<dir>.lock`, so two processes never download
// into, or delete, the same folder. Removes only a folder this call created.
async function cloneStore(ctx, { dir, key, name, parsed }) {
  const release = await acquireLock(`${dir}.lock`, { staleMs: CLONE_LOCK_STALE_MS });
  if (!release) return { error: `${name} is being downloaded by another search right now; try again when it has finished`, repo: name };
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) return { cloned: false };
    const existed = fs.existsSync(dir);
    const r = await G.git(['clone', '--no-checkout', '--quiet', key, dir], { env: authEnv(ctx.env, key), timeoutMs: Math.max(ctx.timeoutMs, 600000) });
    if (!ok(r)) {
      if (!existed) fs.rmSync(dir, { recursive: true, force: true });
      const where = parsed.kind === 'ado' ? ` from ${parsed.org}/${parsed.project}` : '';
      return { error: `could not download ${name}${where}: it may not exist there, or you may not have access (${forbiddenText(r.stderr) || G.firstLine(r.stderr)})`, repo: name };
    }
    const ref = await defaultRef(dir, ctx);
    const err = ref ? await detachAt(dir, ref.full) : `${name} has no default branch`;
    return err ? { error: err, repo: name } : { cloned: true };
  } finally {
    release();
  }
}

// Resolves one repository to a searchable copy. Returns { info } | { needs, ... } | { error }.
async function ensureOne(ctx, spec, { approved = false, reset = false } = {}) {
  const resolved = await resolveKey(ctx, spec);
  if (!resolved.key) return resolved;
  const key = resolved.key;
  const parsed = L.parseRepoUrl(key) || { kind: 'other', repo: key };
  let entry = ctx.map[key] || {};
  const name = L.displayName(key, entry);
  const update = (patch) => { ctx.map = L.mergeEntry(ctx.map, key, patch); entry = ctx.map[key]; };
  if (!ctx.map[key]) update({ name, board: L.boardFromUrl(parsed) });

  // 1. A working copy the person already has: fetch only.
  let target = null, copy = null;
  for (const p of [...(entry.paths || [])]) {
    if (isRepo(p) && (await originKey(p)) === key) { target = p; copy = 'working'; break; }
    ctx.map = L.markStale(ctx.map, key, p); entry = ctx.map[key];
  }

  // 2. Else the store copy; cloned on consent.
  let cloned = false;
  if (!target) {
    const refRoot = ctx.config && ctx.config.referenceRoot;
    if (!refRoot) return { needs: 'setup', repo: name };
    let dir;
    try { dir = entry.reference && !notStore(ctx, entry.reference) ? entry.reference : L.storePath(refRoot, parsed); } catch (e) { return { error: e.message, repo: name }; }
    const refused = notStore(ctx, dir);
    if (refused) return { error: `refusing to use ${dir} as the shared copy of ${name}: ${refused}`, repo: name };
    if (!(fs.existsSync(dir) && fs.readdirSync(dir).length)) {
      if (!approved) return { needs: 'clone', repo: name, missing: { name, url: key, to: dir } };
      const c = await cloneStore(ctx, { dir, key, name, parsed });
      if (c.error) return c;
      cloned = c.cloned;
      if (cloned) update({ reference: dir, fetchedAt: ctx.now, fetchedPath: dir });
    }
    if (!cloned && (!isRepo(dir) || (await originKey(dir)) !== key)) return { error: `${dir} holds something other than ${name}`, repo: name };
    if (entry.reference !== dir) update({ reference: dir });
    target = dir; copy = 'store';
  }

  // 3. Freshness (D6).
  let offline = false, fetchError;
  const minutes = (ctx.config && ctx.config.fetchEveryMinutes) || L.DEFAULT_FETCH_MINUTES;
  const fetched = !cloned && L.shouldFetch({ fetchedAt: entry.fetchedAt, fetchedPath: entry.fetchedPath, target, now: ctx.now, minutes, fresh: ctx.fresh });
  if (fetched) {
    const f = await fetchCopy(target, key, ctx, copy);
    if (f.ok) update({ fetchedAt: ctx.now, fetchedPath: target });
    else { offline = true; fetchError = f.error; }
  }
  const ref = await defaultRef(target, ctx, copy);
  if (!ref) return { error: `${name} has no default branch on the server`, repo: name };

  // 4. The store copy follows the ref, detached and without branches; local edits or commits wait for a yes.
  if (copy === 'store' && !cloned) {
    // A registration may have landed during the fetch: under the map lock, the map and config are
    // read again and the containment check re-run, and the lock is held through the change.
    if (ctx.deps.beforeDestructive) await ctx.deps.beforeDestructive(target);
    const release = await acquireLock(`${ctx.files.map}.lock`, { staleMs: MAP_LOCK.staleMs, waitMs: 120000 });
    if (!release) return { error: 'the repository list is busy with another command; try again in a moment', repo: name };
    try {
      const fresh = { config: readJson(ctx.files.config, ctx.config), map: L.mergeMapChanges(readJson(ctx.files.map, {}), ctx.base, ctx.map, realpath) };
      const refused = notStore(fresh, target);
      if (refused) return { error: `refusing to change ${target}: ${refused}`, repo: name };
      const state = await localState(target);
      if ((state.changes || state.commits) && !reset) return { needs: 'reset', repo: name, url: key, ...state };
      const head = await gitOut(['rev-parse', 'HEAD'], target);
      const want = await gitOut(['rev-parse', '--verify', '--quiet', `${ref.full}^{commit}`], target);
      const attached = ok(await G.git(['symbolic-ref', '--quiet', 'HEAD'], { cwd: target }));
      const branches = await gitOut(['for-each-ref', '--format=%(refname)', 'refs/heads'], target);
      if (state.changes || state.commits || attached || branches || head !== want) {
        const err = await detachAt(target, ref.full, { discard: reset });
        if (err) return { error: err, repo: name };
      }
    } finally {
      release();
    }
  }

  const fetchedAt = entry.fetchedPath === target ? entry.fetchedAt || null : null;
  const info = { repo: name, url: key, path: target, copy, ref: ref.name, fetchedAt, ageMinutes: L.ageMinutes(fetchedAt, ctx.now), offline, fetched: fetched && !offline };
  if (fetchError) info.fetchError = fetchError;
  return { info, gitRef: ref.full };
}

function needsPayload(ctx, outcome, retry) {
  if (outcome.needs === 'setup') {
    const root = L.defaultReferenceRoot(ctx.home);
    return { ...L.needsSetup({ referenceRoot: root, home: ctx.home }), then: `setup --reference-root "${root}", then ${retry}` };
  }
  if (outcome.needs === 'which-project') return L.needsWhichProject(outcome.repo, outcome.projects, retry);
  if (outcome.needs === 'repo-link') return L.needsRepoLink(outcome.repo, retry);
  if (outcome.needs === 'reset') return L.needsResetConsent({ name: outcome.repo, url: outcome.url, changes: outcome.changes, commits: outcome.commits, files: outcome.files, retry });
  return null;
}

async function cmdEnsure(args, deps) {
  const spec = args._[1];
  if (!spec) return { error: 'ensure needs a repository link, org/project/repo or a known name' };
  const ctx = makeCtx(args, deps);
  const retry = [`ensure ${L.quote(spec)}`, namedFlags(args)].filter(Boolean).join(' ');
  if (!ctx.config) return needsPayload(ctx, { needs: 'setup' }, retry);
  ctx.requestProjects = requestProjects(ctx);
  const o = await ensureOne(ctx, spec, { approved: Boolean(args.approved), reset: Boolean(args.reset) });
  if (o.needs === 'clone') return L.needsCloneConsent([o.missing], { referenceRoot: ctx.config.referenceRoot, home: ctx.home });
  if (o.needs) return needsPayload(ctx, o, retry);
  await saveMap(ctx);
  return o.error ? { error: o.error } : o.info;
}

// --- search ----------------------------------------------------------------------------

function pickTargets(ctx, args) {
  if (args.repos && args.repos !== true) return String(args.repos).split(',').map((s) => s.trim()).filter(Boolean);
  const keys = Object.keys(ctx.map);
  if (args.all) return keys;
  if (args.project && args.project !== true) {
    const want = String(args.project).toLowerCase();
    return keys.filter((k) => {
      const e = ctx.map[k], p = L.parseRepoUrl(k) || {};
      return [e.board && e.board.project, p.project].some((x) => x && x.toLowerCase() === want);
    });
  }
  return null;
}

async function searchOne(ctx, info, ref, text, since) {
  const { path: dir } = info;
  const opts = { cwd: dir, timeoutMs: ctx.timeoutMs };
  const sinceArg = since ? [`--since=${since}`] : [];
  const fmt = `--format=${L.LOG_FORMAT}`;
  const [grep, msg, change] = await Promise.all([
    G.git(['grep', '-n', '-I', '-i', '-F', '--no-color', '--max-count=20', '-e', text, ref, '--'], opts),
    G.git(['log', ref, `-n${MAX_COMMITS}`, fmt, '-i', '-F', `--grep=${text}`, ...sinceArg, '--'], opts),
    G.git(['log', ref, `-n${MAX_COMMITS}`, fmt, `-S${text}`, ...sinceArg, '--'], opts),
  ]);
  // git grep exits 1 when nothing matches.
  for (const [r, okCodes] of [[grep, [0, 1]], [msg, [0]], [change, [0]]]) {
    if (!okCodes.includes(r.code)) throw new Error(r.timedOut ? 'search timed out' : G.firstLine(r.stderr) || 'git failed');
  }
  let hits = L.parseGrep(grep.stdout, ref);
  const truncated = hits.length > MAX_HITS;
  hits = hits.slice(0, MAX_HITS).map((h) => ({ ...h, path: path.join(dir, h.file) }));
  return { results: L.repoResults(info.repo, hits, L.parseLog(msg.stdout), L.parseLog(change.stdout)), truncated };
}

function retryCommand(args) {
  const parts = ['search', '--text', `"${args.text}"`];
  if (args.repos && args.repos !== true) parts.push('--repos', `"${args.repos}"`);
  if (args.org && args.org !== true) parts.push('--org', `"${args.org}"`);
  if (args.project && args.project !== true) parts.push('--project', `"${args.project}"`);
  if (args.all) parts.push('--all');
  if (args.since && args.since !== true) parts.push('--since', `"${args.since}"`);
  return parts.join(' ');
}

async function cmdSearch(args, deps) {
  const text = args.text;
  if (!text || text === true) return { error: 'search needs --text' };
  const ctx = makeCtx(args, deps);
  if (!ctx.config) return needsPayload(ctx, { needs: 'setup' }, retryCommand(args));
  const targets = pickTargets(ctx, args);
  if (!targets || !targets.length) {
    const known = Object.entries(ctx.map).map(([k, e]) => ({ name: L.displayName(k, e) }));
    return L.needsWhichRepos(known, text);
  }
  const retry = retryCommand(args);
  const approved = Boolean(args.approved);
  // Links in this --repos list name the project their bare siblings live in.
  ctx.requestProjects = requestProjects(ctx, targets);
  // Two names for one repository (Alpha, alpha, its link) are searched, and downloaded, once.
  const resolved = await G.pool(targets, CONCURRENCY, (t) => resolveKey(ctx, t));
  const unresolved = resolved.find((r) => r.needs);
  if (unresolved) return needsPayload(ctx, unresolved, retry);
  const seen = new Set();
  const unique = resolved.filter((r) => !r.key || (!seen.has(r.key.toLowerCase()) && seen.add(r.key.toLowerCase())));
  const ensured = await G.pool(unique, CONCURRENCY, (r) => (r.key ? ensureOne(ctx, r.key, { approved }) : r));

  const setup = ensured.find((o) => o.needs === 'setup');
  if (setup) return needsPayload(ctx, setup, retry);
  const missing = ensured.filter((o) => o.needs === 'clone').map((o) => o.missing);
  if (missing.length) { await saveMap(ctx); return L.needsCloneConsent(missing, { referenceRoot: ctx.config.referenceRoot, home: ctx.home, retry }); }
  const reset = ensured.find((o) => o.needs === 'reset');
  if (reset) { await saveMap(ctx); return needsPayload(ctx, reset, retry); }

  const outcomes = await G.pool(ensured, CONCURRENCY, async (o, i) => {
    if (o.error) return { repo: o.repo || unique[i].repo, error: o.error };
    try {
      const r = await searchOne(ctx, o.info, o.gitRef, text, args.since !== true ? args.since : undefined);
      return { repo: o.info.repo, info: { ...o.info, truncated: r.truncated || undefined }, results: r.results };
    } catch (e) {
      return { repo: o.info.repo, error: e.message };
    }
  });
  await saveMap(ctx);
  return { text, ...L.mergeResults(outcomes) };
}

// --- setup, where, register ------------------------------------------------------------

// Folders one or two levels below `root` that hold a git repository.
function scanRepos(root) {
  const found = [];
  const walk = (dir, depth) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of items) {
      if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
      const p = path.join(dir, d.name);
      if (isRepo(p)) found.push(p);
      else if (depth < 2) walk(p, depth + 1);
    }
  };
  walk(root, 1);
  return found;
}

async function registerPath(ctx, dir) {
  const top = await gitOut(['rev-parse', '--show-toplevel'], dir);
  if (!top) return { error: `${dir} is not inside a git repository` };
  const root = path.resolve(top);
  const url = await gitOut(['config', '--get', 'remote.origin.url'], root);
  const parsed = url && L.parseRepoUrl(url);
  if (!parsed) return { error: `${root} has no origin remote` };
  const inStore = !notStore(ctx, root);
  const prev = ctx.map[parsed.key] || {};
  ctx.map = L.mergeEntry(ctx.map, parsed.key, {
    name: prev.name || parsed.repo,
    board: L.boardFromUrl(parsed),
    ...(inStore ? { reference: root } : { paths: [root] }),
  });
  return { url: parsed.key, ...ctx.map[parsed.key] };
}

async function cmdRegister(args, deps) {
  const ctx = makeCtx(args, deps);
  const r = await registerPath(ctx, path.resolve(deps.cwd, args._[1] || '.'));
  if (!r.error) await saveMap(ctx);
  return r;
}

async function cmdSetup(args, deps) {
  const ctx = makeCtx(args, deps);
  const refRoot = expandHome(args['reference-root'], ctx.env);
  if (!refRoot) {
    const root = (ctx.config && ctx.config.referenceRoot) || L.defaultReferenceRoot(ctx.home);
    return { ...L.needsSetup({ referenceRoot: root, home: ctx.home }), current: ctx.config || undefined };
  }
  const workingRoot = expandHome(args['working-root'], ctx.env) || (ctx.config && ctx.config.workingRoot) || undefined;
  if (L.rootsConflict(realpath(refRoot), workingRoot && realpath(workingRoot), FOLD)) return { error: 'the shared store and the working folder must be separate folders, neither inside the other' };
  const clash = workingPaths(ctx.map).find((p) => overlaps(refRoot, p));
  if (clash) return { error: `the shared store must be separate from your own projects, neither inside the other: ${clash}` };
  fs.mkdirSync(refRoot, { recursive: true });
  ctx.config = { ...(ctx.config || {}), referenceRoot: refRoot, fetchEveryMinutes: (ctx.config && ctx.config.fetchEveryMinutes) || L.DEFAULT_FETCH_MINUTES };
  if (workingRoot) ctx.config.workingRoot = workingRoot;
  writeJson(ctx.files.config, ctx.config);

  const registered = [];
  if (workingRoot) {
    for (const dir of scanRepos(workingRoot)) {
      const r = await registerPath(ctx, dir);
      if (!r.error) registered.push({ name: r.name, path: dir });
    }
  }

  // Clones the earlier QA assistant kept in QA-Workspaces\<alias>\<repo>.
  const qaRoot = path.join(ctx.home, 'QA-Workspaces');
  const qa = [];
  for (const dir of fs.existsSync(qaRoot) ? scanRepos(qaRoot) : []) {
    const key = await originKey(dir);
    const parsed = key && L.parseRepoUrl(key);
    if (!parsed) continue;
    try { qa.push({ name: parsed.repo, from: dir, url: key, to: L.storePath(refRoot, parsed) }); } catch { /* unsafe location: leave it where it is */ }
  }
  const moved = [], notMoved = [];
  if (args['move-qa']) {
    for (const q of qa) {
      if (fs.existsSync(q.to)) { notMoved.push({ ...q, reason: 'already in the store' }); continue; }
      const refused = notStore(ctx, q.to);
      if (refused) { notMoved.push({ ...q, reason: refused }); continue; }
      try {
        fs.mkdirSync(path.dirname(q.to), { recursive: true });
        fs.renameSync(q.from, q.to);
        ctx.map = L.mergeEntry(ctx.map, q.url, { name: (ctx.map[q.url] || {}).name || q.name, reference: q.to, board: L.boardFromUrl(L.parseRepoUrl(q.url)) });
        moved.push(q);
      } catch (e) { notMoved.push({ ...q, reason: e.code === 'EXDEV' ? 'on another drive' : e.message }); }
    }
  }
  await saveMap(ctx);
  const out = { referenceRoot: refRoot, workingRoot: workingRoot || null, fetchEveryMinutes: ctx.config.fetchEveryMinutes, registered };
  if (args['move-qa']) Object.assign(out, { moved, notMoved });
  else if (qa.length) Object.assign(out, L.needsMoveQa(qa, refRoot), { qaWorkspaces: qa });
  return out;
}

async function cmdWhere(args, deps) {
  const ctx = makeCtx(args, deps);
  const repos = Object.entries(ctx.map).map(([url, e]) => ({
    name: L.displayName(url, e), url, paths: e.paths || [], stale: e.stale || [], reference: e.reference || null,
    board: e.board || null, fetchedAt: e.fetchedAt || null, ageMinutes: L.ageMinutes(e.fetchedAt, ctx.now),
  }));
  const out = { referenceRoot: ctx.config ? ctx.config.referenceRoot : null, workingRoot: (ctx.config && ctx.config.workingRoot) || null, repos };
  if (!ctx.config) Object.assign(out, L.needsSetup({ referenceRoot: L.defaultReferenceRoot(ctx.home), home: ctx.home }));
  return out;
}

// --- link-board ------------------------------------------------------------------------

async function cmdLinkBoard(args, deps) {
  const spec = args._[1];
  if (!spec) return { error: 'link-board needs a repository' };
  const ctx = makeCtx(args, deps);
  const found = L.findEntry(ctx.map, spec);
  const key = found ? found.key : L.normaliseUrl(spec);
  if (!key) return { error: `unknown repository "${spec}": give its link` };
  const parsed = L.parseRepoUrl(key) || {};
  const entry = ctx.map[key] || {};
  const name = L.displayName(key, entry);
  const orgRaw = (args.org !== true && args.org) || (entry.board && entry.board.org) || (parsed.kind === 'ado' && parsed.org);
  const org = orgRaw ? orgName(orgRaw) : orgRaw;
  const project = (args.project !== true && args.project) || (entry.board && entry.board.project) || (parsed.kind === 'ado' && parsed.project);
  if (!org || !project) return { error: `${name} is not in Azure DevOps: give the board's organization and project` };

  if (args.team && args.team !== true) {
    const board = { org, project };
    if (String(args.team).toLowerCase() !== 'none') board.team = String(args.team);
    ctx.map = L.mergeEntry(ctx.map, key, { name, board });
    if (!board.team) delete ctx.map[key].board.team;
    await saveMap(ctx);
    return { url: key, ...ctx.map[key] };
  }
  let teams;
  try {
    const auth = ado.resolveAuth(ctx.env, deps.runAz);
    const url = ado.apiUrl(`https://dev.azure.com/${encodeURIComponent(org)}`, `_apis/projects/${encodeURIComponent(project)}/teams`, { $top: '500' });
    const body = await ado.request(auth, 'GET', url, undefined, { fetch: deps.fetch, timeoutMs: 20000 });
    teams = ((body && body.value) || []).map((t) => t.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
  } catch (e) {
    return { error: `could not list the teams of ${project}: ${e.message}` };
  }
  const target = [L.quote(key), args.org && args.org !== true ? `--org ${L.quote(org)}` : '', args.project && args.project !== true ? `--project ${L.quote(project)}` : ''].filter(Boolean).join(' ');
  return L.needsBoardChoice(name, teams, target);
}

// --- main ------------------------------------------------------------------------------

const COMMANDS = { setup: cmdSetup, where: cmdWhere, register: cmdRegister, ensure: cmdEnsure, search: cmdSearch, 'link-board': cmdLinkBoard };

async function run(argv, deps = defaultDeps()) {
  const args = parseArgs(argv);
  const cmd = COMMANDS[args._[0]];
  if (!cmd) return { error: `usage: workspace.js <${Object.keys(COMMANDS).join('|')}> …` };
  try {
    return await cmd(args, { ...defaultDeps(), ...deps });
  } catch (e) {
    return { error: e.message };
  }
}

async function main(argv, deps) {
  const out = await run(argv, deps);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return out && out.error ? 1 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { run, main, parseArgs, ensureOne, files, acquireLock };
