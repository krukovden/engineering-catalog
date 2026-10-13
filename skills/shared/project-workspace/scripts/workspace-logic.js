'use strict';
// Pure decisions for project-workspace: URL keys, the map, store paths, the fetch throttle,
// `needs` payloads and merged search results. No I/O here.
const path = require('path');

const DEFAULT_FETCH_MINUTES = 10;

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}
const enc = (s) => encodeURIComponent(safeDecode(s));
const stripGit = (s) => s.replace(/\.git$/i, '');

// One key per repository whatever form `origin` uses. Returns
// { key, kind: 'ado'|'github'|'local'|'other', org?, project?, repo, host? } or null.
function parseRepoUrl(input) {
  const raw = String(input || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  let m;
  const ado = (org, project, repo) => {
    const o = safeDecode(org), p = safeDecode(project), r = stripGit(safeDecode(repo));
    return { kind: 'ado', org: o, project: p, repo: r, key: `https://dev.azure.com/${enc(o)}/${enc(p)}/_git/${enc(r)}` };
  };
  // git@ssh.dev.azure.com:v3/org/project/repo, org@vs-ssh.visualstudio.com:v3/org/project/repo
  if ((m = /^(?:ssh:\/\/)?[^@/]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::\d+)?[:/]v3\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(raw))) return ado(m[1], m[2], m[3]);
  // https://[user@]dev.azure.com/org/project/_git/repo
  if ((m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i.exec(raw))) return ado(m[1], m[2], m[3]);
  // https://org.visualstudio.com/[DefaultCollection/]project/_git/repo
  if ((m = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i.exec(raw))) return ado(m[1], m[2], m[3]);
  // GitHub, https or ssh
  if ((m = /^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/git@)github\.com[:/]([^/]+)\/([^/?#]+)$/i.exec(raw))) {
    const repo = stripGit(m[2]);
    return { kind: 'github', org: m[1], repo, key: `https://github.com/${m[1]}/${repo}` };
  }
  // A local path (a bare repository used as origin).
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    return { kind: 'local', repo: path.basename(stripGit(raw.replace(/[\\/]+$/, ''))), key: raw };
  }
  // Anything else with a scheme: lower-case host, no credentials, no .git
  if ((m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]+@)?([^/]*)(\/.*)?$/i.exec(raw))) {
    const scheme = m[1].toLowerCase();
    if (scheme === 'file') {
      const p = safeDecode(m[3] || '/');
      return { kind: 'local', repo: path.basename(stripGit(p)), key: p };
    }
    const p = stripGit(m[3] || '');
    return { kind: 'other', host: m[2].toLowerCase(), repo: path.basename(p), key: `${scheme}://${m[2].toLowerCase()}${p}` };
  }
  // scp-like user@host:path
  if ((m = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(raw))) {
    const p = stripGit(m[2]).replace(/^\/+/, '');
    return { kind: 'other', host: m[1].toLowerCase(), repo: path.basename(p), key: `ssh://${m[1].toLowerCase()}/${p}` };
  }
  // org/project/repo shorthand (Azure DevOps)
  if ((m = /^([^/:\s.][^/:\s]*)\/([^/:]+)\/([^/:\s]+)$/.exec(raw))) return ado(m[1], m[2], m[3]);
  return null;
}

const normaliseUrl = (u) => (parseRepoUrl(u) || {}).key || null;

// A decoded URL segment becomes one directory name: no separators, no dot names, no NUL.
const unsafeSegment = (s) => !s || /[\\/\0]/.test(s) || s === '.' || s === '..';

// Throws when a segment is unsafe or the result would leave `referenceRoot`.
function storePath(referenceRoot, parsed) {
  let segments;
  if (parsed.kind === 'ado') segments = [parsed.org, parsed.project, parsed.repo];
  else if (parsed.kind === 'github') segments = ['github.com', parsed.org, parsed.repo];
  else if (parsed.kind === 'other') segments = [parsed.host, parsed.repo];
  else segments = ['local', parsed.repo];
  const bad = segments.find((s) => unsafeSegment(String(s == null ? '' : s)));
  if (bad !== undefined) throw new Error(`unsafe repository location (${JSON.stringify(bad)}): refusing to use it in the shared store`);
  const result = path.join(referenceRoot, ...segments);
  const rel = path.relative(path.resolve(referenceRoot), path.resolve(result));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('unsafe repository location: it resolves outside the shared store');
  return result;
}

const defaultReferenceRoot = (home) => path.join(home, 'Documents', 'Projects', '.reference');

// `fold`: compare case-insensitively (Windows and macOS file systems).
const isInside = (child, parent, fold = false) => {
  let c = path.resolve(child), p = path.resolve(parent);
  if (fold) { c = c.toLowerCase(); p = p.toLowerCase(); }
  const rel = path.relative(p, c);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// D4: the store and the working root never overlap. Callers pass real paths.
function rootsConflict(referenceRoot, workingRoot, fold = false) {
  if (!workingRoot) return false;
  return isInside(referenceRoot, workingRoot, fold) || isInside(workingRoot, referenceRoot, fold);
}

const uniq = (xs) => [...new Set(xs.filter(Boolean))];

// Merges a patch into one map entry. `paths` and `stale` are sets; a path re-added leaves `stale`.
function mergeEntry(map, key, patch = {}) {
  const prev = map[key] || { name: '', paths: [], stale: [] };
  const next = { ...prev, ...patch };
  next.paths = uniq([...(prev.paths || []), ...(patch.paths || [])]);
  next.stale = uniq([...(prev.stale || []), ...(patch.stale || [])]).filter((p) => !(patch.paths || []).includes(p));
  if (patch.board || prev.board) next.board = { ...(prev.board || {}), ...(patch.board || {}) };
  else delete next.board;
  return { ...map, [key]: next };
}

// Applies this process's changes (base → mine) onto the map now on disk, field by field, so a
// concurrent writer's other repositories and untouched fields survive. `paths` and `stale` are
// sets: this process's additions and removals are applied to the disk's lists, never replacing
// them; `canon` maps a path to its real location so spellings of one folder count once.
function mergeMapChanges(disk, base, mine, canon = (p) => p) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const dedupe = (xs) => { const seen = new Set(); return xs.filter((p) => { const k = canon(p); return !seen.has(k) && seen.add(k); }); };
  const union = (d, was, now) => {
    const w = new Set((was || []).map(canon)), n = new Set((now || []).map(canon));
    const gone = new Set([...w].filter((k) => !n.has(k)));
    return dedupe([...(d || []), ...(now || []).filter((p) => !w.has(canon(p)))]).filter((p) => !gone.has(canon(p)));
  };
  const out = { ...disk };
  for (const key of new Set([...Object.keys(base), ...Object.keys(mine)])) {
    if (same(base[key], mine[key])) continue;
    if (mine[key] === undefined) { delete out[key]; continue; }
    const was = base[key] || {}, now = mine[key], next = { ...(out[key] || {}) };
    for (const f of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (same(was[f], now[f])) continue;
      if (now[f] === undefined) delete next[f];
      else if (f === 'paths' || f === 'stale') next[f] = union(next[f], was[f], now[f]);
      else next[f] = now[f];
    }
    if (next.paths && next.stale) {
      const live = new Set(next.paths.map(canon));
      next.stale = next.stale.filter((p) => !live.has(canon(p)));
    }
    out[key] = next;
  }
  return out;
}

function markStale(map, key, badPath) {
  const e = map[key];
  if (!e) return map;
  return { ...map, [key]: { ...e, paths: (e.paths || []).filter((p) => p !== badPath), stale: uniq([...(e.stale || []), badPath]) } };
}

// Board defaults from the URL: Azure Repos carry org and project; the team comes later or never.
function boardFromUrl(parsed) {
  return parsed && parsed.kind === 'ado' ? { org: parsed.org, project: parsed.project } : undefined;
}

function ageMinutes(fetchedAt, now) {
  if (!fetchedAt) return null;
  const ms = Date.parse(now) - Date.parse(fetchedAt);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 60000)) : null;
}

// D6: fetch at most once per window per copy; --fresh forces it.
function shouldFetch({ fetchedAt, fetchedPath, target, now, minutes = DEFAULT_FETCH_MINUTES, fresh = false }) {
  if (fresh || !fetchedAt || fetchedPath !== target) return true;
  const age = ageMinutes(fetchedAt, now);
  return age === null || age >= minutes;
}

// Finds a map entry by key, URL/spec, or repository name (case-insensitive).
function findEntry(map, spec) {
  if (!spec) return null;
  if (map[spec]) return { key: spec, entry: map[spec] };
  const key = normaliseUrl(spec);
  if (key && map[key]) return { key, entry: map[key] };
  const lower = String(spec).toLowerCase();
  const hits = Object.entries(map).filter(([, e]) => (e.name || '').toLowerCase() === lower);
  if (hits.length === 1) return { key: hits[0][0], entry: hits[0][1] };
  return null;
}

function displayName(key, entry) {
  return (entry && entry.name) || (parseRepoUrl(key) || {}).repo || key;
}

function humanPath(p, home) {
  if (!home || !isInside(p, home)) return p;
  return path.join('~', path.relative(path.resolve(home), path.resolve(p)));
}

const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

// --- needs payloads (D10) --------------------------------------------------------------

function needsSetup({ referenceRoot, home }) {
  return {
    needs: 'setup',
    ask: `I'll keep copies of projects in ${humanPath(referenceRoot, home)}. Is that fine, or should I use another folder?`,
    options: ['yes', 'another folder'],
    defaults: { referenceRoot },
    then: `setup --reference-root ${quote(referenceRoot)}`,
  };
}

function listNames(names) {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function needsCloneConsent(missing, { referenceRoot, home, retry }) {
  const list = listNames(missing.map((m) => m.name));
  const one = missing.length === 1;
  return {
    needs: 'clone-consent',
    ask: `${list} ${one ? 'is' : 'are'} not on this computer. Download ${one ? 'it' : 'them'} to the shared store (${humanPath(referenceRoot, home)})?`,
    options: ['yes', `no — skip ${list}`],
    repos: missing,
    then: retry ? `${retry} --approved` : `ensure ${quote(missing[0].url)} --approved`,
  };
}

function needsMoveQa(found, referenceRoot) {
  const n = found.length, one = n === 1;
  return {
    needs: 'move-qa-workspaces',
    ask: `I found ${n} project${one ? '' : 's'} the bug-filing assistant downloaded earlier. Move ${one ? 'it' : 'them'} into the new folder so ${one ? 'it is' : 'they are'} not downloaded twice?`,
    options: ['yes', 'no — leave them'],
    then: `setup --reference-root ${quote(referenceRoot)} --move-qa`,
  };
}

function needsWhichRepos(known, text) {
  const names = known.map((k) => k.name);
  return {
    needs: 'which-repos',
    ask: names.length
      ? `Which repositories should I search? I know ${listNames(names)}.`
      : 'Which repositories should I search? Give me their names or links.',
    options: names.length ? ['all of them', ...names] : [],
    then: `search --text ${quote(text)} --repos <names, comma-separated> | --all`,
  };
}

function needsResetConsent({ name, url, changes, commits, files = [], retry }) {
  const shown = files.slice(0, 5);
  const list = shown.length ? ` (${listNames(files.length > shown.length ? [...shown, `${files.length - shown.length} more`] : shown)})` : '';
  const what = [changes ? `changed files${list}` : '', commits ? 'commits nobody pushed' : ''].filter(Boolean).join(' and ');
  return {
    needs: 'reset-consent',
    ask: `The shared copy of ${name} has ${what} that are not on the server. Throw them away and bring the copy back to the server's version?`,
    options: ['yes — discard them', `no — skip ${name}`],
    repo: { name, url },
    files,
    then: `ensure ${quote(url)} --reset` + (retry ? `, then ${retry}` : ''),
  };
}

function needsWhichProject(name, projects, retry) {
  return {
    needs: 'which-project',
    ask: `Which Azure DevOps project is ${name} in?`,
    options: projects,
    repo: name,
    then: `${retry}, with "<org>/<project>/${name}" written in place of "${name}"`,
  };
}

function needsRepoLink(name, retry) {
  return {
    needs: 'repo-link',
    ask: `I don't know where ${name} lives. Paste the link to it from Azure DevOps (the address of the repository page).`,
    options: [],
    repo: name,
    then: `${retry}, with the link written in place of "${name}"`,
  };
}

// `target`: the resolved repository URL (plus --org/--project when given), so the
// continuation works for a repository that is not in the map yet.
function needsBoardChoice(name, teams, target = quote(name)) {
  return {
    needs: 'board-choice',
    ask: `Which team's board does ${name} belong to?`,
    options: [...teams, 'none'],
    then: `link-board ${target} --team "<team>"`,
  };
}

// --- search output ---------------------------------------------------------------------

// `git grep -n <ref>` prints `<ref>:<file>:<line>:<text>`.
function parseGrep(out, ref) {
  const prefix = ref + ':';
  const hits = [];
  for (const line of String(out || '').split('\n')) {
    if (!line.startsWith(prefix)) continue;
    const m = /^(.*?):(\d+):(.*)$/.exec(line.slice(prefix.length));
    if (m) hits.push({ file: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 300) });
  }
  return hits;
}

const LOG_FORMAT = '%H%x1f%an%x1f%aI%x1f%s';
function parseLog(out) {
  return String(out || '').split('\n').filter(Boolean).map((l) => {
    const [commit, author, date, subject] = l.split('\x1f');
    return { commit, author, date, subject };
  }).filter((c) => c.commit && /^[0-9a-f]{7,64}$/.test(c.commit));
}

// One repository's grep hits plus message (--grep) and change (-S) commits → one list.
function repoResults(repo, grepHits, messageCommits, changeCommits) {
  const commits = new Map();
  for (const [list, why] of [[messageCommits, 'message'], [changeCommits, 'change']]) {
    for (const c of list) {
      const prev = commits.get(c.commit);
      if (prev) { if (!prev.match.includes(why)) prev.match.push(why); } else commits.set(c.commit, { ...c, match: [why] });
    }
  }
  return [
    ...grepHits.map((h) => ({ repo, kind: 'code', ...h })),
    ...[...commits.values()].map((c) => ({ repo, kind: 'commit', ...c })),
  ];
}

// Per-repository outcomes → the merged answer. One failure never hides the others.
function mergeResults(outcomes) {
  const results = [], repos = [], failed = [];
  for (const o of outcomes) {
    if (o.error) { failed.push({ repo: o.repo, error: o.error }); continue; }
    repos.push(o.info);
    results.push(...o.results);
  }
  const withHits = new Set(results.map((r) => r.repo));
  return {
    results,
    repos,
    found: { in: withHits.size, of: repos.length + failed.length },
    failed,
    partial: failed.length > 0,
    offline: repos.some((r) => r.offline),
    // Age of the oldest copy searched, on every result; null when no repository was searched.
    ageMinutes: repos.length ? repos.reduce((a, r) => (r.ageMinutes == null || a == null ? null : Math.max(a, r.ageMinutes)), 0) : null,
  };
}

module.exports = {
  DEFAULT_FETCH_MINUTES, LOG_FORMAT,
  parseRepoUrl, normaliseUrl, storePath, defaultReferenceRoot, isInside, rootsConflict,
  mergeEntry, mergeMapChanges, markStale, boardFromUrl, ageMinutes, shouldFetch, findEntry, displayName, humanPath,
  needsSetup, needsMoveQa, needsCloneConsent, needsWhichRepos, needsResetConsent, needsBoardChoice, needsWhichProject, needsRepoLink, quote,
  parseGrep, parseLog, repoResults, mergeResults,
};
