'use strict';
// Pure logic for ado-board: no I/O, no network, no clock (callers pass `now`).
// Everything here is tested offline against fixtures in test/fixtures/ado-board.

const BUCKETS = ['todo', 'doing', 'testing', 'verify', 'done'];
const RANK = { todo: 0, doing: 1, testing: 2, verify: 3, done: 4 };
// Azure DevOps state categories (verify against your organisation's process). Resolved is
// `verify`, not done: for a Bug it means "awaiting QA verification". Removed is never touched.
const CATEGORY_BUCKET = { Proposed: 'todo', InProgress: 'doing', Resolved: 'verify', Completed: 'done', Removed: 'removed' };
// A state named like a testing or acceptance step, in any category but Completed and Removed,
// is `testing`: a completed PR proves the code merged, not that anyone tested it.
const TESTING_RE = /test|acceptance|verif|qa\b|review/i;
const looksTesting = (name, bucket) => TESTING_RE.test(String(name)) && bucket !== 'done' && bucket !== 'removed';
// Work item types that never sit on a delivery board; `states discover` skips them by default.
const NON_BOARD_TYPES = new Set([
  'Test Case', 'Test Plan', 'Test Suite', 'Shared Steps', 'Shared Parameter',
  'Code Review Request', 'Code Review Response', 'Feedback Request', 'Feedback Response',
]);
const MAP_VERSION = 1;

// --- states discover -------------------------------------------------------------------

// `choices` is { "<type>:<bucket>": "<state>" }. Returns the type's map plus any bucket that
// holds two states and has no choice yet.
function mapType(type, states, choices = {}) {
  const byState = {};
  const byBucket = {};
  for (const s of states || []) {
    let bucket = CATEGORY_BUCKET[s.category];
    if (!bucket) continue;
    if (looksTesting(s.name, bucket)) bucket = 'testing';
    byState[s.name] = bucket;
    if (bucket === 'removed') continue;
    (byBucket[bucket] = byBucket[bucket] || []).push(s.name);
  }
  const targets = {};
  const ambiguous = [];
  for (const bucket of BUCKETS) {
    const names = byBucket[bucket];
    if (!names) continue;
    if (names.length === 1) { targets[bucket] = names[0]; continue; }
    const chosen = choices[`${type}:${bucket}`];
    if (chosen && names.includes(chosen)) targets[bucket] = chosen;
    else ambiguous.push({ type, bucket, states: names });
  }
  return { states: byState, targets, ambiguous };
}

// "Product Backlog Item:todo=New;Bug:todo=New" -> { "Product Backlog Item:todo": "New", ... }
function parseChoices(text) {
  const out = {};
  for (const part of [].concat(text || []).join(';').split(';')) {
    const m = /^\s*(.+?):(todo|doing|testing|verify|done)\s*=\s*(.+?)\s*$/.exec(part);
    if (m) out[`${m[1]}:${m[2]}`] = m[3];
  }
  return out;
}

// The targets an earlier map settled, as choices: an ambiguous bucket is asked once, not on
// every rediscovery.
function priorChoices(existing) {
  const out = {};
  for (const [type, t] of Object.entries((existing && existing.types) || {})) {
    for (const [bucket, state] of Object.entries((t && t.targets) || {})) out[`${type}:${bucket}`] = state;
  }
  return out;
}

// `types` is { "<type name>": [{ name, category }] }. The map is complete only when
// `ambiguous` is empty; the caller asks the user once and re-runs with the choices.
// `existing` (same organization and project) is merged into, not replaced: its choices are
// reused unless `choices` overrides them, types not rediscovered stay, unknown fields stay.
function buildMap({ organization, project, types, choices = {}, now, existing = null }) {
  const prior = existing && existing.organization === organization && existing.project === project ? existing : null;
  const all = { ...priorChoices(prior), ...choices };
  const map = { ...(prior || {}), version: MAP_VERSION, organization, project, discovered: now, types: { ...((prior && prior.types) || {}) } };
  const ambiguous = [];
  for (const [type, states] of Object.entries(types)) {
    const t = mapType(type, states, all);
    map.types[type] = { ...(map.types[type] || {}), states: t.states, targets: t.targets };
    ambiguous.push(...t.ambiguous);
  }
  return { map, ambiguous };
}

function sameMap(a, b) {
  if (!a || !b) return false;
  return JSON.stringify({
    version: a.version == null ? 0 : a.version,
    organization: a.organization,
    project: a.project,
    types: a.types || {},
  }) === JSON.stringify({
    version: b.version == null ? 0 : b.version,
    organization: b.organization,
    project: b.project,
    types: b.types || {},
  });
}

// The runner's contract: { "<type>": { todo, doing, verify?, done } }, state names. `verify` is the
// testing state when the type has one, else its Resolved (verify) state.
function stateMap(map) {
  const out = {};
  for (const [type, t] of Object.entries((map && map.types) || {})) {
    const g = (t && t.targets) || {};
    const entry = {};
    for (const [key, state] of [['todo', g.todo], ['doing', g.doing], ['verify', g.testing || g.verify], ['done', g.done]]) if (state) entry[key] = state;
    out[type] = entry;
  }
  return out;
}

// `verify` means the testing bucket for a type that has testing states and no Resolved state;
// otherwise it is the Resolved bucket.
function resolveBucket(map, type, bucket) {
  const g = (map && map.types && map.types[type] && map.types[type].targets) || {};
  return bucket === 'verify' && g.testing && !g.verify ? 'testing' : bucket;
}

function boardTypes(list) {
  return (list || []).filter((t) => t && t.name && !t.isDisabled && !NON_BOARD_TYPES.has(t.name)).map((t) => t.name);
}

// --- one transition --------------------------------------------------------------------

function bucketOf(map, type, state) {
  const t = map && map.types && map.types[type];
  if (!t) return null;
  return t.states[state] || null;
}

function hasIdpTag(tags) {
  return String(tags || '').split(';').some((t) => /^idp:/i.test(t.trim()));
}

const isBug = (type) => type === 'Bug';

// Decides one move. `allowIdp` is for the platform's runner, the only writer of idp: cards.
function checkMove({ map, item, bucket: asked, allowIdp = false }) {
  const bucket = resolveBucket(map, item.type, asked);
  const base = { id: item.id, type: item.type, fromState: item.state, rev: item.rev };
  if (!BUCKETS.includes(bucket)) return { ...base, ok: false, code: 'bad-bucket', reason: `bucket must be one of ${BUCKETS.join(', ')}` };
  if (!map.types[item.type]) return { ...base, ok: false, code: 'unknown-type', reason: `type "${item.type}" is not in the state map: run states discover` };
  const from = bucketOf(map, item.type, item.state);
  if (from === 'removed') return { ...base, ok: false, code: 'removed', reason: `"${item.state}" is Removed; ado-board never touches it` };
  if (!from) return { ...base, ok: false, code: 'unknown-state', reason: `state "${item.state}" is not in the map for ${item.type}: run states discover` };
  if (hasIdpTag(item.tags) && !allowIdp) return { ...base, ok: false, code: 'idp', reason: 'carries an idp: tag; the platform runner is the only writer' };
  const toState = map.types[item.type].targets[bucket];
  if (!toState) return { ...base, from, ok: false, code: 'no-target', reason: `${item.type} has no state for "${bucket}"` };
  if (RANK[bucket] === RANK[from]) return { ...base, from, to: bucket, ok: false, code: 'same', reason: `already ${from} (${item.state})` };
  if (RANK[bucket] < RANK[from]) return { ...base, from, to: bucket, ok: false, code: 'backwards', reason: `${from} -> ${bucket} is backwards; ado-board moves forward only` };
  return { ...base, from, to: bucket, toState, ok: true };
}

const hasTesting = (map, type) => {
  const t = map && map.types && map.types[type];
  return !!t && Object.values(t.states || {}).includes('testing');
};

// A map discovered before the `testing` bucket existed files testing states under doing or
// verify. Such a type is not reconciled on PR evidence until `states discover` runs again.
function staleTestingStates(map, type) {
  const t = map && map.types && map.types[type];
  if (!t || hasTesting(map, type)) return [];
  return Object.entries(t.states || {}).filter(([name, bucket]) => looksTesting(name, bucket)).map(([name]) => name);
}

// The bucket a completed PR earns: `testing` when the type has testing states (done stays a
// person's move), else `verify` for a Bug when its type has one, else `done`.
function completedBucket(map, type) {
  const t = map.types[type];
  if (hasTesting(map, type)) return 'testing';
  return isBug(type) && t && t.targets.verify ? 'verify' : 'done';
}

// json-patch body for one transition plus the evidence comment, in a single revision. The
// `test /rev` op makes the server refuse the write when the item changed after it was read.
function movePatch(rev, toState, comment) {
  const ops = [{ op: 'test', path: '/rev', value: rev }, { op: 'add', path: '/fields/System.State', value: toState }];
  if (comment) ops.push({ op: 'add', path: '/fields/System.History', value: comment });
  return ops;
}

// A refused transition names the field it needs (verify: TF401320 rule-validation shape).
function requiredFieldFromError(body) {
  if (!body || typeof body !== 'object') return null;
  const rules = body.customProperties && body.customProperties.RuleValidationErrors;
  if (Array.isArray(rules)) {
    for (const r of rules) {
      const flags = `${r.fieldStatusFlags || ''} ${r.errorMessage || ''}`;
      if (/required|invalidempty/i.test(flags)) {
        const named = /Rule Error for field ([^.]+)\./.exec(r.errorMessage || '');
        return { field: r.fieldReferenceName || null, name: named ? named[1] : r.fieldReferenceName };
      }
    }
  }
  const m = /TF401320: Rule Error for field ([^.]+)\. Error code: ([^.]+)/.exec(body.message || '');
  if (m && /Required|InvalidEmpty/i.test(m[2])) return { field: null, name: m[1] };
  return null;
}

// --- git and PR facts ------------------------------------------------------------------

function branchWorkItemId(name) {
  const m = /^(?:refs\/heads\/)?(?:feature|bug)\/ADO-(\d+)(?:[-/_]|$)/i.exec(String(name || ''));
  return m ? Number(m[1]) : null;
}

const shortBranch = (name) => String(name || '').replace(/^refs\/heads\//, '');

// feat(123) / fix(123) / bug(123), also feat(123,124): the PR title convention of ado-pull-request.
function titleWorkItemIds(title) {
  const m = /^\s*(?:feat|fix|bug)\(\s*(\d+(?:\s*,\s*\d+)*)\s*\)/i.exec(String(title || ''));
  return m ? m[1].split(',').map((x) => Number(x.trim())) : [];
}

// https://dev.azure.com/ORG/PROJECT/_git/REPO, https://ORG.visualstudio.com/[DefaultCollection/]PROJECT/_git/REPO,
// git@ssh.dev.azure.com:v3/ORG/PROJECT/REPO, ORG@vs-ssh.visualstudio.com:v3/ORG/PROJECT/REPO.
function parseRemoteUrl(url) {
  const u = String(url || '').trim();
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  let m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?$/i.exec(u);
  if (m) return { org: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  m = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?$/i.exec(u);
  if (m) return { org: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  m = /^(?:ssh:\/\/)?[^@]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::|\/)v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(u);
  if (m) return { org: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  return null;
}

// --- reconcile -------------------------------------------------------------------------

const DAY = 86400000;
const toMs = (d) => (d ? Date.parse(d) : NaN);

/**
 * Stateless reconcile plan. Inputs are facts, read fresh each run:
 *   branches: [{ name, ahead, date }]       pushed branches of this repository
 *   prs:      [{ id, title, sourceRefName, closedDate, workItemIds, transitionWorkItems }]  completed PRs
 *   items:    { [id]: { id, rev, type, state, tags, title, stateChangeDate } }
 * Returns { moves, skipped, observed, waiting, reports }. Running the moves and planning again
 * yields no moves: the plan is idempotent.
 */
function planReconcile({ map, branches = [], prs = [], items = {}, now, staleDays = 5, graceMinutes = 10, defaultBranch = 'main' }) {
  const nowMs = toMs(now);
  const claims = new Map(); // id -> [{ bucket, evidence, source }]
  const claim = (id, c) => { if (!claims.has(id)) claims.set(id, []); claims.get(id).push(c); };
  const waitingIds = new Map();

  for (const b of branches) {
    const id = branchWorkItemId(b.name);
    if (id && b.ahead > 0) claim(id, { bucket: 'doing', source: 'branch', evidence: `branch ${shortBranch(b.name)} has ${b.ahead} pushed commit(s)${b.commit ? ` (${String(b.commit).slice(0, 7)})` : ''}` });
  }
  for (const pr of prs) {
    const ids = new Set([...(pr.workItemIds || []), ...titleWorkItemIds(pr.title)]);
    const fromBranch = branchWorkItemId(pr.sourceRefName);
    if (fromBranch) ids.add(fromBranch);
    // Do not race the server's "complete linked work items": let it act first, recover later.
    const fresh = pr.transitionWorkItems && nowMs - toMs(pr.closedDate) < graceMinutes * 60000;
    for (const id of ids) {
      if (fresh) { waitingIds.set(id, `PR ${pr.id} completed ${pr.closedDate}; the server's own transition gets ${graceMinutes} minutes first`); continue; }
      claim(id, { bucket: null, source: 'pr', evidence: `PR ${pr.id} "${pr.title}" completed ${pr.closedDate}` });
    }
  }

  const moves = []; const skipped = []; const observed = []; const waiting = [];
  const ids = [...new Set([...claims.keys(), ...waitingIds.keys()])].sort((a, b) => a - b);
  for (const id of ids) {
    const item = items[id];
    if (!item) { skipped.push({ id, code: 'not-found', reason: 'work item not found or not readable' }); continue; }
    if (waitingIds.has(id)) { waiting.push({ id, reason: waitingIds.get(id) }); continue; }
    // Highest claim wins; a PR claim resolves to testing, verify for a Bug, or done.
    let best = null;
    for (const c of claims.get(id)) {
      const bucket = c.bucket || completedBucket(map, item.type);
      if (!best || RANK[bucket] > RANK[best.bucket]) best = { ...c, bucket };
    }
    const stale = staleTestingStates(map, item.type);
    if (stale.length && (stale.includes(item.state) || best.source === 'pr')) {
      skipped.push({ id, code: 'stale-map', reason: `${item.type} has states that look like testing (${stale.join(', ')}) but the state map predates the testing bucket: run states discover; nothing moves on a completed PR until then` });
      continue;
    }
    const d = checkMove({ map, item, bucket: best.bucket });
    if (d.ok) moves.push({ id, rev: item.rev, type: item.type, title: item.title, from: d.from, fromState: item.state, to: d.to, toState: d.toState, source: best.source, evidence: best.evidence });
    else if (d.code === 'same' || d.code === 'backwards') {
      const waits = d.from === 'testing' ? '; in testing, a person moves it on' : '';
      observed.push({ id, state: item.state, bucket: d.from, wanted: best.bucket, reason: `${best.evidence}; already ${d.from}${waits}` });
    }
    else if (d.code === 'idp') skipped.push({ id, code: 'idp', reason: 'idp-owned', detail: d.reason });
    else skipped.push({ id, code: d.code, reason: d.reason });
  }

  return { moves, skipped, observed, waiting, reports: reportReconcile({ map, branches, items, nowMs, staleDays, defaultBranch }) };
}

function reportReconcile({ map, branches, items, nowMs, staleDays, defaultBranch }) {
  const lastPush = new Map();
  for (const b of branches) {
    const id = branchWorkItemId(b.name);
    if (!id || !(b.ahead > 0)) continue;
    lastPush.set(id, Math.max(lastPush.get(id) || 0, toMs(b.date) || 0));
  }
  const cutoff = nowMs - staleDays * DAY;
  const staleDoing = Object.values(items)
    .filter((it) => bucketOf(map, it.type, it.state) === 'doing' && !hasIdpTag(it.tags))
    .filter((it) => !(toMs(it.stateChangeDate) > cutoff) && !((lastPush.get(it.id) || 0) > cutoff))
    .map((it) => ({ id: it.id, state: it.state, title: it.title, lastPush: lastPush.get(it.id) ? new Date(lastPush.get(it.id)).toISOString() : null }))
    .sort((a, b) => a.id - b.id);
  const unlinkedBranches = branches
    .filter((b) => b.ahead > 0 && !branchWorkItemId(b.name) && shortBranch(b.name) !== defaultBranch)
    .map((b) => ({ branch: shortBranch(b.name), ahead: b.ahead, date: b.date }));
  return { staleDays, staleDoing, unlinkedBranches };
}

// --- catalog-freshness nudge -----------------------------------------------------------

function isDue(cache, key, nowMs, hours) {
  const last = cache && cache[key] && toMs(cache[key].lastChecked);
  return !(last && nowMs - last < hours * 3600000);
}

function nudgeLine(staleDoing, staleDays) {
  const n = staleDoing.length;
  if (!n) return '';
  const ids = staleDoing.slice(0, 5).map((x) => `#${x.id}`).join(', ') + (n > 5 ? ', …' : '');
  return `${n} item${n === 1 ? ' has' : 's have'} not moved: ${ids} (doing, no pushed commit for ${staleDays} days). Ask to reconcile the board (ado-board).`;
}

module.exports = {
  BUCKETS, RANK, CATEGORY_BUCKET, TESTING_RE, NON_BOARD_TYPES, MAP_VERSION,
  mapType, parseChoices, buildMap, sameMap, stateMap, resolveBucket, boardTypes,
  bucketOf, hasIdpTag, checkMove, completedBucket, hasTesting, staleTestingStates, movePatch, requiredFieldFromError,
  branchWorkItemId, titleWorkItemIds, parseRemoteUrl,
  planReconcile, isDue, nudgeLine,
};
